// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hero Section Builder
 *
 * Utility for building the hero/featured section for the homepage.
 * Fetches from multiple API endpoints and transforms to UniversalMediaItem format.
 */

import type { PageSection, UniversalMediaItem, MediaType } from '$lib/types/server-driven-ui';
import type { ExternalIds } from '$lib/types/api-common';
import type { HeroFirstSlide } from '$lib/schemas/hero';
import { imageFromIds } from '$lib/utils/image-utils';
import { mediaCompositeKey, hasValidExternalId } from '$lib/utils/media-id-helpers';
import { getExternalIdFor } from '$lib/utils/external-ids';
import { isAudiobook, isEpisode, isSeries } from '$lib/shared/media-types';
import { toUniversalMediaType } from '$lib/shared/media-type-domain';
import { isRecord } from '$lib/utils/data-extraction';
import { FALLBACK_IMAGE } from '$lib/constants/images';
import { UUID_RE } from '$lib/utils/id-patterns';
import { dedupeByKey } from '$lib/utils/hero-rotation';
import { getRandomPicks, getTasteRail } from '$lib/api/for-you';
import type { ForYouRecommendationItem } from '$lib/schemas/api-for-you-responses';
import type { MediaPreview } from '$lib/schemas/api-media-preview';
import { mediaPreviewToUniversal } from './media-preview';

// ============================================================================
// Types for API Responses
// ============================================================================

interface NextUpItem {
    id: string;
    title: string;
    overview?: string;
    customMetadata?: Record<string, unknown>;
    mediaType: 'movie' | 'tv' | 'episode' | 'audiobook';
    year?: number;
    seasonNumber?: number;
    episodeNumber?: number;
    SeriesName?: string;
    seriesName?: string;
    seriesId?: string; // For episodes, the series ID for logos
    seriesChildCount?: number;
    duration?: number;
    rating?: number;
    criticRating?: number;
    genres?: string[];
    imageBackdropId?: string;
    remoteTrailers?: string[];
    tmdbBackdropUrl?: string;
    watchProgress?: number; // Watch progress percentage (0-100)
    isPlaying?: boolean; // Live session actively playing this item (from /continue overlay)
    externalIds?: ExternalIds; // TMDB and other external IDs from API
}

interface MovieRecommendation {
    // Optional: the /api/recommendations?type=movies items are keyed by externalIds
    // (internal/tmdb), not a top-level id. Falling back keeps hero ids unique.
    id?: string;
    title: string;
    overview?: string;
    customMetadata?: Record<string, unknown>;
    mediaType: 'movie' | 'tv' | 'episode' | 'audiobook';
    year?: number;
    seasonNumber?: number;
    episodeNumber?: number;
    seriesChildCount?: number;
    duration?: number;
    rating?: number;
    criticRating?: number;
    genres?: string[];
    imageBackdropId?: string;
    remoteTrailers?: string[];
    tmdbBackdropUrl?: string;
    externalIds?: ExternalIds; // TMDB and other external IDs from API
}

interface NextUpResponse {
    items?: NextUpItem[];
    cachedAt?: number;
    cached?: boolean;
}

interface ValidateNextUpResponse {
    isStale?: boolean;
    reason?: string;
}

// ============================================================================
// Transformer Functions
// ============================================================================

/**
 * Drop the hero candidates whose media type has no `UniversalMediaType` member.
 *
 * The hero already tolerates a short list (it rotates through whatever it gets
 * and the `items.length === 0` guards handle empty), so dropping costs at most a
 * slide and never renders one the client cannot open.
 */
function renderableHeroItems(items: (UniversalMediaItem | null)[]): UniversalMediaItem[] {
    return items.filter((item): item is UniversalMediaItem => item !== null);
}

/**
 * Narrow an arbitrary media-type string onto the hero's `UniversalMediaType`
 * vocabulary, or `null` when it has no member.
 *
 * This used to be a `switch` ending in `default: return 'movie'`. Every type the
 * four explicit cases missed — season, track, album, artist, tvchannel, and all
 * four non-entertainment library types — came out as a movie, so the hero
 * rendered a movie treatment ("Watch Movie", backdrop art it has no source for)
 * for something that is not a movie.
 *
 * Callers DROP on null. The hero shows the next candidate instead; an unopenable
 * hero slide is worse than one fewer slide.
 */
function mapMediaType(type: string): MediaType | null {
    return toUniversalMediaType(type);
}

function transformNextUpItem(item: NextUpItem): UniversalMediaItem | null {
    const mediaType = mapMediaType(item.mediaType);
    // `null` = the UniversalMediaType vocabulary has no member for this row (a
    // season, a home video, a storage-only row). Drop it: the hero would
    // otherwise render a movie treatment — "Watch Movie", backdrop art it has no
    // source for — for something that is not a movie. An unopenable hero slide is
    // worse than one fewer slide.
    if (mediaType === null) return null;
    const itemIsEpisode = isEpisode(item.mediaType);
    const itemIsAudiobook = isAudiobook(item.mediaType);
    const itemSeriesName = item.SeriesName || item.seriesName;
    // For image lookups, episodes use 'tv' (images are on the series)
    const imageMediaType: 'movie' | 'tv' =
        itemIsEpisode || isSeries(item.mediaType) ? 'tv' : 'movie';

    // Build externalIds from the API response (includes TMDB); the item id is
    // the internal UUID of the watching row.
    const externalIds: ExternalIds = {
        ...item.externalIds,
        internal: getExternalIdFor(item.externalIds, 'internal') ?? item.id,
    };

    // For episodes:
    // - Poster (image): Use episode ID for episode-specific poster
    // - Backdrop: Use imageBackdropId (which is ParentBackdropItemId for episodes - the series backdrop)
    // - Logo: Use series ID (seriesId) since logos are on series, not episodes
    // For movies/series:
    // - All images use the item's own ID

    return {
        id: `hero-nextup-${item.id}`,
        externalIds,
        mediaType,
        title: itemIsEpisode ? itemSeriesName || item.title : item.title,
        subtitle: itemIsEpisode ? item.title : undefined,
        image:
            imageFromIds(externalIds, 'poster', imageMediaType, {
                size: 'full',
            }) || FALLBACK_IMAGE,
        backdrop: itemIsAudiobook
            ? undefined
            : imageFromIds(externalIds, 'backdrop', imageMediaType, { size: 'full' }) ||
              item.tmdbBackdropUrl ||
              FALLBACK_IMAGE,
        // Audiobooks carry no logo art — asking for one was a 404 on every load.
        logo: itemIsAudiobook
            ? undefined
            : ((itemIsEpisode && item.seriesId
                  ? imageFromIds({ ...externalIds, internal: item.seriesId }, 'logo', 'tv', {
                        size: 'full',
                    })
                  : imageFromIds(externalIds, 'logo', imageMediaType, {
                        size: 'full',
                    })) ?? undefined),
        overview: item.overview,
        customMetadata: item.customMetadata,
        isAvailable: true,
        canRequest: false,
        seasonNumber: item.seasonNumber,
        episodeNumber: item.episodeNumber,
        seriesName: itemSeriesName,
        seasonCount: item.seriesChildCount,
        rating: item.rating,
        criticRating: item.criticRating,
        durationMs: item.duration ? item.duration * 1000 : undefined,
        year: item.year,
        genres: item.genres,
        trailerUrl: item.remoteTrailers?.[0],
        // Progress bar - only show if there's actual progress (partly watched)
        progress: item.watchProgress && item.watchProgress > 0 ? item.watchProgress : undefined,
        // Live "Playing now" flag from the /continue overlay — drives the hero
        // "Playing now" treatment on the client-rebuilt slide.
        isPlaying: item.isPlaying,
        clickData: { originalItem: item },
    };
}

function transformMovieRecommendation(item: MovieRecommendation): UniversalMediaItem | null {
    const mediaType = mapMediaType(item.mediaType);
    // `null` = the UniversalMediaType vocabulary has no member for this row (a
    // season, a home video, a storage-only row). Drop it: the hero would
    // otherwise render a movie treatment — "Watch Movie", backdrop art it has no
    // source for — for something that is not a movie. An unopenable hero slide is
    // worse than one fewer slide.
    if (mediaType === null) return null;
    const imageMediaType: 'movie' | 'tv' = isSeries(item.mediaType) ? 'tv' : 'movie';
    const itemIsAudiobook = isAudiobook(item.mediaType);

    // Build externalIds from the API response (includes TMDB). `item.id` is
    // only used as the internal id when it is one (these items are usually
    // keyed by tmdb/internal and `id` is often absent).
    const externalIds: ExternalIds = {
        ...item.externalIds,
        ...(!getExternalIdFor(item.externalIds, 'internal') && item.id && UUID_RE.test(item.id)
            ? { internal: item.id }
            : {}),
    };

    // Stable, unique hero id — item.id is often absent on this endpoint, which
    // would collapse every card to `hero-movie-undefined` (duplicate keys → the
    // carousel renders nothing). Use the composite key (same as AI suggestions).
    const stableId = item.id ?? mediaCompositeKey(item.externalIds ?? {}, mediaType, item.title);

    return {
        id: `hero-movie-${stableId}`,
        externalIds,
        mediaType,
        title: item.title,
        image:
            imageFromIds(externalIds, 'poster', imageMediaType, {
                size: 'full',
            }) || FALLBACK_IMAGE,
        backdrop: itemIsAudiobook
            ? undefined
            : imageFromIds(externalIds, 'backdrop', imageMediaType, { size: 'full' }) ||
              item.tmdbBackdropUrl ||
              FALLBACK_IMAGE,
        logo: itemIsAudiobook
            ? undefined
            : imageFromIds(externalIds, 'logo', imageMediaType, {
                  size: 'full',
              }) || undefined,
        overview: item.overview,
        customMetadata: item.customMetadata,
        isAvailable: true,
        canRequest: false,
        seasonCount: item.seriesChildCount,
        rating: item.rating,
        criticRating: item.criticRating,
        durationMs: item.duration ? item.duration * 1000 : undefined,
        year: item.year,
        genres: item.genres,
        trailerUrl: item.remoteTrailers?.[0],
        clickData: { originalItem: item },
    };
}

/**
 * Map a taste-rail item (`GET /api/for-you/taste` — the AiStrategy-backed
 * "From your ratings" rail) to a hero AI-suggestion slide.
 *
 * Replaces the retired `/api/ai/suggestions` composer (AI recs redesign
 * Plan 3): that endpoint now 404s, so the hero sources its AI suggestions from
 * the taste rail's canonical `{ media, score, reason }` envelope instead. The
 * ids{} / images{} unpacking mirrors `recommendationItemToHeroItem`.
 */
function tasteRailItemToHeroItem(item: ForYouRecommendationItem): UniversalMediaItem | null {
    const { media } = item;
    const mediaType = mapMediaType(media.type);
    // `null` = the UniversalMediaType vocabulary has no member for this row (a
    // season, a home video, a storage-only row). Drop it: the hero would
    // otherwise render a movie treatment — "Watch Movie", backdrop art it has no
    // source for — for something that is not a movie. An unopenable hero slide is
    // worse than one fewer slide.
    if (mediaType === null) return null;
    // `isSeries(media.type)`, NOT `isSeries(mediaType)`: applying a comparator to
    // the value a narrowing already produced is the dead-guard shape this
    // refactor removes. It happens to agree here, but only by luck.
    const imageMediaType: 'movie' | 'tv' = isSeries(media.type) ? 'tv' : 'movie';

    // Flat ids{} record → ExternalIds (numeric provider ids as numbers). Guard
    // blank ids: Number('') and Number(null) both coerce to 0, which would
    // otherwise become a spurious provider id 0.
    const externalIds: Record<string, string | number | null> = {};
    for (const [k, v] of Object.entries(media.ids ?? {})) {
        const asNum = v === '' || v == null ? Number.NaN : Number(v);
        externalIds[k] = Number.isNaN(asNum) ? v : asNum;
    }
    const ids = externalIds as ExternalIds;

    // Prefer the item's self-describing catalog/TMDB hrefs; fall back to an
    // ExternalIds-derived image when the rail omitted them.
    const image =
        media.images?.['poster']?.href ??
        (imageFromIds(ids, 'poster', imageMediaType, { size: 'card' }) || FALLBACK_IMAGE);
    const backdrop = isAudiobook(media.type)
        ? undefined
        : (media.images?.['backdrop']?.href ??
          (imageFromIds(ids, 'backdrop', imageMediaType, { size: 'hd' }) || FALLBACK_IMAGE));
    const logo = isAudiobook(media.type)
        ? undefined
        : (media.images?.['logo']?.href ??
          (hasValidExternalId(ids)
              ? (imageFromIds(ids, 'logo', imageMediaType, { size: 'thumb' }) ?? undefined)
              : undefined));

    return {
        // Composite key from externalIds avoids ID collisions across sources.
        id: `hero-ai-${mediaCompositeKey(ids, mediaType, media.title)}`,
        externalIds: ids,
        mediaType,
        title: media.title,
        image,
        backdrop,
        logo,
        year: media.year ?? undefined,
        // Display metadata hydrated server-side by getMediaRailMetadataBatch.
        // Before that existed the rail carried only id/title/year/images, so the
        // hero rendered AI slides with no overview, no ratings and no runtime —
        // and the missing runtimeMinutes ALSO broke preview start positions,
        // which fall back to a flat offset without it.
        overview: media.overview,
        rating: media.rating,
        criticRating: media.criticRating,
        durationMs: media.durationMs,
        seasonCount: media.seasonCount,
        episodeCount: media.episodeCount,
        availableEpisodeCount: media.availableEpisodeCount,
        watchedEpisodeCount: media.watchedEpisodeCount,
        unwatchedEpisodeCount: media.unwatchedEpisodeCount,

        genres: media.genres,
        certification: media.certification,
        resolutionTier: media.resolutionTier,
        hdrTier: media.hdrTier,
        hasAtmos: media.hasAtmos,
        hasCc: media.hasCc,
        hasSdh: media.hasSdh,
        hasAd: media.hasAd,
        // `reason` is an OBJECT on the rail contract but the hero renders it as
        // a string — passing it through raw prints "[object Object]".
        reason: item.reason?.label,
        // Availability MUST be threaded through — a request-only (discovery,
        // has_files=false) title otherwise defaults to watchable and its
        // /watch/<uuid> link 404s.
        isAvailable: item.isAvailable ?? false,
        canRequest: item.canRequest ?? false,
        isAISuggestion: true,
        similarityScore: item.score,
        clickData: { originalItem: item },
    };
}

// ============================================================================
// Pure Hero Item Helpers
// ============================================================================

/** Cap the hero item list; <=0 means no cap. */
export function capHeroItems<T>(items: T[], maxSlides: number): T[] {
    return maxSlides > 0 ? items.slice(0, maxSlides) : items;
}

/**
 * Series/media identity key for deduping the Continue-Watching + Next-Up hero
 * pool. Episodes of the same series share `seriesName`, so it's the reliable
 * cross-source key (a CW episode and its Next-Up successor differ by
 * `externalIds.internal` — the per-episode id — but share the series name).
 * Movies have no `seriesName`, so they fall back to their internal id.
 */
function heroWatchingKey(item: UniversalMediaItem): string | undefined {
    const seriesName = item.seriesName?.trim();
    if (seriesName) return `series:${seriesName.toLowerCase()}`;
    const internal = getExternalIdFor(item.externalIds, 'internal');
    if (internal) return `internal:${internal}`;
    return item.id || undefined;
}

/**
 * Reconcile the SSR first slide with the fully-built item list.
 *
 * - When `built` already contains an item matching `ssr.externalIds.internal`,
 *   that full item is promoted to position 0 (preserving backdrop, trailer, etc.)
 *   and the original position is removed — the thin SSR placeholder is discarded.
 * - When there is NO match, `ssr` is prepended as a placeholder first slide so
 *   the page is not blank while the full data loads.
 */
export function mergeSsrFirstSlide<
    T extends { externalIds?: { internal?: string }; isPlaying?: boolean },
>(ssr: T | undefined, built: T[]): T[] {
    if (!ssr) return built;
    const ssrInternalId = getExternalIdFor(ssr.externalIds, 'internal');
    if (!ssrInternalId) return built;
    const key = ssrInternalId;
    const matchIdx = built.findIndex((i) => getExternalIdFor(i.externalIds, 'internal') === key);
    if (matchIdx !== -1) {
        // Full built item already present — promote it to front, keep its rich
        // data. The client-built item comes from the raw /continue endpoint
        // (no live overlay), so carry the SSR seed's live playing state onto it
        // — otherwise the "Playing now" badge would flash on SSR then vanish on
        // hydration.
        const promoted =
            ssr.isPlaying && !built[matchIdx].isPlaying
                ? { ...built[matchIdx], isPlaying: true }
                : built[matchIdx];
        return [promoted, ...built.filter((_, i) => i !== matchIdx)];
    }
    // Not in built list yet — use the thin SSR object as a placeholder first slide
    return [ssr, ...built];
}

// ============================================================================
// Main Builder Function
// ============================================================================

export interface HeroBuilderOptions {
    /** Number of next-up items to fetch */
    nextUpLimit?: number;
    /** Number of movie recommendations to fetch */
    moviesLimit?: number;
    /** Number of AI suggestions to fetch */
    aiLimit?: number;
    /** Custom fetch function (for SSR) */
    fetch?: typeof globalThis.fetch;
    /** Force refresh (bypass cache) */
    refresh?: boolean;
    /**
     * SSR first slide hydrated from +page.server.ts. When present, the
     * matching full built item is promoted to position 0 (or the thin
     * placeholder is prepended when the built list has no match yet).
     */
    ssrFirstSlide?: HeroFirstSlide;
    /**
     * Maximum number of hero slides to surface after merging. 0 means no cap.
     */
    maxSlides?: number;
}

/**
 * Result from buildHeroSection including metadata about caching
 */
export interface HeroBuildResult {
    section: PageSection;
    /** Whether the nextup data came from cache */
    nextUpCached: boolean;
    /** When the nextup data was cached (if cached) */
    nextUpCachedAt?: number;
}

/**
 * Builds a hero section by fetching from multiple API endpoints.
 * Returns a HeroBuildResult with PageSection and caching metadata.
 *
 * Priority: Next Up → AI Suggestions → Random Movies (fallback if AI unavailable)
 */
export async function buildHeroSection(options: HeroBuilderOptions = {}): Promise<HeroBuildResult> {
    const {
        // A few next-up items (not just 1) so the carousel — not only slot 0 —
        // reflects the daypart rotation and the user's recent watching pool.
        nextUpLimit = 2,
        moviesLimit = 8,
        aiLimit = 8,
        fetch: customFetch = globalThis.fetch,
        refresh = false,
    } = options;

    const items: UniversalMediaItem[] = [];

    // Track caching metadata from nextup response
    let nextUpCached = false;
    let nextUpCachedAt: number | undefined;

    // Kick off the AI-suggestion source in parallel with the watching fetches.
    // The taste rail (`getTasteRail` → AiStrategy) replaces the retired
    // `/api/ai/suggestions` endpoint (AI recs redesign Plan 3 — the old path
    // 404s). It uses the credentialed app fetch client (like
    // `buildLocalHeroSection`'s `getRandomPicks`); `buildHeroSection` is
    // client-only, so it needs no SSR-threaded `customFetch`.
    const tasteRailPromise = getTasteRail();

    // Fetch Continue Watching and Next Up in parallel first. Continue Watching is
    // fetched alongside Next Up so the carousel reflects the same combined pool
    // the SSR hero lead is rotated from (the show the user is actually
    // mid-watching, not only Next Up).
    const [continueResponse, nextUpResponse] = await Promise.allSettled([
        customFetch(
            refresh
                ? '/api/recommendations/refresh'
                : `/api/recommendations?type=continue&limit=${nextUpLimit}`,
            refresh
                ? {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ type: 'continue', limit: nextUpLimit }),
                  }
                : undefined,
        ),
        customFetch(
            refresh
                ? '/api/recommendations/refresh'
                : `/api/recommendations?type=nextup&limit=${nextUpLimit}`,
            refresh
                ? {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ type: 'nextup', limit: nextUpLimit }),
                  }
                : undefined,
        ),
    ]);

    // Helper: parse a recommendations response ({ items: NextUpItem[] } | legacy
    // bare array) into transformed UniversalMediaItems. The /continue endpoint
    // returns the same field shape transformNextUpItem consumes (id, seriesName,
    // seriesId, watchProgress, duration, externalIds), so we reuse it.
    const parseNextUpLike = async (
        settled: PromiseSettledResult<Response>,
        onMeta?: (resp: NextUpResponse) => void,
    ): Promise<UniversalMediaItem[]> => {
        if (settled.status !== 'fulfilled' || !settled.value.ok) return [];
        try {
            const unwrapped = (await settled.value.json()) as NextUpResponse | NextUpItem[];
            if (isRecord(unwrapped) && Array.isArray(unwrapped.items)) {
                onMeta?.(unwrapped);
                return renderableHeroItems(unwrapped.items.map(transformNextUpItem));
            }
            if (Array.isArray(unwrapped)) {
                return renderableHeroItems(unwrapped.map(transformNextUpItem));
            }
        } catch (e) {
            console.warn('[HeroBuilder] Next-up-like fetch failed', e);
        }
        return [];
    };

    // Continue Watching ranks FIRST (most relevant), then Next Up. Dedupe across
    // them by series/media identity so the same series isn't shown twice — the CW
    // entry wins over its Next-Up counterpart (it carries real progress).
    const continueItems = await parseNextUpLike(continueResponse);
    const nextUpItems = await parseNextUpLike(nextUpResponse, (resp) => {
        nextUpCached = resp.cached === true;
        nextUpCachedAt = typeof resp.cachedAt === 'number' ? resp.cachedAt : undefined;
    });
    const watchingPool = dedupeByKey([...continueItems, ...nextUpItems], (item) =>
        heroWatchingKey(item),
    );
    // Cap watching (Continue-Watching + Next-Up) slides to at most 2 so the hero
    // isn't dominated by "Next Up" — the rest of the carousel is AI suggestions /
    // fallbacks. (mergeSsrFirstSlide still pins the rotated lead to slot 0.)
    const MAX_WATCHING_SLIDES = 2;
    items.push(...watchingPool.slice(0, MAX_WATCHING_SLIDES));

    // AI suggestions from the taste rail (kicked off above). `status` may be
    // 'generating' (profile not warm yet) or 'exhausted' — both surface as an
    // empty item list, so we fall through to the random-movies fallback.
    let aiSuggestionsAvailable = false;
    try {
        const tasteResult = await tasteRailPromise;
        const tasteItems = tasteResult.data?.items;
        if (tasteItems && tasteItems.length > 0) {
            items.push(
                ...renderableHeroItems(tasteItems.slice(0, aiLimit).map(tasteRailItemToHeroItem)),
            );
            aiSuggestionsAvailable = true;
        }
    } catch (e) {
        console.warn('[HeroBuilder] AI taste suggestions fetch failed', e);
    }

    // Fall back to random movies if AI suggestions not available
    if (!aiSuggestionsAvailable) {
        try {
            const moviesResponse = await customFetch(
                `/api/recommendations?type=movies&limit=${moviesLimit}`,
            );
            if (moviesResponse.ok) {
                // The endpoint returns `{ items: MovieRecommendation[] }`; tolerate the
                // legacy bare-array shape too (mirrors the next-up parsing above).
                // Without this the fresh-install hero — whose ONLY source is this
                // fallback (next-up + AI are empty before any watch history) — silently
                // discarded every item and rendered blank.
                const moviesData = (await moviesResponse.json()) as
                    MovieRecommendation[] | { items?: MovieRecommendation[] };
                const moviesArray = Array.isArray(moviesData)
                    ? moviesData
                    : Array.isArray(moviesData?.items)
                      ? moviesData.items
                      : [];
                items.push(...renderableHeroItems(moviesArray.map(transformMovieRecommendation)));
            }
        } catch (e) {
            console.warn('[HeroBuilder] Movies fallback fetch failed', e);
        }
    }

    // Reconcile SSR first slide (de-dup) then cap to maxSlides.
    // HeroFirstSlide and UniversalMediaItem both carry externalIds.internal;
    // the cast via `as never` narrows to the shared constraint without `any`.
    const merged = mergeSsrFirstSlide(options.ssrFirstSlide as never, items);
    const capped = capHeroItems(merged, options.maxSlides ?? 0);

    return {
        section: {
            id: 'hero-section',
            type: 'hero',
            items: capped,
            meta: {
                loading: false,
            },
        },
        nextUpCached,
        nextUpCachedAt,
    };
}

/**
 * Creates an empty/loading hero section placeholder.
 */
export function createLoadingHeroSection(): PageSection {
    return {
        id: 'hero-section',
        type: 'hero',
        items: [],
        meta: {
            loading: true,
        },
    };
}

/**
 * Map a canonical ForYouRecommendationItem (the shared client contract returned
 * by `getRandomPicks`) to a UniversalMediaItem for the hero carousel.
 *
 * The random-picks rail is library-local, so the item already carries
 * self-describing catalog image hrefs (`media.images{}`); no TMDB lookup needed.
 */
function recommendationItemToHeroItem(item: MediaPreview): UniversalMediaItem | null {
    return mediaPreviewToUniversal(item);
}

/**
 * Build a hero section from random local library items (no TMDB dependency).
 * Used when media exists but no TMDB metadata is available (State 2).
 *
 * Fetches via the shared `getRandomPicks` client (the unified recommendations
 * pipeline) rather than raw-fetching the legacy `/api/for-you/random-picks`
 * envelope, so the client no longer depends on that rail's bespoke pipeline.
 */
export async function buildLocalHeroSection(
    options: { limit?: number; fetch?: typeof globalThis.fetch } = {},
): Promise<HeroBuildResult> {
    const limit = options.limit ?? 6;

    try {
        const result = await getRandomPicks(limit);
        if (result.error || !result.data) {
            return { section: createEmptyHeroSection(), nextUpCached: false };
        }

        const items = renderableHeroItems(result.data.items.map(recommendationItemToHeroItem));

        if (items.length === 0) {
            return { section: createEmptyHeroSection(), nextUpCached: false };
        }

        return {
            section: {
                id: 'hero-section',
                type: 'hero',
                title: '',
                items,
                meta: { loading: false },
            },
            nextUpCached: false,
        };
    } catch (e) {
        console.warn('[HeroBuilder] buildLocalHeroSection failed', e);
        return { section: createEmptyHeroSection(), nextUpCached: false };
    }
}

function createEmptyHeroSection(): PageSection {
    return {
        id: 'hero-section',
        type: 'hero',
        title: '',
        items: [],
        meta: { loading: false },
    };
}

/**
 * Validates if the hero next-up cache is stale.
 * Returns true if the cache is stale and should be refreshed.
 * This is a lightweight check that only queries the database for activity.
 *
 * @param limit - Must match the limit used in buildHeroSection (default: 1)
 */
export async function validateHeroNextUpCache(
    fetch: typeof globalThis.fetch = globalThis.fetch,
    limit: number = 1,
): Promise<{ isStale: boolean; reason?: string }> {
    try {
        // IMPORTANT: limit must match the original request to check the correct cache key
        const response = await fetch(
            `/api/recommendations?type=nextup&limit=${limit}&validate=true`,
        );
        if (!response.ok) {
            return { isStale: false }; // On error, assume cache is fine
        }
        const data = (await response.json()) as ValidateNextUpResponse;
        // API returns { isStale, reason } directly (no success wrapper)
        return {
            isStale: data.isStale === true,
            reason: data.reason,
        };
    } catch (e) {
        console.warn('[HeroBuilder] validateHeroCache fetch failed', e);
        return { isStale: false }; // On error, assume cache is fine
    }
}
