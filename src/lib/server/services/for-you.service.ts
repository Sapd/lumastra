// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * For You Service - Helper functions for personalized content recommendations
 *
 * Extracted from +server.ts to improve maintainability
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { Logger } from '$lib/server/utils/logger.js';
import { pickDisplayRating } from '$lib/server/utils/rating-utils.js';
import {
    cosineSimilarityOrDefault,
    parseEmbedding as parseEmbeddingVector,
} from '$lib/server/utils/embedding-utils.js';
import { config } from '$lib/server/config.js';
import { buildMetadataLateralJoinFragment } from '$lib/server/database/queries/media-queries.js';
import {
    buildOverrideAwareMetadataLateralJoinFragment,
    buildMediaScalarsLateralJoinFragment,
    buildWinningSourceScalarFilterFragment,
} from '$lib/server/database/queries/builders/provider-metadata.builder.js';
import {
    isAvailableExpr,
    canRequestExpr,
} from '$lib/server/database/queries/availability.queries.js';
import {
    scopedCacheKey,
    type SearchAccessContext,
} from '$lib/server/utils/search-access-context.js';
import * as m from '$lib/paraglide/messages';
import type { CachedListItem } from '$lib/server/ai/list-sync.js';
import { getExternalIdFor, createExternalIds } from '$lib/utils/external-ids.js';
import { getCatalogPosterUrl, getCatalogBackdropUrl } from '$lib/utils/image-utils.js';
import { createExternalIdsFromProvider, buildMediaKey } from '$lib/utils/media-id-helpers.js';
import type { ExternalIds } from '$lib/types/api-common.js';
import { providerResolutionService } from './provider-resolution.service.js';
import { EmbeddingOperationsService } from './embedding-operations.service.js';
import { getDismissService } from './dismiss.service.js';
import { resolveTmdbToUuid } from '$lib/server/database/queries/media-lookup.queries.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import { musicCoverUrl } from '$lib/utils/music-cover.js';
import {
    ALLOWED_KEYWORDS,
    ALLOWED_KEYWORDS_ARRAY,
    keywordDisplayName,
} from '$lib/shared/keyword-vocabulary.js';
import { seededShuffle, hashSeed, mulberry32 } from '$lib/server/utils/diversify-rank.js';
import {
    lookupAvailabilityByTmdbIds,
    querySimilarMediaWithAvailability,
    queryFreshReleases,
    buildWatchedExclusionFilter,
    toWatchedExclusionKey,
    type WatchedExclusionKey,
} from '$lib/server/database/queries/for-you-helpers.queries.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import { getOrComputeSingleFlight } from '$lib/server/cache/single-flight.js';
import { isMovie, isSeries } from '$lib/server/utils/media-types';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import {
    interleaveByAvailability,
    capByAvailabilityClass,
} from '$lib/server/utils/availability-balancing.js';
import { EMBEDDING_SOURCE } from '$lib/server/utils/embedding-source.js';
import { DAMPER_LAMBDA, computeDamperPenalty, type DamperContext } from './taste-damper.service.js';
import { buildDamperPenalty } from '../database/queries/builders/damper-penalty.builder.js';
import { buildAgeRatingFilter } from '$lib/server/database/queries/builders/age-rating.builder.js';
import { buildLibraryAccessFilter } from '$lib/server/database/queries/builders/library-access.builder.js';
import {
    deniesEverything,
    restrictedAccess,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { getRecentlyPlayed } from '$lib/server/database/queries/music.queries.js';
import {
    getMusicBecauseYouListened,
    type BecauseYouListenedRow,
} from '$lib/server/database/queries/music-recommendations.queries.js';
import { getDislikedTrackIds } from '$lib/server/database/queries/music-quick-picks.queries.js';
import {
    KIDS_GENRE_IDS,
    ANIME_GENRE_ID,
} from '$lib/server/database/queries/content-affinity.queries.js';
import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui.js';

// Type-safe cache for similar media results using unified cache system
const similarCache = cacheManager.for(CACHE_NAMESPACES.similarContent);

const logger = Logger.for('ForYouService');

/**
 * ForYou configuration type
 */
export interface ForYouConfig {
    // Basic settings
    minRatings: number;
    defaultLimit: number;
    similarCacheHours: number;

    // "Because you watched" settings
    sourcesLimit: number;
    similarPerSource: number;
    secondBecauseSection: boolean;
    secondBecauseLimit: number;

    // Keyword settings
    keywordRows: number;
    keywordItems: number;
    moodLimit: number;

    // Content mix ratios
    similarAvailableRatio: number;
    bingeAvailableRatio: number;
    keywordsAvailableRatio: number;

    // Anime detection
    animeMinWatched: number;
    animeRecencyMonths: number;

    // Advanced: Base scoring weights
    weightAiSimilarity: number;
    weightMdblistScore: number;
    weightImdbRating: number;

    // Advanced: Preference weights
    weightLikedKeyword: number;
    weightDislikedKeyword: number;
    weightLikedGenre: number;
    weightDislikedGenre: number;
    weightLikedYear: number;
    weightDislikedYear: number;

    // Advanced: Similar media weights
    similarWeightDislikedKeyword: number;
    similarWeightDislikedGenre: number;

    // Advanced: Keyword section weights
    keywordWeightAi: number;
    keywordWeightMdblist: number;
    keywordWeightDislikedKeyword: number;
    keywordWeightDislikedGenre: number;

    // Advanced: Anime section weights
    animeWeightAi: number;
    animeWeightMdblist: number;
    animeWeightImdb: number;
}

// ============================================================================
// Access boundary plumbing
//
// Every exported rail in this module takes a REQUIRED `MediaAccessBoundary`.
// There are no permissive defaults: a caller that wants unrestricted rows must
// construct `unrestrictedAccess()` so the decision is greppable, and a caller
// that may see nothing can now say so with `denyAllAccess()` — a state the old
// `{deniedGroupIds: string[] | null, ageRating: ... | null}` pair could not
// express at all.
//
// Two invariants hold module-wide:
//
//  1. Every rail short-circuits `deniesEverything(access)` to an empty result
//     BEFORE it reads or writes any cache and before it issues any query. That
//     matters beyond skipping a round trip: several rails key their cache with
//     `scopedCacheKey`, whose access suffix is empty for an unrestricted caller
//     and — because it is derived from the legacy null-ness — would also be
//     empty for a denyAll boundary. Short-circuiting first means a denyAll
//     caller never touches those keys, so it can never read an unrestricted
//     caller's cached rail.
//  2. Non-denyAll boundaries are decomposed back to the legacy pair via
//     {@link toLegacyAccessPair} for the query modules that have not been
//     migrated yet. That mapping is lossless in both directions for `all`/
//     `denyGroups` and `any`/`limit`, so the emitted SQL — and therefore which
//     rows a restricted user sees — is unchanged.
// ============================================================================

/**
 * Project a boundary onto the `(deniedGroupIds, ageRating)` pair that a couple
 * of still-loose consumers take: `getMusicBecauseYouListened` (which accepts the
 * bundled pair) and `scopedCacheKey`'s `SearchAccessContext` fields. This is NOT
 * the deleted `fromLegacyAccess` adapter — it projects a real, already-required
 * boundary onto the narrower shape those two call sites still consume, and can
 * only be reached for a non-denyAll boundary.
 *
 * `denyAll` is deliberately NOT representable in the pair — that is the whole
 * reason this migration exists. Callers must short-circuit on
 * {@link deniesEverything} first; reaching here with one is a programming error,
 * and throwing fails closed (every rail wraps its body in a try/catch that
 * returns an empty result).
 */
function toLegacyAccessPair(access: MediaAccessBoundary): {
    deniedGroupIds: string[] | null;
    ageRating: { maxAgeRating: number; allowUnrated: boolean } | null;
} {
    if (deniesEverything(access)) {
        throw new Error(
            'toLegacyAccessPair: denyAll boundary cannot be expressed as the legacy pair — ' +
                'short-circuit with deniesEverything() before calling downstream queries',
        );
    }
    return {
        deniedGroupIds: access.library.kind === 'denyGroups' ? access.library.ids : null,
        ageRating:
            access.age.kind === 'limit'
                ? { maxAgeRating: access.age.maxAgeRating, allowUnrated: access.age.allowUnrated }
                : null,
    };
}

/**
 * Access scope for {@link fetchSimilarMedia}.
 *
 * `boundary` is the required media access boundary. The other two fields are
 * NOT part of the boundary — they never change which rows this rail returns —
 * but `scopedCacheKey` folds them into the cache key today, so they are carried
 * explicitly rather than silently dropped. Dropping them would merge cache
 * entries that are currently partitioned.
 */
export interface SimilarMediaAccess {
    boundary: MediaAccessBoundary;
    /** `SearchAccessContext.liveTvAllowed` — cache partitioning only. */
    liveTvAllowed: boolean;
    /** `SearchAccessContext.showUnavailableMedia` — cache partitioning only. */
    showUnavailableMedia: boolean;
}

/**
 * Build a {@link SimilarMediaAccess} from a request's `SearchAccessContext`.
 *
 * `restrictedAccess` constructs the boundary directly from the context's real
 * values so the mapping stays byte-identical to what the context already
 * encoded — including `unauthenticatedSearchAccessContext()`, whose
 * `maxAgeRating: -1` must keep mapping to `age: limit(-1)` and NOT to `denyAll`
 * (promoting it would close the library axis too, changing which rows it returns).
 */
export function toSimilarMediaAccess(ctx: SearchAccessContext): SimilarMediaAccess {
    return {
        boundary: restrictedAccess({
            deniedGroupIds: ctx.deniedGroupIds ?? [],
            maxAgeRating: ctx.ageRating?.maxAgeRating ?? null,
            allowUnrated: ctx.ageRating?.allowUnrated ?? false,
        }),
        liveTvAllowed: ctx.liveTvAllowed,
        showUnavailableMedia: ctx.showUnavailableMedia,
    };
}

/**
 * Get ForYou config values from config object.
 * Reads directly from the centralized config which already handles
 * ConfigService (JSON file + ENV overrides) priority.
 */
export function getForYouConfig(): ForYouConfig {
    return {
        // Basic settings
        minRatings: config.FORYOU_MIN_RATINGS,
        defaultLimit: config.FORYOU_DEFAULT_LIMIT,
        similarCacheHours: config.FORYOU_SIMILAR_CACHE_HOURS,

        // "Because you watched" settings
        sourcesLimit: config.FORYOU_SOURCES_LIMIT,
        similarPerSource: config.FORYOU_SIMILAR_PER_SOURCE,
        secondBecauseSection: config.FORYOU_SECOND_BECAUSE_SECTION,
        secondBecauseLimit: config.FORYOU_SECOND_BECAUSE_LIMIT,

        // Keyword settings
        keywordRows: config.FORYOU_KEYWORD_ROWS,
        keywordItems: config.FORYOU_KEYWORD_ITEMS,
        moodLimit: config.FORYOU_MOOD_LIMIT,

        // Content mix ratios
        similarAvailableRatio: config.FORYOU_SIMILAR_AVAILABLE_RATIO,
        bingeAvailableRatio: config.FORYOU_BINGE_AVAILABLE_RATIO,
        keywordsAvailableRatio: config.FORYOU_KEYWORDS_AVAILABLE_RATIO,

        // Anime detection
        animeMinWatched: config.FORYOU_ANIME_MIN_WATCHED,
        animeRecencyMonths: config.FORYOU_ANIME_RECENCY_MONTHS,

        // Advanced: Base scoring weights
        weightAiSimilarity: config.FORYOU_WEIGHT_AI_SIMILARITY,
        weightMdblistScore: config.FORYOU_WEIGHT_MDBLIST_SCORE,
        weightImdbRating: config.FORYOU_WEIGHT_IMDB_RATING,

        // Advanced: Preference weights
        weightLikedKeyword: config.FORYOU_WEIGHT_LIKED_KEYWORD,
        weightDislikedKeyword: config.FORYOU_WEIGHT_DISLIKED_KEYWORD,
        weightLikedGenre: config.FORYOU_WEIGHT_LIKED_GENRE,
        weightDislikedGenre: config.FORYOU_WEIGHT_DISLIKED_GENRE,
        weightLikedYear: config.FORYOU_WEIGHT_LIKED_YEAR,
        weightDislikedYear: config.FORYOU_WEIGHT_DISLIKED_YEAR,

        // Advanced: Similar media weights
        similarWeightDislikedKeyword: config.FORYOU_SIMILAR_WEIGHT_DISLIKED_KEYWORD,
        similarWeightDislikedGenre: config.FORYOU_SIMILAR_WEIGHT_DISLIKED_GENRE,

        // Advanced: Keyword section weights
        keywordWeightAi: config.FORYOU_KEYWORD_WEIGHT_AI,
        keywordWeightMdblist: config.FORYOU_KEYWORD_WEIGHT_MDBLIST,
        keywordWeightDislikedKeyword: config.FORYOU_KEYWORD_WEIGHT_DISLIKED_KEYWORD,
        keywordWeightDislikedGenre: config.FORYOU_KEYWORD_WEIGHT_DISLIKED_GENRE,

        // Advanced: Anime section weights
        animeWeightAi: config.FORYOU_ANIME_WEIGHT_AI,
        animeWeightMdblist: config.FORYOU_ANIME_WEIGHT_MDBLIST,
        animeWeightImdb: config.FORYOU_ANIME_WEIGHT_IMDB,
    };
}

export interface KeywordRow {
    keyword: string;
    count: number;
    movies: Array<{
        externalIds: ExternalIds;
        mediaType: string;
        title: string;
        isAvailable: boolean;
        canRequest: boolean;
        trailerUrl?: string;
    }>;
}

export interface ExploreKeyword {
    keyword: string; // Internal keyword (for API calls)
    displayName: string; // Display name (German-friendly)
    count: number; // How many movies have this keyword
}

/** Database row for similar media query results */
import type { SimilarMediaRow } from '$lib/server/database/queries/for-you-helpers.queries.js';

/** Database row for keyword-based movie query results */
interface KeywordMovieRow {
    id?: string; // Internal UUID
    primary_ext_id: string;
    media_type?: 'movie' | 'tv';
    title: string;
    is_available?: boolean;
    can_request?: boolean;
    ai_similarity?: number;
    combined_score?: number;
    mdblist_score?: number;
    mdblist_keywords?: string[];
    genres?: number[];
    library_embedding?: number[] | string;
    imdb_rating?: number;
    trailer_url?: string | null;
    overview?: string | null;
    rt_critic?: number | null;
    rt_audience?: number | null;
    release_year?: number | null;
}

/** Database row for anime/scored content query results */
interface ScoredMediaRow {
    internal_id?: string;
    primary_ext_id: string;
    media_type?: 'movie' | 'tv';
    title: string;
    imdb_rating?: number;
    mdblist_score?: number;
    mal_score?: number;
    is_available?: boolean;
    can_request?: boolean;
    ai_similarity?: number;
    runtime_minutes?: number;
    trailer_url?: string | null;
    overview?: string | null;
    rt_critic?: number | null;
    rt_audience?: number | null;
    release_year?: number | null;
}

interface CountRow {
    count: number | string;
}

interface ShortMovieRow {
    primary_ext_id: string;
    internal_id?: string | null;
    title: string;
    media_type?: 'movie' | 'tv';
    runtime_minutes?: number | null;
    imdb_rating?: number | null;
    mdblist_score?: number | null;
    is_available?: boolean | null;
    can_request?: boolean | null;
    ai_similarity?: number | null;
    trailer_url?: string | null;
    overview?: string | null;
    rt_critic?: number | null;
    rt_audience?: number | null;
    release_year?: number | null;
}

interface UserProfileRow {
    catalog_embedding: unknown;
}

interface MediaKeywordRow {
    primary_ext_id: string;
    title: string;
    mdblist_keywords?: string[] | null;
    keywords?: string[] | null;
}

interface DislikeResultRow {
    user_embedding: number[] | null;
    disliked_ids: Array<{ media_id: string }>; // UUID-based
    hard_filtered_stems: string[];
    soft_disliked_stems: Array<{ stem: string; dislike_count: number }>;
    disliked_genres: Array<{ genre_id: number; dislike_count: number }>;
}

interface KeywordCountRow {
    keyword: string;
    count: number;
}

interface WatchedMediaRow {
    primary_ext_id: string;
    media_type: 'movie' | 'tv';
}

export interface FreshReleaseItem {
    externalIds: ExternalIds;
    mediaType: 'movie' | 'tv';
    title: string;
    rating: number;
    mdblistScore?: number | null;
    releaseDate: string | Date | null;
    overview: string;
    isAvailable: boolean;
    canRequest: boolean;
    posterPath?: string | null;
    backdropPath?: string | null;
    trailerUrl?: string;
}

export interface BingeSeriesItem {
    externalIds: ExternalIds;
    mediaType: 'tv';
    title: string;
    rating: number;
    mdblistScore?: number | null;
    releaseDate: string | Date | null;
    overview: string;
    isAvailable: boolean;
    canRequest: boolean;
    posterPath?: string | null;
    backdropPath?: string | null;
    trailerUrl?: string;
    rtCritic?: number | null;
    rtAudience?: number | null;
    year?: number | null;
}

export interface TrendingItem {
    rank: number;
    externalIds: ExternalIds;
    mediaType: string;
    title: string;
    rating: number;
    isAvailable: boolean;
    canRequest: boolean;
    trailerUrl?: string;
}

export interface PopularShowItem {
    rank: number;
    externalIds: ExternalIds;
    mediaType: string;
    title: string;
    rating: number;
    isAvailable: boolean;
    canRequest: boolean;
    trailerUrl?: string;
}

export interface AnimeRecommendationItem {
    externalIds: ExternalIds;
    mediaType: string;
    title: string;
    imdbRating?: number;
    mdblistScore?: number;
    malScore?: number;
    isAvailable: boolean;
    canRequest: boolean;
    aiSimilarity: number | null;
    trailerUrl?: string;
}

export interface ShortMovieItem {
    externalIds: ExternalIds;
    mediaType: string;
    title: string;
    runtimeMinutes?: number | null;
    imdbRating?: number;
    mdblistScore?: number;
    isAvailable: boolean;
    canRequest: boolean;
    aiSimilarity: number | null;
    trailerUrl?: string;
}

/** Transformed similar media item */
export interface SimilarMediaItem {
    externalIds: ExternalIds;
    mediaType: 'movie' | 'tv';
    title: string;
    rating: number;
    overview: string;
    similarity: number;
    isAvailable: boolean;
    canRequest: boolean;
    trailerUrl?: string;
    rtCritic?: number | null;
    rtAudience?: number | null;
    year?: number | null;
}

/**
 * Deduplicate items by universal ID.
 * Uses the universal-id module to generate unique identifiers based on external IDs.
 *
 * @param items - Array of items to deduplicate
 * @param getExternalIds - Function to extract external IDs from an item
 * @param getMediaType - Function to extract media type from an item
 * @returns Deduplicated array
 */
async function deduplicateByUniversalId<T>(
    items: T[],
    getExternalIds: (item: T) => Record<string, string>,
    getMediaType: (item: T) => string,
): Promise<T[]> {
    const { generateUniversalId } = await import('$lib/server/utils/universal-id.js');
    const seen = new Set<string>();
    const deduplicated: T[] = [];

    for (const item of items) {
        const externalIds = getExternalIds(item);
        const mediaType = getMediaType(item) as
            'movie' | 'tv' | 'season' | 'episode' | 'audio' | 'audiobook';
        const universalId = generateUniversalId(externalIds, mediaType);

        if (universalId && !seen.has(universalId)) {
            seen.add(universalId);
            deduplicated.push(item);
        }
    }

    return deduplicated;
}

/**
 * Stable per-UTC-day rotation seed. Same value all day (cache-friendly) and
 * rotates once per calendar day, so daily-seeded shuffles surface a different
 * ordering each day without any per-request entropy.
 */
function dailyRotationSeed(): number {
    const dateBucket = Math.floor(Date.now() / 86_400_000);
    return hashSeed(String(dateBucket));
}

/**
 * Banded shuffle: split an already-ranked list into contiguous score bands,
 * shuffle WITHIN each band (deterministically, from `seed`), and preserve band
 * order. Unlike a full shuffle, the best band always precedes the next, so the
 * top-ranked pool cannot be dragged to the bottom — the strongest candidates
 * still surface first, but their intra-band order rotates for daily variety.
 *
 * Each band gets a seed derived from the base seed and its offset so bands do
 * not all permute in lockstep. Pure: returns a new array; input untouched.
 *
 * @param items - ranked items (best first)
 * @param seed - base rotation seed (e.g. {@link dailyRotationSeed})
 * @param bands - number of score bands (clamped to `[1, items.length]`)
 */
export function bandedShuffle<T>(items: readonly T[], seed: number, bands: number): T[] {
    const n = items.length;
    if (n <= 1 || bands <= 1) return [...items];
    const bandCount = Math.min(bands, n);
    const bandSize = Math.ceil(n / bandCount);
    const out: T[] = [];
    for (let start = 0; start < n; start += bandSize) {
        const band = items.slice(start, start + bandSize);
        // Derive a distinct per-band seed so adjacent bands do not share the
        // same permutation. Math.imul keeps this a 32-bit integer mix.
        const bandSeed = (seed ^ Math.imul(start + 1, 0x9e3779b1)) >>> 0;
        out.push(...seededShuffle(band, bandSeed));
    }
    return out;
}

// `batchResolveTmdbToUuid` used to live here: an exported resolver that queried
// external_ids with NO access boundary at all and returned raw media_ids. It had
// no production callers (only its own unit test), so it was a latent rather than
// a live leak — but leaving an unfiltered id resolver exported from a module
// being certified boundary-safe is exactly the hazard this migration removes.
// Deleted rather than given a boundary, since nothing needed it. If a caller
// ever needs this again, build it with a required MediaAccessBoundary.

/**
 * Known franchise patterns - titles that indicate same franchise
 * Maps a regex pattern to a franchise identifier
 */
const FRANCHISE_PATTERNS: Array<{ pattern: RegExp; franchise: string }> = [
    // Harry Potter
    { pattern: /^harry potter/i, franchise: 'harry-potter' },
    // Lord of the Rings / Hobbit
    {
        pattern: /^(the )?(lord of the rings|hobbit|herr der ringe)/i,
        franchise: 'lotr',
    },
    // Star Wars
    { pattern: /^star wars/i, franchise: 'star-wars' },
    // Marvel (simplified)
    {
        pattern:
            /^(avengers|iron man|captain america|thor|spider-man|ant-man|guardians of the galaxy|black panther|doctor strange)/i,
        franchise: 'marvel',
    },
    // Fast & Furious
    { pattern: /^(fast|furious|the fast)/i, franchise: 'fast-furious' },
    // Pirates of the Caribbean
    {
        pattern: /^(pirates of the caribbean|fluch der karibik)/i,
        franchise: 'pirates',
    },
    // Transformers
    { pattern: /^transformers/i, franchise: 'transformers' },
    // Mission Impossible
    { pattern: /^mission.?impossible/i, franchise: 'mission-impossible' },
    // James Bond (007)
    { pattern: /^(james bond|007)/i, franchise: 'james-bond' },
    // Jurassic Park/World
    { pattern: /^jurassic (park|world)/i, franchise: 'jurassic' },
    // The Matrix
    { pattern: /^(the )?matrix/i, franchise: 'matrix' },
    // Indiana Jones
    { pattern: /^indiana jones/i, franchise: 'indiana-jones' },
    // John Wick
    { pattern: /^john wick/i, franchise: 'john-wick' },
    // Toy Story
    { pattern: /^toy story/i, franchise: 'toy-story' },
    // Shrek
    { pattern: /^shrek/i, franchise: 'shrek' },
    // Ice Age
    { pattern: /^ice age/i, franchise: 'ice-age' },
    // Despicable Me / Minions
    {
        pattern: /^(despicable me|minions|ich.{0,3}einfach unverbesserlich)/i,
        franchise: 'minions',
    },
    // The Hunger Games
    {
        pattern: /^((the )?hunger games|die tribute von panem)/i,
        franchise: 'hunger-games',
    },
    // Twilight
    { pattern: /^(twilight|bis\(s\))/i, franchise: 'twilight' },
    // Planet of the Apes
    { pattern: /^(planet of the apes|planet der affen)/i, franchise: 'apes' },
    // Alien
    { pattern: /^alien[s:]?/i, franchise: 'alien' },
    // Terminator
    { pattern: /^terminator/i, franchise: 'terminator' },
    // Die Hard
    { pattern: /^(die hard|stirb langsam)/i, franchise: 'die-hard' },
    // Rocky / Creed
    { pattern: /^(rocky|creed)/i, franchise: 'rocky' },
    // Bourne
    { pattern: /^(the )?bourne/i, franchise: 'bourne' },
    // Fantastic Beasts
    {
        pattern: /^(fantastic beasts|phantastische tierwesen)/i,
        franchise: 'wizarding-world',
    },
    // Maze Runner
    {
        pattern: /^((the )?maze runner|die auserwählten)/i,
        franchise: 'maze-runner',
    },
    // Divergent
    { pattern: /^(divergent|die bestimmung)/i, franchise: 'divergent' },
    // Conjuring universe
    { pattern: /^conjuring|^annabelle/i, franchise: 'conjuring' },
    // A Quiet Place
    { pattern: /^a quiet place/i, franchise: 'quiet-place' },
    // Scream
    { pattern: /^scream/i, franchise: 'scream' },
    // Insidious
    { pattern: /^insidious/i, franchise: 'insidious' },
    // Paranormal Activity
    { pattern: /^paranormal activity/i, franchise: 'paranormal-activity' },
    // Saw
    { pattern: /^saw/i, franchise: 'saw' },
    // The Purge
    { pattern: /^(the )?purge/i, franchise: 'purge' },
    // Final Destination
    { pattern: /^final destination/i, franchise: 'final-destination' },
    // Escape Room
    { pattern: /^escape room/i, franchise: 'escape-room' },
    // It (Stephen King)
    { pattern: /^es (kapitel|chapter)|^it (chapter)/i, franchise: 'it' },
    // Halloween
    { pattern: /^halloween/i, franchise: 'halloween' },
    // Friday the 13th
    { pattern: /^friday the 13th|^freitag der 13/i, franchise: 'friday13' },
    // Nightmare on Elm Street
    { pattern: /^(a )?nightmare on elm street/i, franchise: 'nightmare-elm' },
    // Child's Play / Chucky
    { pattern: /^child'?s play|^chucky/i, franchise: 'chucky' },
    // Exorcist
    { pattern: /^(the |der )?exorzist/i, franchise: 'exorcist' },
    // Ocean's (Eleven, etc.)
    { pattern: /^ocean'?s/i, franchise: 'oceans' },
    // Now You See Me
    {
        pattern: /^now you see me|^die unfassbaren/i,
        franchise: 'now-you-see-me',
    },
    // Men in Black
    { pattern: /^men in black|^mib/i, franchise: 'mib' },
    // Bad Boys
    { pattern: /^bad boys/i, franchise: 'bad-boys' },
    // Rush Hour
    { pattern: /^rush hour/i, franchise: 'rush-hour' },
    // Naked Gun
    {
        pattern: /^(the )?naked gun|^die nackte kanone/i,
        franchise: 'naked-gun',
    },
    // Hangover
    { pattern: /^(the )?hangover/i, franchise: 'hangover' },
    // Night at the Museum
    {
        pattern: /^nachts? im museum|^night at the museum/i,
        franchise: 'museum',
    },
    // How to Train Your Dragon
    {
        pattern: /^how to train your dragon|^drachenzähmen/i,
        franchise: 'dragons',
    },
    // Kung Fu Panda
    { pattern: /^kung fu panda/i, franchise: 'kungfu-panda' },
    // Madagascar
    { pattern: /^madagascar/i, franchise: 'madagascar' },
    // Hotel Transylvania
    {
        pattern: /^hotel transylvania|^hotel transsilvanien/i,
        franchise: 'hotel-transylvania',
    },
    // Cars
    { pattern: /^cars\b/i, franchise: 'cars' },
    // Finding Nemo/Dory
    {
        pattern: /^finding (nemo|dory)|^findet (nemo|dorie)/i,
        franchise: 'finding-nemo',
    },
    // Monsters Inc/University
    {
        pattern: /^monsters?,? (inc|university)|^die monster (ag|uni)/i,
        franchise: 'monsters-inc',
    },
    // Incredibles
    {
        pattern: /^(the )?incredibles|^die unglaublichen/i,
        franchise: 'incredibles',
    },
    // Dune
    { pattern: /^dune\b/i, franchise: 'dune' },
    // Blade Runner
    { pattern: /^blade runner/i, franchise: 'blade-runner' },
    // Ghostbusters
    { pattern: /^ghostbusters/i, franchise: 'ghostbusters' },
    // Back to the Future
    {
        pattern: /^back to the future|^zurück in die zukunft/i,
        franchise: 'bttf',
    },
    // Godfather
    {
        pattern: /^(the |der )?pate\b|^(the )?godfather/i,
        franchise: 'godfather',
    },
    // Expendables
    { pattern: /^(the )?expendables/i, franchise: 'expendables' },
    // Rambo
    { pattern: /^rambo/i, franchise: 'rambo' },
    // Predator
    { pattern: /^predator/i, franchise: 'predator' },
    // X-Men
    { pattern: /^x-?men/i, franchise: 'x-men' },
    // Batman (DC)
    { pattern: /^(the )?batman|^(the )?dark knight/i, franchise: 'batman' },
    // Superman
    { pattern: /^superman|^man of steel/i, franchise: 'superman' },
    // Aquaman
    { pattern: /^aquaman/i, franchise: 'aquaman' },
    // Wonder Woman
    { pattern: /^wonder woman/i, franchise: 'wonder-woman' },
    // Suicide Squad
    { pattern: /^suicide squad/i, franchise: 'suicide-squad' },
    // Godzilla
    { pattern: /^godzilla/i, franchise: 'godzilla' },
    // King Kong
    { pattern: /^king kong|^kong:/i, franchise: 'kong' },
    // Pacific Rim
    { pattern: /^pacific rim/i, franchise: 'pacific-rim' },
    // Cloverfield
    { pattern: /^cloverfield/i, franchise: 'cloverfield' },
    // National Treasure
    {
        pattern: /^national treasure|^das vermächtnis/i,
        franchise: 'national-treasure',
    },
    // Chronicles of Narnia
    {
        pattern: /^(the )?chronicles of narnia|^die chroniken von narnia/i,
        franchise: 'narnia',
    },
    // Percy Jackson
    { pattern: /^percy jackson/i, franchise: 'percy-jackson' },
];

/**
 * Get franchise identifier for a title, if it matches a known franchise
 */
function getFranchiseId(title: string): string | null {
    const normalizedTitle = title.toLowerCase().trim();
    for (const { pattern, franchise } of FRANCHISE_PATTERNS) {
        if (pattern.test(normalizedTitle)) {
            return franchise;
        }
    }
    return null;
}

/**
 * Check if two titles are from the same franchise
 */
function isSameFranchise(title1: string, title2: string): boolean {
    const franchise1 = getFranchiseId(title1);
    const franchise2 = getFranchiseId(title2);

    // Both must be in a known franchise and match
    if (franchise1 && franchise2 && franchise1 === franchise2) {
        return true;
    }

    return false;
}

// Similar media cache uses unified cache system (see import at top)
// TTL: CACHE_NAMESPACES.similarContent (5min L1, 15min L2)

/**
 * Invalidate similar media cache for a specific user
 * Call this when user submits a rating to ensure downvoted content is filtered out
 * Uses unified cache's deleteUserCache for efficient user-scoped invalidation
 */
export async function invalidateSimilarCacheForUser(userId: UserId): Promise<void> {
    await similarCache.deleteUserCache(userId);
    logger.debug('Invalidated similar media cache for user', { userId });
}

/**
 * Fetch similar media (movies or TV) using AI embeddings
 * Now includes user-specific dislike filtering (keywords, genres, year buckets)
 * @param tmdbId - TMDB ID of the source media
 * @param mediaType - 'movie' or 'tv'
 * @param limit - Number of similar items to return
 * @param userId - User ID for personalization and dislike filtering
 * @param watchedTmdbIds - TMDB IDs of content user has already watched (to exclude)
 */
// Allowlist: Only these keywords are meaningful taste indicators for filtering
// Everything else (technical tags, generic actions, objects) is ignored
const TASTE_INDICATOR_KEYWORDS = new Set([
    // Genres/subgenres that indicate specific taste
    'horror',
    'slasher',
    'found-footage',
    'body-horror',
    'folk-horror',
    'cosmic-horror',
    'comedy',
    'dark-comedy',
    'slapstick',
    'parody',
    'satire',
    'mockumentary',
    'romance',
    'romantic-comedy',
    'rom-com',
    'love-triangle',
    'thriller',
    'psychological-thriller',
    'erotic-thriller',
    'western',
    'spaghetti-western',
    'neo-western',
    'noir',
    'neo-noir',
    'tech-noir',
    'musical',
    'jukebox-musical',
    'documentary',
    'docudrama',
    'true-crime',
    'anime',
    'manga',
    'isekai',
    'mecha',
    'shonen',
    'seinen',
    'slice-of-life',
    'bollywood',
    'k-drama',
    'telenovela',

    // Specific themes/settings that indicate taste
    'superhero',
    'supervillain',
    'comic-book',
    'dc-comics',
    'marvel-comics',
    'zombie',
    'vampire',
    'werewolf',
    'witch',
    'demon',
    'exorcism',
    'alien',
    'alien-invasion',
    'extraterrestrial',
    'ufo',
    'time-travel',
    'parallel-universe',
    'multiverse',
    'alternate-history',
    'cyberpunk',
    'steampunk',
    'dieselpunk',
    'biopunk',
    'space',
    'space-opera',
    'space-exploration',
    'astronaut',
    'medieval',
    'ancient-rome',
    'ancient-egypt',
    'samurai',
    'viking',
    'fairy-tale',
    'folklore',
    'mythology',
    'greek-mythology',
    'norse-mythology',
    'christmas',
    'halloween',
    'holiday',

    // Content styles that indicate taste
    'found-footage',
    'anthology',
    'mockumentary',
    'black-and-white',
    'silent-film',
    'art-house',
    'experimental',
    'surreal',
    'absurdist',
    'exploitation',
    'grindhouse',
    'splatter',
    'torture-porn',
    'erotic',
    'softcore',
    'pinku',

    // Specific content focuses
    'sports',
    'boxing',
    'martial-arts',
    'kung-fu',
    'karate',
    'wrestling',
    'heist',
    'caper',
    'prison',
    'courtroom',
    'legal-drama',
    'war',
    'world-war-ii',
    'world-war-i',
    'vietnam-war',
    'civil-war',
    'spy',
    'espionage',
    'cold-war',
    'mafia',
    'gangster',
    'organized-crime',
    'yakuza',
    'cartel',
    'serial-killer',
    'slasher-killer',
    'coming-of-age',
    'teen',
    'high-school',
    'college',
    'road-trip',
    'road-movie',
    'religious',
    'faith-based',
    'christian',
    'lgbtq',
    'gay',
    'lesbian',
    'transgender',
    'queer',
    'biographical',
    'biopic',
    'monster',
    'kaiju',
    'giant-monster',
    'creature-feature',
]);

/**
 * Resolve provider and build cache key for similar media lookup.
 */
async function resolveSimilarMediaProvider(
    externalIds: ExternalIds,
    mediaType: 'movie' | 'tv',
): Promise<{ tmdbId: number; cacheKey: string } | null> {
    const resolution = await providerResolutionService.resolveToTmdb(externalIds, mediaType);
    if (!resolution.success) {
        logger.warn('Failed to resolve externalIds to tmdbId', {
            externalIds,
            mediaType,
        });
        return null;
    }

    const mediaKey = buildMediaKey(externalIds, mediaType);
    if (!mediaKey) {
        logger.warn('Failed to build media key', { externalIds, mediaType });
        return null;
    }

    return {
        tmdbId: resolution.tmdbId,
        cacheKey: mediaKey,
    };
}

/**
 * Lookup embedding for source media.
 */
async function lookupSimilarEmbedding(
    sql: postgres.Sql,
    tmdbId: number,
    mediaType: 'movie' | 'tv',
    externalIds: ExternalIds,
): Promise<{
    embedding: number[];
    sourceTitle: string;
} | null> {
    const embeddingOps = new EmbeddingOperationsService(sql);
    const mediaId = await resolveTmdbToUuid(sql, tmdbId, mediaType);
    if (!mediaId) {
        logger.warn('Failed to resolve TMDB ID to UUID', {
            tmdbId,
            mediaType,
            externalIds,
        });
        return null;
    }

    const sourceMedia = await embeddingOps.buildMediaEmbeddingFromUuid(mediaId);
    if (!sourceMedia) {
        logger.warn('No source media found for embedding', {
            tmdbId,
            mediaType,
            externalIds,
        });
        return null;
    }

    const embedding =
        parseEmbeddingVector(sourceMedia.library_embedding) ??
        parseEmbeddingVector(sourceMedia.discovery_embedding);

    if (!embedding || embedding.length === 0) {
        logger.warn('No embedding found for source media', {
            tmdbId,
            mediaType,
            title: sourceMedia.title,
            hasLibraryEmbedding: !!sourceMedia.library_embedding,
            hasDiscoveryEmbedding: !!sourceMedia.discovery_embedding,
        });
        return null;
    }

    return {
        embedding,
        sourceTitle: sourceMedia.title || '',
    };
}

/**
 * Deduplicate similar results and filter out franchise matches.
 */
async function deduplicateSimilarResults(
    similar: SimilarMediaRow[],
    sourceTitle: string,
): Promise<SimilarMediaRow[]> {
    const { generateUniversalId } = await import('$lib/server/utils/universal-id.js');
    const seen = new Set<string>();
    const deduplicated: SimilarMediaRow[] = [];

    for (const item of similar) {
        const externalIds = createExternalIdsFromProvider(
            getPrimaryExternalIdProvider(),
            item.primary_ext_id,
        );
        const mediaType = item.media_type || 'movie';
        const externalIdMap: Record<string, string> = {};
        for (const [key, value] of Object.entries(externalIds)) {
            if (value !== undefined) {
                externalIdMap[key] = value;
            }
        }
        const universalId = generateUniversalId(externalIdMap, mediaType);

        if (universalId && !seen.has(universalId)) {
            seen.add(universalId);
            deduplicated.push(item);
        }
    }

    logger.debug('Similar media deduplication', {
        rawCount: similar.length,
        deduplicatedCount: deduplicated.length,
        seenIdsCount: seen.size,
        sourceTitle,
        topRaw: similar.slice(0, 5).map((i) => ({
            title: i.title,
            sim: i.vector_similarity?.toFixed(3),
        })),
    });

    return deduplicated.filter((item) => !isSameFranchise(sourceTitle, item.title || ''));
}

/**
 * Score similar results and enrich with availability data.
 */
function scoreSimilarResults(deduplicated: SimilarMediaRow[]): SimilarMediaItem[] {
    return deduplicated.map((item): SimilarMediaItem => {
        const externalIds = createExternalIds({
            [getPrimaryExternalIdProvider()]: item.primary_ext_id,
            internal: item.internal_id,
        });

        return {
            externalIds,
            mediaType: item.media_type,
            title: item.title,
            rating: pickDisplayRating({ imdbRating: item.imdb_rating }) ?? 0,
            overview: item.overview || '',
            similarity: Math.max(0, Math.min(Math.round((item.combined_score || 0) * 100), 100)),
            isAvailable: item.is_available,
            canRequest: !item.is_available && item.has_discovery_embedding === true,
            trailerUrl: item.trailer_url || undefined,
            rtCritic: item.rt_critic ?? undefined,
            rtAudience: item.rt_audience ?? undefined,
            year: item.release_year ?? undefined,
        };
    });
}

/**
 * Fetch similar media based on AI embeddings and user preferences.
 *
 * IMPORTANT: Uses externalIds parameter to avoid TMDB ID collisions.
 * Resolves to tmdbId internally only for DB queries.
 */
/**
 * Filter out items the user explicitly dismissed from a similar-media result.
 *
 * Dismissed keys may be composite (`"tmdb:550:movie"`) or bare UUIDs. Composite
 * keys are matched by `(tmdbId, mediaType)` to respect the movie/TV id-collision
 * rule; UUIDs are matched against `externalIds.internal`.
 */
export function excludeDismissedSimilarItems<
    T extends { externalIds: ExternalIds; mediaType: 'movie' | 'tv' },
>(items: readonly T[], dismissedMediaKeys: readonly string[]): T[] {
    if (dismissedMediaKeys.length === 0) return [...items];
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const uuidSet = new Set<string>();
    const compositeSet = new Set<string>();
    for (const key of dismissedMediaKeys) {
        if (uuidRe.test(key)) {
            uuidSet.add(key.toLowerCase());
            continue;
        }
        const sep = key.lastIndexOf(':');
        if (sep <= 0) continue;
        const type = key.slice(sep + 1).toLowerCase();
        const id = key.slice(0, sep).split(':').pop() ?? '';
        if (id) compositeSet.add(`${id}:${type}`);
    }
    return items.filter((item) => {
        const internal = getExternalIdFor(item.externalIds, 'internal');
        if (internal && uuidSet.has(internal.toLowerCase())) return false;
        const tmdb = getExternalIdFor(item.externalIds, 'tmdb');
        if (tmdb && compositeSet.has(`${tmdb}:${item.mediaType}`)) return false;
        return true;
    });
}

export async function fetchSimilarMedia(
    sql: postgres.Sql,
    externalIds: ExternalIds,
    mediaType: 'movie' | 'tv',
    limit: number,
    userId: UserId,
    watchedItems: Array<{
        externalIds: ExternalIds;
        mediaType: 'movie' | 'tv';
    }>,
    access: SimilarMediaAccess,
    dismiss: { steering?: boolean; beta?: number } = {},
    /**
     * `availableOnly`: restrict the candidate pool to titles with files inside
     * the query, so `limit` counts available rows only. Part of the cache key.
     */
    options: { availableOnly?: boolean } = {},
): Promise<SimilarMediaItem[]> {
    // denyAll: return empty WITHOUT touching the cache. See the module-level
    // access-boundary note — the scopedCacheKey suffix cannot distinguish
    // denyAll from unrestricted, so a denyAll caller must never read this key.
    if (deniesEverything(access.boundary)) return [];
    const legacyAccess = toLegacyAccessPair(access.boundary);

    const forYouConfig = getForYouConfig();

    const resolved = await resolveSimilarMediaProvider(externalIds, mediaType);
    if (!resolved) {
        return [];
    }
    const { tmdbId, cacheKey: mediaKey } = resolved;

    // Dismiss steering (Because-you-watched): dismissals are recorded per source
    // media (Valkey, ~2h). When any exist for this (user, seed) we (a) steer the
    // source embedding away from the dismissed items and (b) drop the dismissed
    // ids from the result. `steering=false` bypasses (a) but still honours (b) —
    // a user who dismissed an item never wants it back. The dismiss state is
    // folded into the cache key so a fresh dismissal invalidates immediately.
    const sourceMediaKey = `tmdb:${tmdbId}:${mediaType}`;
    const steeringEnabled = dismiss.steering ?? true;
    const beta = dismiss.beta ?? 0.3;
    const dismissService = getDismissService(sql);
    const dismissedKeys = await dismissService.getDismissedMediaKeys(userId, sourceMediaKey);
    const dismissToken =
        dismissedKeys.length > 0
            ? `:d${hashSeed(dismissedKeys.slice().sort().join('|')).toString(36)}` +
              (steeringEnabled ? `:b${beta}` : ':nos')
            : '';

    // v3: dismiss steering can now change the ranking input vector and drop
    // dismissed ids; the token also carries the dismiss/steering state.
    // Cache key is built from the legacy pair so the emitted key string is
    // byte-identical to the pre-migration one (no cache churn on deploy).
    // `username` is not read by buildSearchAccessCacheKey.
    const cacheKey = scopedCacheKey(
        `similar:v4:${mediaKey}${dismissToken}${options.availableOnly ? ':ao' : ''}`,
        {
            username: null,
            deniedGroupIds: legacyAccess.deniedGroupIds,
            ageRating: legacyAccess.ageRating,
            liveTvAllowed: access.liveTvAllowed,
            showUnavailableMedia: access.showUnavailableMedia,
        },
        [limit],
    );

    const cached = await similarCache.get<SimilarMediaItem[]>(cacheKey, userId);
    if (cached) {
        return cached;
    }

    try {
        // Single-flight the expensive embedding + vector-similarity compute.
        // "Because you watched" fans one fetchSimilarMedia call out per watched
        // source item, so a cold home load can fire several of these at once;
        // collapsing concurrent misses on the same (media, access, limit, user)
        // key runs the heavy pgvector query exactly once. Query SHAPE is
        // untouched — this only wraps the miss path. Raw Valkey key mirrors
        // UnifiedCache.buildL2Key(cacheKey, userId) so a warm value is shared
        // with (and invalidated the same way as) the similarCache entry below.
        const ns = CACHE_NAMESPACES.similarContent;
        const rawValkeyKey = `${ns.name}:${userId}:${cacheKey}`;
        const ttlSeconds = Math.floor(ns.l2TTL / 1000);

        const json = await getOrComputeSingleFlight({
            cacheKey: rawValkeyKey,
            ttlSeconds,
            compute: async () => {
                const { KEYWORD_STEM_MAP } = await import('$lib/server/utils/keyword-stems.js');

                const embeddingData = await lookupSimilarEmbedding(
                    sql,
                    tmdbId,
                    mediaType,
                    externalIds,
                );
                if (!embeddingData) {
                    return JSON.stringify([]);
                }
                const { embedding, sourceTitle } = embeddingData;

                logger.debug('Fetching similar media', {
                    tmdbId,
                    mediaType,
                    mediaKey,
                    title: sourceTitle,
                    embeddingLength: embedding.length,
                    cacheKey,
                });

                const stemMapEntries = Object.entries(KEYWORD_STEM_MAP);
                const rawKeywords = stemMapEntries.map(([k]) => k);
                const stems = stemMapEntries.map(([, v]) => v);
                const tasteKeywords = Array.from(TASTE_INDICATOR_KEYWORDS);

                // Dismiss steering: replace the source vector with the negatively
                // steered one when steering is enabled and dismissals exist. This
                // is purely a different INPUT vector — the similarity query shape
                // (and the full-scan/two-phase parity) is untouched.
                let effectiveEmbedding = embedding;
                if (steeringEnabled && dismissedKeys.length > 0) {
                    const steer = await dismissService.getSteeredVector(
                        userId,
                        sourceMediaKey,
                        embedding,
                        beta,
                    );
                    if (steer && steer.steeredVector.length === embedding.length) {
                        effectiveEmbedding = steer.steeredVector;
                    }
                }
                const embeddingStr = `[${effectiveEmbedding.join(',')}]`;

                // Resolve every watched item's TMDB id in parallel — these are
                // independent lookups and the resulting keys form an unordered
                // exclusion set, so there is no reason to await them serially.
                const resolvedWatched = await Promise.all(
                    watchedItems.map((item) =>
                        providerResolutionService.resolveToTmdb(item.externalIds, item.mediaType),
                    ),
                );
                const watchedKeys: WatchedExclusionKey[] = [];
                resolvedWatched.forEach((res, i) => {
                    if (res.success) {
                        watchedKeys.push(
                            toWatchedExclusionKey(res.tmdbId, watchedItems[i].mediaType),
                        );
                    }
                });

                // FEATURE_TWO_PHASE_ANN (default ON): the HNSW-accelerated two-phase
                // similarity path. prod EXPLAIN measured ~3.5s full-scan vs ~124ms warm
                // HNSW, so it is the default now; only an explicit
                // FEATURE_TWO_PHASE_ANN=false forces the proven full-scan path. Read
                // once here and threaded down. (The flag stays an env read rather than
                // a config.ts getter — it is infrastructure-only and not surfaced in the
                // admin settings schema; the two-phase variant also falls back to the
                // full scan automatically on any error.)
                const useTwoPhaseAnn =
                    process.env.FEATURE_TWO_PHASE_ANN?.trim().toLowerCase() !== 'false';

                const similar = await querySimilarMediaWithAvailability(sql, {
                    userId,
                    mediaType,
                    tmdbId,
                    embeddingStr,
                    rawKeywords,
                    stems,
                    tasteKeywords,
                    watchedKeys,
                    limit,
                    similarWeightDislikedKeyword: forYouConfig.similarWeightDislikedKeyword,
                    similarWeightDislikedGenre: forYouConfig.similarWeightDislikedGenre,
                    access: access.boundary,
                    useTwoPhaseAnn,
                    availableOnly: options.availableOnly === true,
                });

                const deduplicated = await deduplicateSimilarResults(similar, sourceTitle);
                // Drop any explicitly dismissed items BEFORE the availability
                // interleave/slice so the row still fills to `limit` with
                // non-dismissed candidates.
                const scored = excludeDismissedSimilarItems(
                    scoreSimilarResults(deduplicated),
                    dismissedKeys,
                );

                const computed = interleaveByAvailability(
                    scored,
                    limit,
                    forYouConfig.similarAvailableRatio,
                    (item) => item.isAvailable,
                );
                return JSON.stringify(computed);
            },
        });

        let result: SimilarMediaItem[];
        try {
            result = JSON.parse(json) as SimilarMediaItem[];
        } catch {
            result = [];
        }

        // Populate L1 (and mirror the L2 write single-flight already made) so
        // subsequent in-process reads skip Valkey.
        await similarCache.set(cacheKey, result, undefined, userId);
        return result;
    } catch (error) {
        logger.warn('Failed to fetch similar media', { tmdbId, mediaType }, error as Error);
        return [];
    }
}

/**
 * Fetch fresh releases - recently released content available in Jellyfin
 * @param sql - PostgreSQL connection
 * @param limit - Number of items to return
 * @param watchedKeys - composite `(externalId, mediaType)` keys to exclude as already watched
 */
export async function fetchFreshReleases(
    sql: postgres.Sql,
    limit: number,
    watchedKeys: readonly WatchedExclusionKey[],
    access: MediaAccessBoundary,
): Promise<FreshReleaseItem[]> {
    if (deniesEverything(access)) return [];
    try {
        // Get content released in the last 3 months, prefer available in Jellyfin
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

        // Ensure valid date string
        const dateString = threeMonthsAgo.toISOString().split('T')[0];
        if (!dateString || dateString.trim() === '') {
            throw new Error('Failed to generate valid date string for fresh releases query');
        }

        // Use extracted query module for fresh releases CTE
        const results = await queryFreshReleases(sql, dateString, watchedKeys, limit, access);

        // Staleness rotation: the query orders deterministically (available DESC,
        // quality DESC) over a 3-5× pool, which froze the same titles at the top
        // every day. Banded-shuffle WITHIN the available and requestable pools
        // (daily seed) so the ordering rotates day-to-day while the "available
        // first" feel is preserved (available block precedes the requestable one).
        const rotationSeed = dailyRotationSeed();
        const availablePool = results.filter((r) => r.is_available);
        const requestablePool = results.filter((r) => !r.is_available);
        const rotated = [
            ...bandedShuffle(availablePool, rotationSeed, 4),
            ...bandedShuffle(requestablePool, rotationSeed, 4),
        ];

        return rotated.slice(0, limit).map((item) => {
            const externalIds = createExternalIds({
                [getPrimaryExternalIdProvider()]: item.primary_ext_id,
                internal: item.internal_id,
            });
            return {
                externalIds,
                mediaType: item.media_type,
                title: item.title,
                rating:
                    pickDisplayRating({
                        imdbRating: item.imdb_rating,
                        tmdbRating: item.tmdb_rating,
                        voteCount: item.vote_count,
                    }) ?? 0,
                mdblistScore: item.mdblist_score,
                releaseDate: item.release_date,
                overview: item.overview || '',
                isAvailable: item.is_available,
                canRequest: !item.is_available,
                posterPath: item.poster_path,
                backdropPath: item.backdrop_path,
                trailerUrl: item.trailer_url || undefined,
                rtCritic: item.rt_critic ?? undefined,
                rtAudience: item.rt_audience ?? undefined,
                year: item.release_year ?? undefined,
            };
        });
    } catch (error) {
        logger.warn('Failed to fetch fresh releases', error as Error);
        return [];
    }
}

/**
 * Post-cache dislike exclusion for fresh releases.
 *
 * `fetchFreshReleases` feeds a GLOBAL (access-scoped, NOT user-scoped) cache, so
 * a per-user "rating <= 4" exclusion cannot be baked into the query/result
 * without leaking one user's taste to everyone sharing that access scope. The
 * exclusion is therefore applied AFTER the shared cache read, using the
 * requesting user's disliked internal UUIDs (see `getDislikedMediaIds()` in
 * for-you-helpers.queries) — the same post-cache pattern the watched filter
 * already uses for this rail.
 *
 * @param items - fresh-release items straight out of the shared cache
 * @param dislikedInternalIds - the user's disliked media UUIDs
 */
export function excludeDislikedFreshReleases<T extends { externalIds: ExternalIds }>(
    items: readonly T[],
    dislikedInternalIds: ReadonlySet<string>,
): T[] {
    if (dislikedInternalIds.size === 0) return [...items];
    return items.filter((item) => {
        const internal = getExternalIdFor(item.externalIds, 'internal');
        return !(internal && dislikedInternalIds.has(internal));
    });
}

/**
 * Trailing options bag for the suppress-and-damper tail shared by
 * `fetchBingeWorthySeries` and `fetchShortMovies`. Folding these into one object
 * (instead of adjacent positional `suppressKids`/`suppressAnime` booleans) closes
 * a silent-swap footgun: two same-typed booleans that the two sibling rails
 * previously ordered differently around `damper`.
 */
export interface RailSuppressionOpts {
    /**
     * Soft down-rank Family/Kids content (genres 10751/10762). Never excludes —
     * subtracts a flat penalty from the ordering score so a family-heavy library
     * still fills the rail rather than returning empty.
     */
    suppressKids?: boolean;
    /**
     * Soft down-rank anime (mdblist keyword 'anime', OR genre 16 (Animation) AND
     * Japanese original language). Never excludes — same flat-penalty shape as
     * `suppressKids`.
     */
    suppressAnime?: boolean;
    /**
     * Active "show less like this" taste-dampers for the requesting user.
     * Attenuates the positive part of the ordering score.
     */
    damper?: DamperContext | null;
}

/**
 * Required counts bag for `fetchKeywordBasedRecommendations`, collapsing the two
 * adjacent same-typed `number` positionals (`limit`, `itemsPerKeyword`) that a
 * caller could silently transpose.
 */
export interface KeywordRecCounts {
    /** Rows fetched per keyword query (was positional `limit`). */
    limit: number;
    /** Keyword breadth (was positional `itemsPerKeyword`). */
    itemsPerKeyword: number;
}

/**
 * Fetch binge-worthy TV series - highly rated completed/established shows
 * @param sql - PostgreSQL connection
 * @param limit - Number of items to return
 * @param watchedTmdbIds - TMDB IDs of content user has already watched (to exclude)
 * @param userId - User ID for personalization
 * @param access - Media access boundary
 * @param opts - Suppress/damper options (see {@link RailSuppressionOpts})
 */
export async function fetchBingeWorthySeries(
    sql: postgres.Sql,
    limit: number,
    watchedTmdbIds: number[],
    userId: UserId | undefined,
    access: MediaAccessBoundary,
    opts: RailSuppressionOpts = {},
): Promise<BingeSeriesItem[]> {
    const {
        suppressKids: suppressKidsContent = false,
        suppressAnime: suppressAnimeContent = false,
        damper = null,
    } = opts;
    if (deniesEverything(access)) return [];

    // Get config values (reads from JSON file + ENV overrides)
    const forYouConfig = getForYouConfig();

    try {
        if (!userId) {
            logger.warn('No userId provided for binge-worthy series');
            return [];
        }

        // Get highly rated TV series that are at least 6 months old (so there's content to binge)
        const sixMonthsAgo = new Date();
        sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

        // Use centralized query module for optimized query
        const { getBingeWorthySeries } =
            await import('$lib/server/database/queries/binge-worthy.queries.js');

        // Fetch extra rows for genre diversity and available/requestable ratio
        const rows = await getBingeWorthySeries(sql, {
            userId,
            excludeTmdbIds: watchedTmdbIds,
            limit: limit + 5, // Fetch extra for genre diversity
            sixMonthsAgo: sixMonthsAgo.toISOString().split('T')[0],
            access,
            damper,
            suppressKidsContent,
            suppressAnimeContent,
        });

        // Calculate how many available vs requestable items we want (config ratio, default 70/30)
        const availableLimit = Math.ceil(limit * forYouConfig.bingeAvailableRatio);
        const requestableLimit = Math.floor(limit * (1 - forYouConfig.bingeAvailableRatio));

        // Split into available and requestable based on is_available flag.
        // Staleness rotation: the pool is quality-ranked (available DESC, quality
        // DESC) over a 3-5× overfetch, which froze the same shows daily. Banded-
        // shuffle WITHIN each pool (daily seed) BEFORE the availability interleave
        // so order rotates day-to-day while the "available first" ratio is kept.
        const rotationSeed = dailyRotationSeed();
        const availableRows = bandedShuffle(
            rows.filter((r) => r.is_available),
            rotationSeed,
            4,
        );
        const requestableRows = bandedShuffle(
            rows.filter((r) => !r.is_available),
            rotationSeed,
            4,
        );

        // Transform rows to BingeSeriesItem
        const transformRow = (item: (typeof rows)[0], isAvailable: boolean): BingeSeriesItem => {
            const externalIds = createExternalIds({
                [getPrimaryExternalIdProvider()]: item.primary_ext_id,
                internal: item.internal_id,
            });
            return {
                externalIds,
                mediaType: 'tv',
                title: item.title,
                rating:
                    pickDisplayRating({
                        imdbRating: item.imdb_rating,
                        tmdbRating: item.tmdb_rating,
                        voteCount: item.vote_count,
                    }) ?? 0,
                mdblistScore: item.mdblist_score,
                releaseDate: item.release_date,
                overview: item.overview || '',
                isAvailable,
                canRequest: !isAvailable,
                posterPath: item.poster_path,
                backdropPath: item.backdrop_path,
                trailerUrl: item.trailer_url || undefined,
                rtCritic: item.rt_critic ?? undefined,
                rtAudience: item.rt_audience ?? undefined,
                year: item.release_year ?? undefined,
            };
        };

        // Map available and requestable items
        const availableItems = availableRows
            .slice(0, availableLimit)
            .map((item) => transformRow(item, true));
        const requestableItems = requestableRows
            .slice(0, requestableLimit)
            .map((item) => transformRow(item, false));

        // Interleave: put requestable items at positions to spread them out
        const result: BingeSeriesItem[] = [];
        let availableIdx = 0;
        let requestableIdx = 0;

        for (
            let i = 0;
            i < limit &&
            (availableIdx < availableItems.length || requestableIdx < requestableItems.length);
            i++
        ) {
            // Insert a requestable item roughly every 3-4 items (30%)
            if (requestableIdx < requestableItems.length && (i + 1) % 4 === 0) {
                result.push(requestableItems[requestableIdx++]);
            } else if (availableIdx < availableItems.length) {
                result.push(availableItems[availableIdx++]);
            } else if (requestableIdx < requestableItems.length) {
                result.push(requestableItems[requestableIdx++]);
            }
        }

        return result;
    } catch (error) {
        logger.warn('Failed to fetch binge-worthy series', error as Error);
        return [];
    }
}

// Groups of similar/related keywords - only one from each group should be shown
const SIMILAR_KEYWORD_GROUPS = [
    // Supernatural/occult
    ['witch', 'demon', 'occult', 'satanism', 'exorcism', 'possession', 'cult'],
    // Horror creatures
    ['vampire', 'werewolf', 'zombie', 'undead'],
    // Ghosts/spirits
    ['ghost', 'haunted', 'paranormal', 'supernatural', 'poltergeist'],
    // Crime types
    ['serial-killer', 'murder', 'murder-mystery', 'whodunit'],
    // Heist/theft
    ['heist', 'robbery', 'thief', 'con-artist'],
    // Space themes
    ['outer-space', 'space-opera', 'spaceship', 'alien', 'extraterrestrial'],
    // Time themes
    ['time-travel', 'time-loop', 'alternate-timeline'],
    // Dystopia/apocalypse
    ['dystopia', 'post-apocalyptic', 'apocalypse'],
    // Martial arts/fighting
    ['martial-arts', 'kung-fu', 'samurai', 'ninja'],
    // Spy/espionage
    ['spy', 'espionage', 'secret-agent'],
    // Romance types
    ['romance', 'love-story', 'romantic-comedy'],
    // Coming of age
    ['coming-of-age', 'teen', 'high-school'],
    // Anime styles
    ['anime', 'anime-animation', 'manga', 'shounen', 'seinen', 'isekai'],
];

/**
 * Get keywords that are similar to the given keyword
 */
function getSimilarKeywords(keyword: string): Set<string> {
    const similar = new Set<string>();
    for (const group of SIMILAR_KEYWORD_GROUPS) {
        if (group.includes(keyword)) {
            group.forEach((kw) => similar.add(kw));
        }
    }
    return similar;
}

/**
 * Extract top keywords from watched content (phase 1).
 */
async function extractTopKeywords(
    sql: postgres.Sql,
    watchedItems: WatchedMediaItem[],
    limit: number,
): Promise<{ keywords: string[]; counts: Map<string, number> }> {
    const movieIds = watchedItems.filter((w) => isMovie(w.media_type)).map((w) => w.primary_ext_id);
    const tvIds = watchedItems.filter((w) => isSeries(w.media_type)).map((w) => w.primary_ext_id);

    const [movieMedia, tvMedia] = await Promise.all([
        movieIds.length > 0
            ? sql<MediaKeywordRow[]>`
                SELECT
                    primary_ext.external_id as primary_ext_id,
                    mi.title,
                    CASE WHEN pm.metadata->'mdblist_keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'mdblist_keywords') = 'array'
                        THEN ARRAY(SELECT jsonb_array_elements_text(pm.metadata->'mdblist_keywords'))
                        ELSE NULL
                    END as mdblist_keywords,
                    CASE WHEN pm.metadata->'keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'keywords') = 'array'
                        THEN ARRAY(SELECT jsonb_array_elements_text(pm.metadata->'keywords'))
                        ELSE NULL
                    END as keywords
                FROM media_items mi
                JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
                ${buildMetadataLateralJoinFragment(sql)}
                WHERE mi.status = 'active'
                  AND primary_ext.external_id = ANY(${movieIds.map(String)}::text[])
                  AND mi.media_type = 'movie'
                  AND (pm.metadata->'mdblist_keywords' IS NOT NULL OR pm.metadata->'keywords' IS NOT NULL)
            `
            : Promise.resolve([]),
        tvIds.length > 0
            ? sql<MediaKeywordRow[]>`
                SELECT
                    primary_ext.external_id as primary_ext_id,
                    mi.title,
                    CASE WHEN pm.metadata->'mdblist_keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'mdblist_keywords') = 'array'
                        THEN ARRAY(SELECT jsonb_array_elements_text(pm.metadata->'mdblist_keywords'))
                        ELSE NULL
                    END as mdblist_keywords,
                    CASE WHEN pm.metadata->'keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'keywords') = 'array'
                        THEN ARRAY(SELECT jsonb_array_elements_text(pm.metadata->'keywords'))
                        ELSE NULL
                    END as keywords
                FROM media_items mi
                JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
                ${buildMetadataLateralJoinFragment(sql)}
                WHERE mi.status = 'active'
                  AND primary_ext.external_id = ANY(${tvIds.map(String)}::text[])
                  AND mi.media_type = 'tv'
                  AND (pm.metadata->'mdblist_keywords' IS NOT NULL OR pm.metadata->'keywords' IS NOT NULL)
            `
            : Promise.resolve([]),
    ]);

    const watchedMedia = [...movieMedia, ...tvMedia];
    const keywordCounts = new Map<string, number>();

    for (const media of watchedMedia) {
        const allKeywords = [...(media.mdblist_keywords || []), ...(media.keywords || [])];
        for (const keyword of allKeywords) {
            const kw = keyword.toLowerCase().trim();
            if (ALLOWED_KEYWORDS.has(kw)) {
                keywordCounts.set(kw, (keywordCounts.get(kw) || 0) + 1);
            }
        }
    }

    const sortedKeywords = Array.from(keywordCounts.entries())
        .filter(([_, count]) => count >= 2)
        .sort((a, b) => b[1] - a[1]);

    // Tie-break adjacent keywords with equal counts using a seeded PRNG so the
    // ordering is stable within a calendar day but rotates daily (eliminates
    // Math.random at this site).
    const dateBucket = Math.floor(Date.now() / 86_400_000);
    const tieRng = mulberry32(hashSeed(String(dateBucket)));
    for (let i = 0; i < sortedKeywords.length - 1; i++) {
        if (Math.abs(sortedKeywords[i][1] - sortedKeywords[i + 1][1]) <= 1 && tieRng() > 0.5) {
            [sortedKeywords[i], sortedKeywords[i + 1]] = [sortedKeywords[i + 1], sortedKeywords[i]];
        }
    }

    const selectedKeywords: string[] = [];
    for (const [keyword] of sortedKeywords) {
        if (selectedKeywords.length >= limit) break;
        const similarKeywords = getSimilarKeywords(keyword);
        const isSimilarToSelected = selectedKeywords.some((selected) =>
            similarKeywords.has(selected),
        );
        if (!isSimilarToSelected) {
            selectedKeywords.push(keyword);
        }
    }

    return { keywords: selectedKeywords, counts: keywordCounts };
}

/**
 * Pre-fetch user dislike data (phase 2).
 */
async function prefetchUserDislikeData(
    sql: postgres.Sql,
    userId: UserId,
): Promise<{
    userEmbedding: number[] | null;
    dislikedUuids: Array<{ media_id: string }>;
    hardFilteredStems: string[];
    softDislikedStems: Array<{ stem: string; dislike_count: number }>;
    dislikedGenres: Array<{ genre_id: number; dislike_count: number }>;
}> {
    const { KEYWORD_STEM_MAP, NOISE_KEYWORDS } = await import('$lib/server/utils/keyword-stems.js');
    const stemMapEntries = Object.entries(KEYWORD_STEM_MAP);
    const rawKeywordsForStem = stemMapEntries.map(([k]) => k);
    const stemsForMap = stemMapEntries.map(([, v]) => v);
    const noiseKeywordsArray = Array.from(NOISE_KEYWORDS);

    const [dislikeResult] = await sql<DislikeResultRow[]>`
        WITH
        stem_map AS (
            SELECT unnest(${rawKeywordsForStem}::text[]) as raw_keyword, unnest(${stemsForMap}::text[]) as stem
        ),
        noise_keywords AS (
            SELECT unnest(${noiseKeywordsArray}::text[]) as keyword
        ),
        user_profile AS (
            SELECT catalog_embedding
            FROM user_profiles
            WHERE user_id = ${userId}
        ),
        disliked_movies AS (
            SELECT
                ur.media_id,
                CASE WHEN pm.metadata->'mdblist_keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'mdblist_keywords') = 'array'
                    THEN ARRAY(SELECT jsonb_array_elements_text(pm.metadata->'mdblist_keywords'))
                    ELSE NULL
                END as mdblist_keywords,
                CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                    THEN ARRAY(SELECT (elem->>'id')::integer FROM jsonb_array_elements(pm.metadata->'genres') AS elem)
                    ELSE NULL
                END as genres
            FROM user_ratings ur
            JOIN media_items mi_dis ON mi_dis.id = ur.media_id
            ${buildMetadataLateralJoinFragment(sql, undefined, 'ur.media_id')}
            WHERE ur.user_id = ${userId} AND ur.rating <= 4
        ),
        disliked_stem_counts AS (
            SELECT COALESCE(sm.stem, LOWER(kw)) as stem, COUNT(*) as dislike_count
            FROM disliked_movies dm
            CROSS JOIN LATERAL unnest(dm.mdblist_keywords) as kw
            LEFT JOIN stem_map sm ON LOWER(kw) = sm.raw_keyword
            WHERE dm.mdblist_keywords IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM noise_keywords nk WHERE nk.keyword = LOWER(kw))
            GROUP BY COALESCE(sm.stem, LOWER(kw))
            HAVING COUNT(*) >= 2
        ),
        disliked_genre_counts AS (
            SELECT g as genre_id, COUNT(*) as dislike_count
            FROM disliked_movies dm
            CROSS JOIN LATERAL unnest(dm.genres) as g
            WHERE dm.genres IS NOT NULL
            GROUP BY g
        )
        SELECT
            (SELECT catalog_embedding FROM user_profile) as user_embedding,
            (SELECT COALESCE(json_agg(json_build_object('media_id', media_id)), '[]') FROM disliked_movies) as disliked_ids,
            (SELECT COALESCE(array_agg(stem), '{}') FROM disliked_stem_counts WHERE dislike_count >= 3) as hard_filtered_stems,
            (SELECT COALESCE(json_agg(json_build_object('stem', stem, 'dislike_count', dislike_count)), '[]') FROM disliked_stem_counts) as soft_disliked_stems,
            (SELECT COALESCE(json_agg(json_build_object('genre_id', genre_id, 'dislike_count', dislike_count)), '[]') FROM disliked_genre_counts) as disliked_genres
    `;

    return {
        userEmbedding: dislikeResult?.user_embedding ?? null,
        dislikedUuids: dislikeResult?.disliked_ids || [],
        hardFilteredStems: dislikeResult?.hard_filtered_stems || [],
        softDislikedStems: dislikeResult?.soft_disliked_stems || [],
        dislikedGenres: dislikeResult?.disliked_genres || [],
    };
}

/**
 * Fetch and score movies for a keyword (phase 3).
 */
async function fetchAndScoreKeywordMovies(
    sql: postgres.Sql,
    keyword: string,
    watchedKeys: readonly WatchedExclusionKey[],
    userDislikeData: {
        userEmbedding: number[] | null;
        dislikedUuids: Array<{ media_id: string }>;
        hardFilteredStems: string[];
        softDislikedStems: Array<{ stem: string; dislike_count: number }>;
        dislikedGenres: Array<{ genre_id: number; dislike_count: number }>;
    },
    itemsPerKeyword: number,
    forYouConfig: ReturnType<typeof getForYouConfig>,
    access: MediaAccessBoundary,
    damper: DamperContext | null = null,
): Promise<KeywordMovieRow[]> {
    // Scope-aware builders: `all`/`any` emit nothing, `denyGroups`/`limit` emit
    // the same predicate as before, `denyAll` emits `AND false`. The caller
    // (fetchKeywordBasedRecommendations) already short-circuits denyAll, so the
    // `AND false` arm is defence in depth rather than the live path.
    const libraryFilter = buildLibraryAccessFilter(sql, access.library);
    const ageFilter = buildAgeRatingFilter(sql, access.age);
    const { KEYWORD_STEM_MAP } = await import('$lib/server/utils/keyword-stems.js');

    const matches = await sql<KeywordMovieRow[]>`
        WITH deduped AS (
            SELECT DISTINCT ON (primary_ext.external_id, mi.media_type)
                mi.id,
                primary_ext.external_id as primary_ext_id,
                mi.title,
                mi.media_type,
                ${isAvailableExpr(sql)} AS is_available,
                ${canRequestExpr(sql)} AS can_request,
                ms.imdb_rating::float as imdb_rating,
                ms.mdblist_score as mdblist_score,
                ms.trailer_url as trailer_url,
                ms.overview as overview,
                ms.rt_rating as rt_critic,
                ms.rt_audience_score as rt_audience,
                ms.release_year as release_year,
                -- keyword/genre arrays from the SAME winning source ms read from
                -- (media_keywords/media_genres). Keywords are the normalized lowercased
                -- form (the scorer lowercases anyway); genre ids now also include the
                -- scalar-encoded ids the old (elem->>'id') dropped.
                (SELECT ARRAY_AGG(mk.keyword) FROM media_keywords mk
                   WHERE mk.media_id = mi.id AND mk.source = ms.source AND mk.keyword_type = 'mdblist') as mdblist_keywords,
                (SELECT ARRAY_AGG(mg.genre_id) FROM media_genres mg
                   WHERE mg.media_id = mi.id AND mg.source = ms.source) as genres,
                jf_emb.embedding as library_embedding
            FROM media_items mi
            JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
            ${buildMediaScalarsLateralJoinFragment(sql)}
            LEFT JOIN media_embeddings jf_emb ON jf_emb.media_id = mi.id AND jf_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
            WHERE mi.status = 'active'
              -- keyword membership on the winning source becomes an index join on
              -- media_keywords(keyword_type, keyword) instead of a per-row unnest+LOWER.
              AND EXISTS (
                SELECT 1 FROM media_keywords mk
                WHERE mk.media_id = mi.id AND mk.source = ms.source AND mk.keyword = LOWER(${keyword})
              )
              ${buildWatchedExclusionFilter(sql, watchedKeys)}
              ${libraryFilter}
              ${ageFilter}
            ORDER BY
                primary_ext.external_id, mi.media_type,
                is_available DESC,
                mdblist_score DESC NULLS LAST
        )
        SELECT * FROM deduped
        ORDER BY is_available DESC, mdblist_score DESC NULLS LAST
        LIMIT ${itemsPerKeyword * 3}
    `;

    const dislikedUuidSet = new Set(userDislikeData.dislikedUuids.map((d) => d.media_id));
    const hardFilteredStemSet = new Set(userDislikeData.hardFilteredStems);
    const softStemMap = new Map(
        userDislikeData.softDislikedStems.map((s) => [s.stem, s.dislike_count]),
    );
    const genreDislikeMap = new Map(
        userDislikeData.dislikedGenres.map((g) => [g.genre_id, g.dislike_count]),
    );

    const scored = matches
        .filter((m) => {
            if (m.id && dislikedUuidSet.has(m.id)) return false;

            const movieKeywords = [...(m.mdblist_keywords || [])];
            for (const kw of movieKeywords) {
                const stem = KEYWORD_STEM_MAP[kw.toLowerCase()] || kw.toLowerCase();
                if (hardFilteredStemSet.has(stem)) return false;
            }
            return true;
        })
        .map((m) => {
            // Missing embedding → 0 (not 0.5): real cosines mostly sit below 0.5,
            // so a 0.5 default over-rewarded unscored items into the top ranks.
            const aiSimilarity = cosineSimilarityOrDefault(
                userDislikeData.userEmbedding,
                m.library_embedding,
                0,
            );

            // "Show less like this": per-damper mean-centered MAX-pool penalty
            // ∈ [0,1] (parity with the SQL paths). Applied multiplicatively below.
            const damperPen = computeDamperPenalty(damper, m.library_embedding);

            let stemPenalty = 0;
            const movieKeywords = [...(m.mdblist_keywords || [])];
            for (const kw of movieKeywords) {
                const stem = KEYWORD_STEM_MAP[kw.toLowerCase()] || kw.toLowerCase();
                stemPenalty += softStemMap.get(stem) || 0;
            }

            let genrePenalty = 0;
            for (const g of m.genres || []) {
                genrePenalty += genreDislikeMap.get(g) || 0;
            }

            const baseScore =
                (m.is_available ? 5 : 0) +
                aiSimilarity * forYouConfig.keywordWeightAi +
                (m.mdblist_score || 0) * forYouConfig.keywordWeightMdblist -
                stemPenalty * forYouConfig.keywordWeightDislikedKeyword -
                genrePenalty * forYouConfig.keywordWeightDislikedGenre;

            // "Show less like this": multiplicative attenuation on the positive
            // part only (mirrors the SQL paths; never boosts a negative score).
            const combinedScore = baseScore - Math.max(0, baseScore) * DAMPER_LAMBDA * damperPen;

            return {
                ...m,
                ai_similarity: aiSimilarity,
                combined_score: combinedScore,
            };
        })
        .sort((a, b) => b.combined_score - a.combined_score)
        .slice(0, itemsPerKeyword);

    return scored;
}

/** Watched item with external ID and media type for proper collision handling */
export interface WatchedMediaItem {
    primary_ext_id: string;
    media_type: 'movie' | 'tv';
}

/**
 * Analyze user's watch history to find common keywords and recommend similar content
 * Supports AI personalization when user has a taste profile
 *
 * IMPORTANT: Uses composite keys (tmdb_id + media_type) to avoid TMDB ID collisions
 * where the same ID can refer to both a movie AND a TV show.
 */
export async function fetchKeywordBasedRecommendations(
    sql: postgres.Sql,
    watchedItems: WatchedMediaItem[],
    counts: KeywordRecCounts,
    userId: UserId | null,
    access: MediaAccessBoundary,
    opts: { damper?: DamperContext | null } = {},
): Promise<KeywordRow[]> {
    const { limit, itemsPerKeyword } = counts;
    const { damper = null } = opts;
    if (deniesEverything(access)) return [];

    const forYouConfig = getForYouConfig();

    if (watchedItems.length === 0) return [];

    try {
        const { keywords: selectedKeywords, counts: keywordCounts } = await extractTopKeywords(
            sql,
            watchedItems,
            limit,
        );
        if (selectedKeywords.length === 0) return [];

        const watchedKeys = watchedItems.map((w) =>
            toWatchedExclusionKey(w.primary_ext_id, w.media_type),
        );

        let userDislikeData = {
            userEmbedding: null as number[] | null,
            dislikedUuids: [] as Array<{ media_id: string }>,
            hardFilteredStems: [] as string[],
            softDislikedStems: [] as Array<{
                stem: string;
                dislike_count: number;
            }>,
            dislikedGenres: [] as Array<{
                genre_id: number;
                dislike_count: number;
            }>,
        };

        if (userId) {
            userDislikeData = await prefetchUserDislikeData(sql, userId);
        }

        const keywordResults = await Promise.all(
            selectedKeywords.map(async (keyword) => ({
                keyword,
                movies: await fetchAndScoreKeywordMovies(
                    sql,
                    keyword,
                    watchedKeys,
                    userDislikeData,
                    itemsPerKeyword,
                    forYouConfig,
                    access,
                    damper,
                ),
            })),
        );

        const keywordRows: KeywordRow[] = [];

        // Post-process results
        for (const { keyword, movies } of keywordResults) {
            if (movies.length >= 3) {
                // Only show keyword rows with at least 3 results
                // Use i18n display name (covers the full keyword whitelist) or
                // fall back to a title-cased version of the raw keyword.
                const displayName = keywordDisplayName(keyword);

                // Balance available vs requestable based on config ratio
                const interleaved = interleaveByAvailability(
                    movies,
                    itemsPerKeyword,
                    forYouConfig.keywordsAvailableRatio,
                    (m) => m.is_available || false,
                );

                keywordRows.push({
                    keyword: displayName,
                    count: keywordCounts.get(keyword) || 0,
                    movies: interleaved.map((m) => ({
                        externalIds: createExternalIds({
                            [getPrimaryExternalIdProvider()]: m.primary_ext_id,
                            internal: m.id ?? undefined,
                        }),
                        mediaType: m.media_type || 'movie',
                        title: m.title,
                        isAvailable: m.is_available || false,
                        canRequest: m.can_request || false,
                        trailerUrl: m.trailer_url || undefined,
                        overview: m.overview || undefined,
                        rtCritic: m.rt_critic ?? undefined,
                        rtAudience: m.rt_audience ?? undefined,
                        year: m.release_year ?? undefined,
                    })),
                });
            }
        }

        return keywordRows;
    } catch (error) {
        logger.warn('Failed to fetch keyword-based recommendations', {}, error as Error);
        return [];
    }
}

// Curated priority keywords - these will always be shown if they have enough movies
const PRIORITY_KEYWORDS = [
    // Mystery & Crime
    'whodunit',
    'murder-mystery',
    'heist',
    'serial-killer',
    'detective',
    // Sci-Fi & Fantasy
    'time-travel',
    'superhero',
    'dystopia',
    'alien',
    'zombie',
    // Space
    'outer-space',
    'space-opera',
    'spaceship',
    // Action & Adventure
    'martial-arts',
    'spy',
    'survival',
    'one-man-army',
    // Drama & Themes
    'dark-comedy',
    'psychological-thriller',
    'coming-of-age',
    'anti-hero',
    // Anime
    'anime',
    'isekai',
    'shounen',
    // Horror
    'supernatural-horror',
    'ghost',
    'vampire',
    // Other interesting
    'cult-film',
    'neo-noir',
    'conspiracy',
];

/**
 * Fetch popular keywords for the "Explore" buttons
 * Uses a mix of priority keywords and popular ones
 */
export async function fetchPopularKeywords(
    sql: postgres.Sql,
    limit: number,
    access: MediaAccessBoundary,
): Promise<ExploreKeyword[]> {
    if (deniesEverything(access)) return [];
    try {
        // Shared curated vocabulary; expanded as a relation below.
        const allowedKeywordsArray = ALLOWED_KEYWORDS_ARRAY;

        // MISSING AXIS (pre-existing, deliberately preserved): this rail applies
        // the LIBRARY axis only. `access.age` is threaded in but not turned into
        // a predicate — adding one would change which keyword counts an
        // age-restricted user sees, which this migration must not do. The age
        // axis is still honoured for the one state it can decide safely:
        // `denyAll` short-circuits above.
        const accessFilter = buildLibraryAccessFilter(sql, access.library);

        // Rewritten off the JSONB `provider_metadata.metadata` unnest (was
        // unnesting mdblist_keywords/keywords via jsonb_array_elements_text for
        // every active media item, twice) onto the trigger-synced `media_keywords`
        // table, which already carries these same arrays as rows keyed by
        // (media_id, source, keyword_type, keyword) and is indexed on
        // (keyword_type, keyword). `winners` picks the same highest-priority
        // provider row per media item that the old LATERAL pick did (mirrors
        // `buildMediaScalarsLateralJoinFragment`'s ORDER BY/LIMIT 1), but only for
        // media that already matched one of the whitelisted keywords — so the
        // provider-priority lookup runs once per candidate item instead of once
        // per active item. Verified on prod 2026-09-26: identical 251-row result
        // set (diffed against the old query), 3072ms -> ~800ms.
        //
        // matched_keywords is scanned once and reused: the DISTINCT media_id pick
        // and the count used to repeat the keyword = ANY(...) bitmap scan three
        // times (once per keyword_type UNION branch). One keyword_type IN (...)
        // pass gives the same (primary_ext_id, keyword) set. Identical rows on
        // prod 2026-09-27, ~680 ms -> ~470 ms warm.
        // Expose the whitelist as a fixed-size relation, including in generic
        // prepared plans. One array parameter hides its cardinality (unnest
        // estimates only 10 rows), which can bring back a slow probe plan after
        // a connection reuses this statement. VALUES keeps the row count visible.
        // The fence preserves the semi-join; IN cannot multiply keyword counts.
        // Measured against production: ~1.5s -> ~0.4s with identical rows.
        const matchedKeywords = sql`
            SELECT media_id, source, keyword_type, keyword FROM media_keywords
            WHERE keyword_type IN ('mdblist', 'plain')
              AND keyword IN (
                  SELECT value
                  FROM (VALUES ${sql(allowedKeywordsArray.map((keyword) => [keyword]))}) AS allowed(value)
                  OFFSET 0
              )
        `;

        // Get keyword counts from database - only for whitelisted keywords (UUID-based)
        const results = await sql<KeywordCountRow[]>`
            WITH matched_keywords AS (${matchedKeywords}),
            matched_media AS (
                SELECT DISTINCT media_id FROM matched_keywords
            ),
            winners AS (
                SELECT mm.media_id, ms.source as winning_source
                FROM matched_media mm
                ${buildMediaScalarsLateralJoinFragment(sql, undefined, 'mm.media_id')}
            )
            SELECT keyword, COUNT(*)::int as count
            FROM (
                SELECT DISTINCT primary_ext.external_id as primary_ext_id, mk.keyword as keyword
                FROM matched_keywords mk
                JOIN winners ON winners.media_id = mk.media_id AND winners.winning_source = mk.source
                JOIN media_items mi ON mi.id = mk.media_id AND mi.status = 'active'
                JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
                WHERE true
                ${accessFilter}
            ) sub
            GROUP BY keyword
            HAVING COUNT(*) >= 5
            ORDER BY count DESC
        `;

        // Build a map of keyword -> count
        const keywordCounts = new Map<string, number>();
        for (const r of results) {
            keywordCounts.set(r.keyword, r.count);
        }

        // Start with priority keywords that have enough movies
        const selectedKeywords: string[] = [];
        for (const kw of PRIORITY_KEYWORDS) {
            if (keywordCounts.has(kw) && selectedKeywords.length < limit) {
                selectedKeywords.push(kw);
            }
        }

        // Fill remaining slots with other popular keywords (by count)
        for (const r of results) {
            if (selectedKeywords.length >= limit) break;
            if (!selectedKeywords.includes(r.keyword)) {
                selectedKeywords.push(r.keyword);
            }
        }

        // Sort by count for display, keeping priority keywords first
        const prioritySet = new Set(PRIORITY_KEYWORDS);
        return selectedKeywords
            .map((kw) => ({
                keyword: kw,
                displayName: keywordDisplayName(kw),
                count: keywordCounts.get(kw) || 0,
            }))
            .sort((a, b) => {
                // Priority keywords first, then by count
                const aIsPriority = prioritySet.has(a.keyword);
                const bIsPriority = prioritySet.has(b.keyword);
                if (aIsPriority && !bIsPriority) return -1;
                if (!aIsPriority && bIsPriority) return 1;
                return b.count - a.count;
            });
    } catch (error) {
        logger.warn('Failed to fetch popular keywords', {}, error as Error);
        return [];
    }
}

/**
 * Fetch trending content from MDBList, enriched with availability from our library
 * Combines available items (prioritized) with requestable trending items
 * @param sql - Postgres SQL client instance
 * @param limit - Maximum number of items to return
 */
export async function fetchTrending(
    sql: postgres.Sql,
    limit: number,
    access: MediaAccessBoundary,
): Promise<TrendingItem[]> {
    if (deniesEverything(access)) return [];
    try {
        const { getCachedListItems, syncList, CURATED_LISTS } =
            await import('$lib/server/ai/list-sync.js');

        // Get both trending and popular movies lists
        const trendingList = CURATED_LISTS.find((l) => l.list_id === 'trending-movies');
        const popularList = CURATED_LISTS.find((l) => l.list_id === 'popular-movies');

        // Fetch from both lists
        let trendingItems: CachedListItem[] = trendingList
            ? await getCachedListItems('trending-movies', limit * 2)
            : [];
        let popularItems: CachedListItem[] = popularList
            ? await getCachedListItems('popular-movies', limit * 2)
            : [];

        // Sync if needed
        if (trendingItems.length === 0 && trendingList) {
            await syncList(trendingList, limit * 2);
            trendingItems = await getCachedListItems('trending-movies', limit * 2);
        }
        if (popularItems.length === 0 && popularList) {
            await syncList(popularList, limit * 2);
            popularItems = await getCachedListItems('popular-movies', limit * 2);
        }

        // Combine items - interleave trending and popular to get mix of both.
        // Trending items lead so the combined order matches the rail's
        // trending framing; popular movies (newer releases) follow as backfill.
        let combinedItems: Array<CachedListItem & { source: 'trending' | 'popular' }> = [];

        // Add trending items first (established hits)
        for (const item of trendingItems) {
            combinedItems.push({ ...item, source: 'trending' });
        }

        // Then add popular items (newer releases user might not have)
        for (const item of popularItems) {
            combinedItems.push({ ...item, source: 'popular' });
        }

        if (combinedItems.length === 0) return [];

        combinedItems = await deduplicateByUniversalId(
            combinedItems,
            (item) =>
                createExternalIds({
                    [getPrimaryExternalIdProvider()]: item.primary_ext_id,
                }) as Record<string, string>,
            (item) => item.media_type || 'movie',
        );

        // Get TMDB IDs from combined list
        const allTmdbIds = combinedItems.map((i) => i.primary_ext_id).filter(Boolean);

        const availabilityMap = await lookupAvailabilityByTmdbIds(sql, allTmdbIds, access);

        // Enrich items with availability - items not in our DB default to canRequest: true
        const enrichedItems = combinedItems.map((item) => {
            // Look up by composite key to get the correct media type's availability
            const mediaType = item.media_type || 'movie';
            const compositeKey = `${item.primary_ext_id}:${mediaType}`;
            const availability = availabilityMap.get(compositeKey);

            // Age-restricted users: skip items not in our DB (we can't verify
            // their age rating). This is a correctness predicate in TypeScript,
            // not SQL — it has no library-axis equivalent, and that asymmetry is
            // deliberate: a discovery item absent from our DB is emitted
            // regardless of denied library groups.
            //
            // Scope mapping (identical to the old null-ness check):
            //   age 'any'     -> keep   (legacy: ageRating null / maxAgeRating null)
            //   age 'limit'   -> drop   (legacy: numeric maxAgeRating)
            //   age 'denyAll' -> unreachable, the whole rail short-circuits above
            if (access.age.kind === 'limit' && !availability) {
                return null;
            }

            // Build externalIds with internal UUID + TMDB (provider-agnostic)
            const externalIds = createExternalIds({
                [getPrimaryExternalIdProvider()]: item.primary_ext_id,
                internal: availability?.internal_id,
            });

            return {
                externalIds,
                mediaType: item.media_type || 'movie',
                title: item.title,
                rating: item.score || 0,
                overview: availability?.overview ?? undefined,
                isAvailable: availability?.is_available ?? false,
                // If not in our DB, assume it's requestable (true by default)
                canRequest: availability ? (availability.can_request ?? false) : true,
                trailerUrl: availability?.trailer_url ?? undefined,
                source: item.source,
            };
        });

        // Keep combined order - filter out nulls (age-restricted) and keep available OR requestable.
        // Cap each availability class independently (not a blind slice): a mixed
        // combined-order truncation lets one class evict the other before the
        // strategy's downstream showUnavailableMedia filter runs, collapsing the
        // rail to near-zero when unavailable items dominate chart order (see
        // capByAvailabilityClass / for-you-helpers.queries.ts availability_ranked).
        const validItems = capByAvailabilityClass(
            enrichedItems.filter(
                (i): i is NonNullable<typeof i> => i !== null && (i.isAvailable || i.canRequest),
            ),
            limit,
            (i) => i.isAvailable,
        );

        // Return with rank - include internal UUID for URL stability
        return validItems.map((item, index) => {
            // Use TMDB for availability lookup (MDBList items always have TMDB)
            const tmdbId = getExternalIdFor(item.externalIds, 'tmdb');
            const availability = availabilityMap.get(`${tmdbId}:${item.mediaType}`);
            return {
                rank: index + 1,
                externalIds: item.externalIds,
                mediaType: item.mediaType,
                title: item.title,
                rating: item.rating,
                overview: item.overview || undefined,
                isAvailable: item.isAvailable,
                canRequest: item.canRequest,
                trailerUrl: item.trailerUrl || undefined,
                rtCritic: availability?.rt_critic ?? undefined,
                rtAudience: availability?.rt_audience ?? undefined,
                year: availability?.release_year ?? undefined,
            };
        });
    } catch (error) {
        logger.warn('Failed to fetch trending', {}, error as Error);
        return [];
    }
}

/**
 * Fetch popular TV shows from MDBList, enriched with availability from our library
 * @param sql - Postgres SQL client instance
 * @param limit - Maximum number of items to return
 */
export async function fetchPopularShows(
    sql: postgres.Sql,
    limit: number,
    access: MediaAccessBoundary,
): Promise<PopularShowItem[]> {
    if (deniesEverything(access)) return [];
    try {
        const { getCachedListItems, syncList, CURATED_LISTS } =
            await import('$lib/server/ai/list-sync.js');

        // Get popular shows list - fetch more to have buffer
        const popularShowsList = CURATED_LISTS.find((l) => l.list_id === 'popular-shows');
        if (!popularShowsList) return [];

        let items: CachedListItem[] = await getCachedListItems('popular-shows', limit * 3);

        // If no cached items, sync the list first
        if (items.length === 0) {
            await syncList(popularShowsList, limit * 3);
            items = await getCachedListItems('popular-shows', limit * 3);
        }

        if (items.length === 0) return [];

        // Get TMDB IDs from popular list
        const popularTmdbIds = items.map((i) => i.primary_ext_id).filter(Boolean);

        const availabilityMap = await lookupAvailabilityByTmdbIds(sql, popularTmdbIds, access);

        // Enrich items with availability - items not in our DB default to canRequest: true
        const enrichedItems = items.map((item, originalIndex) => {
            // Look up by composite key to get the correct media type's availability
            const mediaType = item.media_type || 'tv';
            const compositeKey = `${item.primary_ext_id}:${mediaType}`;
            const availability = availabilityMap.get(compositeKey);

            // Age-restricted users: skip items not in our DB (we can't verify
            // their age rating). This is a correctness predicate in TypeScript,
            // not SQL — it has no library-axis equivalent, and that asymmetry is
            // deliberate: a discovery item absent from our DB is emitted
            // regardless of denied library groups.
            //
            // Scope mapping (identical to the old null-ness check):
            //   age 'any'     -> keep   (legacy: ageRating null / maxAgeRating null)
            //   age 'limit'   -> drop   (legacy: numeric maxAgeRating)
            //   age 'denyAll' -> unreachable, the whole rail short-circuits above
            if (access.age.kind === 'limit' && !availability) {
                return null;
            }

            // Build externalIds with internal UUID + TMDB (provider-agnostic)
            const externalIds = createExternalIds({
                [getPrimaryExternalIdProvider()]: item.primary_ext_id,
                internal: availability?.internal_id,
            });

            return {
                originalRank: originalIndex + 1,
                externalIds,
                mediaType: item.media_type || 'tv',
                title: item.title,
                rating: item.score || 0,
                isAvailable: availability?.is_available ?? false,
                // If not in our DB, assume it's requestable (true by default)
                canRequest: availability ? (availability.can_request ?? false) : true,
                trailerUrl: availability?.trailer_url ?? undefined,
                overview: availability?.overview ?? undefined,
            };
        });

        // Filter out nulls (age-restricted items not in our DB)
        const nonNullItems = enrichedItems.filter((i): i is NonNullable<typeof i> => i !== null);

        const deduplicated = await deduplicateByUniversalId(
            nonNullItems,
            (item) => item.externalIds as Record<string, string>,
            (item) => item.mediaType || 'tv',
        );

        // Keep original MDBList order - just filter to available OR requestable.
        // Cap each availability class independently (see fetchTrending comment)
        // so the downstream showUnavailableMedia filter isn't starved of
        // available rows.
        const validItems = capByAvailabilityClass(
            deduplicated.filter((i) => i.isAvailable || i.canRequest),
            limit,
            (i) => i.isAvailable,
        );

        // Return with rank - ensure tmdb is defined (all items from MDBList have TMDB)
        return validItems.map((item, index) => {
            // MDBList items always have TMDB, use helper for provider-agnostic access
            const tmdbId = getExternalIdFor(item.externalIds, 'tmdb');
            const availability = availabilityMap.get(`${tmdbId}:${item.mediaType}`);
            return {
                rank: index + 1,
                externalIds: item.externalIds,
                mediaType: item.mediaType,
                title: item.title,
                rating: item.rating,
                isAvailable: item.isAvailable,
                canRequest: item.canRequest,
                trailerUrl: item.trailerUrl || undefined,
                overview: item.overview || undefined,
                rtCritic: availability?.rt_critic ?? undefined,
                rtAudience: availability?.rt_audience ?? undefined,
                year: availability?.release_year ?? undefined,
            };
        });
    } catch (error) {
        logger.warn('Failed to fetch popular shows', {}, error as Error);
        return [];
    }
}

// Anime-related keywords that indicate anime content
// Strong indicators - these UNAMBIGUOUSLY indicate anime (no dual meanings)
// NOTE: Removed ambiguous terms that can apply to non-anime:
//   - 'harem' (can mean literal harem scene, e.g., Fellini's 8½)
//   - 'magical-girl' (can mean any girl who uses magic, e.g., The Owl House)
//   - 'isekai' (can mean any "transported to another world" story, e.g., Infinity Train)
//   - 'shojo'/'josei' (can be applied broadly to female-targeted content)
const ANIME_KEYWORDS_STRONG = new Set([
    'anime',
    'anime-animation',
    'japanese-animation',
    'shounen',
    'seinen', // These are specifically Japanese manga demographics
    'based-on-manga',
    'based-on-anime',
    'based-on-light-novel',
    'based-on-anime-series',
    'live-action-remake-of-anime',
]);

// Weak indicators - these need to be combined with Animation genre (16) to be considered anime
// These keywords have dual meanings and can appear in Western animation
const ANIME_KEYWORDS_WEAK = new Set([
    'isekai',
    'magical-girl',
    'harem',
    'shojo',
    'josei',
    'school-life',
    'slice-of-life',
    'mecha',
]);

// TMDB Animation genre id. Hoisted to module scope so the two watch-count
// helpers below can gate WEAK keywords on it (see ANIME_KEYWORDS_WEAK comment)
// the same way the candidate `scored_anime` query does (~line 3300).
const ANIME_ANIMATION_GENRE_ID = 16;

async function countRecentAnimeFromSessions(
    sql: postgres.Sql,
    userId: UserId | null,
    jellyfinUserId: string | null,
    recencyMonths: number,
): Promise<number> {
    if (!userId && !jellyfinUserId) {
        return 0;
    }

    try {
        const animeKeywordsStrongArray = Array.from(ANIME_KEYWORDS_STRONG);
        const animeKeywordsWeakArray = Array.from(ANIME_KEYWORDS_WEAK);
        const recentAnimeCount = await sql<CountRow[]>`
            WITH recent_watches AS (
                SELECT DISTINCT
                    COALESCE(vs.series_name, vs.title) as watch_title
                FROM watch_history vs
                WHERE (
                    ${jellyfinUserId ? sql`vs.jellyfin_user_id = ${jellyfinUserId}` : sql`FALSE`}
                    OR ${userId ? sql`vs.user_id = ${userId}` : sql`FALSE`}
                )
                  AND vs.session_start_time > NOW() - INTERVAL '1 month' * ${recencyMonths}
                  AND COALESCE(vs.series_name, vs.title) != ''
            )
            SELECT COUNT(DISTINCT primary_ext.external_id) as count
            FROM recent_watches rw
            JOIN media_items mi ON LOWER(mi.title) = LOWER(rw.watch_title)
            JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
            ${buildMediaScalarsLateralJoinFragment(sql)}
            WHERE mi.status = 'active'
              -- Anime keyword membership on the winning source is an index join on
              -- media_keywords(keyword_type, keyword) instead of a per-row JSONB
              -- unnest+LOWER over provider_metadata. media_keywords already stores
              -- lower(btrim(keyword)) for both 'mdblist' and 'plain' keyword_types
              -- (the JSONB mdblist_keywords + keyword arrays), so this matches the
              -- old dual EXISTS check. mk.source = ms.source scopes to the same
              -- winning provider the old pm lateral picked.
              -- STRONG keywords are unambiguous alone; WEAK keywords (isekai,
              -- harem, school-life, ...) have dual meanings in Western media and
              -- only count when paired with the Animation genre (mirrors the
              -- scored_anime candidate query's genre+keyword combination).
              AND (
                EXISTS (
                    SELECT 1 FROM media_keywords mk
                    WHERE mk.media_id = mi.id AND mk.source = ms.source
                      AND mk.keyword = ANY(${animeKeywordsStrongArray})
                )
                OR (
                    EXISTS (
                        SELECT 1 FROM media_keywords mk
                        WHERE mk.media_id = mi.id AND mk.source = ms.source
                          AND mk.keyword = ANY(${animeKeywordsWeakArray})
                    )
                    AND EXISTS (
                        SELECT 1 FROM media_genres mg
                        WHERE mg.media_id = mi.id AND mg.source = ms.source
                          AND mg.genre_id = ${ANIME_ANIMATION_GENRE_ID}
                    )
                )
              )
        `;
        return Number.parseInt(String(recentAnimeCount[0]?.count ?? '0'), 10);
    } catch (e) {
        logger.debug('Failed to check recent anime watches from watch_history', {
            userId,
            error: e,
        });
        return -1;
    }
}

async function countAnimeFromTmdbIds(sql: postgres.Sql, watchedTmdbIds: number[]): Promise<number> {
    if (watchedTmdbIds.length === 0) {
        return 0;
    }

    const animeKeywordsStrongArray = Array.from(ANIME_KEYWORDS_STRONG);
    const animeKeywordsWeakArray = Array.from(ANIME_KEYWORDS_WEAK);
    const animeWatchCount = await sql<CountRow[]>`
        SELECT COUNT(*) as count
        FROM media_items mi
        JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
        ${buildMediaScalarsLateralJoinFragment(sql)}
        WHERE mi.status = 'active'
          AND primary_ext.external_id = ANY(${watchedTmdbIds}::text[])
          -- The caller (AnimeStrategy) only has bare TMDB ids here, with no
          -- media_type alongside them (client 'watched=' hint, not a composite
          -- pair) — see anime.strategy.ts's readWatchedTmdbIds. TMDB ids are NOT
          -- unique across media types (e.g. 1429 is both a movie and a TV show),
          -- so without per-id type info we can only scope to the media types
          -- this anime check cares about, not fully disambiguate the collision.
          AND mi.media_type IN ('movie', 'tv')
          -- Same normalized-keyword lookup as countRecentAnimeFromSessions:
          -- index join on media_keywords(keyword_type, keyword), winning source
          -- scoped by mk.source = ms.source, replacing the JSONB unnests.
          -- STRONG-alone OR WEAK+Animation-genre, mirroring the scored_anime
          -- candidate query and the ANIME_KEYWORDS_WEAK doc comment above.
          AND (
            EXISTS (
                SELECT 1 FROM media_keywords mk
                WHERE mk.media_id = mi.id AND mk.source = ms.source
                  AND mk.keyword = ANY(${animeKeywordsStrongArray})
            )
            OR (
                EXISTS (
                    SELECT 1 FROM media_keywords mk
                    WHERE mk.media_id = mi.id AND mk.source = ms.source
                      AND mk.keyword = ANY(${animeKeywordsWeakArray})
                )
                AND EXISTS (
                    SELECT 1 FROM media_genres mg
                    WHERE mg.media_id = mi.id AND mg.source = ms.source
                      AND mg.genre_id = ${ANIME_ANIMATION_GENRE_ID}
                )
            )
          )
    `;
    return Number.parseInt(String(animeWatchCount[0]?.count ?? '0'), 10);
}

/**
 * Fetch anime recommendations from the database
 * Only shows for users who have watched anime before
 * Uses AI personalization when user has a taste profile
 */
export async function fetchAnimeRecommendations(
    sql: postgres.Sql,
    limit: number,
    userId: UserId | null = null,
    watchedTmdbIds: number[] = [],
    jellyfinUserId: string | null,
    access: MediaAccessBoundary,
    damper: DamperContext | null = null,
): Promise<AnimeRecommendationItem[]> {
    // MISSING AXIS (pre-existing, deliberately preserved): this rail has never
    // applied the AGE axis. Both of its CTEs below filter on the library axis
    // only, and `anime.strategy.ts` computed an age filter and then dropped it
    // on the floor because the old signature had no slot for it.
    //
    // Under the required-by-shape design the boundary must be handed in whole,
    // so `access.age` now arrives here — but turning it into a predicate would
    // change which rows an age-restricted user sees, which this migration must
    // not do. It is therefore threaded and deliberately ignored for `any` and
    // `limit`. The one state it can decide without changing semantics is
    // `denyAll`, which was previously inexpressible; that short-circuits below.
    // Closing the age axis properly is a follow-up, not a side effect of a
    // mechanical refactor.
    if (deniesEverything(access)) return [];

    // Get config values (reads from JSON file + ENV overrides)
    const forYouConfig = getForYouConfig();

    logger.debug('fetchAnimeRecommendations called', {
        limit,
        userId,
        watchedTmdbIdsCount: watchedTmdbIds.length,
        jellyfinUserId,
    });
    try {
        const animeKeywordsStrongArray = Array.from(ANIME_KEYWORDS_STRONG);
        const ANIMATION_GENRE_ID = 16; // TMDB Animation genre

        // Check if user has watched enough anime RECENTLY to be considered an active anime watcher
        // Configurable thresholds (defaults: 3 anime titles in the last 3 months)
        const ANIME_WATCHER_THRESHOLD = forYouConfig.animeMinWatched;
        const ANIME_RECENCY_MONTHS = forYouConfig.animeRecencyMonths;

        let recentAnimeWatched = 0;

        // Check recently watched anime from watch_history table
        // This gives us accurate recent watch data
        // Note: watch_history doesn't have tmdb_id, so we match via title/series_name
        // Query by both jellyfin_user_id and user_id to catch all sessions
        if (userId || jellyfinUserId) {
            recentAnimeWatched = await countRecentAnimeFromSessions(
                sql,
                userId,
                jellyfinUserId,
                ANIME_RECENCY_MONTHS,
            );
            logger.debug('Tier 1 anime detection (watch_history)', {
                userId,
                jellyfinUserId,
                recentAnimeWatched,
                monthsBack: ANIME_RECENCY_MONTHS,
            });
        }

        // Fallback: If watch_history check failed or returned 0, also check TMDB IDs from recently played
        if ((recentAnimeWatched === -1 || recentAnimeWatched === 0) && watchedTmdbIds.length > 0) {
            const tmdbAnimeCount = await countAnimeFromTmdbIds(sql, watchedTmdbIds);
            if (tmdbAnimeCount > recentAnimeWatched) {
                recentAnimeWatched = tmdbAnimeCount;
                logger.debug('Tier 2 anime detection (TMDB IDs)', {
                    userId,
                    recentAnimeWatched,
                });
            }
        }

        // Only show anime section if user has watched enough anime
        if (recentAnimeWatched < ANIME_WATCHER_THRESHOLD) {
            logger.debug('User has not watched enough anime, skipping anime section', {
                userId,
                recentAnimeWatched,
                threshold: ANIME_WATCHER_THRESHOLD,
            });
            return [];
        }

        logger.debug('User watches anime, showing anime section', {
            userId,
            recentAnimeWatched,
        });

        // Check if user has an AI profile for personalization
        let userHasProfile = false;
        if (userId) {
            try {
                const [userProfile] = await sql<UserProfileRow[]>`
                    SELECT catalog_embedding
                    FROM user_profiles
                    WHERE user_id = ${userId}
                    AND catalog_embedding IS NOT NULL
                `;
                if (userProfile?.catalog_embedding) {
                    userHasProfile = true;
                }
            } catch {
                logger.debug('No user profile found for anime personalization', { userId });
            }
        }

        let anime: ScoredMediaRow[];

        if (userHasProfile && userId) {
            // Query with AI personalization (UUID-based)
            // PRIMARY: Use anime_genres column (most reliable - from MDBList)
            // FALLBACK: Strong anime keywords + Animation genre (to filter out bad metadata like "Schlafes Bruder" having 'anime' tag)
            anime = await sql<ScoredMediaRow[]>`
                WITH user_profile AS (
                    SELECT catalog_embedding
                    FROM user_profiles
                    WHERE user_id = ${userId}
                ),
                -- Superset of the anime filter below, checked against ANY source
                -- (the winning source is only known after the per-row LATERAL).
                -- The exact filter still runs on the winning ms row; this only
                -- keeps the LATERAL from running for every active item (~109k
                -- loops on prod -> ~1.9k, ~700 ms -> ~130 ms). No source list
                -- here: the provider chain is configurable.
                anime_candidate_ids AS (
                    SELECT media_id FROM media_scalars
                    WHERE has_anime_genres
                    UNION
                    SELECT mg.media_id FROM media_genres mg
                    WHERE mg.genre_id = ${ANIMATION_GENRE_ID}
                      AND EXISTS (SELECT 1 FROM media_keywords mk
                          WHERE mk.media_id = mg.media_id AND mk.source = mg.source
                            AND mk.keyword = ANY(${animeKeywordsStrongArray}))
                ),
                scored_anime AS (
                    SELECT DISTINCT ON (primary_ext.external_id, mi.media_type)
                        mi.id as internal_id,
                        primary_ext.external_id as primary_ext_id,
                        mi.title,
                        mi.media_type,
                        ms.imdb_rating::float as imdb_rating,
                        ms.mdblist_score as mdblist_score,
                        ms.mal_score::float as mal_score,
                        ms.trailer_url as trailer_url,
                        ms.overview as overview,
                        ms.rt_rating as rt_critic,
                        ms.rt_audience_score as rt_audience,
                        ms.release_year as release_year,
                        ${isAvailableExpr(sql)} AS is_available,
                        ${canRequestExpr(sql)} AS can_request,
                        CASE
                            WHEN jf_emb.embedding IS NOT NULL AND up.catalog_embedding IS NOT NULL
                            THEN 1 - (jf_emb.embedding <=> up.catalog_embedding)
                            -- Missing embedding → 0 (not 0.5); a 0.5 freebie made
                            -- unscored anime look like a 50% match and jump the queue.
                            ELSE 0
                        END as ai_similarity,
                        ${buildDamperPenalty(sql, sql`jf_emb.embedding`, damper)} as damper_pen
                    FROM media_items mi
                    JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
                        ${buildMediaScalarsLateralJoinFragment(sql)}
                    LEFT JOIN media_embeddings jf_emb ON jf_emb.media_id = mi.id AND jf_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
                    CROSS JOIN user_profile up
                    WHERE mi.status = 'active'
                      AND mi.id IN (SELECT media_id FROM anime_candidate_ids)
                      AND (
                        -- PRIMARY: has_anime_genres (projected from anime_genres presence).
                        ms.has_anime_genres
                        -- FALLBACK: Animation genre + strong anime keywords, from the same
                        -- winning source (media_genres/media_keywords). Genre-16 detection now
                        -- also catches scalar-encoded ids the old (elem->>'id') dropped.
                        OR (
                            EXISTS (SELECT 1 FROM media_genres mg
                                WHERE mg.media_id = mi.id AND mg.source = ms.source AND mg.genre_id = ${ANIMATION_GENRE_ID})
                            AND EXISTS (SELECT 1 FROM media_keywords mk
                                WHERE mk.media_id = mi.id AND mk.source = ms.source AND mk.keyword = ANY(${animeKeywordsStrongArray}))
                        )
                      )
                      ${buildLibraryAccessFilter(sql, access.library)}
                    -- Deterministic tiebreak (mirrors the other DISTINCT ON queries in this
                    -- file, e.g. queryMoviesByKeyword above): without one, a file-less
                    -- discovery-sourced duplicate of the same TMDB id could win over the
                    -- real playable row depending on scan order/plan. Prefer the playable
                    -- row, then the best AI match, then mdblist score.
                    ORDER BY
                        primary_ext.external_id, mi.media_type,
                        is_available DESC,
                        ai_similarity DESC NULLS LAST,
                        mdblist_score DESC NULLS LAST
                ),
                -- Per-class cap: the pool above has no availability signal in its
                -- ORDER BY, and media_items mixes library (available) + discovery
                -- (unavailable) rows. A single mixed LIMIT lets discovery rows (which
                -- outnumber library rows) crowd out available anime entirely before
                -- the strategy's showUnavailableMedia filter runs (same crowd-out
                -- class as the availability_ranked CTE in for-you-helpers.queries.ts).
                availability_ranked AS (
                    SELECT *, ROW_NUMBER() OVER (
                        PARTITION BY is_available
                        ORDER BY (
                            ai_similarity * ${forYouConfig.animeWeightAi}::numeric +
                            (COALESCE(mdblist_score, 0) / 100.0) * ${forYouConfig.animeWeightMdblist}::numeric +
                            (COALESCE(imdb_rating, 0) / 10.0) * ${forYouConfig.animeWeightImdb}::numeric
                        ) * (1 - ${DAMPER_LAMBDA}::numeric * damper_pen) DESC
                    ) as availability_rank
                    FROM scored_anime
                )
                SELECT *
                FROM availability_ranked
                WHERE availability_rank <= ${limit * 2}
                ORDER BY
                    -- Note: Cast config weights to numeric to avoid postgres parameter type inference issues
                    (
                        ai_similarity * ${forYouConfig.animeWeightAi}::numeric +
                        (COALESCE(mdblist_score, 0) / 100.0) * ${forYouConfig.animeWeightMdblist}::numeric +
                        (COALESCE(imdb_rating, 0) / 10.0) * ${forYouConfig.animeWeightImdb}::numeric
                    ) * (1 - ${DAMPER_LAMBDA}::numeric * damper_pen) DESC
            `;
        } else {
            // Query without AI personalization (UUID-based)
            // PRIMARY: Use anime_genres column (most reliable - from MDBList)
            // FALLBACK: Strong anime keywords + Animation genre (to filter out bad metadata)
            anime = await sql<ScoredMediaRow[]>`
                WITH deduped AS (
                    SELECT DISTINCT ON (primary_ext.external_id, mi.media_type)
                        mi.id as internal_id,
                        primary_ext.external_id as primary_ext_id,
                        mi.title,
                        mi.media_type,
                        ms.imdb_rating::float as imdb_rating,
                        ms.mdblist_score as mdblist_score,
                        ms.mal_score::float as mal_score,
                        ms.trailer_url as trailer_url,
                        ms.overview as overview,
                        ms.rt_rating as rt_critic,
                        ms.rt_audience_score as rt_audience,
                        ms.release_year as release_year,
                        ${isAvailableExpr(sql)} AS is_available,
                        ${canRequestExpr(sql)} AS can_request,
                        -- No user profile → no AI match signal (0, not a 0.5 freebie).
                        0 as ai_similarity
                    FROM media_items mi
                    JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
                    ${buildMediaScalarsLateralJoinFragment(sql)}
                    WHERE mi.status = 'active'
                      AND (
                        ms.has_anime_genres
                        OR (
                            EXISTS (SELECT 1 FROM media_genres mg
                                WHERE mg.media_id = mi.id AND mg.source = ms.source AND mg.genre_id = ${ANIMATION_GENRE_ID})
                            AND EXISTS (SELECT 1 FROM media_keywords mk
                                WHERE mk.media_id = mi.id AND mk.source = ms.source AND mk.keyword = ANY(${animeKeywordsStrongArray}))
                        )
                      )
                      ${buildLibraryAccessFilter(sql, access.library)}
                    ORDER BY
                        primary_ext.external_id, mi.media_type,
                        mdblist_score DESC NULLS LAST,
                        imdb_rating DESC NULLS LAST
                ),
                -- Per-class cap — see the personalized branch above for why a mixed
                -- LIMIT here would let discovery rows crowd out available anime.
                availability_ranked AS (
                    SELECT *, ROW_NUMBER() OVER (
                        PARTITION BY is_available
                        ORDER BY mdblist_score DESC NULLS LAST, imdb_rating DESC NULLS LAST
                    ) as availability_rank
                    FROM deduped
                )
                SELECT * FROM availability_ranked
                WHERE availability_rank <= ${limit * 2}
                ORDER BY mdblist_score DESC NULLS LAST, imdb_rating DESC NULLS LAST
            `;
        }

        // Deduplicate by universal ID (provider-agnostic)
        const deduplicated = await deduplicateByUniversalId(
            anime,
            (item) => {
                const externalIds = createExternalIdsFromProvider(
                    getPrimaryExternalIdProvider(),
                    item.primary_ext_id,
                );
                const filtered: Record<string, string> = {};
                for (const [key, value] of Object.entries(externalIds)) {
                    if (value !== undefined) filtered[key] = value;
                }
                return filtered;
            },
            (item) => item.media_type || 'movie',
        );

        logger.debug('Anime deduplication', {
            rawCount: anime.length,
            deduplicatedCount: deduplicated.length,
        });

        // Banded (quartile) shuffle for variety without sacrificing quality:
        // the pool is ranked (query ORDER BY), so a FULL shuffle would give the
        // best match only a ~50% chance of surviving the 2×-pool cut. Banding
        // keeps the top quartile ahead of the rest while rotating order within
        // each band daily, so strong matches still lead but the row is not
        // frozen day-to-day.
        // Cap each availability class independently after the shuffle (not a
        // blind slice) so the strategy's downstream showUnavailableMedia filter
        // isn't starved when discovery (unavailable) rows dominate the pool.
        const shuffled = capByAvailabilityClass(
            bandedShuffle(deduplicated, dailyRotationSeed(), 4),
            limit,
            (item) => !!item.is_available,
        );

        // Keep every row that has an id we can address: the internal UUID is
        // enough (a Jellyfin id never was a requirement for a library item).
        const filtered = shuffled.filter((item) => !!(item.internal_id || item.primary_ext_id));

        logger.debug('Anime after shuffle', {
            shuffledCount: shuffled.length,
            filteredCount: filtered.length,
        });

        return filtered.map((item) => {
            // Build externalIds with TMDB + internal UUID (provider-agnostic)
            const externalIds = createExternalIds({
                [getPrimaryExternalIdProvider()]: item.primary_ext_id,
                internal: item.internal_id,
            });

            return {
                externalIds,
                mediaType: item.media_type || 'movie',
                title: item.title,
                imdbRating: item.imdb_rating,
                mdblistScore: item.mdblist_score,
                malScore: item.mal_score,
                isAvailable: item.is_available || false,
                canRequest: item.can_request || false,
                aiSimilarity: item.ai_similarity ? Math.round(item.ai_similarity * 100) : null,
                trailerUrl: item.trailer_url || undefined,
                overview: item.overview || undefined,
                rtCritic: item.rt_critic ?? undefined,
                rtAudience: item.rt_audience ?? undefined,
                year: item.release_year ?? undefined,
            };
        });
    } catch (error) {
        logger.warn('Failed to fetch anime recommendations', {}, error as Error);
        return [];
    }
}

/**
 * Fetch short movies (under 90 minutes) from the database
 * Uses AI personalization when user has a taste profile
 */
export async function fetchShortMovies(
    sql: postgres.Sql,
    limit: number,
    userId: UserId | null,
    watchedTmdbIds: number[],
    access: MediaAccessBoundary,
    opts: RailSuppressionOpts = {},
): Promise<ShortMovieItem[]> {
    const {
        suppressKids: suppressKidsContent = false,
        suppressAnime: suppressAnimeContent = false,
        damper = null,
    } = opts;
    if (deniesEverything(access)) return [];

    // Get config values (reads from JSON file + ENV overrides)
    const forYouConfig = getForYouConfig();

    // Import keyword stem utility for normalizing keywords
    const { KEYWORD_STEM_MAP, NOISE_KEYWORDS } = await import('$lib/server/utils/keyword-stems.js');

    try {
        // Build stem map arrays for SQL
        const stemMapEntries = Object.entries(KEYWORD_STEM_MAP);
        const rawKeywords = stemMapEntries.map(([k]) => k);
        const stems = stemMapEntries.map(([, v]) => v);

        // Convert noise keywords Set to array for SQL
        const noiseKeywordsArray = Array.from(NOISE_KEYWORDS);

        // Check if user has an AI profile for personalization
        let userHasProfile = false;
        if (userId) {
            try {
                const [userProfile] = await sql<UserProfileRow[]>`
                    SELECT catalog_embedding
                    FROM user_profiles
                    WHERE user_id = ${userId}
                    AND catalog_embedding IS NOT NULL
                `;
                if (userProfile?.catalog_embedding) {
                    userHasProfile = true;
                }
            } catch {
                logger.debug('No user profile found for short movies personalization', { userId });
            }
        }

        let movies: ShortMovieRow[];

        if (userHasProfile && userId) {
            // Query with AI personalization - user's taste influences ordering
            // Minimum quality threshold to avoid showing "trash"
            logger.debug('Fetching short movies with AI personalization', {
                userId,
            });

            movies = await sql<ShortMovieRow[]>`
                WITH
                -- Keyword stem mapping table for normalization (e.g., cartoon -> animation)
                stem_map AS (
                    SELECT unnest(${rawKeywords}::text[]) as raw_keyword, unnest(${stems}::text[]) as stem
                ),
                user_profile AS (
                    SELECT catalog_embedding
                    FROM user_profiles
                    WHERE user_id = ${userId}
                ),
                -- Get movies the user has rated highly (7+ stars = liked) - UUID-based
                liked_movies AS (
                    SELECT
                        primary_ext.external_id as primary_ext_id,
                        primary_ext.media_type,
                        ur.rating,
                        CASE WHEN pm.metadata->'mdblist_keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'mdblist_keywords') = 'array'
                            THEN ARRAY(SELECT jsonb_array_elements_text(pm.metadata->'mdblist_keywords'))
                            ELSE NULL
                        END as liked_keywords,
                        CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                            THEN ARRAY(SELECT (elem->>'id')::integer FROM jsonb_array_elements(pm.metadata->'genres') AS elem)
                            ELSE NULL
                        END as liked_genres,
                        NULLIF(pm.metadata->>'release_date', '')::date as release_date
                    FROM user_ratings ur
                    JOIN media_items mi_liked ON mi_liked.id = ur.media_id
                    JOIN external_ids primary_ext ON primary_ext.media_id = ur.media_id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi_liked.media_type
                    ${buildMetadataLateralJoinFragment(sql, undefined, 'ur.media_id')}
                    WHERE ur.user_id = ${userId}
                    AND ur.rating >= 7
                ),
                -- Noise keywords to exclude (media format tags, not content preferences)
                noise_keywords AS (
                    SELECT unnest(${noiseKeywordsArray}::text[]) as keyword
                ),
                -- Normalize and collect stems from liked movies (boost stems user likes)
                liked_stem_counts AS (
                    SELECT
                        COALESCE(sm.stem, LOWER(kw)) as stem,
                        COUNT(*) as like_count
                    FROM liked_movies lm
                    CROSS JOIN LATERAL unnest(lm.liked_keywords) as kw
                    LEFT JOIN stem_map sm ON LOWER(kw) = sm.raw_keyword
                    WHERE lm.liked_keywords IS NOT NULL
                      AND NOT EXISTS (SELECT 1 FROM noise_keywords nk WHERE nk.keyword = LOWER(kw))
                    GROUP BY COALESCE(sm.stem, LOWER(kw))
                    HAVING COUNT(*) >= 2
                ),
                -- Collect genres from liked movies (boost genres user likes)
                liked_genre_counts AS (
                    SELECT g as genre_id, COUNT(*) as like_count
                    FROM liked_movies lm
                    CROSS JOIN LATERAL unnest(lm.liked_genres) as g
                    WHERE lm.liked_genres IS NOT NULL
                    GROUP BY g
                    HAVING COUNT(*) >= 2
                ),
                -- Collect year buckets from liked movies
                liked_year_buckets AS (
                    SELECT
                        CASE
                            WHEN EXTRACT(YEAR FROM release_date) < 1950 THEN 'pre1950'
                            WHEN EXTRACT(YEAR FROM release_date) < 1970 THEN '1950s-60s'
                            WHEN EXTRACT(YEAR FROM release_date) < 1990 THEN '1970s-80s'
                            WHEN EXTRACT(YEAR FROM release_date) < 2000 THEN '1990s'
                            WHEN EXTRACT(YEAR FROM release_date) < 2010 THEN '2000s'
                            WHEN EXTRACT(YEAR FROM release_date) < 2020 THEN '2010s'
                            ELSE '2020s'
                        END as year_bucket,
                        COUNT(*) as like_count
                    FROM liked_movies
                    WHERE release_date IS NOT NULL
                    GROUP BY 1
                    HAVING COUNT(*) >= 2
                ),
                -- Get movies the user has rated poorly (1-4 stars out of 10) - UUID-based, no external_ids join
                disliked_movies AS (
                    SELECT
                        ur.media_id,
                        CASE WHEN pm.metadata->'mdblist_keywords' IS NOT NULL AND jsonb_typeof(pm.metadata->'mdblist_keywords') = 'array'
                            THEN ARRAY(SELECT jsonb_array_elements_text(pm.metadata->'mdblist_keywords'))
                            ELSE NULL
                        END as disliked_keywords,
                        CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                            THEN ARRAY(SELECT (elem->>'id')::integer FROM jsonb_array_elements(pm.metadata->'genres') AS elem)
                            ELSE NULL
                        END as disliked_genres,
                        NULLIF(pm.metadata->>'release_date', '')::date as release_date
                    FROM user_ratings ur
                    JOIN media_items mi_disliked ON mi_disliked.id = ur.media_id
                    ${buildMetadataLateralJoinFragment(sql, undefined, 'ur.media_id')}
                    WHERE ur.user_id = ${userId}
                    AND ur.rating <= 4
                ),
                -- Normalize and collect stems from disliked movies
                disliked_stem_counts AS (
                    SELECT
                        COALESCE(sm.stem, LOWER(kw)) as stem,
                        COUNT(*) as dislike_count
                    FROM disliked_movies dm
                    CROSS JOIN LATERAL unnest(dm.disliked_keywords) as kw
                    LEFT JOIN stem_map sm ON LOWER(kw) = sm.raw_keyword
                    WHERE dm.disliked_keywords IS NOT NULL
                      AND NOT EXISTS (SELECT 1 FROM noise_keywords nk WHERE nk.keyword = LOWER(kw))
                    GROUP BY COALESCE(sm.stem, LOWER(kw))
                    HAVING COUNT(*) >= 2
                ),
                -- Collect genres from disliked movies (penalize genres user dislikes)
                disliked_genre_counts AS (
                    SELECT g as genre_id, COUNT(*) as dislike_count
                    FROM disliked_movies dm
                    CROSS JOIN LATERAL unnest(dm.disliked_genres) as g
                    WHERE dm.disliked_genres IS NOT NULL
                    GROUP BY g
                    HAVING COUNT(*) >= 2
                ),
                -- Collect year buckets from disliked movies
                disliked_year_buckets AS (
                    SELECT
                        CASE
                            WHEN EXTRACT(YEAR FROM release_date) < 1950 THEN 'pre1950'
                            WHEN EXTRACT(YEAR FROM release_date) < 1970 THEN '1950s-60s'
                            WHEN EXTRACT(YEAR FROM release_date) < 1990 THEN '1970s-80s'
                            WHEN EXTRACT(YEAR FROM release_date) < 2000 THEN '1990s'
                            WHEN EXTRACT(YEAR FROM release_date) < 2010 THEN '2000s'
                            WHEN EXTRACT(YEAR FROM release_date) < 2020 THEN '2010s'
                            ELSE '2020s'
                        END as year_bucket,
                        COUNT(*) as dislike_count
                    FROM disliked_movies
                    WHERE release_date IS NOT NULL
                    GROUP BY 1
                    HAVING COUNT(*) >= 2
                ),
                -- Hard filter sets (small, indexed lookups)
                -- Only keywords/stems get hard filtered - they're specific enough (e.g., "anime", "cartoon")
                -- Genres and year buckets are too broad for hard filtering - use soft penalties only
                hard_filtered_stems AS (
                    SELECT stem FROM disliked_stem_counts WHERE dislike_count >= 3
                ),
                -- Pre-filter candidate movies (apply hard filters early to reduce dataset) - UUID-based
                candidate_movies AS (
                    SELECT
                        mi.id::text as internal_id,
                        primary_ext.external_id as primary_ext_id,
                        mi.title,
                        mi.media_type,
                        ms.runtime_minutes as runtime_minutes,
                        ms.imdb_rating::float as imdb_rating,
                        ms.mdblist_score as mdblist_score,
                        ms.release_date as release_date,
                        ms.trailer_url as trailer_url,
                        ms.overview as overview,
                        ms.rt_rating as rt_critic,
                        ms.rt_audience_score as rt_audience,
                        ms.release_year as release_year,
                        ${isAvailableExpr(sql)} AS is_available,
                        ${canRequestExpr(sql)} AS can_request,
                        -- keyword/genre arrays from the winning source (media_keywords/media_genres),
                        -- normalized (lowercased keywords; genre ids incl. scalar-encoded).
                        (SELECT ARRAY_AGG(mk.keyword) FROM media_keywords mk
                           WHERE mk.media_id = mi.id AND mk.source = ms.source AND mk.keyword_type = 'mdblist') as mdblist_keywords,
                        (SELECT ARRAY_AGG(mg.genre_id) FROM media_genres mg
                           WHERE mg.media_id = mi.id AND mg.source = ms.source) as genres,
                        -- Anime item detection: mdblist keyword 'anime', OR
                        -- (Animation genre 16 AND Japanese original language) —
                        -- soft down-rank signal only, mirrors kids_genre_matches.
                        (
                            EXISTS (
                                SELECT 1 FROM media_keywords mk_anime
                                WHERE mk_anime.media_id = mi.id AND mk_anime.source = ms.source
                                  AND mk_anime.keyword_type = 'mdblist' AND mk_anime.keyword = 'anime'
                            )
                            OR (
                                EXISTS (
                                    SELECT 1 FROM media_genres mg_anime
                                    WHERE mg_anime.media_id = mi.id AND mg_anime.source = ms.source
                                      AND mg_anime.genre_id = ${ANIME_GENRE_ID}
                                )
                                AND EXISTS (
                                    SELECT 1 FROM provider_metadata pm_anime
                                    WHERE pm_anime.media_id = mi.id AND pm_anime.provider = ms.source
                                      AND pm_anime.metadata->>'original_language' = 'ja'
                                )
                            )
                        ) as is_anime,
                        jf_emb.embedding as library_embedding,
                        -- Pre-compute year bucket once
                        CASE
                            WHEN EXTRACT(YEAR FROM ms.release_date) < 1950 THEN 'pre1950'
                            WHEN EXTRACT(YEAR FROM ms.release_date) < 1970 THEN '1950s-60s'
                            WHEN EXTRACT(YEAR FROM ms.release_date) < 1990 THEN '1970s-80s'
                            WHEN EXTRACT(YEAR FROM ms.release_date) < 2000 THEN '1990s'
                            WHEN EXTRACT(YEAR FROM ms.release_date) < 2010 THEN '2000s'
                            WHEN EXTRACT(YEAR FROM ms.release_date) < 2020 THEN '2010s'
                            ELSE '2020s'
                        END as year_bucket
                    -- Inverted scan (FROM media_scalars) so the scalar-range predicates
                    -- hit the column indexes; winning-source filter keeps the LATERAL's
                    -- exact per-media_id pick. ~12× faster (see buildWinningSourceScalarFilter).
                    FROM media_scalars ms
                    JOIN media_items mi ON mi.id = ms.media_id AND mi.status = 'active' AND mi.media_type = 'movie'
                    JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
                    LEFT JOIN media_embeddings jf_emb ON jf_emb.media_id = mi.id AND jf_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
                    WHERE ms.runtime_minutes > 0
                      AND ms.runtime_minutes < 90
                      -- Quality filter: require at least one rating (no unknown quality loophole)
                      AND (ms.imdb_rating >= 5.5 OR ms.mdblist_score >= 55)
                      -- Baseline date filter for short movies section (no silent films etc)
                      AND ms.release_date >= '1970-01-01'
                      AND ${buildWinningSourceScalarFilterFragment(sql)}
                      -- Exclude already watched content. Scope by media_type so a watched
                      -- TV show with the same numeric TMDB ID can never suppress a movie
                      -- candidate (TMDB IDs are not unique across media types).
                      ${watchedTmdbIds.length > 0 ? sql`AND NOT (primary_ext.media_type = 'movie' AND primary_ext.external_id = ANY(${watchedTmdbIds.map(String)}::text[]))` : sql``}
                      -- Exclude directly downvoted movies (UUID comparison)
                      AND NOT EXISTS (SELECT 1 FROM disliked_movies dm WHERE dm.media_id = mi.id)
                      -- NOTE: Year buckets use soft penalties only (too broad for hard filtering)
                      ${buildAgeRatingFilter(sql, access.age)}
                      ${buildLibraryAccessFilter(sql, access.library)}
                ),
                -- Pre-compute normalized stems for each candidate movie
                movie_stems AS (
                    SELECT
                        cm.primary_ext_id,
                        cm.media_type,
                        ARRAY_AGG(DISTINCT COALESCE(sm.stem, LOWER(kw))) as stems
                    FROM candidate_movies cm
                    CROSS JOIN LATERAL unnest(cm.mdblist_keywords) as kw
                    LEFT JOIN stem_map sm ON LOWER(kw) = sm.raw_keyword
                    WHERE cm.mdblist_keywords IS NOT NULL
                      -- Stems are only compared against the liked/disliked stem sets
                      -- (hard_filtered_stems is a subset of disliked), so drop the
                      -- rest. The planner rescans this CTE once per candidate;
                      -- unrestricted it held every keyword stem of every candidate.
                      AND (
                          EXISTS (SELECT 1 FROM liked_stem_counts lsc_f WHERE lsc_f.stem = COALESCE(sm.stem, LOWER(kw)))
                          OR EXISTS (SELECT 1 FROM disliked_stem_counts dsc_f WHERE dsc_f.stem = COALESCE(sm.stem, LOWER(kw)))
                      )
                    GROUP BY cm.primary_ext_id, cm.media_type
                ),
                -- Filter out movies with hard-filtered stems
                filtered_movies AS (
                    SELECT cm.*
                    FROM candidate_movies cm
                    LEFT JOIN movie_stems ms ON cm.primary_ext_id = ms.primary_ext_id AND cm.media_type = ms.media_type
                    WHERE NOT EXISTS (
                        SELECT 1 FROM hard_filtered_stems hfs
                        WHERE hfs.stem = ANY(ms.stems)
                    )
                    OR ms.stems IS NULL
                ),
                -- Calculate scores using JOINs instead of correlated subqueries
                scored_movies AS (
                    SELECT
                        fm.*,
                        CASE
                            WHEN fm.library_embedding IS NOT NULL AND up.catalog_embedding IS NOT NULL
                            THEN 1 - (fm.library_embedding <=> up.catalog_embedding)
                            -- Missing embedding → 0 (not 0.5): unscored shorts should
                            -- not borrow a half-match boost over genuinely similar ones.
                            ELSE 0
                        END as ai_similarity,
                        ${buildDamperPenalty(sql, sql`fm.library_embedding`, damper)} as damper_pen,
                        -- Kids/family genre matches (Family 10751, Kids 10762) — soft
                        -- down-rank signal only, never a hard exclusion.
                        (
                            SELECT COUNT(*)
                            FROM unnest(fm.genres) g
                            WHERE g = ANY(${KIDS_GENRE_IDS})
                        ) as kids_genre_matches,
                        COALESCE(lk.total_likes, 0) as liked_keyword_overlap,
                        COALESCE(dk.total_dislikes, 0) as disliked_keyword_overlap,
                        COALESCE(lg.total_likes, 0) as liked_genre_overlap,
                        COALESCE(dg.total_dislikes, 0) as disliked_genre_overlap,
                        COALESCE(lyb.like_count, 0) as liked_year_overlap,
                        COALESCE(dyb.dislike_count, 0) as disliked_year_overlap
                    FROM filtered_movies fm
                    CROSS JOIN user_profile up
                    -- Keyword overlaps via pre-computed stems
                    LEFT JOIN movie_stems ms ON fm.primary_ext_id = ms.primary_ext_id AND fm.media_type = ms.media_type
                    LEFT JOIN LATERAL (
                        SELECT SUM(lsc.like_count) as total_likes
                        FROM liked_stem_counts lsc
                        WHERE lsc.stem = ANY(ms.stems)
                    ) lk ON true
                    LEFT JOIN LATERAL (
                        SELECT SUM(dsc.dislike_count) as total_dislikes
                        FROM disliked_stem_counts dsc
                        WHERE dsc.stem = ANY(ms.stems)
                    ) dk ON true
                    -- Genre overlaps
                    LEFT JOIN LATERAL (
                        SELECT SUM(lgc.like_count) as total_likes
                        FROM liked_genre_counts lgc
                        WHERE lgc.genre_id = ANY(fm.genres)
                    ) lg ON true
                    LEFT JOIN LATERAL (
                        SELECT SUM(dgc.dislike_count) as total_dislikes
                        FROM disliked_genre_counts dgc
                        WHERE dgc.genre_id = ANY(fm.genres)
                    ) dg ON true
                    -- Year overlaps (simple lookup by pre-computed bucket)
                    LEFT JOIN liked_year_buckets lyb ON lyb.year_bucket = fm.year_bucket
                    LEFT JOIN disliked_year_buckets dyb ON dyb.year_bucket = fm.year_bucket
                ),
                deduped AS (
                    SELECT DISTINCT ON (primary_ext_id, media_type)
                        internal_id, primary_ext_id, title, media_type, runtime_minutes, imdb_rating, mdblist_score,
                        release_date, trailer_url, is_available, can_request, mdblist_keywords, genres,
                        ai_similarity, damper_pen, liked_keyword_overlap, disliked_keyword_overlap,
                        liked_genre_overlap, disliked_genre_overlap, liked_year_overlap, disliked_year_overlap,
                        -- Pre-calculate combined score for sorting
                        (
                            ai_similarity * ${forYouConfig.weightAiSimilarity}::numeric +
                            (COALESCE(mdblist_score, 0) / 100.0) * ${forYouConfig.weightMdblistScore}::numeric +
                            (COALESCE(imdb_rating, 0) / 10.0) * ${forYouConfig.weightImdbRating}::numeric +
                            (liked_keyword_overlap * ${forYouConfig.weightLikedKeyword}::numeric) -
                            (disliked_keyword_overlap * ${forYouConfig.weightDislikedKeyword}::numeric) +
                            (liked_genre_overlap * ${forYouConfig.weightLikedGenre}::numeric) -
                            (disliked_genre_overlap * ${forYouConfig.weightDislikedGenre}::numeric) +
                            (liked_year_overlap * ${forYouConfig.weightLikedYear}::numeric) -
                            (disliked_year_overlap * ${forYouConfig.weightDislikedYear}::numeric) -
                            -- Soft cluster (kids/anime) down-rank (flat penalty, no
                            -- exclusion). combined_score's default-weight ceiling is
                            -- ~0.6 baseline (ai/mdblist/imdb) plus at most a point or
                            -- two from liked/disliked keyword+genre+year overlaps, so
                            -- 5.0 reliably outranks every realistic non-cluster
                            -- candidate while never being large enough to matter
                            -- beyond ranking.
                            (CASE WHEN (${suppressKidsContent} AND kids_genre_matches > 0)
                                  OR (${suppressAnimeContent} AND is_anime)
                             THEN 5.0 ELSE 0 END)
                        ) as combined_score
                    FROM scored_movies
                    ORDER BY primary_ext_id, media_type, combined_score DESC
                ),
                -- Per-class cap: the pool has no availability signal in its ORDER BY,
                -- and media_items mixes library (available) + discovery (unavailable)
                -- rows. A single mixed LIMIT lets discovery rows crowd out available
                -- short movies entirely before the strategy's showUnavailableMedia
                -- filter runs (same crowd-out class as the availability_ranked CTE
                -- in for-you-helpers.queries.ts).
                availability_ranked AS (
                    SELECT *, ROW_NUMBER() OVER (
                        PARTITION BY is_available
                        ORDER BY combined_score - GREATEST(combined_score, 0) * ${DAMPER_LAMBDA}::numeric * damper_pen DESC
                    ) as availability_rank
                    FROM deduped
                )
                SELECT
                    internal_id, primary_ext_id, title, media_type, runtime_minutes, imdb_rating, mdblist_score,
                    release_date, trailer_url, is_available, can_request, mdblist_keywords, genres,
                    ai_similarity, liked_keyword_overlap, disliked_keyword_overlap,
                    liked_genre_overlap, disliked_genre_overlap, liked_year_overlap, disliked_year_overlap
                FROM availability_ranked
                WHERE availability_rank <= ${limit * 5}
                -- "Show less like this": attenuate only the positive part of the
                -- score (a negative score must not be boosted toward 0), so the
                -- effect is scale-invariant and never re-ranks bottom items up.
                ORDER BY combined_score - GREATEST(combined_score, 0) * ${DAMPER_LAMBDA}::numeric * damper_pen DESC
            `;

            logger.debug('Short movies query result', {
                userId,
                count: movies.length,
                sample: movies.slice(0, 3).map((m) => ({
                    title: m.title,
                    ai_sim: m.ai_similarity,
                    imdb: m.imdb_rating,
                })),
            });
        } else {
            // Query without AI personalization - just use ratings with quality filter (UUID-based)
            logger.debug('Fetching short movies without AI (no profile)', {
                userId,
            });

            movies = await sql<ShortMovieRow[]>`
                WITH candidate_movies AS (
                    SELECT
                        mi.id::text as internal_id,
                        primary_ext.external_id as primary_ext_id,
                        mi.title,
                        mi.media_type,
                        ms.runtime_minutes as runtime_minutes,
                        ms.imdb_rating::float as imdb_rating,
                        ms.mdblist_score as mdblist_score,
                        ms.release_date as release_date,
                        ms.trailer_url as trailer_url,
                        ms.overview as overview,
                        ms.rt_rating as rt_critic,
                        ms.rt_audience_score as rt_audience,
                        ms.release_year as release_year,
                        ${isAvailableExpr(sql)} AS is_available,
                        ${canRequestExpr(sql)} AS can_request,
                        -- No user profile → no AI match signal (0, not a 0.5 freebie).
                        0 as ai_similarity,
                        -- Soft cluster (kids/anime) down-rank (flat penalty on the
                        -- primary 0-100 mdblist_score sort key, no exclusion). The
                        -- quality filter below requires imdb_rating >= 5.5 OR
                        -- mdblist_score >= 55, so subtracting 60 reliably drops a
                        -- match below every qualifying non-cluster candidate while
                        -- leaving it in the pool (LIMIT below still includes it).
                        (
                            COALESCE(ms.mdblist_score, 0) -
                            (CASE WHEN (
                                ${suppressKidsContent} AND EXISTS (
                                    SELECT 1 FROM media_genres mg
                                    WHERE mg.media_id = mi.id
                                      AND mg.source = ms.source
                                      AND mg.genre_id = ANY(${KIDS_GENRE_IDS})
                                )
                              ) OR (
                                ${suppressAnimeContent} AND (
                                    EXISTS (
                                        SELECT 1 FROM media_keywords mk_anime
                                        WHERE mk_anime.media_id = mi.id AND mk_anime.source = ms.source
                                          AND mk_anime.keyword_type = 'mdblist' AND mk_anime.keyword = 'anime'
                                    )
                                    OR (
                                        EXISTS (
                                            SELECT 1 FROM media_genres mg_anime
                                            WHERE mg_anime.media_id = mi.id AND mg_anime.source = ms.source
                                              AND mg_anime.genre_id = ${ANIME_GENRE_ID}
                                        )
                                        AND EXISTS (
                                            SELECT 1 FROM provider_metadata pm_anime
                                            WHERE pm_anime.media_id = mi.id AND pm_anime.provider = ms.source
                                              AND pm_anime.metadata->>'original_language' = 'ja'
                                        )
                                    )
                                )
                            ) THEN 60 ELSE 0 END)
                        ) as sort_score
                    -- Inverted scan: drive FROM media_scalars so the runtime/imdb/mdblist/
                    -- release_date predicates hit the column indexes (bitmap), then keep only
                    -- the winning-provider row per media_id — equivalent to the LATERAL pick,
                    -- ~12× faster (see buildWinningSourceScalarFilter).
                    FROM media_scalars ms
                    JOIN media_items mi ON mi.id = ms.media_id AND mi.status = 'active' AND mi.media_type = 'movie'
                    JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
                    WHERE ms.runtime_minutes IS NOT NULL
                      AND ms.runtime_minutes > 0
                      AND ms.runtime_minutes < 90
                      -- Quality filter: require at least one rating (no unknown quality)
                      AND (ms.imdb_rating >= 5.5 OR ms.mdblist_score >= 55)
                      -- Baseline date filter for short movies section
                      AND ms.release_date >= '1970-01-01'
                      AND ${buildWinningSourceScalarFilterFragment(sql)}
                      -- Exclude already watched content. Scope by media_type so a watched
                      -- TV show with the same numeric TMDB ID can never suppress a movie
                      -- candidate (TMDB IDs are not unique across media types).
                      ${watchedTmdbIds.length > 0 ? sql`AND NOT (primary_ext.media_type = 'movie' AND primary_ext.external_id = ANY(${watchedTmdbIds.map(String)}::text[]))` : sql``}
                      ${buildAgeRatingFilter(sql, access.age)}
                      ${buildLibraryAccessFilter(sql, access.library)}
                ),
                -- Per-class cap: the pool above has no availability signal in its
                -- ORDER BY, and media_items mixes library (available) + discovery
                -- (unavailable) rows. A single mixed LIMIT lets discovery rows crowd
                -- out available short movies entirely before the strategy's
                -- showUnavailableMedia filter runs (same crowd-out class as the
                -- availability_ranked CTE in for-you-helpers.queries.ts).
                availability_ranked AS (
                    SELECT *, ROW_NUMBER() OVER (
                        PARTITION BY is_available
                        ORDER BY sort_score DESC, imdb_rating DESC
                    ) as availability_rank
                    FROM candidate_movies
                )
                SELECT
                    internal_id, primary_ext_id, title, media_type, runtime_minutes, imdb_rating, mdblist_score,
                    release_date, trailer_url, overview, rt_critic, rt_audience, release_year,
                    is_available, can_request, ai_similarity
                FROM availability_ranked
                WHERE availability_rank <= ${limit * 5}
                ORDER BY sort_score DESC, imdb_rating DESC
            `;
        }

        // Banded (quartile) shuffle among top results to add variety. A full
        // shuffle of the limit×5 scored pool would be a uniform random pick and
        // throw away the AI/quality ranking entirely; banding keeps the
        // top-ranked candidates ahead of the rest while still rotating order
        // within each band daily. Cap each availability class independently
        // afterward (not a blind slice) so the strategy's downstream
        // showUnavailableMedia filter isn't starved when discovery (unavailable)
        // rows dominate the pool.
        const shuffled = capByAvailabilityClass(
            bandedShuffle(movies, dailyRotationSeed(), 4),
            limit,
            (m) => !!m.is_available,
        );

        return shuffled.map((movie) => ({
            externalIds: createExternalIds({
                [getPrimaryExternalIdProvider()]: movie.primary_ext_id,
                internal: movie.internal_id ?? undefined,
            }),
            mediaType: movie.media_type || 'movie',
            title: movie.title,
            runtimeMinutes: movie.runtime_minutes,
            imdbRating: movie.imdb_rating ?? undefined,
            mdblistScore: movie.mdblist_score ?? undefined,
            isAvailable: movie.is_available || false,
            canRequest: movie.can_request || false,
            aiSimilarity: movie.ai_similarity ? Math.round(movie.ai_similarity * 100) : null,
            trailerUrl: movie.trailer_url || undefined,
            overview: movie.overview || undefined,
            rtCritic: movie.rt_critic ?? undefined,
            rtAudience: movie.rt_audience ?? undefined,
            year: movie.release_year ?? undefined,
        }));
    } catch (error) {
        logger.warn('Failed to fetch short movies', {}, error as Error);
        return [];
    }
}

/**
 * Fulfilled Request - a user's request that is now available to watch
 */
export interface FulfilledRequest {
    externalIds: ExternalIds;
    mediaType: 'movie' | 'tv';
    title: string;
    posterUrl?: string;
    backdropUrl?: string;
    overview?: string;
    releaseDate?: string;
    requestDate: string;
    fulfilledDate?: string;
    imdbRating?: number;
    trailerUrl?: string;
    /**
     * True only when a playable (has_files=true) catalog row actually resolved
     * for this request. A request fulfilled in Jellyseerr is not guaranteed to
     * map to a playable row here (e.g. the file was ingested as a row that never
     * got cross-linked to the requested TMDB id). When false the card must not
     * claim "ready" — see transformFulfilledRequest.
     */
    isAvailable: boolean;
}

/**
 * Fetch user's requests that are now available (fulfilled)
 * Cross-references Jellyseerr requests with Jellyfin availability
 *
 * Filters:
 * - All fulfilled requests (no time limit)
 * - Dismissed items excluded via server-side request_dismissed flags
 * - Items already watched by the user are excluded
 */
export async function fetchFulfilledRequests(
    sql: postgres.Sql,
    username: string,
    options: { dismissedMediaIds?: ReadonlySet<string> } = {},
    access: MediaAccessBoundary,
): Promise<FulfilledRequest[]> {
    if (deniesEverything(access)) return [];
    try {
        const { jellyseerrClient } = await import('$lib/server/jellyseerr.js');

        // Get fulfilled requests from Jellyseerr
        const fulfilledRequests = await jellyseerrClient.getFulfilledRequestsForUser(username);

        if (fulfilledRequests.length === 0) {
            return [];
        }

        // Get TMDB IDs and titles from fulfilled requests for watch status check
        // NOTE: No time filter - show all fulfilled/personally fulfilled requests regardless of age
        // Jellyseerr API uses tmdbId field (not externalIds)
        const tmdbIds = fulfilledRequests.map((r) => r.media.tmdbId);

        // Filter: Exclude items the user has already watched
        // Use composite key (tmdbId:mediaType) to avoid TMDB ID collisions
        let watchedTmdbIds = new Set<string>();

        // watch_history.user_id and user_media_state.user_id are now uuid REFERENCES
        // users(id) (mig 16.46.0). The Jellyseerr call above legitimately needs the
        // username; resolve a users.id UUID only for the SQL binds below. No such
        // local user → skip the watched filter (better to show items than nothing).
        const uid = await getUserIdByUsername(sql, username);

        if (uid && tmdbIds.length > 0) {
            try {
                // Get watched items by checking watch_history joined with media_items (UUID-based)
                // watch_history tracks what the user watched, external_ids has tmdb_id
                // A title is considered "watched" if:
                // - For movies: is_completed = true OR watch progress > 80%
                // - For TV: Use user_watch_history table to check watch percentage (only exclude if >80% watched)
                const watchedResults = await sql<WatchedMediaRow[]>`
                    WITH user_watched_movies AS (
                        SELECT DISTINCT
                            vs.media_id,
                            LOWER(COALESCE(vs.series_name, vs.title)) as watched_title
                        FROM watch_history vs
                        WHERE vs.user_id = ${uid}::uuid
                          AND vs.media_type = 'movie'
                          AND (
                            vs.status = 'completed'
                            OR (vs.total_runtime_seconds > 0 AND vs.max_position_seconds::float / vs.total_runtime_seconds > 0.8)
                          )
                    )
                    -- Primary: match by media identity (watch_history.media_id -> external_ids),
                    -- not title, so two distinct movies sharing a title (remakes) don't cross-suppress.
                    SELECT DISTINCT ei.external_id as primary_ext_id, ei.media_type
                    FROM user_watched_movies uwm
                    JOIN external_ids ei ON ei.media_id = uwm.media_id AND ei.provider = ${getPrimaryExternalIdProvider()} AND ei.media_type = 'movie'
                    WHERE uwm.media_id IS NOT NULL
                      AND ei.external_id = ANY(${tmdbIds.map(String)}::text[])

                    UNION

                    -- Fallback for legacy watch_history rows with no media_id: best-effort title match
                    SELECT DISTINCT primary_ext.external_id as primary_ext_id, mi.media_type
                    FROM media_items mi
                    JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
                    JOIN user_watched_movies uwm ON uwm.media_id IS NULL AND LOWER(mi.title) = uwm.watched_title
                    WHERE mi.status = 'active'
                      AND primary_ext.external_id = ANY(${tmdbIds.map(String)}::text[])
                      AND mi.media_type = 'movie'

                    UNION

                    -- For TV shows: exclude if user has watched any episode
                    -- (simplified check - user_media_state tracks per-show, not per-episode)
                    SELECT DISTINCT primary_ext.external_id as primary_ext_id, primary_ext.media_type
                    FROM user_media_state uwh
                    JOIN media_items mi_uwh ON mi_uwh.id = uwh.media_id
                    JOIN external_ids primary_ext ON primary_ext.media_id = uwh.media_id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi_uwh.media_type
                    WHERE uwh.user_id = ${uid}::uuid
                      AND uwh.is_watched = true
                      AND primary_ext.media_type = 'tv'
                      AND primary_ext.external_id = ANY(${tmdbIds.map(String)}::text[])
                `;

                // Use composite key (tmdbId:mediaType) to avoid TMDB ID collisions
                // Same TMDB ID can be both a movie AND a TV show (e.g., ID 1429)
                watchedTmdbIds = new Set(
                    watchedResults.map((r) => `${r.primary_ext_id}:${r.media_type}`),
                );
                logger.debug(
                    `Found ${watchedTmdbIds.size} already-watched items from fulfilled requests`,
                );
            } catch (dbError) {
                logger.warn('Failed to check watched status from database', {}, dbError as Error);
                // Continue without filtering - better to show potentially watched items than nothing
            }
        }

        const dbDataMap = new Map<
            string,
            {
                internalId?: string;
                hasFiles: boolean;
                imdbRating?: number;
                trailerUrl?: string;
            }
        >();
        if (tmdbIds.length > 0) {
            try {
                const batchResults = await sql<
                    {
                        primary_ext_id: string;
                        media_type: string;
                        internal_id: string;
                        has_files: boolean;
                        imdb_rating: number | null;
                        trailer_url: string | null;
                    }[]
                >`
                    SELECT
                        ei_primary.external_id as primary_ext_id,
                        mi.media_type,
                        mi.id as internal_id,
                        mi.has_files,
                        (pm.metadata->>'imdb_rating')::float as imdb_rating,
                        pm.metadata->>'trailer_url' as trailer_url
                    FROM media_items mi
                    JOIN external_ids ei_primary ON ei_primary.media_id = mi.id
                        AND ei_primary.provider = ${getPrimaryExternalIdProvider()}
                        AND ei_primary.media_type = mi.media_type
                    ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
                    WHERE mi.status = 'active'
                      AND ei_primary.external_id = ANY(${tmdbIds.map(String)}::text[])
                      ${buildLibraryAccessFilter(sql, access.library)}
                      ${buildAgeRatingFilter(sql, access.age)}
                    ORDER BY mi.has_files DESC
                `;

                for (const row of batchResults) {
                    const compositeKey = `${row.primary_ext_id}:${row.media_type}`;
                    const existing = dbDataMap.get(compositeKey);
                    // A TMDB id can map to more than one active row (e.g. a
                    // file-less discovery duplicate alongside the real file row).
                    // `ORDER BY has_files DESC` surfaces the playable row first;
                    // once a has_files=true row is recorded for a key, never let a
                    // later file-less row clobber it.
                    if (existing?.hasFiles && !row.has_files) {
                        continue;
                    }
                    dbDataMap.set(compositeKey, {
                        internalId: row.internal_id,
                        hasFiles: row.has_files,
                        imdbRating: row.imdb_rating ?? undefined,
                        trailerUrl: row.trailer_url ?? undefined,
                    });
                }
            } catch (batchError) {
                logger.warn(
                    'Failed to batch lookup DB data for fulfilled requests',
                    {},
                    batchError as Error,
                );
            }
        }

        const results: FulfilledRequest[] = [];

        const dismissedMediaIds = options.dismissedMediaIds;

        // First pass: drop watched/dismissed requests so we only issue Jellyseerr
        // detail calls for items we will actually surface.
        const visibleRequests = fulfilledRequests.filter((request) => {
            const compositeKey = `${request.media.tmdbId}:${request.type}`;
            if (watchedTmdbIds.has(compositeKey)) {
                return false;
            }

            // Server-side anti-join against `request_dismissed` flags. The
            // internal UUID may be missing for items that exist in
            // Jellyseerr but not in our catalog — those can't be dismissed
            // anyway since the user_media_flags target_id is FK'd to
            // media_items.id, so skipping the check for unmatched rows is
            // correct.
            const internalIdForDismissal = dbDataMap.get(compositeKey)?.internalId;
            if (
                dismissedMediaIds &&
                internalIdForDismissal &&
                dismissedMediaIds.has(internalIdForDismissal)
            ) {
                return false;
            }

            return true;
        });

        // Fetch per-item TMDB display metadata concurrently instead of
        // sequentially (the previous `await` inside the loop issued N serial
        // HTTP round-trips to Jellyseerr).
        const detailResults = await Promise.allSettled(
            visibleRequests.map((request) =>
                jellyseerrClient.getMediaByTmdbId(request.media.tmdbId, request.type),
            ),
        );

        for (let i = 0; i < visibleRequests.length; i++) {
            const request = visibleRequests[i];
            const tmdbId = request.media.tmdbId;
            const mediaType = request.type;
            const compositeKey = `${tmdbId}:${mediaType}`;
            const detail = detailResults[i];

            if (detail.status === 'rejected') {
                logger.warn(
                    `Failed to get details for request ${request.id}`,
                    {},
                    detail.reason as Error,
                );
                continue;
            }

            const mediaDetails = detail.value;

            const dbData = dbDataMap.get(compositeKey);
            const externalIds: ExternalIds = {
                [getPrimaryExternalIdProvider()]: String(tmdbId),
                ...(dbData?.internalId ? { internal: dbData.internalId } : {}),
            };
            const imdbRating = dbData?.imdbRating;
            const trailerUrl = dbData?.trailerUrl;

            const tmdbIdForTitle = getExternalIdFor(externalIds, 'tmdb');
            results.push({
                externalIds,
                mediaType,
                // Only "ready" if a playable (has_files=true) catalog row
                // actually resolved. A fulfilled Jellyseerr request whose
                // only local match is a file-less discovery row is NOT
                // playable here — claiming it is causes a 404 on click/play.
                isAvailable: dbData?.hasFiles ?? false,
                title:
                    mediaDetails?.title ||
                    mediaDetails?.name ||
                    `${isMovie(mediaType) ? 'Movie' : 'TV Show'} #${tmdbIdForTitle}`,
                // Route through proxy for WebP conversion (provider-agnostic)
                posterUrl:
                    mediaDetails?.posterPath && getExternalIdFor(externalIds, 'internal')
                        ? getCatalogPosterUrl(getExternalIdFor(externalIds, 'internal')!, {
                              size: 'thumb',
                          })
                        : undefined,
                backdropUrl:
                    mediaDetails?.backdropPath && getExternalIdFor(externalIds, 'internal')
                        ? getCatalogBackdropUrl(getExternalIdFor(externalIds, 'internal')!, {
                              size: 'card',
                          })
                        : undefined,
                overview: mediaDetails?.overview,
                releaseDate: mediaDetails?.releaseDate || mediaDetails?.firstAirDate,
                requestDate: request.createdAt,
                fulfilledDate: request.media.updatedAt,
                imdbRating,
                trailerUrl,
            });
        }

        logger.debug(
            `Returning ${results.length} fulfilled requests for ${username} (filtered: unwatched + not-dismissed)`,
        );
        return results;
    } catch (error) {
        logger.warn('Failed to fetch fulfilled requests', {}, error as Error);
        return [];
    }
}

// =============================================================================
// Music Recommendations
// =============================================================================

const MUSIC_RECOMMENDATIONS_LIMIT = 12;

/**
 * Transform a BecauseYouListenedRow into a UniversalMediaItem for music tracks.
 */
function transformBecauseYouListenedRow(row: BecauseYouListenedRow): UniversalMediaItem {
    return {
        id: `music-byl-${row.id}`,
        externalIds: { internal: row.id },
        mediaType: 'track',
        title: row.title,
        subtitle: row.artist_title || undefined,
        // NOT `custom_poster_url ?? placeholder`: that column is only the
        // track's OWN cover, and 22,411 of the 29,980 production tracks have
        // none — every one of them got the placeholder while the byte route
        // would have inherited real art from the album or artist. `fallback:
        // 'none'` (inside musicCoverUrl) makes a genuine miss a 404, which the
        // card's own onerror turns into its placeholder.
        image: musicCoverUrl({ id: row.id, size: 'card' }),
        aspectRatio: 'square',
        isAvailable: true,
        canRequest: false,
    };
}

/**
 * Fetch "Because You Listened To" music recommendations.
 *
 * Finds the user's most recently played audio track, then returns
 * similar tracks via embedding cosine similarity, as a PageSection.
 *
 * Returns null if the user has no music play history or if there are
 * no embedding-based results.
 *
 * @param sql - PostgreSQL connection
 * @param userId - Username used for watch_history lookup
 */
export async function fetchMusicRecommendations(
    sql: postgres.Sql,
    userId: UserId,
    access: MediaAccessBoundary,
): Promise<PageSection | null> {
    if (deniesEverything(access)) return null;
    const legacyAccess = toLegacyAccessPair(access);
    try {
        // Pull a small recently-played pool: the first entry seeds the section,
        // but ALL of them are excluded from the results so we don't recommend
        // tracks the user just heard (the section endpoint excludes 20 — match
        // that here instead of only excluding the single seed track).
        const recentTracks = await getRecentlyPlayed(sql, userId, 20);
        if (recentTracks.length === 0) {
            return null;
        }

        const sourceTrack = recentTracks[0];
        const recentExcludeIds = recentTracks.map((t) => t.id);
        // Best-effort: never let a dislike-lookup failure null an otherwise-fine
        // section — degrade to no extra exclusions.
        const dislikedIds = await getDislikedTrackIds(sql, userId).catch((err) => {
            logger.warn('Disliked track lookup failed for music recommendations', err as Error);
            return [] as string[];
        });

        const recommendations = await getMusicBecauseYouListened(
            sql,
            sourceTrack.id,
            recentExcludeIds,
            MUSIC_RECOMMENDATIONS_LIMIT,
            legacyAccess,
            dislikedIds,
        );

        if (recommendations.length === 0) {
            return null;
        }

        // Anchor on the artist, falling back to the track title. We deliberately
        // do NOT fall back to album_title: a compilation/album name (e.g.
        // "Greatest Hits") is a misleading anchor for a "Because You Listened
        // To…" header, whereas the track title is always meaningful.
        const anchorTitle = sourceTrack.artist_title ?? sourceTrack.title;
        const sectionTitle = m.music_because_you_listened({ title: anchorTitle });

        // NOT gated on either `custom_poster_url`: the byte route inherits
        // track -> album -> artist, so a seed track with no cover of its own
        // still resolves one. Reading the raw columns left the rail's header
        // image blank for the 22,411 of 29,980 production tracks that carry no
        // artwork on their own row.
        const sourceImage = musicCoverUrl({ id: sourceTrack.id, size: 'card' });

        const section: PageSection = {
            id: `music-because-${sourceTrack.id}`,
            type: 'carousel',
            title: sectionTitle,
            items: recommendations.map(transformBecauseYouListenedRow),
            meta: {
                icon: 'musical-note',
                accentColor: 'purple',
                sourceImage,
                sourceTitle: sourceTrack.title,
            },
        };

        logger.debug('Music recommendations section built', {
            userId,
            sourceTrackId: sourceTrack.id,
            sourceTitle: sourceTrack.title,
            count: recommendations.length,
        });

        return section;
    } catch (error) {
        logger.warn('Failed to fetch music recommendations', {}, error as Error);
        return null;
    }
}
