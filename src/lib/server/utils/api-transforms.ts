// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * API Transform Utilities
 *
 * Functions for transforming database records to provider-agnostic API responses.
 * These ensure consistent response formats across all endpoints.
 */

import { personImageSet } from '$lib/server/services/image-descriptor/resources.js';
import type {
    ExternalIds,
    MediaListItem,
    RecommendedMediaItem,
    ProgressMediaItem,
} from '../../types/api-common.js';
import {
    selectBestRating,
    buildRatingsMap,
    pickDisplayRating,
    DEFAULT_RATING_PREFERENCE,
} from './rating-utils.js';
import type {
    AudiobookDetail,
    MovieDetail,
    TvDetail,
    Actor,
    Director,
    MediaNodeDetails,
} from '../../schemas/media-detail.js';
import { toApiMediaType, toDetailMediaType } from '$lib/shared/media-type-domain';
import { buildQualitySummary } from './media-quality-summary.js';
import { buildExternalIdsFromRow } from './external-id-builder.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import type { MediaDetailRow } from '../database/queries/media-details.queries.js';
import type { MediaStreamSummary } from '../database/queries/media-stream-summary.queries.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';

// =============================================================================
// Database Row Types
// =============================================================================

/**
 * Common fields from database queries
 */
export interface DbMediaRow {
    media_id: string;
    tmdb_id?: number | string;
    imdb_id?: string;
    tvdb_id?: number | string;
    trakt_id?: number | string;
    mal_id?: number | string;
    media_type: string;
    title: string;
    original_title?: string;
    original_language?: string;
    english_title?: string;
    overview?: string;
    tagline?: string;
    year?: number;
    poster_path?: string;
    backdrop_path?: string;
    // Rating fields (used by selectBestRating)
    imdb_rating?: number;
    tmdb_rating?: number;
    vote_average?: number; // TMDB's raw field name
    mdblist_score?: number;
    letterboxd_rating?: number;
    rt_rating?: number;
    rt_audience_score?: number;
    metacritic_score?: number;
    trakt_score?: number;
    mal_score?: number;
    // Other metadata
    popularity?: number;
    is_available?: boolean;
    can_request?: boolean;
    genres?: string[] | number[];
    runtime_minutes?: number;
    // Extended fields
    similarity?: number;
    reason?: string;
    source?: string;
    progress?: number;
    progress_ticks?: number;
    runtime_ticks?: number;
    last_played?: string;
    season_number?: number;
    episode_number?: number;
    series_title?: string;
    series_id?: string;
    // TV-specific fields
    first_air_date?: string;
    last_air_date?: string;
    status?: string;
    season_count?: number;
    episode_count?: number;
    networks?: string[];
    creators?: string[];
    // Detail fields
    keywords?: string[];
    certification?: string;
    trailer_url?: string;
    has_local_trailer?: boolean;
    /** File-backed extras (trailers, behind-the-scenes, featurettes, …) — raw DB shape */
    extras?: Array<{
        id: string;
        title: string;
        extra_type: string;
        runtime_seconds: number | null;
    }>;
    vote_count?: number;
    letterboxd_votes?: number;
    is_local_only?: boolean;
    // Best-available version quality (media_item_quality projection + best audio stream)
    resolution_tier?: string | null;
    hdr_tier?: string | null;
    hdr_type?: string | null;
    best_audio?: {
        codec: string | null;
        channels: number | null;
        channel_layout: string | null;
        profile: string | null;
    } | null;
    // Cast/crew — flat string arrays from DB JSONB
    actors?: unknown;
    directors?: unknown;
    // Structured cast/crew from provider_metadata JSONB (when available)
    cast_structured?: Array<{
        name: string;
        character?: string;
        /** Provider person id (TMDB) → headshot via /people/{id}/images/profile. */
        person_id?: string;
        profile_path?: string;
    }>;
    crew_structured?: Array<{
        name: string;
        job?: string;
        person_id?: string;
        profile_path?: string;
    }>;
}

// =============================================================================
// External IDs Helpers
// =============================================================================

/**
 * Build ExternalIds object from database row
 */
export function buildExternalIds(row: DbMediaRow): ExternalIds {
    return buildExternalIdsFromRow(row);
}

/**
 * Build ExternalIds from separate external_ids table records
 */
export function buildExternalIdsFromRecords(
    records: Array<{ provider: string; external_id: string }>,
): ExternalIds {
    const ids: ExternalIds = {};

    for (const record of records) {
        const provider = record.provider.toLowerCase();
        switch (provider) {
            case 'tmdb':
                ids.tmdb = record.external_id;
                break;
            case 'imdb':
                ids.imdb = record.external_id;
                break;
            case 'tvdb':
                ids.tvdb = record.external_id;
                break;
            case 'trakt':
                ids.trakt = record.external_id;
                break;
            case 'mal':
                ids.mal = record.external_id;
                break;
            case 'anilist':
                ids.anilist = record.external_id;
                break;
            // 'jellyfin' is deliberately not mapped: Jellyfin item ids are
            // sync-only and never part of an API response.
        }
    }

    return ids;
}

// =============================================================================
// Media Type Normalization
// =============================================================================

/**
 * `normalizeMediaType()` was REMOVED from this module.
 *
 * It was one of FOUR independent implementations of that name (the others were
 * in `media-transformer.service.ts`, `data-normalization.service.ts` and
 * `tasks/context-primitives.ts`), which is why fixing one of them never fixed
 * the others. All four are now one function:
 * `toApiMediaType()` / `toInternalMediaType()` in `$lib/shared/media-type-domain`.
 *
 * The old body ended in `default: return 'movie'`. That is what made
 * `isAudiobook(normalizeMediaType(x))` unreachable dead code — the guard read
 * correctly at the point of inspection and could never be true, because the
 * normalizer had already answered `'movie'`.
 *
 * `toApiMediaType()` returns `ApiMediaType | null`; `null` means the
 * four-member `ApiMediaTypeSchema` vocabulary (movie | series | episode |
 * season) genuinely cannot describe the row.
 */

// =============================================================================
// Transform Functions
// =============================================================================

/**
 * Transform database row to MediaListItem, or `null` when the row's media type
 * has no `ApiMediaType` representation.
 *
 * `MediaListItem.mediaType` is `ApiMediaType` — a closed four-member union
 * (movie | series | episode | season). An audiobook, track, album, channel or
 * home-video row cannot be described by it. This used to return a `MediaListItem`
 * with `mediaType: 'movie'` for all of them.
 *
 * DROPPING is the right call here rather than substituting: the consumer of a
 * `MediaListItem` uses `mediaType` to build the composite key it navigates with,
 * so a wrong type produces a card that opens the wrong thing — worse than no
 * card. {@link transformToMediaListItems} filters the nulls out.
 */
export function transformToMediaListItem(row: DbMediaRow): MediaListItem | null {
    const mediaType = toApiMediaType(row.media_type);
    if (mediaType === null) return null;

    // Use provider-aware rating selection with automatic normalization
    const { rating, ratingSource } = selectBestRating(row);

    return {
        id: row.media_id,
        externalIds: buildExternalIds(row),
        mediaType,
        title: row.title,
        originalTitle: row.original_title ?? undefined,
        englishTitle: row.english_title ?? undefined,
        overview: row.overview ?? undefined,
        year: row.year ?? undefined,
        posterPath: row.poster_path ?? undefined,
        backdropPath: row.backdrop_path ?? undefined,
        rating,
        ratingSource,
        isAvailable: row.is_available ?? false,
        canRequest: row.can_request ?? !row.is_available,
        genres: normalizeGenres(row.genres),
        runtime: row.runtime_minutes,
    };
}

/**
 * Transform database row to RecommendedMediaItem
 */
export function transformToRecommendedItem(row: DbMediaRow): RecommendedMediaItem | null {
    const base = transformToMediaListItem(row);
    if (base === null) return null;
    return {
        ...base,
        similarity: row.similarity,
        reason: row.reason,
        source: row.source,
    };
}

/**
 * Transform database row to ProgressMediaItem
 */
export function transformToProgressItem(row: DbMediaRow): ProgressMediaItem | null {
    const base = transformToMediaListItem(row);
    if (base === null) return null;
    return {
        ...base,
        progress: row.progress,
        progressTicks: row.progress_ticks,
        runtimeTicks: row.runtime_ticks,
        lastPlayed: row.last_played,
        seasonNumber: row.season_number,
        episodeNumber: row.episode_number,
        seriesTitle: row.series_title,
        seriesId: row.series_id,
    };
}

/**
 * Transform an array of database rows to MediaListItems
 */
export function transformToMediaListItems(rows: DbMediaRow[]): MediaListItem[] {
    // Rows with no ApiMediaType representation are dropped, not relabelled.
    return rows
        .map(transformToMediaListItem)
        .filter((item): item is MediaListItem => item !== null);
}

/**
 * Transform an array of database rows to RecommendedMediaItems
 */
export function transformToRecommendedItems(rows: DbMediaRow[]): RecommendedMediaItem[] {
    return rows
        .map(transformToRecommendedItem)
        .filter((item): item is RecommendedMediaItem => item !== null);
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Normalize genres from various formats to string array.
 * Exported for unit testing.
 */
export function normalizeGenres(
    genres: string[] | number[] | Array<{ id?: number; name?: string }> | null | undefined,
): string[] | undefined {
    if (!genres || genres.length === 0) return undefined;

    // Filter out null/undefined elements (can arrive from SQL arrays with NULL elements)
    const nonNull = (genres as unknown[]).filter((g) => g !== null && g !== undefined);
    if (nonNull.length === 0) return undefined;

    const first = nonNull[0];
    if (typeof first === 'string') {
        return nonNull.filter((s): s is string => typeof s === 'string');
    }
    if (typeof first === 'object' && 'name' in (first as object)) {
        return (nonNull as Array<{ name?: string }>)
            .map((g) => g.name)
            .filter((n): n is string => typeof n === 'string');
    }
    // Number IDs — convert to string but filter out NaN results
    return (nonNull as number[])
        .map(String)
        .filter((s) => s !== 'null' && s !== 'undefined' && s !== 'NaN');
}

/**
 * Create a minimal MediaListItem for error responses or placeholders
 */
export function createEmptyMediaItem(id: string, title: string = 'Unknown'): MediaListItem {
    return {
        id,
        externalIds: {},
        mediaType: 'movie',
        title,
        isAvailable: false,
        canRequest: false,
    };
}

// =============================================================================
// MediaDetail Transform (unified detail response)
// =============================================================================

/**
 * Parse a JSONB value into a flat string array.
 * Handles both already-parsed arrays and JSON strings.
 */
function parseJsonToStringArray(value: unknown): string[] | undefined {
    if (!value) return undefined;
    if (Array.isArray(value)) {
        return value
            .filter(
                (item): item is string | number =>
                    typeof item === 'string' || typeof item === 'number',
            )
            .map(String);
    }
    if (typeof value === 'string') {
        try {
            const parsed: unknown = JSON.parse(value);
            if (Array.isArray(parsed)) {
                return parsed
                    .filter(
                        (item): item is string | number =>
                            typeof item === 'string' || typeof item === 'number',
                    )
                    .map(String);
            }
        } catch {
            return undefined;
        }
    }
    return undefined;
}

/**
 * Parse actors from structured cast data or flat string array.
 * Structured data comes from provider_metadata JSONB cast arrays.
 */
function parseActorsForDetail(
    structured: DbMediaRow['cast_structured'],
    flatUnknown: unknown,
    surface: ApiSurface,
): Actor[] | undefined {
    if (structured && Array.isArray(structured) && structured.length > 0) {
        const mapped = structured
            .filter((c) => c && typeof c.name === 'string')
            .map((c) => {
                // The person-image proxy resolves ONLY numeric TMDB person ids;
                // emitting a URL for a non-numeric id would 404. Surface `tmdbId`
                // only when it's a genuine numeric id, and derive the proxied +
                // file-cached headshot from the same value.
                const tmdbId = c.person_id && /^\d+$/.test(c.person_id) ? c.person_id : undefined;
                return {
                    name: c.name,
                    character: c.character ?? undefined,
                    // Canonical person-image route, on the surface being served:
                    // the legacy `/api/image/person/{id}` is cookie-only and has
                    // no /api/v1 twin, so a Bearer client got 401/404 for it.
                    images: tmdbId ? personImageSet(surface, tmdbId, c.profile_path) : {},
                    tmdbId,
                };
            });
        // Only take the structured result when it actually yielded actors —
        // otherwise fall through to the flat names (matches parseDirectorsForDetail).
        if (mapped.length > 0) {
            return mapped;
        }
    }
    // Fall back to flat string array from DB
    const flat = parseJsonToStringArray(flatUnknown);
    if (flat && flat.length > 0) {
        return flat.map((name) => ({ name }));
    }
    return undefined;
}

/**
 * Parse directors from structured crew data or flat string array.
 * Structured data filters to job === 'director' from crew arrays.
 */
function parseDirectorsForDetail(
    structured: DbMediaRow['crew_structured'],
    flatUnknown: unknown,
    surface: ApiSurface,
): Director[] | undefined {
    if (structured && Array.isArray(structured) && structured.length > 0) {
        // Filter to directors only (structured crew includes all jobs)
        const directors = structured.filter(
            (c) => c && typeof c.name === 'string' && c.job?.toLowerCase() === 'director',
        );
        if (directors.length > 0) {
            return directors.map((c) => ({
                name: c.name,
                job: c.job ?? undefined,
                images: c.person_id ? personImageSet(surface, c.person_id, c.profile_path) : {},
            }));
        }
    }
    // Fall back to flat string array from DB
    const flat = parseJsonToStringArray(flatUnknown);
    if (flat && flat.length > 0) {
        return flat.map((name) => ({ name }));
    }
    return undefined;
}

/**
 * Map raw `extras` rows (snake_case, from the `media-details.queries.ts`
 * JSON aggregate) into the schema's camelCase shape. Returns undefined for
 * an empty/missing list so the field is omitted rather than an empty array
 * (matches the `.optional()` schema convention elsewhere in this module).
 */
function mapExtrasForDetail(
    extras: DbMediaRow['extras'],
): Array<{ id: string; title: string; extraType: string; durationMs?: number }> | undefined {
    if (!extras || extras.length === 0) return undefined;
    return extras.map((extra) => ({
        id: extra.id,
        title: extra.title,
        extraType: extra.extra_type,
        durationMs:
            extra.runtime_seconds == null ? undefined : Math.round(extra.runtime_seconds * 1000),
    }));
}

/**
 * Normalize TV series status to enum values.
 */
function normalizeTvStatus(
    status: string | undefined,
): 'Continuing' | 'Ended' | 'Canceled' | 'Planned' | undefined {
    if (!status) return undefined;
    const lower = status.toLowerCase();
    if (lower === 'continuing' || lower === 'returning series') {
        return 'Continuing';
    }
    if (lower === 'ended') return 'Ended';
    if (lower === 'canceled' || lower === 'cancelled') return 'Canceled';
    if (lower === 'planned' || lower === 'in production') return 'Planned';
    return undefined;
}

/**
 * Transform a database row to the unified MediaDetail response.
 *
 * This is the core transform for all detail endpoints.
 * Produces a MovieDetail, TvDetail or AudiobookDetail based on media_type —
 * the same three arms `MediaDetailSchema`'s discriminated union carries.
 *
 * @param row - Database row (extended DbMediaRow)
 * @param externalIds - External IDs to include in response
 * @returns MovieDetail, TvDetail or AudiobookDetail
 */
export function transformToMediaDetail(
    row: DbMediaRow,
    externalIds: ExternalIds,
    streamSummary?: MediaStreamSummary,
    surface: ApiSurface = 'internal',
    images: ImageSet = {},
): MovieDetail | TvDetail | AudiobookDetail | null {
    // Classified ONCE, from the RAW row.media_type, through the single owner of
    // the mapping. There is deliberately no second normalized copy of the type
    // in this function: the previous version kept both `detailType` and an
    // `apiMediaType` from a normalizer whose `default:` arm returned 'movie',
    // and mixing the two is what made the audiobook branch unreachable.
    //
    // `null` = MediaDetailSchema's closed union (movie | series | audiobook) has
    // no arm for this row: an episode, season, track, album, channel or
    // home-video. It used to be emitted as a MovieDetail, which is the same
    // failure as the audiobook bug with a different subject — a client reading
    // `type: 'movie'` renders "Watch Movie" for a single episode. Callers return
    // 404 or skip the expansion; see the call sites in
    // `api/defs/media/details.ts`, `catalog/media-id.ts`, `catalog/series-id.ts`.
    const detailType = toDetailMediaType(row.media_type);
    if (detailType === null) return null;
    // Gate the imdb/tmdb precedence on vote_count (pickDisplayRating) before
    // falling through to selectBestRating's OTHER sources (rt, letterboxd,
    // trakt, mdblist, mal) — those aren't affected by the tmdb vote_count bug,
    // so their fallback chain is preserved unchanged.
    const displayRating = pickDisplayRating({
        imdbRating: row.imdb_rating,
        tmdbRating: row.tmdb_rating ?? row.vote_average,
        voteCount: row.vote_count,
    });
    const otherSources = selectBestRating(row, {
        primary: [],
        fallback: DEFAULT_RATING_PREFERENCE.fallback,
    });
    const rating = displayRating ?? otherSources.rating;
    const ratingSource =
        displayRating !== undefined
            ? row.imdb_rating && row.imdb_rating > 0
                ? 'imdb'
                : 'tmdb'
            : otherSources.ratingSource;
    const ratingsMap = buildRatingsMap(row);
    const genres = normalizeGenres(row.genres);

    // Parse actors and directors (structured → flat fallback)
    const actors = parseActorsForDetail(row.cast_structured, row.actors, surface);
    const directors = parseDirectorsForDetail(row.crew_structured, row.directors, surface);

    // Base fields shared by movie and TV (canonical contract: `ids` + `images`,
    // not the legacy `externalIds` / `posterUrl` / `backdropUrl`).
    const base = {
        id: row.media_id,
        ids: externalIds as Record<string, string>,
        title: row.title,
        originalTitle: row.original_title ?? undefined,
        overview: row.overview ?? undefined,
        tagline: row.tagline?.trim() || undefined,
        images,
        genres,
        keywords: row.keywords ?? undefined,
        certification: row.certification ?? undefined,
        trailerUrl: row.trailer_url ?? undefined,
        hasLocalTrailer: row.has_local_trailer || undefined,
        extras: mapExtrasForDetail(row.extras),
        isAvailable: row.is_available ?? false,
        canRequest: row.can_request ?? !row.is_available,
        rating,
        ratingSource,
        ratings: ratingsMap,
        actors,
        directors,
        popularity: row.popularity ?? undefined,
        voteCount: row.vote_count ?? undefined,
        originalLanguage: row.original_language ?? undefined,
        audioLanguages: streamSummary?.audioLanguages,
        subtitleLanguages: streamSummary?.subtitleLanguages,
        quality: buildQualitySummary({
            resolutionTier: row.resolution_tier,
            hdrTier: row.hdr_tier,
            hdrType: row.hdr_type,
            bestAudio: streamSummary?.bestAudio ?? row.best_audio,
            hasClosedCaptions: streamSummary?.hasClosedCaptions,
            hasSDH: streamSummary?.hasSDH,
            hasAudioDescription: streamSummary?.hasAudioDescription,
        }),
    };

    if (detailType === 'audiobook') {
        // The book's own identity (authors / narrators / chapters) is NOT
        // available here — an ABS book keeps it in custom_metadata, which needs
        // a second query (getAudiobookNodeDetail) and rides the base node of
        // GET /media/{id} instead. Every AudiobookFieldsSchema field is
        // optional, so the honest type discriminator alone is a valid
        // AudiobookDetail; the modal reads the rich book fields off its own
        // /media/{id} fetch.
        const audiobookDetail: AudiobookDetail = {
            ...base,
            type: 'audiobook' as const,
            images: {},
            year: row.year ?? undefined,
        };
        return audiobookDetail;
    }

    // No `isSeries(...)` second opinion here any more. The legacy raw token
    // 'show' — the one reason the old code re-checked — is folded onto 'tv' by
    // `toInternalMediaType()` before the detail table is consulted, so
    // `detailType` already covers it. Re-applying a comparator to an
    // already-narrowed value is how the previous fix attempt hid its own bug.
    if (detailType === 'series') {
        const tvDetail: TvDetail = {
            ...base,
            type: 'series' as const,
            firstAirDate: row.first_air_date ?? undefined,
            lastAirDate: row.last_air_date ?? undefined,
            status: normalizeTvStatus(row.status),
            seasonCount: row.season_count ?? undefined,
            episodeCount: row.episode_count ?? undefined,
            networks: row.networks ?? undefined,
            creators: row.creators ?? undefined,
        };
        return tvDetail;
    }

    const movieDetail: MovieDetail = {
        ...base,
        type: 'movie' as const,
        year: row.year ?? undefined,
        runtime: row.runtime_minutes ?? undefined,
    };
    return movieDetail;
}

/**
 * Fields the parent `MediaNode` already carries at its own level — either on
 * `MediaNodeBaseSchema` (id/ids/title/year/overview/images) or added by
 * `MediaNodeMovieSchema`/`MediaNodeSeriesSchema` (isAvailable/canRequest/type).
 * MUST stay in sync with those schemas (media-detail.ts) — a field added to
 * either one without adding it here leaks a duplicate, undeclared key into
 * `details` (exactly the `year` regression this list was added to fix: Zod
 * silently drops unknown keys on `.parse()`, so nothing here catches a
 * missed field except the strict-decode test in api-transforms.test.ts).
 */
const NODE_LEVEL_FIELDS = [
    'id',
    'ids',
    'title',
    'year',
    'overview',
    'tagline',
    'images',
    'isAvailable',
    'canRequest',
    'type',
    // Cast and crew moved to the node-level `credits` (people with tmdb:N handles); the
    // details block no longer declares these legacy name lists.
    'actors',
    'directors',
    'creators',
    // Duration lives on the node as durationMs, not as a second runtime in minutes.
    'runtime',
] as const;

/**
 * Strip the fields the parent `MediaNode` already carries at its own level
 * from a `transformToMediaDetail()` result, leaving just the rich
 * augmentation — the shape of `MediaNode.details` (`?include=details` on
 * `GET /media/{id}` and `GET /series/{id}`). Keyed deletion (rather than
 * destructuring) sidesteps `year` only existing on `MovieDetail`, not
 * `TvDetail` — a union-destructure would fail to type-check for that field.
 */
export function toNodeDetailsExtra(
    detail: MovieDetail | TvDetail | AudiobookDetail,
): MediaNodeDetails {
    const extra: Record<string, unknown> = { ...detail };
    for (const key of NODE_LEVEL_FIELDS) delete extra[key];
    return extra as MediaNodeDetails;
}

/** ISO release/air date → release year, or undefined if absent/unparseable. */
export function computeYear(releaseDate: string | Date | null | undefined): number | undefined {
    if (!releaseDate) return undefined;
    const year = new Date(releaseDate).getFullYear();
    return isNaN(year) ? undefined : year;
}

/**
 * Map a `media-details.queries.ts` `MediaDetailRow` (the rich-query shape)
 * into `transformToMediaDetail()`'s `DbMediaRow` input. Shared by `GET
 * /api/media-details` (`defs/media/details.ts`) and the `?include=details`
 * expansion on `GET /media/{id}` / `GET /series/{id}` — both need the exact
 * same mapping so the rich shape they emit can't drift apart.
 */
export function toDbMediaRow(media: MediaDetailRow, genreNames: string[]): DbMediaRow {
    return {
        media_id: media.media_id,
        media_type: media.media_type,
        title: media.title,
        original_language: media.original_language ?? undefined,
        overview: media.overview ?? undefined,
        tagline: media.tagline ?? undefined,
        year: computeYear(media.release_date),
        poster_path: undefined,
        backdrop_path: undefined,
        imdb_rating: media.imdb_rating ?? undefined,
        tmdb_rating: media.tmdb_rating ?? undefined,
        rt_rating: media.rt_rating ?? undefined,
        rt_audience_score: media.rt_audience_score ?? undefined,
        letterboxd_rating: media.letterboxd_rating ?? undefined,
        letterboxd_votes: media.letterboxd_votes ?? undefined,
        metacritic_score: media.metacritic_score ?? undefined,
        trakt_score: media.trakt_score ?? undefined,
        mdblist_score: media.mdblist_score ?? undefined,
        popularity: media.popularity ?? undefined,
        vote_count: media.vote_count ?? undefined,
        runtime_minutes: media.runtime_minutes ?? undefined,
        genres: genreNames.length > 0 ? genreNames : undefined,
        keywords: media.keywords ?? undefined,
        actors: media.actors ?? undefined,
        cast_structured: media.cast_structured ?? undefined,
        directors: media.directors ?? undefined,
        certification: media.certification ?? undefined,
        has_local_trailer: media.has_local_trailer,
        extras: media.extras && media.extras.length > 0 ? media.extras : undefined,
        is_available: media.is_available,
        can_request: media.can_request,
        first_air_date: media.first_air_date ?? undefined,
        last_air_date: media.last_air_date ?? undefined,
        status: media.status ?? undefined,
        season_count: media.season_count ?? undefined,
        episode_count: media.episode_count ?? undefined,
        networks: media.networks ?? undefined,
        resolution_tier: media.resolution_tier ?? null,
        hdr_tier: media.hdr_tier ?? null,
        hdr_type: media.hdr_type ?? null,
        best_audio: media.best_audio ?? null,
    };
}

// =============================================================================
// Response Builders
// =============================================================================

/**
 * Build a successful API response
 */
export function buildSuccessResponse<T>(data: T): {
    success: true;
    data: T;
    timestamp: string;
} {
    return {
        success: true,
        data,
        timestamp: new Date().toISOString(),
    };
}

/**
 * Build an error API response
 */
export function buildErrorResponse(error: string): {
    success: false;
    error: string;
    timestamp: string;
} {
    return {
        success: false,
        error,
        timestamp: new Date().toISOString(),
    };
}
