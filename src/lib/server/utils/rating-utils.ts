// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Rating Utilities
 *
 * Provider-aware rating selection and normalization.
 * All ratings are normalized to a 0-10 scale for consistent display.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Known rating sources
 */
export type RatingSource =
    | 'imdb'
    | 'tmdb'
    | 'rt'
    | 'rt_audience'
    | 'metacritic'
    | 'letterboxd'
    | 'trakt'
    | 'mdblist'
    | 'mal';

/**
 * Rating value with source attribution
 */
export interface RatingValue {
    /** Normalized to 0-10 scale */
    value: number;
    /** Which rating source this is from */
    source: RatingSource;
    /** Original (raw) value before normalization */
    rawValue: number;
}

/**
 * Rating preference configuration
 */
export interface RatingPreference {
    /** Preferred rating sources in order */
    primary: RatingSource[];
    /** Fallback sources if primary unavailable */
    fallback: RatingSource[];
}

// =============================================================================
// Configuration
// =============================================================================

/**
 * Default rating preference order.
 * IMDB is preferred as the most recognized rating system,
 * followed by TMDB, then other sources.
 */
export const DEFAULT_RATING_PREFERENCE: RatingPreference = {
    primary: ['imdb', 'tmdb'],
    fallback: ['letterboxd', 'trakt', 'mdblist', 'rt', 'mal'],
};

/**
 * Rating scale normalization constants.
 * Each source has a max value and a normalize function to convert to 0-10.
 */
const RATING_SCALES: Record<RatingSource, { max: number; normalize: (v: number) => number }> = {
    imdb: { max: 10, normalize: (v) => v },
    tmdb: { max: 10, normalize: (v) => v },
    // letterboxd_rating is written by mdblist-sync from MDBList's `value`, and
    // MDBList reports Letterboxd ALREADY DOUBLED onto 0-10 — not the 0-5 stars
    // the site displays. Measured on the prod provider_metadata table
    // (2026-08-20): 23,754 rows spanning 2 → 10.2, 87.5% of them above 5, and
    // titles carrying both sources agree across scales (The Gatekeeper imdb 8.7
    // / letterboxd 9.0; Shawshank 8.7 / 9.2). The old `v * 2` therefore
    // double-doubled, emitting up to 20.4 and breaching the 0-10 response
    // contract on 18,674 items.
    letterboxd: { max: 10, normalize: (v) => v },
    rt: { max: 100, normalize: (v) => v / 10 }, // 0-100 → 0-10
    rt_audience: { max: 100, normalize: (v) => v / 10 },
    metacritic: { max: 100, normalize: (v) => v / 10 },
    trakt: { max: 100, normalize: (v) => v / 10 }, // trakt_score is 0-100
    mdblist: { max: 100, normalize: (v) => v / 10 }, // mdblist_score is 0-100
    mal: { max: 10, normalize: (v) => v },
};

/** Upper bound of the normalized scale — and of every rating-typed response field. */
const NORMALIZED_MAX = 10;

/**
 * Normalize a raw provider value onto 0-10 and CLAMP it into range.
 *
 * The clamp is not cosmetic: `rating` is declared `z.number().min(0).max(10)`
 * on the media-detail contract, so a provider that overshoots its own declared
 * scale (two prod rows store letterboxd_rating = 10.2) would otherwise fail
 * mount()'s response-conformance check and get the whole body rejected by a
 * strict generated client. Clamping keeps one bad upstream value from
 * invalidating an entire response.
 */
function normalizeToTenScale(raw: number, source: RatingSource): number {
    const normalized = RATING_SCALES[source].normalize(raw);
    return Math.min(NORMALIZED_MAX, Math.max(0, normalized));
}

/**
 * Is this raw provider value usable as a rating?
 *
 * Rejects null/undefined/NaN and NEGATIVE values. The negative check exists
 * because MDBList writes `-1` to mean "no score": 7 prod rows carry
 * mdblist_score = -1, and every one of them lacks imdb/tmdb/letterboxd/trakt,
 * so -1 was actually being selected and emitted as -0.1 — under `.min(0)`.
 *
 * Zero is deliberately still valid here (see the "treats 0 as valid rating"
 * tests); `pickDisplayRating` applies its own stricter `> 0` display gate.
 */
function isUsableRawRating(raw: number | undefined | null): raw is number {
    if (raw === undefined || raw === null) return false;
    const n = Number(raw);
    return !isNaN(n) && n >= 0;
}

// =============================================================================
// Database Row Interface
// =============================================================================

/**
 * Expected shape of database row containing rating fields.
 * Supports both direct fields and JSONB extracted fields.
 */
export interface RatingRow {
    imdb_rating?: number | null;
    tmdb_rating?: number | null;
    vote_average?: number | null; // TMDB's field name in raw API responses
    mdblist_score?: number | null;
    letterboxd_rating?: number | null;
    rt_rating?: number | null;
    rt_audience_score?: number | null;
    metacritic_score?: number | null;
    trakt_score?: number | null;
    mal_score?: number | null;
}

// =============================================================================
// Rating Selection Functions
// =============================================================================

/**
 * Select the best rating from a database row based on preference.
 * All ratings are normalized to 0-10 scale.
 *
 * @param row - Database row containing rating fields
 * @param preference - Rating source preference (optional, uses default if not provided)
 * @returns Object with normalized rating and source, or undefined values if no rating found
 *
 * @example
 * const { rating, ratingSource } = selectBestRating(row);
 * // rating: 7.8, ratingSource: 'imdb'
 *
 * @example
 * // Custom preference - prefer RT over IMDB
 * const { rating, ratingSource } = selectBestRating(row, {
 *     primary: ['rt', 'rt_audience'],
 *     fallback: ['imdb', 'tmdb']
 * });
 */
export function selectBestRating(
    row: RatingRow,
    preference: RatingPreference = DEFAULT_RATING_PREFERENCE,
): { rating: number | undefined; ratingSource: RatingSource | undefined } {
    // Map source names to row fields (raw values, not normalized yet)
    // Note: vote_average is TMDB's field name, treat it as TMDB source
    const ratingMap: Record<RatingSource, number | undefined | null> = {
        imdb: row.imdb_rating,
        tmdb: row.tmdb_rating ?? row.vote_average,
        mdblist: row.mdblist_score,
        letterboxd: row.letterboxd_rating,
        rt: row.rt_rating,
        rt_audience: row.rt_audience_score,
        metacritic: row.metacritic_score,
        trakt: row.trakt_score,
        mal: row.mal_score,
    };

    // Try primary sources first
    for (const source of preference.primary) {
        const raw = ratingMap[source];
        if (isUsableRawRating(raw)) {
            return {
                rating: normalizeToTenScale(Number(raw), source),
                ratingSource: source,
            };
        }
    }

    // Try fallback sources
    for (const source of preference.fallback) {
        const raw = ratingMap[source];
        if (isUsableRawRating(raw)) {
            return {
                rating: normalizeToTenScale(Number(raw), source),
                ratingSource: source,
            };
        }
    }

    return { rating: undefined, ratingSource: undefined };
}

/**
 * Minimum TMDB `vote_count` required before a `vote_average`-derived rating
 * may be displayed. Below this floor a handful of votes can produce a
 * misleading near-perfect score (e.g. a single 10/10 vote renders as a
 * bogus "★ 10.0" badge).
 */
export const MIN_DISPLAY_VOTE_COUNT = 50;

/**
 * Pick the rating value to actually display on a card/modal badge.
 *
 * Precedence: IMDB (when present and > 0) always wins. TMDB's `vote_average`
 * is only used as a fallback, and only when `voteCount` clears
 * {@link MIN_DISPLAY_VOTE_COUNT} — otherwise no rating is returned at all
 * (callers should hide the badge rather than show a 0 or an unqualified
 * TMDB score).
 *
 * @param input - imdbRating, tmdbRating (vote_average), and voteCount
 * @returns Display rating (0-10), or undefined if nothing qualifies
 *
 * @example
 * pickDisplayRating({ imdbRating: 7.8, tmdbRating: 8.0, voteCount: 3 }); // 7.8
 * pickDisplayRating({ tmdbRating: 8.0, voteCount: 200 }); // 8.0
 * pickDisplayRating({ tmdbRating: 10.0, voteCount: 1 }); // undefined
 * pickDisplayRating({ tmdbRating: 0, voteCount: 200 }); // undefined
 */
export function pickDisplayRating(input: {
    imdbRating?: number | null;
    tmdbRating?: number | null;
    voteCount?: number | null;
}): number | undefined {
    const { imdbRating, tmdbRating, voteCount } = input;

    if (imdbRating != null && imdbRating > 0) {
        return imdbRating;
    }

    // `> 0` mirrors the IMDb branch. A vote_average of exactly 0 means "no
    // score", not "the worst film ever made" — returning it renders a literal
    // "★ 0.0" badge and, in transformToMediaDetail, suppresses the mdblist/RT
    // fallback that would have produced a real number.
    if (
        tmdbRating != null &&
        tmdbRating > 0 &&
        voteCount != null &&
        voteCount >= MIN_DISPLAY_VOTE_COUNT
    ) {
        return tmdbRating;
    }

    return undefined;
}

/**
 * Get all available ratings from a row, normalized to 0-10 scale.
 * Useful for displaying multiple ratings or debugging.
 *
 * @param row - Database row containing rating fields
 * @returns Array of all available ratings with their sources
 *
 * @example
 * const ratings = getAllRatings(row);
 * // [
 * //   { value: 7.8, source: 'imdb', rawValue: 7.8 },
 * //   { value: 6.5, source: 'rt', rawValue: 65 }
 * // ]
 */
export function getAllRatings(row: RatingRow): RatingValue[] {
    const ratings: RatingValue[] = [];

    const sources: Array<{
        source: RatingSource;
        value: number | undefined | null;
    }> = [
        { source: 'imdb', value: row.imdb_rating },
        { source: 'tmdb', value: row.tmdb_rating ?? row.vote_average },
        { source: 'mdblist', value: row.mdblist_score },
        { source: 'letterboxd', value: row.letterboxd_rating },
        { source: 'rt', value: row.rt_rating },
        { source: 'rt_audience', value: row.rt_audience_score },
        { source: 'metacritic', value: row.metacritic_score },
        { source: 'trakt', value: row.trakt_score },
        { source: 'mal', value: row.mal_score },
    ];

    for (const { source, value } of sources) {
        if (isUsableRawRating(value)) {
            ratings.push({
                value: normalizeToTenScale(Number(value), source),
                source,
                rawValue: value,
            });
        }
    }

    return ratings;
}

/**
 * Normalize a rating value from a specific source to 0-10 scale.
 *
 * @param value - Raw rating value
 * @param source - Rating source for scale information
 * @returns Normalized value (0-10) or undefined if invalid input
 *
 * @example
 * normalizeRating(65, 'rt'); // 6.5
 * normalizeRating(3.5, 'letterboxd'); // 3.5 (MDBList reports letterboxd 0-10)
 */
export function normalizeRating(
    value: number | undefined | null,
    source: RatingSource,
): number | undefined {
    if (!isUsableRawRating(value)) {
        return undefined;
    }
    return normalizeToTenScale(Number(value), source);
}

/**
 * Get the maximum value for a rating source.
 * Useful for displaying rating scales in UI.
 *
 * @param source - Rating source
 * @returns Maximum value for that source's scale
 *
 * @example
 * getRatingMax('imdb'); // 10
 * getRatingMax('rt'); // 100
 * getRatingMax('letterboxd'); // 10
 */
export function getRatingMax(source: RatingSource): number {
    return RATING_SCALES[source].max;
}

/**
 * Format a rating value for display.
 * Rounds to 1 decimal place.
 *
 * @param value - Rating value (already normalized to 0-10)
 * @returns Formatted string or undefined if invalid
 *
 * @example
 * formatRating(7.82); // "7.8"
 * formatRating(undefined); // undefined
 */
export function formatRating(value: number | undefined | null): string | undefined {
    if (value === undefined || value === null || isNaN(value)) {
        return undefined;
    }
    return value.toFixed(1);
}

// =============================================================================
// Ratings Map Builder
// =============================================================================

/**
 * Build a flat ratings map from a database row.
 * Keys are source names, values are RAW values (not normalized).
 * This is used for the `ratings` field in MediaDetail responses.
 *
 * @param row - Database row containing rating fields
 * @returns Record of source name → raw rating value
 *
 * @example
 * buildRatingsMap(row);
 * // { imdb: 7.8, tmdb: 7.5, rtCritic: 85, letterboxd: 3.8 }
 */
export function buildRatingsMap(row: RatingRow): Record<string, number> | undefined {
    const map: Record<string, number> = {};

    const entries: Array<{
        key: string;
        value: number | undefined | null;
    }> = [
        { key: 'imdb', value: row.imdb_rating },
        { key: 'tmdb', value: row.tmdb_rating ?? row.vote_average },
        { key: 'rtCritic', value: row.rt_rating },
        { key: 'rtAudience', value: row.rt_audience_score },
        { key: 'letterboxd', value: row.letterboxd_rating },
        { key: 'metacritic', value: row.metacritic_score },
        { key: 'mdblist', value: row.mdblist_score },
        { key: 'trakt', value: row.trakt_score },
        { key: 'mal', value: row.mal_score },
    ];

    for (const { key, value } of entries) {
        if (value !== undefined && value !== null && !isNaN(Number(value))) {
            map[key] = Number(value);
        }
    }

    return Object.keys(map).length > 0 ? map : undefined;
}
