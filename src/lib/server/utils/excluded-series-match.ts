// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The "did the user mute this?" predicates, on their own.
 *
 * Split out of `excluded-series.ts` deliberately: that module reaches the cache
 * manager and `getDb()` at import time, which transitively constructs the
 * TaskRegistry and reads config at module scope. Consumers that only need the
 * pure matching rules — and test suites that stub the DB-backed lookup — would
 * otherwise have to drag all of it in.
 *
 * Matching is by id only. A catalog item is muted when its UUID is in `itemIds`;
 * a Sonarr/Radarr-only row has no UUID and is muted by its TMDB id. Titles are
 * never compared: a row without a TMDB id is never muted, so muting "Lanterns"
 * cannot hide "Lanterns (2026)" or a movie called "Lanterns of Vell".
 *
 * @module server/utils/excluded-series-match
 */

/** A user's mutes in the keyings the matcher understands. */
export interface SeriesExclusions {
    /**
     * Catalog item ids (lowercase UUID text): muted series and muted movies,
     * plus every catalog item a TMDB key resolves to.
     */
    itemIds: ReadonlySet<string>;
    /** TMDB TV ids: muted monitored series, plus the TMDB id of every muted catalog series. */
    tmdbTv: ReadonlySet<string>;
    /** TMDB movie ids, same idea for movies. */
    tmdbMovie: ReadonlySet<string>;
    /**
     * TVDB ids of muted catalog series, for a Sonarr row whose TMDB id is
     * missing or differs from the catalog's.
     */
    tvdbTv: ReadonlySet<string>;
    /**
     * A TMDB mute matched no catalog item yet. The title may be ingested soon,
     * so the cached set should expire early.
     */
    unresolvedTmdb?: boolean;
}

export const NO_EXCLUSIONS: SeriesExclusions = {
    itemIds: new Set(),
    tmdbTv: new Set(),
    tmdbMovie: new Set(),
    tvdbTv: new Set(),
};

export function hasExclusions(ex: SeriesExclusions): boolean {
    return ex.itemIds.size > 0 || ex.tmdbTv.size > 0 || ex.tmdbMovie.size > 0 || ex.tvdbTv.size > 0;
}

/** JSON-safe form for the cache layer. */
export interface SerializedSeriesExclusions {
    itemIds: string[];
    tmdbTv: string[];
    tmdbMovie: string[];
    tvdbTv: string[];
    unresolvedTmdb?: boolean;
}

export function serializeExclusions(ex: SeriesExclusions): SerializedSeriesExclusions {
    return {
        itemIds: [...ex.itemIds],
        tmdbTv: [...ex.tmdbTv],
        tmdbMovie: [...ex.tmdbMovie],
        tvdbTv: [...ex.tvdbTv],
        unresolvedTmdb: ex.unresolvedTmdb === true,
    };
}

export function deserializeExclusions(raw: SerializedSeriesExclusions): SeriesExclusions {
    return {
        itemIds: new Set(raw.itemIds),
        tmdbTv: new Set(raw.tmdbTv),
        tmdbMovie: new Set(raw.tmdbMovie),
        tvdbTv: new Set(raw.tvdbTv ?? []),
        unresolvedTmdb: raw.unresolvedTmdb === true,
    };
}

type TmdbId = string | number | null | undefined;

/** A real provider id: arr payloads use 0 (or '') for "none". */
function hasTmdbId(tmdbId: TmdbId): tmdbId is string | number {
    return (
        tmdbId !== null && tmdbId !== undefined && String(tmdbId) !== '' && String(tmdbId) !== '0'
    );
}

/** Whether a catalog item (series or movie) is muted. */
export function isCatalogItemExcluded(
    ex: SeriesExclusions,
    itemId: string | null | undefined,
): boolean {
    return !!itemId && ex.itemIds.has(itemId.toLowerCase());
}

/**
 * Whether a TV row with no catalog id is muted, by its TMDB or TVDB id; a row
 * with neither never is.
 */
export function isMonitoredSeriesExcluded(
    ex: SeriesExclusions,
    tmdbId: TmdbId,
    tvdbId?: TmdbId,
): boolean {
    return (
        (hasTmdbId(tmdbId) && ex.tmdbTv.has(String(tmdbId))) ||
        (hasTmdbId(tvdbId) && ex.tvdbTv.has(String(tvdbId)))
    );
}

/** Movie counterpart of {@link isMonitoredSeriesExcluded}. */
export function isMonitoredMovieExcluded(ex: SeriesExclusions, tmdbId: TmdbId): boolean {
    return hasTmdbId(tmdbId) && ex.tmdbMovie.has(String(tmdbId));
}

/** The calendar row fields the predicate reads. */
export interface ExcludableCalendarRow {
    /** Episode or movie UUID; null for a monitored-only row. */
    id: string | null;
    title: string;
    media_type: string;
    series_name: string | null;
    /** Series UUID (episodes); on a monitored row only when its series is in the catalog. */
    series_id: string | null;
    tmdb_id: number | null;
}

/**
 * Whether one calendar row is muted by the user.
 *
 * The calendar query is cached globally and the mute is applied after it, in
 * the HTTP layer, so every consumer of `getCalendarItemsFromDb` (the REST
 * routes and the `get_upcoming_releases` assistant tool) must run this.
 */
export function isCalendarRowExcluded(ex: SeriesExclusions, row: ExcludableCalendarRow): boolean {
    if (!hasExclusions(ex)) return false;
    if (row.media_type === 'movie') {
        if (row.id) return isCatalogItemExcluded(ex, row.id);
        return isMonitoredMovieExcluded(ex, row.tmdb_id);
    }
    if (row.series_id && isCatalogItemExcluded(ex, row.series_id)) return true;
    // A Sonarr/Radarr-only row (no id of its own) may also carry its catalog
    // series id; its TMDB id still counts.
    if (!row.id) return isMonitoredSeriesExcluded(ex, row.tmdb_id);
    return false;
}
