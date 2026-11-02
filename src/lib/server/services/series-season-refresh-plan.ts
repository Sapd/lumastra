// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which seasons a ROUTINE series re-sync has to fetch from TMDB.
 *
 * A re-sync used to refetch every season (`/tv/{id}/season/{n}`) even when
 * nothing changed: on prod, `airing-series-refresh` re-syncs ~420 airing series
 * about daily, which was ~6 TMDB calls per run and ~10.7k calls a week.
 * Finished seasons practically never change, so a routine run fetches:
 *
 *  - the two highest regular seasons (the airing one and the next announced);
 *  - any season we hold no episodes for yet (new season, never fetched);
 *  - any season whose episode count or air date in the `/tv/{id}` details
 *    differs from what we stored (TMDB added/removed episodes, moved a date);
 *  - EVERYTHING when a file-backed episode has no TMDB identity: the season
 *    structure / absolute-numbering reconcilers need the complete catalog.
 *
 * A routine run also fetches EVERY season when the last full season fetch is
 * older than {@link FULL_REFRESH_MAX_AGE_DAYS} (or was never recorded), which
 * closes the gap left by the rules above: an edit inside an old season that
 * keeps its count and air date. It is a window, not a calendar day, so a series
 * that is not synced every day is still refreshed on its next sync. The
 * timestamp lives in `provider_metadata.metadata->>'seasons_full_fetch_at'`
 * (provider 'tmdb'); the per-series threshold is spread over the last
 * {@link FULL_REFRESH_SPREAD_DAYS} days by an id hash so a first rollout does
 * not make every series full-refresh in lockstep forever.
 *
 * Specials (season 0) follow the same count/date rule but are never "latest":
 * an edit to an existing special that keeps count and date is only picked up
 * by an explicit/forced sync. Forced syncs never come through here.
 */

export interface SeasonListing {
    season_number: number;
    episode_count?: number;
    air_date?: string;
}

export interface StoredSeasonState {
    /** Episode rows stored under the season. */
    episodeCount: number;
    /** Stored season premiere date as YYYY-MM-DD, or null. */
    premiereDate: string | null;
}

/** How many of the highest regular seasons are always refreshed. */
export const ALWAYS_REFRESH_LATEST_SEASONS = 2;

/** Key in the series' tmdb `provider_metadata.metadata` holding the ISO time of the last full fetch. */
export const FULL_REFRESH_METADATA_KEY = 'seasons_full_fetch_at';
export const FULL_REFRESH_MAX_AGE_DAYS = 30;
export const FULL_REFRESH_SPREAD_DAYS = 7;

/** FNV-1a 32-bit: stable across processes and releases. */
function stableHash(value: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        h ^= value.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
}

/**
 * True when the last full season fetch (epoch ms, null = never/unreadable) is
 * older than this series' threshold: 30 days minus 0..6 days from its id hash.
 */
export function isFullRefreshDue(
    seriesId: string,
    lastFullFetchAtMs: number | null,
    nowMs: number,
): boolean {
    if (lastFullFetchAtMs == null || Number.isNaN(lastFullFetchAtMs)) return true;
    const thresholdDays =
        FULL_REFRESH_MAX_AGE_DAYS - (stableHash(seriesId) % FULL_REFRESH_SPREAD_DAYS);
    return nowMs - lastFullFetchAtMs >= thresholdDays * 86_400_000;
}

export function selectSeasonsToRefresh(
    listing: SeasonListing[],
    stored: ReadonlyMap<number, StoredSeasonState>,
    hasUnidentifiedFileBackedEpisode: boolean,
    fullRefreshDue = false,
): Set<number> {
    if (hasUnidentifiedFileBackedEpisode || fullRefreshDue) {
        return new Set(listing.map((s) => s.season_number));
    }
    const latest = new Set(
        listing
            .map((s) => s.season_number)
            .filter((n) => n > 0)
            .sort((a, b) => b - a)
            .slice(0, ALWAYS_REFRESH_LATEST_SEASONS),
    );
    const out = new Set<number>();
    for (const season of listing) {
        const n = season.season_number;
        const local = stored.get(n);
        const changed =
            (local?.episodeCount ?? 0) !== (season.episode_count ?? 0) ||
            (season.air_date != null && (local?.premiereDate ?? null) !== season.air_date) ||
            (season.air_date == null && local != null && local.premiereDate != null);
        if (latest.has(n) || changed) out.add(n);
    }
    return out;
}
