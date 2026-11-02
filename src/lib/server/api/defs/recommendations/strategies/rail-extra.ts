// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * rail-extra.ts — shared parsers for the folded curated-rail `opts.extra` bag.
 *
 * The legacy `GET /api/for-you/*` rails accepted client-supplied "already
 * seen" lists as CSV query params (`watched=` = TMDB ids, `watchedIds=` =
 * internal UUIDs). The folded recommender dispatch carries the same data
 * through `RecommenderOptions.extra` so each strategy reads exactly what it
 * needs without widening the strategy interface.
 *
 * The recommendations endpoint normalises the raw query CSV into:
 *   extra.watchedTmdbIds : number[]   (from `watched=`)
 *   extra.watchedUuids   : string[]   (from `watchedIds=`)
 */

import type { RecommenderOptions } from '../recommender.js';

/** Parse a CSV string of TMDB ids into a deduped number[] (drops NaN/0). */
export function parseWatchedTmdb(csv: string | null | undefined): number[] {
    if (!csv) return [];
    return csv
        .split(',')
        .map((id) => Number.parseInt(id, 10))
        .filter((id) => !Number.isNaN(id) && id !== 0);
}

/** Parse a CSV string of internal UUIDs into a string[] (drops empties). */
export function parseWatchedUuids(csv: string | null | undefined): string[] {
    if (!csv) return [];
    return csv.split(',').filter(Boolean);
}

/** Read pre-parsed TMDB watched ids from the strategy extra bag. */
export function readWatchedTmdbIds(opts: RecommenderOptions): number[] {
    const v = opts.extra?.watchedTmdbIds;
    return Array.isArray(v) ? (v as number[]) : [];
}

/** Read pre-parsed internal UUID watched ids from the strategy extra bag. */
export function readWatchedUuids(opts: RecommenderOptions): string[] {
    const v = opts.extra?.watchedUuids;
    return Array.isArray(v) ? (v as string[]) : [];
}
