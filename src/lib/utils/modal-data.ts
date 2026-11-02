// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Modal Data Utilities
 *
 * Provides data fetching and enrichment functions for ModalMovie.
 * Implements a "self-healing" pattern where modals automatically
 * fetch missing details if not provided initially.
 *
 * Key Features:
 * - Strict type safety (no `any` types in public APIs)
 * - Graceful error handling (never throws, returns safe defaults)
 * - Prevents infinite loops on API failures
 */

// ============================================================================
// Types
// ============================================================================

// Import shared API types for compile-time safety
import { pickVariant } from '$lib/utils/image-utils';
import type { SocialActivityItem } from '$lib/schemas/api-media-responses';
import {
    AudiobookChapterSchema,
    AudiobookPersonRefSchema,
    AudiobookSeriesRefSchema,
    type AudiobookPersonRef,
    type AudiobookSeriesRef,
} from '$lib/schemas/api-audiobook';
import { PlaybackProgressSchema, type PlaybackProgress } from '$lib/schemas/api-playback-progress';
import { ImageSetSchema, type ImageSet } from '$lib/schemas/api-image-descriptor';
import type { AudiobookChapter, MediaQualitySummary } from '$lib/schemas/media-detail';
import type { ApiMediaType, ExternalIds } from '$lib/types/api-common';
import type { SimilarMediaItem } from '$lib/types/api-media';
import type { ContextSimilarItem } from '$lib/schemas/api-media-context-response';
import type { SeasonsCollectionResponse } from '$lib/schemas/api-series-responses';
import {
    buildMediaApiUrl,
    buildMediaKey,
    hasValidExternalId,
    getExternalIdFor,
} from '$lib/utils/media-id-helpers';
import { isAudiobook, isMovie, isSeries, isEpisode } from '$lib/shared/media-types';
import { toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';
import { isRecord } from '$lib/utils/data-extraction';
import * as userApi from '$lib/api/user';
import * as contentApi from '$lib/api/content';
import { unwrapApiResult } from '$lib/api/unwrap';

/**
 * Type alias for backwards compatibility.
 *
 * Imports from api-media-responses.ts Zod schema (single source of truth per DL-007).
 */

/** Minutes from a media node's `durationMs` (the API's one duration source). */
function nodeDurationMinutes(node: object): number | undefined {
    const value = (node as { durationMs?: unknown }).durationMs;
    return typeof value === 'number' && value > 0 ? Math.round(value / 60000) : undefined;
}

export type SocialActivity = SocialActivityItem;

/**
 * The audiobook-shaped block of a media detail response, as the modal needs it.
 *
 * Kept as ONE nested field on {@link ModalMediaData} rather than eight flat ones
 * so the merge/enrichment plumbing carries a single value, and so the modal can
 * ask "is this an audiobook with data?" by presence instead of by re-deriving it
 * from `mediaType` (which arrives UPPER-CASED through `openMediaModal`).
 */
export interface AudiobookModalFields {
    authors: AudiobookPersonRef[];
    narrators: AudiobookPersonRef[];
    series?: AudiobookSeriesRef | null;
    publisher?: string;
    durationMs?: number;
    images?: ImageSet;
    abridged?: boolean;
    chapterCount: number;
    chapters: AudiobookChapter[];
    progress?: PlaybackProgress;
}

/** Read only catalog fields; malformed entries are omitted from fail-open responses. */
export function extractAudiobookFields(node: unknown): AudiobookModalFields | undefined {
    if (!isRecord(node) || !isAudiobook(typeof node.type === 'string' ? node.type : undefined))
        return undefined;
    const people = (value: unknown): AudiobookPersonRef[] =>
        Array.isArray(value)
            ? value.flatMap((entry) => {
                  const parsed = AudiobookPersonRefSchema.safeParse(entry);
                  return parsed.success ? [parsed.data] : [];
              })
            : [];
    const chapters = Array.isArray(node.chapters)
        ? node.chapters.flatMap((entry) => {
              const parsed = AudiobookChapterSchema.safeParse(entry);
              return parsed.success ? [parsed.data] : [];
          })
        : [];
    const images = ImageSetSchema.safeParse(node.images);
    const series = AudiobookSeriesRefSchema.safeParse(node.series);
    const progress = PlaybackProgressSchema.safeParse(node.progress);
    return {
        images: images.success ? images.data : undefined,
        authors: people(node.authors),
        narrators: people(node.narrators),
        series: series.success ? series.data : undefined,
        publisher: typeof node.publisher === 'string' ? node.publisher : undefined,
        durationMs:
            typeof node.durationMs === 'number' && Number.isFinite(node.durationMs)
                ? node.durationMs
                : undefined,
        abridged: typeof node.abridged === 'boolean' ? node.abridged : undefined,
        chapterCount: typeof node.chapterCount === 'number' ? node.chapterCount : chapters.length,
        chapters,
        progress: progress.success ? progress.data : undefined,
    };
}

export interface ModalMediaData {
    seasonCount?: number;
    episodeCount?: number;
    availableEpisodeCount?: number;
    watchedEpisodeCount?: number;
    unwatchedEpisodeCount?: number;

    // Core identifiers - provider-agnostic
    /** External IDs from various providers */
    externalIds?: ExternalIds;
    /** Internal UUID from database */
    id?: string;
    /** Internal UUID of the parent series. */
    seriesInternalId?: string;
    sonarrSeriesId?: string;

    // Media info
    mediaType?: string;
    title?: string;
    originalTitle?: string;
    englishTitle?: string;
    tagline?: string;
    certification?: string;
    libraryNames?: string[];
    overview?: string;
    rating?: number;
    year?: string;
    duration?: number;
    genres?: string[];
    genreIds?: number[];
    seriesName?: string;
    seriesChildCount?: number;
    seasonNumber?: number;
    episodeNumber?: number;
    episodeNumberEnd?: number;
    studio?: string;
    author?: string;

    // Ratings
    criticRating?: number;
    rtCritic?: number;
    rtAudience?: number;
    letterboxdRating?: number;
    letterboxdVotes?: number;
    mdblistScore?: number;
    metacriticScore?: number;
    traktScore?: number;

    // People (actors can be strings or objects with name/character)
    actors?: Array<
        string | { name: string; character?: string; personId?: string | null; profileUrl?: string }
    >;
    directors?: string[];

    // Availability
    isAvailable?: boolean;
    availabilitySource?: string;
    canRequest?: boolean;
    sonarrHasFile?: boolean;

    // Sonarr-specific (non-language fields kept for debug panel)
    sonarrAbsoluteEpisode?: number;
    sonarrNetwork?: string;
    sonarrQuality?: string;
    sonarrAirDate?: string;

    // File-based language data (from media_streams + external_subtitle_files)
    originalLanguage?: string;
    audioLanguages?: string[];
    subtitleLanguages?: string[];

    // Trailer
    remoteTrailers?: string;
    /** A playable local trailer file exists for this item (Task 5). */
    hasLocalTrailer?: boolean;
    /** File-backed extras (trailers, behind-the-scenes, featurettes, …) belonging to this item. */
    extras?: Array<{ id: string; title: string; extraType: string; durationMs?: number }>;
    /** Best-available version quality summary (4K / HDR / Dolby Vision / Atmos badges). */
    quality?: MediaQualitySummary;

    /** Author/narrator/chapter block — present only for audiobook items. */
    audiobook?: AudiobookModalFields;

    // Initial episode context (for navigating from episode to series)
    initialSeason?: number;
    initialEpisode?: number;
}

/**
 * Similar movie/show item.
 * Type alias for SimilarMediaItem from shared types.
 */
export type SimilarMovie = SimilarMediaItem;

export interface Season {
    seasonNumber: number;
    name: string;
    id: string;
    episodeCount: number;
    watchedCount: number;
    premiereDate?: string | null;
    overview?: string | null;
    imageTag?: string | null;
    href?: string;
    episodesHref?: string;
}

export interface Episode {
    id: string;
    name: string;
    seasonNumber: number;
    episodeNumber: number;
    overview?: string;
    runtime?: number;
    premiereDate?: string;
    played?: boolean;
    imageTag?: string;
}

export interface EnrichedModalData extends Partial<ModalMediaData> {
    _enriched?: boolean;
    _enrichedAt?: number;
}

// ============================================================================
// Data Enrichment
// ============================================================================

/**
 * Check if modal data is missing key fields that should be fetched
 */
export function needsEnrichment(data: Partial<ModalMediaData> | null | undefined): boolean {
    if (!data) return false;

    // Require valid external ID (provider-agnostic) to enable enrichment
    if (!hasValidExternalId(data.externalIds)) return false;

    // Check for missing key fields
    const hasCriticalData = data.overview || data.rating || data.actors?.length;

    // Even if we have basic data, check if we're missing MDBList ratings
    // (search results don't include these, so we need to enrich)
    const hasRatingsData =
        data.rtCritic !== undefined ||
        data.rtAudience !== undefined ||
        data.mdblistScore !== undefined ||
        data.letterboxdRating !== undefined ||
        data.metacriticScore !== undefined;

    // Local-trailer availability only travels on detail payloads (list
    // payloads deliberately omit it), so an undefined value means "unknown —
    // fetch it" rather than "no trailer". Without this, card/search-opened
    // modals (which supply overview+ratings) never learn about local trailers
    // and the trailer pill stays hidden.
    const hasTrailerData = data.hasLocalTrailer !== undefined;

    // Need enrichment if missing critical data OR ratings OR trailer knowledge
    return !hasCriticalData || !hasRatingsData || !hasTrailerData;
}

/**
 * Enrich modal data by fetching missing details from the API
 * Returns the merged data object with fetched details filled in
 */
export async function enrichMediaData(
    initialData: Partial<ModalMediaData>,
): Promise<EnrichedModalData> {
    // Require externalIds for provider-agnostic enrichment
    const externalIds = initialData.externalIds;
    if (!externalIds || !Object.keys(externalIds).length) {
        return { ...initialData, _enriched: false };
    }

    const mediaType = initialData.mediaType;
    // TMDB namespace for this row, or null when TMDB has no such entity —
    // audiobooks, tracks, albums, artists, channels. `toTmdbType` used to answer
    // 'movie' for all of them, which is how an audiobook modal ended up querying
    // TMDB for a movie with the book's id.
    const tmdbType = toTmdbType(mediaType);
    // The composite key only needs a type when there is no internal UUID to key
    // on — buildMediaKey prefers externalIds.internal. When TMDB has no
    // namespace, carry the row's OWN type rather than relabelling it: media-key-parser
    // resolves `tmdb:123:audiobook`, whereas `tmdb:123:movie` resolves to a
    // different entity entirely.
    const keyMediaType = tmdbType ?? mediaType ?? 'movie';

    try {
        // Try provider-agnostic API first (has additional ratings data from aggregated metadata)
        const mediaKey = buildMediaKey(externalIds, keyMediaType);
        if (!mediaKey) {
            return { ...initialData, _enriched: false };
        }
        // Rich details and credits are included by default.
        const { data: responseData, error: apiError } = await contentApi.getMediaDetails(mediaKey);
        if (!apiError && responseData) {
            // Response from /api/media/[id] is a MediaNode; rich fields are
            // NESTED under `.details` (see nodeRich below).
            const details = responseData;
            if (details && details.id) {
                // Rich nested detail block — only movie/series nodes carry it.
                // Cast, runtime, rating, ratings, genres, and directors ALL live
                // HERE (MediaNodeDetailsSchema), NOT at the node top level.
                // Reading them off `details` directly is always undefined — the
                // bug that made the modal never self-heal cast/runtime.
                const nodeRich = 'details' in details ? details.details : undefined;
                const credits = 'credits' in details ? details.credits : undefined;
                // Extended ratings map from the nested block.
                const ratings = nodeRich?.ratings;
                // `type` is the new canonical discriminator (replaces old `mediaType`).
                // The node's one duration (ms); shown in minutes for movies.
                const runtime = isMovie(details.type) ? nodeDurationMinutes(details) : undefined;
                // Audiobook identity (author/narrator/chapters) rides the node's
                // TOP level, not `.details` — see MediaNodeAudiobookSchema.
                const audiobook = extractAudiobookFields(details);
                // Year IS node-level (MediaNodeBase), so it stays on `details`.
                // Books publish in a year too, and it is the only date they have.
                const year =
                    isMovie(details.type) || audiobook
                        ? (details as { year?: number }).year
                        : undefined;
                // `ids` is the new open external-ID map (replaces old `externalIds`)
                const detailIds = details.ids as ExternalIds;

                // Preserve supplied metadata, but use the detail overview: list
                // cards may supply only a 150-character preview ending in "...".
                return {
                    ...initialData,
                    // Title from API (used to fix season-name titles in Continue Watching)
                    title: details.title,
                    tagline: details.tagline,
                    certification: nodeRich?.certification ?? initialData.certification,
                    libraryNames: details.libraryNames,
                    // Update externalIds with fetched ids map
                    externalIds: {
                        ...initialData.externalIds,
                        ...detailIds,
                    },
                    overview: details.overview || initialData.overview || '',
                    rating: initialData.rating || nodeRich?.rating || 0,
                    year: initialData.year || (year ? String(year) : ''),
                    duration:
                        initialData.duration ||
                        (runtime ? runtime * 60 : undefined) ||
                        (audiobook?.durationMs !== undefined
                            ? audiobook.durationMs / 1000
                            : undefined),
                    audiobook,
                    seasonCount:
                        ('seasonCount' in details ? details.seasonCount : undefined) ??
                        nodeRich?.seasonCount,
                    episodeCount:
                        ('episodeCount' in details ? details.episodeCount : undefined) ??
                        nodeRich?.episodeCount,
                    availableEpisodeCount:
                        ('availableEpisodeCount' in details
                            ? details.availableEpisodeCount
                            : undefined) ?? nodeRich?.availableEpisodeCount,
                    watchedEpisodeCount:
                        ('watchedEpisodeCount' in details
                            ? details.watchedEpisodeCount
                            : undefined) ?? nodeRich?.watchedEpisodeCount,
                    unwatchedEpisodeCount:
                        ('unwatchedEpisodeCount' in details
                            ? details.unwatchedEpisodeCount
                            : undefined) ?? nodeRich?.unwatchedEpisodeCount,

                    // Always prefer fetched genre names (strings) over IDs (numbers)
                    genres: nodeRich?.genres?.length ? nodeRich.genres : initialData.genres || [],
                    // `?.length` (not truthiness): a caller-supplied EMPTY array is
                    // truthy, so `initialData.actors || …` would block the self-heal.
                    actors: initialData.actors?.length
                        ? initialData.actors
                        : credits?.cast.map(({ person, character }) => ({
                              name: person.name,
                              character,
                              personId: person.id,
                              profileUrl: person.images?.primary?.href,
                          })),
                    directors: initialData.directors?.length
                        ? initialData.directors
                        : credits?.crew
                              .filter((credit) => credit.job === 'Director')
                              .map((credit) => credit.person.name),
                    canRequest: details.canRequest ?? initialData.canRequest,
                    isAvailable: details.isAvailable ?? initialData.isAvailable,
                    id: initialData.id || getExternalIdFor(detailIds, 'internal') || undefined,
                    // Extended ratings from nested ratings map
                    rtCritic: initialData.rtCritic ?? ratings?.rtCritic,
                    rtAudience: initialData.rtAudience ?? ratings?.rtAudience,
                    letterboxdRating: initialData.letterboxdRating ?? ratings?.letterboxd,
                    letterboxdVotes: initialData.letterboxdVotes,
                    mdblistScore: initialData.mdblistScore ?? ratings?.mdblist,
                    metacriticScore: initialData.metacriticScore ?? ratings?.metacritic,
                    traktScore: initialData.traktScore ?? ratings?.trakt,
                    _enriched: true,
                    _enrichedAt: Date.now(),
                    originalLanguage: nodeRich?.originalLanguage,
                    audioLanguages: nodeRich?.audioLanguages,
                    subtitleLanguages: nodeRich?.subtitleLanguages,
                    // Local-trailer availability + YouTube trailer URL.
                    // GET /api/media/{id} returns the NODE shape: the rich
                    // fields live NESTED under `.details` (MediaNodeDetails,
                    // present with ?include=details on movie/series nodes) —
                    // reading them at the top level is always undefined.
                    hasLocalTrailer: nodeRich?.hasLocalTrailer,
                    remoteTrailers: nodeRich?.trailerUrl ?? initialData.remoteTrailers,
                    extras: nodeRich?.extras,
                    quality: nodeRich?.quality,
                };
            }
        }

        // Fall back to legacy TMDB details endpoint for additional data (trailers,
        // etc.) — but only for rows TMDB actually catalogs. An audiobook or track
        // has nothing to fetch there, and asking with a clamped 'movie' returned
        // another title's trailers.
        const tmdbDetails = tmdbType ? await fetchTmdbDetails(externalIds, tmdbType) : null;
        if (tmdbDetails) {
            return {
                ...initialData,
                externalIds: {
                    ...initialData.externalIds,
                    ...tmdbDetails.externalIds,
                },
                overview: tmdbDetails.overview || initialData.overview || '',
                tagline: tmdbDetails.tagline,
                certification: tmdbDetails.certification ?? initialData.certification,
                rating: initialData.rating || tmdbDetails.rating || 0,
                year: initialData.year || tmdbDetails.year || '',
                duration: initialData.duration || tmdbDetails.duration,
                // Always prefer fetched genre names (strings) over IDs (numbers)
                genres: tmdbDetails.genres?.length ? tmdbDetails.genres : initialData.genres || [],
                actors: initialData.actors || tmdbDetails.actors,
                remoteTrailers: initialData.remoteTrailers || tmdbDetails.remoteTrailers,
                canRequest: tmdbDetails.canRequest ?? initialData.canRequest,
                isAvailable: tmdbDetails.isAvailable ?? initialData.isAvailable,
                id: initialData.id || tmdbDetails.id,
                _enriched: true,
                _enrichedAt: Date.now(),
            };
        }

        return { ...initialData, _enriched: false };
    } catch (error) {
        console.error('[modal-data] Failed to enrich modal data:', error);
        return { ...initialData, _enriched: false };
    }
}

// ============================================================================
// Similar Content
// ============================================================================

/**
 * Response type for provider-agnostic similar endpoint
 * Note: API returns data directly without success wrapper
 */

/**
 * Small client-side cache for similar-content results. Reopening the same
 * title's modal within the TTL skips the network round-trip entirely — the
 * per-modal composable state dies with the modal instance, so without this
 * every reopen re-hit the API even when the server cache was warm.
 *
 * No mutation hooks on purpose: similar cards render title/poster/community
 * scores (not the viewer's own rating or live watch state), so the only cost
 * of staleness is a ≤5-min-old ranking — not worth coupling this module to
 * the rating/watch stores. Empty results are never cached (see below).
 */
const SIMILAR_CLIENT_CACHE_TTL = 5 * 60 * 1000;
const SIMILAR_CLIENT_CACHE_MAX = 50;
const similarClientCache = new Map<string, { fetchedAt: number; items: ContextSimilarItem[] }>();

function similarCachePut(key: string, items: ContextSimilarItem[]): void {
    // Map preserves insertion order — evict the oldest entry when full.
    if (similarClientCache.size >= SIMILAR_CLIENT_CACHE_MAX) {
        const oldest = similarClientCache.keys().next().value;
        if (oldest !== undefined) similarClientCache.delete(oldest);
    }
    similarClientCache.set(key, { fetchedAt: Date.now(), items });
}

/**
 * Fetch similar movies/shows using provider-agnostic endpoint
 * @returns Array of similar movies, empty array on error (never throws)
 */
export async function fetchSimilarContent(
    externalIds: ExternalIds,
    mediaType: 'movie' | 'tv' = 'movie',
    limit: number = 10,
): Promise<ContextSimilarItem[]> {
    // Build provider-agnostic key
    const mediaKey = buildMediaKey(externalIds, mediaType);
    if (!mediaKey) {
        console.warn('[modal-data] No valid external ID for similar content');
        return [];
    }

    const cacheKey = `${mediaKey}:${limit}`;
    const cachedEntry = similarClientCache.get(cacheKey);
    if (cachedEntry && Date.now() - cachedEntry.fetchedAt < SIMILAR_CLIENT_CACHE_TTL) {
        return cachedEntry.items;
    }

    try {
        const { data, error } = await contentApi.getSimilarMedia(mediaKey, limit);
        if (error) {
            // 400/404 are expected when series doesn't have embeddings yet
            return [];
        }

        const similarData = data;
        // API returns data directly without success wrapper
        if (similarData?.items && Array.isArray(similarData.items)) {
            // Don't cache empty results: the server intentionally keeps
            // not-yet-embedded items on a short (60 s) negative TTL so
            // similar content surfaces promptly once embeddings land —
            // pinning [] client-side for 5 minutes would defeat that.
            const items: ContextSimilarItem[] = similarData.items
                .filter((item) => item.type === 'movie' || item.type === 'series')
                .map((item) => ({
                    id: item.id,
                    type: item.type as 'movie' | 'series',
                    ids: { ...item.ids, ...(item.catalogId ? { internal: item.catalogId } : {}) },
                    title: item.title,
                    overview: item.overview,
                    year: item.year,
                    images: {
                        poster: item.images.poster
                            ? {
                                  href: item.images.poster.href,
                                  thumb: pickVariant(item.images.poster, 'thumb'),
                              }
                            : undefined,
                        backdrop: item.images.backdrop
                            ? { href: item.images.backdrop.href }
                            : undefined,
                    },
                    similarity: item.score,
                    isAvailable: item.availability?.isAvailable,
                    canRequest: item.availability?.canRequest,
                }));
            if (items.length > 0) {
                similarCachePut(cacheKey, items);
            }
            return items;
        }
        return [];
    } catch (error) {
        // Graceful failure - log but don't throw
        console.warn(
            '[modal-data] Failed to fetch similar content:',
            error instanceof Error ? error.message : 'Unknown error',
        );
        return [];
    }
}

// ============================================================================
// Social Activity
// ============================================================================

/**
 * Fetch social watch activity (other instance users who watched/rated this)
 * @returns Array of social activities, empty array on error (never throws)
 */
export async function fetchSocialActivity(
    externalIds: ExternalIds,
    mediaType: 'movie' | 'tv' = 'movie',
): Promise<SocialActivity[]> {
    // Build provider-agnostic URL for social activity
    // Cast: 'tv' is the established legacy convention this call site has always
    // passed (see media-type case-consistency notes) — buildMediaApiUrl's
    // ApiMediaType param type is stricter than the values this module's callers
    // actually use; widening it lives outside this file's scope.
    const apiUrl = buildMediaApiUrl(
        '/api/social/watch-activity',
        externalIds,
        mediaType as ApiMediaType,
    );
    if (!apiUrl) return [];

    try {
        const response = await fetch(apiUrl);
        if (!response.ok) {
            // Social activity is optional - don't log errors for 404s
            if (response.status !== 404) {
                console.warn(`[modal-data] Social activity fetch returned ${response.status}`);
            }
            return [];
        }

        // API returns data directly without success wrapper: { activities: [...] }
        const data = (await response.json()) as {
            activities: SocialActivity[];
        };
        if (data?.activities && Array.isArray(data.activities)) {
            return data.activities;
        }
        return [];
    } catch (error) {
        // Graceful failure - social activity is non-critical
        console.warn(
            '[modal-data] Failed to fetch social activity:',
            error instanceof Error ? error.message : 'Unknown error',
        );
        return [];
    }
}

/**
 * The audiobook counterpart of {@link fetchSocialActivity}.
 *
 * Audiobooks come from AudiobookShelf and carry no TMDB namespace, so the
 * TMDB-keyed endpoint above has nothing to look up for them. This one is keyed
 * by internal UUID and returns the SAME item shape, including the comparative
 * phrasing the listening projection builds ("3 chapters ahead of you").
 *
 * Same contract as its sibling: never throws, empty array on any failure —
 * social activity is optional and must not take the modal down with it.
 */
export async function fetchAudiobookSocialActivity(
    externalIds: ExternalIds,
): Promise<SocialActivity[]> {
    const mediaId = getExternalIdFor(externalIds, 'internal');
    if (!mediaId) return [];

    try {
        const { getSocialWatchActivity } = await import('$lib/api/integrations');
        const { data, error } = await getSocialWatchActivity(mediaId);
        if (error || !data) return [];
        return data.activities ?? [];
    } catch (error) {
        console.warn(
            '[modal-data] Failed to fetch audiobook social activity:',
            error instanceof Error ? error.message : 'Unknown error',
        );
        return [];
    }
}

// ============================================================================
// User Rating
// ============================================================================

/**
 * Fetch the user's own rating for this content
 * @returns User's rating (1-10) or null if not rated (never throws)
 */
export async function fetchUserRating(
    externalIds: ExternalIds,
    mediaType: 'movie' | 'tv' = 'movie',
): Promise<number | null> {
    // Build provider-agnostic URL
    // Cast: see the equivalent note in fetchSocialActivity above.
    const apiUrl = buildMediaApiUrl('/api/media', externalIds, mediaType as ApiMediaType);
    if (!apiUrl) {
        return null;
    }

    try {
        const response = await fetch(`${apiUrl}/rating`);
        if (!response.ok) {
            // Rating not found is normal - user may not have rated this
            return null;
        }

        // API returns data directly without success wrapper: { rating: number | null, canRate?: boolean }
        const data = (await response.json()) as {
            rating: number | null;
            canRate?: boolean;
        };
        if (data?.rating !== undefined && data.rating !== null) {
            // Validate rating is in expected range
            const rating = data.rating;
            if (typeof rating === 'number' && rating >= 1 && rating <= 10) {
                return rating;
            }
        }
        return null;
    } catch (error) {
        // Graceful failure - rating is non-critical
        console.warn(
            '[modal-data] Failed to fetch user rating:',
            error instanceof Error ? error.message : 'Unknown error',
        );
        return null;
    }
}

// ============================================================================
// Watched Status
// ============================================================================

/**
 * Fetch watched status from Jellyfin
 * @returns true if watched, false otherwise (never throws)
 */
export async function fetchWatchedStatus(itemId: string): Promise<boolean> {
    if (!itemId || itemId.trim() === '') return false;

    return unwrapApiResult(userApi.getWatchedStatus(itemId), {
        defaultValue: false,
        onError: (error) => console.warn('[modal-data] Failed to fetch watched status:', error),
        transform: (data) => data.watched === true,
    });
}

/**
 * Toggle watched status
 */
export async function toggleWatchedStatus(
    itemId: string,
    currentlyWatched: boolean,
    metadata?: { externalIds?: ExternalIds; mediaType?: string; title?: string },
): Promise<boolean> {
    if (!itemId) return currentlyWatched;

    try {
        // buildMediaKey takes `ApiMediaType | string` — it puts the token straight
        // into the composite key, which the server parses across all five tokens.
        // Narrowing it here only mislabelled the episodes this is called with.
        const mediaKey = metadata?.externalIds
            ? buildMediaKey(metadata.externalIds, metadata.mediaType || 'movie')
            : null;

        if (currentlyWatched) {
            // Unmark watched — itemId can be Jellyfin ID or internal UUID (withIdResolution handles both)
            const { error } = await userApi.unmarkWatched(itemId);
            return error ? currentlyWatched : !currentlyWatched;
        } else {
            // Mark watched with metadata params
            const params: Record<string, string | number | boolean | undefined> = {};
            if (mediaKey) params.key = mediaKey;
            const { error } = await userApi.markWatched(itemId, params);
            return error ? currentlyWatched : !currentlyWatched;
        }
    } catch (error) {
        console.error('[modal-data] Failed to toggle watched status:', error);
        return currentlyWatched;
    }
}

// ============================================================================
// Seasons & Episodes
// ============================================================================

interface LocalSeasonsResponse {
    seasons: Season[];
    source: 'jellyfin' | 'tmdb' | 'database';
}

/**
 * Fetch seasons for a series
 */
export async function fetchSeasons(
    seriesId: string | undefined,
    externalIds: ExternalIds | undefined,
    mediaType: string,
): Promise<LocalSeasonsResponse> {
    if (!seriesId && !hasValidExternalId(externalIds)) {
        return { seasons: [], source: 'jellyfin' };
    }

    const normalizedMediaType = ['tv', 'episode'].includes(mediaType) ? 'tv' : 'movie';

    try {
        let seasonsKey: string | null = null;

        if (seriesId && seriesId !== 'tmdb') {
            seasonsKey = seriesId;
        } else if (hasValidExternalId(externalIds)) {
            // Use provider-agnostic seasons endpoint
            seasonsKey = buildMediaKey(externalIds, normalizedMediaType);
        }

        if (!seasonsKey) {
            return { seasons: [], source: 'jellyfin' };
        }

        // Explicit generics: without them, TS infers R solely from `transform`'s
        // return type (source: 'database'), then rejects `defaultValue`'s
        // 'jellyfin' literal against that too-narrow inferred type.
        return unwrapApiResult<SeasonsCollectionResponse, LocalSeasonsResponse>(
            contentApi.getSeriesSeasons(seasonsKey),
            {
                defaultValue: { seasons: [], source: 'jellyfin' as const },
                onError: (error) => console.error('[modal-data] Failed to fetch seasons:', error),
                transform: (data) => ({
                    seasons: data.items.map((s): Season => ({
                        seasonNumber: s.seasonNumber,
                        name: s.title,
                        id: s.id,
                        episodeCount: s.episodeCount,
                        watchedCount: s.watchedCount,
                        premiereDate: s.premiereDate,
                        overview: s.overview,
                        imageTag: pickVariant(s.images.poster, 'thumb'),
                        href: s.href,
                        episodesHref: s.episodes.href,
                    })),
                    source: 'database' as const,
                }),
            },
        );
    } catch (error) {
        console.error('[modal-data] Failed to fetch seasons:', error);
        return { seasons: [], source: 'jellyfin' };
    }
}

/**
 * Fetch episodes for a season
 * @param seriesId - The series ID (Jellyfin or TMDB-prefixed)
 * @param seasonNumber - The season number to fetch episodes for
 * @returns Array of episodes, empty array on error (never throws)
 */
export async function fetchEpisodes(seriesId: string, seasonNumber: number): Promise<Episode[]> {
    if (!seriesId || seriesId === 'tmdb') {
        return [];
    }

    return unwrapApiResult(contentApi.getSeriesEpisodes(seriesId, seasonNumber), {
        defaultValue: [],
        onError: (error) => console.warn('[modal-data] Failed to fetch episodes:', error),
        transform: (data) =>
            data.items.map((ep): Episode => ({
                id: ep.id,
                name: ep.title,
                seasonNumber: ep.context?.seasonNumber ?? 0,
                episodeNumber: ep.context?.episodeNumber ?? 0,
                overview: ep.overview,
                runtime: ep.durationMs == null ? undefined : Math.round(ep.durationMs / 60_000),
                premiereDate: ep.context?.airDate,
                played: ep.progress?.finished ?? false,
                imageTag: pickVariant(ep.images.thumb, 'thumb'),
            })),
    });
}

/**
 * Fetch the next episode to watch for a series
 * Uses NextUp API to get the next unwatched episode,
 * falls back to first episode if series hasn't been started
 * @returns Next episode info or null if not found
 */
export async function fetchNextEpisode(
    seriesId: string,
): Promise<{ id: string; seasonNumber: number; episodeNumber: number } | null> {
    if (!seriesId || seriesId === 'tmdb') {
        return null;
    }

    try {
        // Use the new next-episode API that handles NextUp + fallback
        const { data, error } = await contentApi.getNextEpisode(seriesId);
        if (error || !data || !data.id) return null;

        return {
            id: data.id,
            seasonNumber: data.seasonNumber || 1,
            episodeNumber: data.episodeNumber || 1,
        };
    } catch (error) {
        console.warn(
            '[modal-data] Failed to fetch next episode:',
            error instanceof Error ? error.message : 'Unknown error',
        );
        return null;
    }
}

/**
 * Fetch a specific episode by season and episode number
 * Use this when the UI displays a specific episode (e.g., "Play S1E1")
 * to ensure we play exactly what's shown, not a heuristically determined episode.
 * @returns Episode info or null if not found
 */
export async function fetchExplicitEpisode(
    seriesId: string,
    seasonNumber: number,
    episodeNumber: number,
): Promise<{
    id: string;
    seasonNumber: number;
    episodeNumber: number;
    name?: string;
    /** False when the episode has no file yet; the Watch button is then disabled */
    playable: boolean;
} | null> {
    if (!seriesId || seriesId === 'tmdb') {
        return null;
    }

    try {
        const { data, error } = await contentApi.getNextEpisode(
            seriesId,
            seasonNumber,
            episodeNumber,
        );
        if (error || !data || !data.id) return null;

        return {
            id: data.id,
            seasonNumber: data.seasonNumber || seasonNumber,
            episodeNumber: data.episodeNumber || episodeNumber,
            name: data.title,
            playable: data.playable !== false,
        };
    } catch (error) {
        console.warn(
            '[modal-data] Failed to fetch explicit episode:',
            error instanceof Error ? error.message : 'Unknown error',
        );
        return null;
    }
}

// ============================================================================
// Media Details (provider-agnostic)
// ============================================================================

export interface TmdbDetails {
    tagline?: string;
    certification?: string;
    /** External IDs from various providers */
    externalIds: ExternalIds;
    mediaType: string;
    title: string;
    overview?: string;
    rating?: number;
    year?: string;
    genres?: string[];
    duration?: number;
    id?: string;
    isAvailable: boolean;
    availabilitySource?: string;
    canRequest: boolean;
    actors?: Array<
        string | { name: string; character?: string; personId?: string | null; profileUrl?: string }
    >;
    remoteTrailers?: string;
}

/**
 * Fetch full media details using provider-agnostic endpoint
 * @returns Media details or null on error (never throws)
 */
export async function fetchTmdbDetails(
    externalIds: ExternalIds,
    mediaType: 'movie' | 'tv',
): Promise<TmdbDetails | null> {
    // Build provider-agnostic key
    const mediaKey = buildMediaKey(externalIds, mediaType);
    if (!mediaKey) {
        return null;
    }

    try {
        // Rich metadata is included by default.
        const { data: responseData, error } = await contentApi.getMediaDetails(mediaKey);
        if (error || !responseData) {
            return null;
        }

        const data = responseData;
        if (!data?.id) {
            return null;
        }

        const isTv = isSeries(mediaType);
        // Rich fields (rating/genres/actors/runtime/trailer) are NESTED under
        // `.details` (MediaNodeDetails); reading them off the node is undefined.
        const nodeRich = 'details' in data ? data.details : undefined;
        const credits = 'credits' in data ? data.credits : undefined;
        // `type` is the new canonical discriminator (replaces old `mediaType`)
        const runtime = isMovie(data.type) ? nodeDurationMinutes(data) : undefined;
        const year = isMovie(data.type) ? (data as { year?: number }).year : undefined;

        return {
            // `ids` is the new open external-ID map (replaces old `externalIds`)
            externalIds: data.ids as ExternalIds,
            mediaType: isTv ? 'tv' : 'movie',
            title: data.title,
            overview: data.overview,
            tagline: data.tagline,
            certification: nodeRich?.certification,
            rating: nodeRich?.rating,
            year: year ? String(year) : undefined,
            genres: nodeRich?.genres,
            duration: runtime ? runtime * 60 : undefined,
            id: data.id,
            isAvailable: data.isAvailable,
            availabilitySource: data.isAvailable ? 'lumastra' : undefined,
            canRequest: data.canRequest,
            actors: credits?.cast.map(({ person, character }) => ({
                name: person.name,
                character,
                personId: person.id,
                profileUrl: person.images?.primary?.href,
            })),
            remoteTrailers: nodeRich?.trailerUrl,
        };
    } catch (error) {
        console.warn(
            '[modal-data] Failed to fetch media details:',
            error instanceof Error ? error.message : 'Unknown error',
        );
        return null;
    }
}

// ============================================================================
// Helper: Determine Media Type
// ============================================================================

/**
 * The TMDB namespace a modal's media type maps onto, or `null` when TMDB has no
 * such entity (audiobook, track, album, artist, channel, home video).
 *
 * It used to return `'movie'` for all of those, so the modal for an audiobook
 * fetched movie ratings, movie social activity and "similar movies" keyed by the
 * book's id. Consumers must SKIP those fetches on `null`, not substitute.
 */
export function getApiMediaType(mediaType: string | undefined): 'movie' | 'tv' | null {
    return toTmdbType(mediaType);
}

/** Input type for canPlayDirectly - accepts partial modal data */
interface PlayableMediaValue {
    mediaType?: string;
    isAvailable?: boolean;
    availabilitySource?: string;
    sonarrHasFile?: boolean;
    isEpisode?: boolean;
}

/**
 * Check if media can be played directly (has playable content)
 */
export function canPlayDirectly(value: PlayableMediaValue | null | undefined): boolean {
    if (!value) return false;

    // Playback requires explicit availability; provider hints cannot supply it.
    if (value.isAvailable !== true) return false;

    const mediaType = value.mediaType?.toLowerCase();

    // Series/TV shows cannot be played directly - only their episodes can
    if (isSeries(mediaType) || mediaType === 'sonarr') {
        return false;
    }

    // Movies can play if they are available in Jellyfin
    if (isMovie(mediaType)) {
        return Boolean(value.isAvailable);
    }

    // Episodes can play if they are available or have a file
    if (isEpisode(mediaType) || value.isEpisode) {
        return Boolean(value.isAvailable || value.sonarrHasFile);
    }

    // Items explicitly marked as available (local library files)
    if (
        value.isAvailable &&
        (value.availabilitySource === 'lumastra' || value.availabilitySource === 'jellyfin')
    )
        return true;

    // Sonarr items with file that are available
    if (value.sonarrHasFile && value.isAvailable) return true;

    return false;
}

type TrailerData = {
    trailerUrl?: string;
    remoteTrailers?: string | string[];
};

/**
 * Extract a trailer URL from modal value data.
 * Handles trailerUrl (UniversalMediaItem) and remoteTrailers (Jellyfin API) formats.
 */
export function getTrailerUrl(data: TrailerData | null | undefined): string | null {
    if (!data) return null;
    if (data.trailerUrl && typeof data.trailerUrl === 'string') {
        return data.trailerUrl;
    }
    const trailers = data.remoteTrailers;
    if (!trailers) return null;
    if (Array.isArray(trailers) && trailers.length > 0) {
        return trailers[0];
    }
    if (typeof trailers === 'string' && trailers !== '') {
        return trailers;
    }
    return null;
}
