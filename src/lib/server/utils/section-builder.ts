// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Server-Side Section Builder
 *
 * Transforms legacy API data into Server-Driven UI PageSection[] format.
 * This moves the transformation logic from the frontend to the backend.
 *
 * ARCHITECTURE NOTE (2026-02-17):
 * This module provides two layers of abstraction:
 * 1. Low-level transform functions (transformContinueWatching, transformSimilarItem, etc.)
 *    - Now implemented as thin wrappers over MediaTransformerService
 *    - Maintained for backward compatibility with existing endpoints
 *    - New code should use MediaTransformerService directly
 *
 * 2. High-level section builders (buildContinueWatchingSection, buildTrendingSection, etc.)
 *    - Compose complete PageSection objects with metadata
 *    - Used by 10+ API endpoints in /api/for-you/*
 *
 * Migration Path:
 * - High-traffic new endpoints: Use MediaTransformerService directly
 * - Existing endpoints: Continue using section builders (they use MediaTransformerService internally)
 * - Client code: Use client-side transformers in browse-transformers.ts
 */

import type {
    PageSection,
    UniversalMediaItem,
    Badge,
    TitlePart,
    FeaturedPickCriteria,
} from '$lib/types/server-driven-ui';
// Straight from the schema (the single source of truth) — server-driven-ui
// re-exports this same type under the shorter alias `MediaType`.
import type { UniversalMediaType } from '$lib/schemas/api-responses';
import type { ExternalIds } from '$lib/types/api-common';
import * as m from '$lib/paraglide/messages';
import { escapeHtml } from '$lib/utils/escape-html';
import {
    getCatalogPosterUrl,
    getCatalogBackdropUrl,
    getCatalogImageUrl,
} from '$lib/utils/image-utils.js';
import { mediaCompositeKey } from '$lib/utils/media-id-helpers';
import { getGenreNames } from '$lib/constants/genres';
import { getPreferredExternalId, getExternalIdFor } from '$lib/utils/external-ids';
import { getMediaTransformerService } from '$lib/server/services/media-transformer.service.js';
import { USER_DRIVEN_SOURCES } from '$lib/server/database/queries/user-media-events.queries.js';
import { FALLBACK_IMAGE } from '$lib/constants/images';
import { config } from '$lib/server/config.js';
import { formatRelativeTime } from '$lib/utils/time-formatting.js';
import { resolveSeriesAnchor } from './series-anchor.js';
import { toUniversalMediaType } from '$lib/shared/media-type-domain';
import { isAudiobook } from '$lib/shared/media-types';

/**
 * Drop the items a media-type narrowing produced no answer for.
 *
 * Every transform below returns `UniversalMediaItem | null`; `null` means the
 * row's `media_type` has no `UniversalMediaType` member (a `season`, a
 * `home_video`, a `radio` row, a storage-only bookkeeping row …). Those used to
 * be emitted as `mediaType: 'movie'`, so the client rendered a movie card that
 * opened the movie modal for something that is not a movie.
 *
 * Dropping is deliberate and matches the rule the recommendation feeds already
 * follow: a card the client cannot open correctly is worse than no card. A
 * section that ends up empty is handled by the `items.length === 0` guards the
 * builders already have.
 */
function renderable(items: (UniversalMediaItem | null)[]): UniversalMediaItem[] {
    return items.filter((item): item is UniversalMediaItem => item !== null);
}

// ============================================================================
// Legacy Data Types (matching API responses)
// ============================================================================

export interface ContinueWatchingItem {
    id: string;
    title: string;
    // Synopsis of the item (episode overview for episodes, movie overview for
    // movies). Carried through so the SSR home-hero first slide can show a
    // description on first paint for the personalized (Next Up / CW) branch.
    overview?: string;
    customMetadata?: Record<string, unknown>;
    mediaType: string;
    seriesName?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    watchProgress: number;
    duration?: number;
    imageUrl?: string;
    externalIds: ExternalIds;
    // Internal series UUID (from grandparent_id for episodes). Used as the
    // per-series dedup/anchor key in buildMergedWatchingSection. Null for
    // movies (they dedup on id). Optional because older callers may not
    // populate it; merge logic falls back to the external id / id.
    seriesId?: string;
    // Fraction of runtime watched (0–1). Populated for CW items only;
    // used by the anchor rule to distinguish substantial in-progress watches
    // from brief scrub-ahead phantoms.
    resumeRatio?: number;
    // ISO timestamp of last activity. For CW items this is uws.last_event_at;
    // for NU items it's the last completion in the series. Used to detect
    // stale phantom CW entries and to order the final merged row.
    updatedAt?: string;
    // Which query produced this item. Set by the row→item transforms so the
    // merge can choose the right transformer without re-inspecting content.
    source?: 'continue-watching' | 'next-up';
    // True when the underlying watch state was recorded inside a bulk-mark
    // sync window (e.g. Jellyfin "mark series played" cascade). The card
    // renders a warning indicator so the user can confirm (mark watched) or
    // reject (hide) without leaving the row. Populated by the watching API
    // route from detectBulkMarkWindows results; upstream callers that don't
    // have bulk-mark context can omit it.
    isSuspicious?: boolean;
    // Source of the latest event on the underlying `user_media_state` row
    // (e.g. 'lumastra-player', 'jellyfin-sync'). Used by markSuspiciousItems
    // to veto a false suspicion flag when the most recent activity was a
    // legitimate user-driven event — a bulk-mark window may overlap with
    // real playback and we must not punish the user for that coincidence.
    lastEventSource?: string;
    // Present when a live session overlay is currently backing this row.
    // Lets the card label distinguish "actively playing" from the generic
    // persisted resume state ("Paused 3m ago").
    livePlaybackState?: 'playing' | 'paused';
    // Backdrop blurhash LQIP placeholder. Populated for Next Up items (from
    // NextUpRow.backdrop_blurhash) so the SSR home hero's first slide can paint
    // a blurhash placeholder for returning users. Optional — Continue-Watching
    // rows and other callers leave it undefined.
    backdropBlurhash?: string;
    /** Authoritative local-file evidence used by the card transformer. */
    hasFiles?: boolean;
    /** Explicit local-file evidence from the canonical media row. */
    isAvailable?: boolean;
}

/**
 * Minimal shape of a bulk-mark window for the suspicion helper. Matches the
 * BulkMarkWindow type in user-media-events.queries.ts but only lists the
 * fields the helper actually reads — decoupled so tests don't need the full
 * DB row shape and so callers from other routes can pass synthetic windows.
 */
export interface SuspicionWindow {
    window_start: string;
    window_end: string;
}

export interface SimilarItem {
    externalIds: ExternalIds;
    mediaType: string;
    title: string;
    rating: number;
    overview?: string;
    similarity: number;
    isAvailable: boolean;
    canRequest: boolean;
    trailerUrl?: string;
    rtCritic?: number | null;
    rtAudience?: number | null;
    year?: number | null;
}

export interface BecauseYouWatchedRow {
    sourceMovie: {
        externalIds: ExternalIds;
        title: string;
        mediaType: string;
        posterUrl?: string;
    };
    similar: SimilarItem[];
}

export interface TrendingItem {
    rank: number;
    externalIds: ExternalIds;
    mediaType: string;
    title: string;
    rating?: number;
    overview?: string;
    isAvailable: boolean;
    canRequest: boolean;
    trailerUrl?: string;
    rtCritic?: number | null;
    rtAudience?: number | null;
    year?: number | null;
}

export interface KeywordRow {
    keyword: string;
    count: number;
    movies: Array<{
        externalIds: ExternalIds;
        mediaType: string;
        title: string;
        overview?: string;
        isAvailable: boolean;
        canRequest: boolean;
        trailerUrl?: string;
        rtCritic?: number | null;
        rtAudience?: number | null;
        year?: number | null;
    }>;
}

export interface ShortMovieItem {
    externalIds: ExternalIds;
    mediaType: string;
    title: string;
    overview?: string;
    runtimeMinutes?: number | null;
    imdbRating?: number;
    mdblistScore?: number;
    isAvailable: boolean;
    canRequest: boolean;
    aiSimilarity?: number | null;
    trailerUrl?: string;
    rtCritic?: number | null;
    rtAudience?: number | null;
    year?: number | null;
}

export interface AnimeItem {
    externalIds: ExternalIds;
    mediaType: string;
    title: string;
    overview?: string;
    imdbRating?: number;
    mdblistScore?: number;
    malScore?: number;
    isAvailable: boolean;
    canRequest: boolean;
    trailerUrl?: string;
    rtCritic?: number | null;
    rtAudience?: number | null;
    year?: number | null;
}

export interface FreshReleaseItem {
    externalIds: ExternalIds;
    mediaType: string;
    title: string;
    rating?: number;
    mdblistScore?: number | null;
    releaseDate?: string | Date | null;
    overview?: string;
    isAvailable: boolean;
    canRequest: boolean;
    posterPath?: string | null;
    backdropPath?: string | null;
    trailerUrl?: string;
    rtCritic?: number | null;
    rtAudience?: number | null;
    year?: number | null;
}

export interface BingeWorthyItem {
    externalIds: ExternalIds;
    mediaType: string;
    title: string;
    overview?: string;
    rating?: number;
    mdblistScore?: number;
    isAvailable: boolean;
    canRequest: boolean;
    trailerUrl?: string;
    rtCritic?: number | null;
    rtAudience?: number | null;
    year?: number | null;
}

export interface FulfilledRequestItem {
    externalIds: ExternalIds;
    mediaType: 'movie' | 'tv';
    title: string;
    overview?: string;
    imdbRating?: number;
    trailerUrl?: string;
    rtCritic?: number | null;
    rtAudience?: number | null;
    year?: number | null;
    /**
     * Whether a playable (has_files=true) catalog row actually resolved for this
     * request. A fulfilled Jellyseerr request is NOT guaranteed to map to a
     * playable row in our catalog (e.g. the file was ingested as a separate
     * row that never got cross-linked to the requested TMDB id). When false the
     * card must not claim "ready" — otherwise clicking 404s on play.
     *
     * Required (not optional) so a new caller can't silently reintroduce the
     * hardcoded-"ready" 404 bug by forgetting to set it.
     */
    isAvailable: boolean;
}

export interface MoodData {
    mood: string;
    moodProfile: { name: string; description: string };
    title: string;
    timeOfDay: string;
    personalized: boolean;
    recommendations: Array<{
        externalIds: ExternalIds;
        mediaType: string;
        title: string;
        overview?: string;
        imdbRating?: number;
        letterboxdRating?: number;
        mdblistScore?: number;
        isAvailable: boolean;
        canRequest: boolean;
        trailerUrl?: string;
        rtCritic?: number | null;
        rtAudience?: number | null;
        year?: number | null;
    }>;
}

export interface AISuggestionItem {
    externalIds: ExternalIds;
    media_type: string;
    title: string;
    overview: string;
    similarity_score: number;
    reason?: string;
    is_available: boolean;
    can_request: boolean;
    is_watched?: boolean;
    mediaId?: string;
    rt_critic?: number;
    rt_audience?: number;
    letterboxd_rating?: number;
    letterboxd_votes?: number;
    mdblist_score?: number;
    trakt_score?: number;
    metacritic_score?: number;
    trailer_url?: string;
}

// ============================================================================
// Transformer Functions
// ============================================================================

/**
 * Get poster URL using internal UUID via catalog endpoint.
 */
function getPosterUrl(
    externalIds: ExternalIds,
    _mediaType: string,
    size: 'thumb' | 'full' = 'thumb',
): string {
    const internalId = getExternalIdFor(externalIds, 'internal');
    return internalId ? getCatalogPosterUrl(internalId, { size }) : FALLBACK_IMAGE;
}

/**
 * Build a human-readable "why is this card here" label for a CW item.
 * Returns "Paused <relative time>" when we have an activity timestamp,
 * otherwise "Paused" without the duration (better than showing nothing).
 */
function buildResumeContextLabel(item: ContinueWatchingItem): string {
    if (item.livePlaybackState === 'playing') {
        // A book is listened to, not watched. Same live signal, the verb the
        // rest of the audiobook surface already uses ("Listen", "Continue
        // listening") rather than the video one.
        return isAudiobook(item.mediaType) ? m.section_listening_now() : m.section_playing_now();
    }
    if (!item.updatedAt) return m.section_paused();
    return m.section_paused_time({ time: formatRelativeTime(item.updatedAt) });
}

/**
 * Build a context label for a Next Up item. Prefers a concrete episode
 * reference ("S2:E04") when available, falling back to the generic
 * "Next episode" label.
 */
function buildNextUpContextLabel(item: ContinueWatchingItem): string {
    if (item.seasonNumber !== undefined && item.episodeNumber !== undefined) {
        const s = String(item.seasonNumber);
        const e = String(item.episodeNumber).padStart(2, '0');
        return m.section_next_episode_code({ season: s, episode: e });
    }
    return m.section_next_episode();
}

/**
 * Transform continue watching item to UniversalMediaItem
 * Now uses MediaTransformerService for consolidated transformation logic
 */
export function transformContinueWatching(item: ContinueWatchingItem): UniversalMediaItem | null {
    const transformer = getMediaTransformerService();
    const base = transformer.transformToUniversalMedia(item, {
        prefix: 'cw',
        includeProgress: true,
    });
    if (base === null) return null;
    // contextLabel answers "why is this card here" — for resume it's the
    // paused-X-ago line. We intentionally do NOT set isNew here; the merged
    // CW row represents user engagement, not freshness.
    return {
        ...base,
        contextLabel: buildResumeContextLabel(item),
        // Machine-readable live playing flag (the locale-independent companion
        // to the "Playing now" contextLabel). The home hero reads this off the
        // live watchingSections to flip its own treatment in lock-step with the
        // CW carousel — both directions — without a rebuild. Undefined when not
        // playing so it stays absent from the serialized payload.
        isPlaying: item.livePlaybackState === 'playing' ? true : undefined,
        // Carry the suspicion flag set upstream so the card can render the
        // warning indicator. Leave undefined when not flagged so the field
        // stays optional in the serialized payload.
        isSuspicious: item.isSuspicious ? true : undefined,
    };
}

export function transformNextUp(item: ContinueWatchingItem): UniversalMediaItem | null {
    const base = transformContinueWatching(item);
    if (base === null) return null;

    // Use mediaCompositeKey for consistent ID generation (prevents duplicates)
    const uniqueId = mediaCompositeKey(item.externalIds, item.mediaType, 'nu');

    return {
        ...base,
        id: uniqueId,
        progress: undefined,
        // NU items are "next up", not "new". isNew drove a generic "New" badge
        // that rendered on every CW row and was indistinguishable from actual
        // freshly-aired episodes. The contextLabel below carries the intent.
        isNew: false,
        isNextUp: true,
        contextLabel: buildNextUpContextLabel(item),
    };
}

/**
 * Transform trending item to UniversalMediaItem
 * Now uses MediaTransformerService for consolidated transformation logic
 */
export function transformTrendingItem(
    item: TrendingItem,
    prefix = 'tr',
): UniversalMediaItem | null {
    const transformer = getMediaTransformerService();
    const base = transformer.transformToUniversalMedia(item, { prefix });
    if (base === null) return null;
    // is_available is derived from media_items.has_files, so availability is
    // the local-file signal. Carry it as hasFiles so the play gate hides Play
    // on discovery-only (no-file) trending entries.
    return { ...base, hasFiles: item.isAvailable };
}

/**
 * Transform similar media item to UniversalMediaItem
 * Now uses MediaTransformerService for consolidated transformation logic
 */
export function transformSimilarItem(item: SimilarItem): UniversalMediaItem | null {
    const transformer = getMediaTransformerService();
    const base = transformer.transformToUniversalMedia(item, { prefix: 'sim' });
    if (base === null) return null;
    return { ...base, hasFiles: item.isAvailable };
}

export function transformKeywordItem(item: KeywordRow['movies'][0]): UniversalMediaItem | null {
    const mediaType = toUniversalMediaType(item.mediaType);
    // A bare `item.mediaType as UniversalMediaType` used to sit in the object
    // literal below: an unchecked assertion that let ANY string the query
    // produced pose as a member of the union. Narrowing through the shared table
    // drops what the client cannot render instead of mislabelling it.
    if (mediaType === null) return null;
    const uniqueId = mediaCompositeKey(item.externalIds, item.mediaType, 'yl');

    return {
        id: uniqueId,
        externalIds: item.externalIds,
        mediaType,
        title: item.title,
        image: getExternalIdFor(item.externalIds, 'internal')
            ? getCatalogPosterUrl(getExternalIdFor(item.externalIds, 'internal')!, {
                  size: 'thumb',
              })
            : FALLBACK_IMAGE,
        overview: item.overview,
        isAvailable: item.isAvailable,
        hasFiles: item.isAvailable,
        canRequest: item.canRequest,
        trailerUrl: item.trailerUrl,
        criticRating: item.rtCritic ?? undefined,
        audienceRating: item.rtAudience ?? undefined,
        year: item.year ?? undefined,
    };
}

export function transformShortMovie(item: ShortMovieItem): UniversalMediaItem {
    const uniqueId = mediaCompositeKey(item.externalIds, item.mediaType, 'short');

    return {
        id: uniqueId,
        externalIds: item.externalIds,
        mediaType: 'movie',
        title: item.title,
        subtitle: item.runtimeMinutes
            ? m.time_minutes_short({ count: String(item.runtimeMinutes) })
            : undefined,
        image: getExternalIdFor(item.externalIds, 'internal')
            ? getCatalogPosterUrl(getExternalIdFor(item.externalIds, 'internal')!, {
                  size: 'thumb',
              })
            : FALLBACK_IMAGE,
        overview: item.overview,
        rating: item.imdbRating,
        mdblistScore: item.mdblistScore ?? undefined,
        durationMs:
            item.runtimeMinutes == null ? undefined : Math.round(item.runtimeMinutes * 60_000),
        isAvailable: item.isAvailable,
        hasFiles: item.isAvailable,
        canRequest: item.canRequest,
        trailerUrl: item.trailerUrl,
        criticRating: item.rtCritic ?? undefined,
        audienceRating: item.rtAudience ?? undefined,
        year: item.year ?? undefined,
    };
}

export function transformAnimeItem(item: AnimeItem): UniversalMediaItem | null {
    const mediaType = toUniversalMediaType(item.mediaType);
    // A bare `item.mediaType as UniversalMediaType` used to sit in the object
    // literal below: an unchecked assertion that let ANY string the query
    // produced pose as a member of the union. Narrowing through the shared table
    // drops what the client cannot render instead of mislabelling it.
    if (mediaType === null) return null;
    const uniqueId = mediaCompositeKey(item.externalIds, item.mediaType, 'anime');

    return {
        id: uniqueId,
        externalIds: item.externalIds,
        mediaType,
        title: item.title,
        image: getExternalIdFor(item.externalIds, 'internal')
            ? getCatalogPosterUrl(getExternalIdFor(item.externalIds, 'internal')!, {
                  size: 'thumb',
              })
            : FALLBACK_IMAGE,
        overview: item.overview,
        rating: item.imdbRating,
        malScore: item.malScore ?? undefined,
        mdblistScore: item.mdblistScore ?? undefined,
        isAvailable: item.isAvailable,
        hasFiles: item.isAvailable,
        canRequest: item.canRequest,
        trailerUrl: item.trailerUrl,
        criticRating: item.rtCritic ?? undefined,
        audienceRating: item.rtAudience ?? undefined,
        year: item.year ?? undefined,
    };
}

export function transformFreshRelease(item: FreshReleaseItem): UniversalMediaItem | null {
    const mediaType = toUniversalMediaType(item.mediaType);
    // A bare `item.mediaType as UniversalMediaType` used to sit in the object
    // literal below: an unchecked assertion that let ANY string the query
    // produced pose as a member of the union. Narrowing through the shared table
    // drops what the client cannot render instead of mislabelling it.
    if (mediaType === null) return null;
    const uniqueId = mediaCompositeKey(item.externalIds, item.mediaType, 'fresh');

    // Convert releaseDate to string if it's a Date object
    let releaseDateStr: string | undefined;
    if (item.releaseDate) {
        releaseDateStr =
            item.releaseDate instanceof Date
                ? item.releaseDate.toISOString().split('T')[0]
                : item.releaseDate;
    }

    return {
        id: uniqueId,
        externalIds: item.externalIds,
        mediaType,
        title: item.title,
        image: getExternalIdFor(item.externalIds, 'internal')
            ? getCatalogPosterUrl(getExternalIdFor(item.externalIds, 'internal')!, {
                  size: 'thumb',
              })
            : FALLBACK_IMAGE,
        overview: item.overview,
        rating: item.rating,
        mdblistScore: item.mdblistScore ?? undefined,
        releaseDate: releaseDateStr,
        isAvailable: item.isAvailable,
        hasFiles: item.isAvailable,
        canRequest: item.canRequest,
        trailerUrl: item.trailerUrl,
        criticRating: item.rtCritic ?? undefined,
        audienceRating: item.rtAudience ?? undefined,
        year: item.year ?? undefined,
    };
}

export function transformBingeWorthy(item: BingeWorthyItem): UniversalMediaItem {
    const badges: Badge[] =
        item.mdblistScore && item.mdblistScore >= 80
            ? [{ text: String(item.mdblistScore), color: 'success' }]
            : [];

    const uniqueId = mediaCompositeKey(item.externalIds, item.mediaType, 'binge');

    return {
        id: uniqueId,
        externalIds: item.externalIds,
        // Binge-worthy is series-only. The public discriminator is 'series' —
        // the stored 'tv' token is never emitted on a card.
        mediaType: 'series',
        title: item.title,
        image: getExternalIdFor(item.externalIds, 'internal')
            ? getCatalogPosterUrl(getExternalIdFor(item.externalIds, 'internal')!, {
                  size: 'thumb',
              })
            : FALLBACK_IMAGE,
        overview: item.overview,
        rating: item.rating,
        mdblistScore: item.mdblistScore ?? undefined,
        isAvailable: item.isAvailable,
        hasFiles: item.isAvailable,
        canRequest: item.canRequest,
        badges: badges.length > 0 ? badges : undefined,
        trailerUrl: item.trailerUrl,
        criticRating: item.rtCritic ?? undefined,
        audienceRating: item.rtAudience ?? undefined,
        year: item.year ?? undefined,
    };
}

/**
 * `'movie' | 'tv'` → the public card discriminator.
 *
 * For a `string` input the right tool is `toUniversalMediaType()`, which returns
 * `| null` so the caller drops what the client cannot render. The two
 * transformers below take an input already narrowed to movie-or-series, so that
 * `null` would be an unreachable branch that forces their callers to filter.
 * This table is exhaustive over the narrow union instead — and becomes a compile
 * error if either item type ever widens `mediaType`.
 *
 * Note the raw `item.mediaType` is still what feeds `mediaCompositeKey()`: that
 * helper interpolates the token verbatim into `provider:id:type`, so emitting
 * 'series' there would change every composite key these rails produce.
 */
const MOVIE_OR_TV_TO_CARD: Readonly<Record<'movie' | 'tv', UniversalMediaType>> = {
    movie: 'movie',
    tv: 'series',
};

export function transformFulfilledRequest(item: FulfilledRequestItem): UniversalMediaItem {
    const uniqueId = mediaCompositeKey(item.externalIds, item.mediaType, 'fulfilled');

    // Derive availability from whether a playable row actually resolved — never
    // assume a fulfilled request is playable.
    const isAvailable = item.isAvailable;

    return {
        id: uniqueId,
        externalIds: item.externalIds,
        mediaType: MOVIE_OR_TV_TO_CARD[item.mediaType],
        title: item.title,
        image: getPosterUrl(item.externalIds, item.mediaType),
        overview: item.overview,
        rating: item.imdbRating,
        isAvailable,
        hasFiles: isAvailable,
        canRequest: false,
        trailerUrl: item.trailerUrl,
        criticRating: item.rtCritic ?? undefined,
        audienceRating: item.rtAudience ?? undefined,
        year: item.year ?? undefined,
    };
}

export function transformMoodItem(item: MoodData['recommendations'][0]): UniversalMediaItem | null {
    const mediaType = toUniversalMediaType(item.mediaType);
    // A bare `item.mediaType as UniversalMediaType` used to sit in the object
    // literal below: an unchecked assertion that let ANY string the query
    // produced pose as a member of the union. Narrowing through the shared table
    // drops what the client cannot render instead of mislabelling it.
    if (mediaType === null) return null;
    const uniqueId = mediaCompositeKey(item.externalIds, item.mediaType, 'mood');

    return {
        id: uniqueId,
        externalIds: item.externalIds,
        mediaType,
        title: item.title,
        image: getPosterUrl(item.externalIds, item.mediaType),
        overview: item.overview,
        rating: item.imdbRating,
        letterboxdRating: item.letterboxdRating ?? undefined,
        mdblistScore: item.mdblistScore ?? undefined,
        isAvailable: item.isAvailable,
        hasFiles: item.isAvailable,
        canRequest: item.canRequest,
        trailerUrl: item.trailerUrl,
        criticRating: item.rtCritic ?? undefined,
        audienceRating: item.rtAudience ?? undefined,
        year: item.year ?? undefined,
    };
}

export function transformAISuggestion(item: AISuggestionItem): UniversalMediaItem | null {
    const mediaType = toUniversalMediaType(item.media_type);
    // A bare `item.mediaType as UniversalMediaType` used to sit in the object
    // literal below: an unchecked assertion that let ANY string the query
    // produced pose as a member of the union. Narrowing through the shared table
    // drops what the client cannot render instead of mislabelling it.
    if (mediaType === null) return null;
    const uniqueId = mediaCompositeKey(item.externalIds, item.media_type, 'ai');

    return {
        id: uniqueId,
        externalIds: item.externalIds,
        // UniversalMediaType already models episode/series/audiobook — narrowing
        // to two tokens here discarded that rather than converting anything.
        mediaType,
        title: item.title,
        image: getPosterUrl(item.externalIds, item.media_type),
        overview: item.overview,
        isAvailable: item.is_available,
        hasFiles: item.is_available,
        canRequest: item.can_request,
        isPlayed: item.is_watched,
        similarityScore: item.similarity_score,
        reason: item.reason,
        criticRating: item.rt_critic ?? undefined,
        audienceRating: item.rt_audience ?? undefined,
        letterboxdRating: item.letterboxd_rating ?? undefined,
        letterboxdVotes: item.letterboxd_votes ?? undefined,
        mdblistScore: item.mdblist_score ?? undefined,
        metacriticScore: item.metacritic_score ?? undefined,
        traktScore: item.trakt_score ?? undefined,
        trailerUrl: item.trailer_url,
    };
}

// ============================================================================
// Section Builders
// ============================================================================

export function buildContinueWatchingSection(
    items: ContinueWatchingItem[],
    loading = false,
): PageSection | null {
    if (items.length === 0 && !loading) return null;
    return {
        id: 'continue-watching',
        type: 'continue-watching',
        title: m.section_continue_watching(),
        items: renderable(items.map(transformContinueWatching)),
        meta: {
            icon: 'play-circle',
            iconColor: 'text-green-400',
            loading,
            accentColor: 'green',
        },
    };
}

export function buildNextUpSection(
    items: ContinueWatchingItem[],
    loading = false,
): PageSection | null {
    if (items.length === 0 && !loading) return null;
    return {
        id: 'next-up',
        type: 'next-up',
        title: m.section_next_episode(),
        items: renderable(items.map(transformNextUp)),
        meta: {
            icon: 'forward',
            iconColor: 'text-blue-400',
            loading,
            accentColor: 'blue',
        },
    };
}

export function buildFulfilledRequestsSection(items: FulfilledRequestItem[]): PageSection | null {
    if (items.length === 0) return null;
    return {
        id: 'fulfilled-requests',
        type: 'carousel',
        title: m.section_requests_ready(),
        items: items.map(transformFulfilledRequest),
        meta: {
            icon: 'gift-top',
            iconColor: 'text-green-400',
            subtitle: `${items.length} ${m.section_new()}`,
            accentColor: 'green',
        },
    };
}

export function buildMoodSection(moodData: MoodData | null): PageSection | null {
    if (!moodData || moodData.recommendations.length === 0) return null;
    return {
        id: 'mood-recommendations',
        type: 'carousel',
        title: moodData.title,
        items: renderable(moodData.recommendations.map(transformMoodItem)),
        meta: {
            icon:
                moodData.timeOfDay === 'morning' || moodData.timeOfDay === 'afternoon'
                    ? 'sun'
                    : 'moon',
            iconColor: 'text-indigo-400',
            subtitle: moodData.moodProfile.description,
            accentColor: 'indigo',
        },
    };
}

export function buildBecauseYouWatchedSections(rows: BecauseYouWatchedRow[]): PageSection[] {
    return rows.map((row) => {
        // Build structured titleParts for non-HTML clients (tvOS)
        // Handles both "Because you watched {title}" (EN) and "Weil du {title} geschaut hast" (DE)
        const titleParts: TitlePart[] = [
            { text: m.section_because_you_watched_prefix() + ' ' },
            { text: row.sourceMovie.title, highlight: true, color: 'purple' },
        ];

        // Add suffix if present (German has "geschaut hast" after the title)
        const suffix = m.section_because_you_watched_suffix();
        if (suffix) {
            titleParts.push({ text: ' ' + suffix });
        }

        // Debug: Check for undefined items
        const validItems = row.similar.filter((item) => item !== null && item !== undefined);
        if (validItems.length !== row.similar.length) {
            const sectionId = mediaCompositeKey(
                row.sourceMovie.externalIds,
                row.sourceMovie.mediaType,
                'because',
            );
            console.warn(
                `[buildBecauseYouWatchedSections] Found ${row.similar.length - validItems.length} null/undefined items in section "${sectionId}"`,
            );
        }

        // Get backdrop URL for subtle background accent
        const backdropUrl = getExternalIdFor(row.sourceMovie.externalIds, 'internal')
            ? getCatalogBackdropUrl(getExternalIdFor(row.sourceMovie.externalIds, 'internal')!, {
                  size: 'medium',
              })
            : undefined;

        // Get source poster for thumbnail in header. Prefer the catalog-proxy
        // URL (served/cached through our own image proxy) whenever we have an
        // internal UUID to resolve it from; only fall back to the raw stored
        // `posterUrl` (which may be a stale or arbitrary external URL — see
        // the "window blinds" bug) when there's no UUID, and finally to the
        // shared placeholder if neither is available. Note getPosterUrl()
        // itself always returns a truthy string (FALLBACK_IMAGE when there's
        // no UUID), so a plain `||` chain against it would never fall through
        // to posterUrl — the branch below is required to keep it sensible.
        const sourceInternalId = getExternalIdFor(row.sourceMovie.externalIds, 'internal');
        const sourceImage = sourceInternalId
            ? getCatalogPosterUrl(sourceInternalId, { size: 'thumb' })
            : row.sourceMovie.posterUrl || FALLBACK_IMAGE;

        return {
            id: mediaCompositeKey(
                row.sourceMovie.externalIds,
                row.sourceMovie.mediaType,
                'because',
            ),
            type: 'carousel' as const,
            // The message is HTML; the title is library data, so it goes in as text.
            title: m.section_because_you_watched({
                title: escapeHtml(row.sourceMovie.title),
            }),
            items: renderable(validItems.map(transformSimilarItem)),
            meta: {
                accentColor: 'purple',
                titleParts,
                backdropUrl: backdropUrl || undefined,
                sourceImage,
                sourceTitle: row.sourceMovie.title,
            },
        };
    });
}

export function buildYouLikeSections(rows: KeywordRow[]): PageSection[] {
    return rows.map((row) => {
        // Build structured titleParts for non-HTML clients (tvOS)
        const titleParts: TitlePart[] = [
            { text: m.section_you_like_prefix() + ' ' },
            { text: row.keyword, highlight: true, color: 'cyan' },
        ];

        return {
            id: `youlike-${row.keyword}`,
            type: 'carousel' as const,
            title: m.section_you_like({ keyword: escapeHtml(row.keyword) }),
            items: renderable(row.movies.map(transformKeywordItem)),
            meta: {
                icon: 'hashtag',
                iconColor: 'text-cyan-400',
                accentColor: 'cyan',
                titleParts,
            },
        };
    });
}

export function buildAISuggestionsSection(items: AISuggestionItem[]): PageSection | null {
    if (items.length === 0) return null;
    return {
        id: 'ai-suggestions',
        type: 'carousel',
        title: m.section_ai_recommendations(),
        items: renderable(items.map(transformAISuggestion)),
        meta: {
            icon: 'light-bulb',
            iconColor: 'text-yellow-400',
            accentColor: 'yellow',
        },
    };
}

export function buildShortMoviesSection(items: ShortMovieItem[]): PageSection | null {
    if (items.length === 0) return null;
    return {
        id: 'short-movies',
        type: 'carousel',
        title: m.section_short_movies(),
        items: items.map(transformShortMovie),
        meta: {
            icon: 'clock',
            iconColor: 'text-emerald-400',
            subtitle: m.section_short_movies_subtitle(),
            accentColor: 'emerald',
        },
    };
}

export function buildAnimeSection(items: AnimeItem[]): PageSection | null {
    if (items.length === 0) return null;
    return {
        id: 'anime',
        type: 'carousel',
        title: m.section_anime_for_you(),
        items: renderable(items.map(transformAnimeItem)),
        meta: { accentColor: 'pink' },
    };
}

export function buildFreshReleasesSection(items: FreshReleaseItem[]): PageSection | null {
    if (items.length === 0) return null;
    return {
        id: 'fresh-releases',
        type: 'carousel',
        title: m.section_fresh_releases(),
        items: renderable(items.map(transformFreshRelease)),
        meta: { accentColor: 'teal' },
    };
}

export function buildBingeWorthySection(items: BingeWorthyItem[]): PageSection | null {
    if (items.length === 0) return null;
    return {
        id: 'binge-worthy',
        type: 'carousel',
        title: m.section_binge_worthy(),
        items: items.map(transformBingeWorthy),
        meta: {
            subtitle: m.section_binge_worthy_subtitle(),
            accentColor: 'violet',
        },
    };
}

export function buildTrendingSection(items: TrendingItem[]): PageSection | null {
    if (items.length === 0) return null;
    return {
        id: 'trending',
        type: 'carousel',
        title: m.section_trending_today(),
        items: renderable(items.map((i) => transformTrendingItem(i, 'tr'))),
        meta: { icon: 'fire', iconColor: 'text-red-500', accentColor: 'amber' },
    };
}

export function buildPopularShowsSection(items: TrendingItem[]): PageSection | null {
    if (items.length === 0) return null;
    return {
        id: 'popular-shows',
        type: 'carousel',
        title: m.section_popular_shows(),
        items: renderable(items.map((i) => transformTrendingItem(i, 'pop'))),
        meta: {
            icon: 'fire',
            iconColor: 'text-orange-500',
            accentColor: 'cyan',
        },
    };
}

// ============================================================================
// Library Fallback Section Builders
// ============================================================================

export interface LibraryMediaItem {
    id: string;
    title: string;
    media_type: string;
    year: number | null;
    overview: string | null;
    created_at?: Date;
}

function transformLibraryItem(item: LibraryMediaItem): UniversalMediaItem | null {
    // `media_type` here is the raw column, and these rails ("recently added",
    // "random picks") are library-wide — an album, track or audiobook row
    // genuinely arrives. The previous `isMovie(x) ? 'movie' : 'tv'` was a binary
    // fallback that labelled every one of them a series. Narrow through the
    // shared table and drop what the client cannot render instead.
    const mediaType = toUniversalMediaType(item.media_type);
    if (mediaType === null) return null;

    return {
        id: item.id,
        title: item.title,
        mediaType,
        year: item.year ?? undefined,
        overview: item.overview ?? undefined,
        image: `/api/image/catalog/${item.id}/poster`,
        backdrop: `/api/image/catalog/${item.id}/backdrop`,
        externalIds: { internal: item.id },
        isAvailable: true,
        canRequest: false,
    };
}

export function buildRecentlyAddedSection(items: LibraryMediaItem[]): PageSection | null {
    // Guard the RENDERABLE count, not the input count: transformLibraryItem now
    // drops rows the client has no card for, so an all-dropped batch would
    // otherwise ship an empty rail.
    const cards = renderable(items.map(transformLibraryItem));
    if (cards.length === 0) return null;
    return {
        id: 'recently-added',
        type: 'carousel',
        title: m.section_recently_added(),
        items: cards,
        meta: {
            icon: 'clock',
            accentColor: 'blue',
        },
    };
}

export function buildRandomPicksSection(items: LibraryMediaItem[]): PageSection | null {
    // Guard the RENDERABLE count — see buildRecentlyAddedSection.
    const cards = renderable(items.map(transformLibraryItem));
    if (cards.length === 0) return null;
    return {
        id: 'random-picks',
        type: 'carousel',
        title: m.section_random_picks(),
        items: cards,
        meta: {
            icon: 'sparkles',
            accentColor: 'purple',
        },
    };
}

// ============================================================================
// Main Section Builder
// ============================================================================

export interface ForYouData {
    becauseYouWatched: BecauseYouWatchedRow[];
    youLikeRows: KeywordRow[];
    trending: TrendingItem[];
    popularShows: TrendingItem[];
    shortMovies: ShortMovieItem[];
    animeRecommendations: AnimeItem[];
    freshReleases: FreshReleaseItem[];
    bingeWorthySeries: BingeWorthyItem[];
    fulfilledRequests: FulfilledRequestItem[];
}

export function buildForYouSections(data: ForYouData): PageSection[] {
    const sections: PageSection[] = [];

    // Fulfilled Requests (high priority - user's requests are ready)
    const fulfilledSection = buildFulfilledRequestsSection(data.fulfilledRequests);
    if (fulfilledSection) sections.push(fulfilledSection);

    // Because You Watched (personalized rows)
    sections.push(...buildBecauseYouWatchedSections(data.becauseYouWatched));

    // You Like X (keyword-based rows)
    sections.push(...buildYouLikeSections(data.youLikeRows));

    // Short Movies
    const shortSection = buildShortMoviesSection(data.shortMovies);
    if (shortSection) sections.push(shortSection);

    // Anime
    const animeSection = buildAnimeSection(data.animeRecommendations);
    if (animeSection) sections.push(animeSection);

    // Fresh Releases
    const freshSection = buildFreshReleasesSection(data.freshReleases);
    if (freshSection) sections.push(freshSection);

    // Binge-Worthy
    const bingeSection = buildBingeWorthySection(data.bingeWorthySeries);
    if (bingeSection) sections.push(bingeSection);

    // Trending
    const trendingSection = buildTrendingSection(data.trending);
    if (trendingSection) sections.push(trendingSection);

    // Popular Shows
    const popularSection = buildPopularShowsSection(data.popularShows);
    if (popularSection) sections.push(popularSection);

    return sections;
}

export interface WatchingData {
    continueWatching: ContinueWatchingItem[];
    nextUp: ContinueWatchingItem[];
}

/**
 * Flag CW/NU items whose `updatedAt` falls inside any bulk-mark window.
 * Pure — returns a new array with `isSuspicious` set on matched items;
 * does not mutate its inputs.
 *
 * Windows are pre-normalized into numeric epoch-ms ranges so the per-item
 * check is O(windows) rather than re-parsing ISO strings for each item.
 * Items without an `updatedAt` are left unflagged (can't prove suspicion
 * without a timestamp to compare against).
 */
export function markSuspiciousItems<T extends ContinueWatchingItem>(
    items: T[],
    windows: readonly SuspicionWindow[],
): T[] {
    if (windows.length === 0) return items;

    const ranges: Array<{ start: number; end: number }> = [];
    for (const w of windows) {
        const start = Date.parse(w.window_start);
        const end = Date.parse(w.window_end);
        if (Number.isNaN(start) || Number.isNaN(end)) continue;
        ranges.push({ start, end });
    }
    if (ranges.length === 0) return items;

    return items.map((item) => {
        // Veto: if the latest event on this row was a legitimate
        // user-driven source we trust it even when the timestamp happens
        // to fall inside a bulk-mark window. Without this check a real
        // Lumastra play session concurrent with a Jellyfin cascade would
        // light up the amber warning on a card the user actually touched.
        if (
            item.lastEventSource &&
            (USER_DRIVEN_SOURCES as readonly string[]).includes(item.lastEventSource)
        ) {
            return item;
        }
        if (!item.updatedAt) return item;
        const ms = Date.parse(item.updatedAt);
        if (Number.isNaN(ms)) return item;
        for (const r of ranges) {
            if (ms >= r.start && ms <= r.end) {
                return { ...item, isSuspicious: true };
            }
        }
        return item;
    });
}

/**
 * Build a merged "Continue Watching" section combining Continue Watching and Next Up.
 *
 * Per-series anchor rule (fixes phantom-scrub bug where a brief play on a
 * later episode outranked the correct Next Up episode):
 *
 *   1. Dedup CW within a series — keep only the most recently updated row.
 *   2. For movies (no series): CW wins by default (there's no Next Up path).
 *   3. For series where CW and NU both exist:
 *      a. If CW's episode order < NU's → CW is backlog catch-up → CW wins.
 *      b. If CW's order >= NU's AND (CW is substantial OR CW is fresh):
 *         → user is deliberately jumping ahead → CW wins.
 *      c. Otherwise (CW is ahead-of-sequence AND low-progress AND stale):
 *         → CW is likely a phantom scrub → NU wins.
 *   4. Order final cards by max(CW.updatedAt, NU.updatedAt) DESC.
 *
 * Thresholds are tunable via env: CONTINUE_WATCHING_SUBSTANTIAL_PERCENT
 * (default 20) and CONTINUE_WATCHING_PHANTOM_STALENESS_DAYS (default 3).
 *
 * The CW-vs-NU arbitration itself lives in `series-anchor.ts` so it can be
 * tested in isolation. This builder owns dedup and final ordering only.
 */
function parseActivityTs(iso: string | undefined): number {
    if (!iso) return 0;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? 0 : ms;
}

function seriesDedupKey(item: ContinueWatchingItem): string {
    // seriesId (internal UUID) is globally unique, so it needs no media-type
    // scoping. The external-ID fallback, however, is a
    // raw provider ID (e.g. TMDB) which is NOT unique across media types — a
    // movie and a TV series can share the same numeric ID. Scope that branch
    // by mediaType so two different-type items never collapse into one bucket.
    const externalId = getPreferredExternalId(item.externalIds)?.id;
    return item.seriesId || (externalId ? `${externalId}:${item.mediaType}` : undefined) || item.id;
}

/**
 * Build the empty-state payload for the CW row. Rendered in place of cards
 * when the user has nothing to resume or continue — replaces the silent
 * "section disappears" behavior so the slot still communicates value.
 *
 * The CTA is "Browse" (the library), which always has a destination. The
 * server cannot know whether the home Trending row will have anything to show
 * (it resolves client-side, and a small library often holds none of the global
 * trending titles), so the client upgrades this to "Browse trending" only once
 * the Trending row has actually loaded items (see trending-availability.ts).
 */
function buildCwEmptyState(): NonNullable<NonNullable<PageSection['meta']>['emptyState']> {
    return {
        message: m.section_all_caught_up(),
        linkHref: '/browse',
        linkLabel: m.nav_browse(),
    };
}

export interface WatchingAnchor {
    item: ContinueWatchingItem;
    origin: 'cw' | 'nextup';
    activityAt: number;
}

/**
 * One card per series: dedup CW, index NU, arbitrate the winner via
 * resolveSeriesAnchor, sort freshest-first. Shared by the web home
 * (buildMergedWatchingSection) and the /feed watching section so the two
 * surfaces can never drift on which episode a series shows.
 */
export function arbitrateWatching(data: {
    continueWatching: ContinueWatchingItem[];
    nextUp: ContinueWatchingItem[];
}): WatchingAnchor[] {
    const { continueWatching, nextUp } = data;
    const anchorConfig = {
        substantialPercent: (config.CONTINUE_WATCHING_SUBSTANTIAL_PERCENT ?? 20) / 100,
        phantomStalenessDays: config.CONTINUE_WATCHING_PHANTOM_STALENESS_DAYS ?? 3,
    };

    // Step 1: dedup CW per series — keep the most recently updated row.
    const cwBySeries = new Map<string, ContinueWatchingItem>();
    for (const item of continueWatching) {
        const key = seriesDedupKey(item);
        const existing = cwBySeries.get(key);
        if (!existing || parseActivityTs(item.updatedAt) > parseActivityTs(existing.updatedAt)) {
            cwBySeries.set(key, item);
        }
    }

    // Step 2: index NU per series (query is already one-per-series).
    const nuBySeries = new Map<string, ContinueWatchingItem>();
    for (const item of nextUp) {
        const key = seriesDedupKey(item);
        if (!nuBySeries.has(key)) {
            nuBySeries.set(key, item);
        }
    }

    // Step 3: compute one anchor card per series, applying the anchor rule
    // via the extracted `resolveSeriesAnchor` primitive.
    const anchors: WatchingAnchor[] = [];

    const allKeys = new Set<string>([...cwBySeries.keys(), ...nuBySeries.keys()]);

    for (const key of allKeys) {
        const cw = cwBySeries.get(key);
        const nu = nuBySeries.get(key);

        const cwAt = parseActivityTs(cw?.updatedAt);
        const nuAt = parseActivityTs(nu?.updatedAt);
        const activityAt = Math.max(cwAt, nuAt);

        const { winner } = resolveSeriesAnchor({
            cw,
            nu,
            config: anchorConfig,
        });
        if (winner === 'cw' && cw) {
            anchors.push({ item: cw, origin: 'cw', activityAt });
        } else if (winner === 'nu' && nu) {
            anchors.push({ item: nu, origin: 'nextup', activityAt });
        }
    }

    // Step 4: sort by most recent activity (freshest first). Secondary key
    // on id keeps ordering deterministic across reloads when timestamps tie
    // (e.g. both items missing updatedAt) — cards would otherwise reshuffle.
    anchors.sort((a, b) => b.activityAt - a.activityAt || a.item.id.localeCompare(b.item.id));
    return anchors;
}

export function buildMergedWatchingSection(
    data: WatchingData,
    loading = false,
): PageSection | null {
    const { continueWatching, nextUp } = data;

    if (continueWatching.length === 0 && nextUp.length === 0 && !loading) {
        // Render the row with an empty-state CTA instead of hiding it —
        // the CW slot is the primary row on /, leaving a silent gap breaks
        // the visual rhythm and removes a useful pointer to browse.
        return {
            id: 'continue-watching',
            type: 'continue-watching',
            title: m.section_continue_watching(),
            items: [],
            meta: {
                icon: 'play-circle',
                iconColor: 'text-green-400',
                accentColor: 'green',
                emptyState: buildCwEmptyState(),
            },
        };
    }

    // Steps 1–4 (dedup CW/NU per series, arbitrate the winner, sort
    // freshest-first) are delegated to the shared `arbitrateWatching` helper
    // so web and the /feed watching section can never drift on which episode
    // a series shows (B1).
    const mergedItems = renderable(
        arbitrateWatching({ continueWatching, nextUp }).map((a) =>
            a.origin === 'cw' ? transformContinueWatching(a.item) : transformNextUp(a.item),
        ),
    );

    if (mergedItems.length === 0 && !loading) {
        // All phantom CW rows were arbitrated away and NU produced nothing —
        // same user-facing outcome as "no rows at all", so surface the same
        // empty state instead of vanishing the section.
        return {
            id: 'continue-watching',
            type: 'continue-watching',
            title: m.section_continue_watching(),
            items: [],
            meta: {
                icon: 'play-circle',
                iconColor: 'text-green-400',
                accentColor: 'green',
                emptyState: buildCwEmptyState(),
            },
        };
    }

    return {
        id: 'continue-watching',
        type: 'continue-watching',
        title: m.section_continue_watching(),
        items: mergedItems,
        meta: {
            icon: 'play-circle',
            iconColor: 'text-green-400',
            loading,
            accentColor: 'green',
        },
    };
}

export function buildWatchingSections(data: WatchingData): PageSection[] {
    const sections: PageSection[] = [];

    // Use merged section instead of separate sections
    const mergedSection = buildMergedWatchingSection(data);
    if (mergedSection) sections.push(mergedSection);

    return sections;
}

// ============================================================================
// Featured Pick Section Builder
// ============================================================================

export interface FeaturedPickItem {
    mediaId: string;
    externalIds: ExternalIds;
    mediaType: 'movie' | 'tv';
    title: string;
    overview?: string;
    rating?: number;
    popularity?: number;
    releaseDate?: Date;
    releaseYear?: number;
    runtimeMinutes?: number;
    genres?: string[];
    backdropUrl?: string;
    logoUrl?: string;
    trailerUrl?: string;
    isAvailable: boolean;
    canRequest: boolean;
    similarityScore?: number;
    // Additional ratings
    rtCritic?: number;
    rtAudience?: number;
    mdblistScore?: number;
}

/**
 * Get the localized reason text for a featured pick criteria.
 */
function getFeaturedReason(criteria: FeaturedPickCriteria): string {
    switch (criteria) {
        case 'hidden-gem':
            return m.featured_hidden_gem();
        case 'fresh-for-you':
            return m.featured_fresh_for_you();
        case 'perfect-match':
            return m.featured_perfect_match();
        case 'overlooked-classic':
            return m.featured_overlooked_classic();
        case 'buzzing-now':
            return m.featured_buzzing_now();
        default:
            return m.featured_pick();
    }
}

/**
 * Transform a FeaturedPickItem to UniversalMediaItem.
 */
export function transformFeaturedPick(item: FeaturedPickItem): UniversalMediaItem {
    const uniqueId = mediaCompositeKey(item.externalIds, item.mediaType, 'fp');

    return {
        id: uniqueId,
        externalIds: item.externalIds,
        mediaType: MOVIE_OR_TV_TO_CARD[item.mediaType],
        title: item.title,
        image: getExternalIdFor(item.externalIds, 'internal')
            ? getCatalogPosterUrl(getExternalIdFor(item.externalIds, 'internal')!, {
                  size: 'thumb',
              })
            : FALLBACK_IMAGE,
        backdrop: getExternalIdFor(item.externalIds, 'internal')
            ? getCatalogBackdropUrl(getExternalIdFor(item.externalIds, 'internal')!, {
                  size: 'full',
              })
            : undefined,
        logo: getExternalIdFor(item.externalIds, 'internal')
            ? getCatalogImageUrl(getExternalIdFor(item.externalIds, 'internal')!, 'logo', {
                  fallback: 'none',
              })
            : undefined,
        overview: item.overview,
        rating: item.rating,
        durationMs:
            item.runtimeMinutes == null ? undefined : Math.round(item.runtimeMinutes * 60_000),
        releaseDate: item.releaseDate
            ? new Date(item.releaseDate).toISOString().split('T')[0]
            : undefined,
        year: item.releaseYear,
        genres: item.genres
            ? getGenreNames(
                  item.genres.map((g) => (typeof g === 'number' ? g : parseInt(String(g), 10))),
              )
            : undefined,
        isAvailable: item.isAvailable,
        hasFiles: item.isAvailable,
        canRequest: item.canRequest,
        trailerUrl: item.trailerUrl,
        similarityScore: item.similarityScore,
        criticRating: item.rtCritic,
        audienceRating: item.rtAudience,
        mdblistScore: item.mdblistScore,
    };
}

/**
 * Build a featured-pick section from a candidate and criteria.
 */
export function buildFeaturedPickSection(
    candidate: FeaturedPickItem,
    criteria: FeaturedPickCriteria,
): PageSection {
    const item = transformFeaturedPick(candidate);
    const featuredReason = getFeaturedReason(criteria);

    return {
        id: 'featured-pick',
        type: 'featured-pick',
        title: featuredReason,
        items: [item],
        meta: {
            featuredCriteria: criteria,
            featuredReason,
            accentColor: 'primary',
        },
    };
}
