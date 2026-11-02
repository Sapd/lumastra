// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Rank-weighted sampling without replacement, with a soft recency penalty.
 *
 * Used by Quick Picks to replace Fisher-Yates shuffle. Fisher-Yates spreads
 * picks uniformly across a pool, which (when the pool is a stable top-N)
 * still feels static across reloads. Rank-weighted sampling keeps top items
 * dominant for anchor buckets (heavy-rotation, highly-rated) while letting
 * lower-ranked items surface occasionally. Flat decay gives discovery
 * buckets (taste-similar, deep-cuts) wider spread.
 *
 * Recency penalty: a track played in the last hour is ~5x less likely to
 * surface than an equivalent-rank track played >24h ago. Soft multiplier —
 * never banishes a favourite.
 *
 * The field is named `hours_since_played` (snake_case) to match the DB
 * projection directly — the sampler consumes `RecentTrackRow`-shaped
 * objects as-is without a remap layer. `null` (LEFT JOIN miss) is treated
 * identically to `undefined`: never-played → factor 1.0.
 */

export interface RankedItem {
    /** Hours since last play. null/undefined = never played (no penalty). */
    hours_since_played?: number | null;
}

export interface SampleOptions {
    /** Rank decay: 0.5 = flat spread, 1 = linear, 2 = sharp (top-heavy) */
    decay: number;
    count: number;
    rng?: () => number;
}

/**
 * Soft multiplier applied to a rank weight based on last-played recency.
 * Step-function values: <1h → 0.2 (5x penalty), <6h → 0.5, <24h → 0.8,
 * ≥24h → 1.0 (no penalty). Null and undefined both mean "never played".
 */
export function recencyFactor(hoursSincePlayed: number | null | undefined): number {
    if (hoursSincePlayed === undefined || hoursSincePlayed === null) return 1.0;
    if (hoursSincePlayed < 1) return 0.2;
    if (hoursSincePlayed < 6) return 0.5;
    if (hoursSincePlayed < 24) return 0.8;
    return 1.0;
}

/**
 * Sample up to `count` items from `items` (expected pre-sorted high→low by
 * relevance) using weighted random without replacement.
 *
 * Weight formula: `(1 / (rank + 1) ^ decay) * recencyFactor(hours)`.
 * Weights floor to 0.001 to avoid zero-probability regions.
 */
export function rankWeightedSample<T extends RankedItem>(items: T[], options: SampleOptions): T[] {
    const { decay, count } = options;
    const rng = options.rng ?? Math.random;
    if (items.length === 0 || count <= 0) return [];
    if (count >= items.length) return [...items];

    const pool = items.map((item, rank) => ({
        item,
        weight: Math.max(
            0.001,
            (1 / Math.pow(rank + 1, decay)) * recencyFactor(item.hours_since_played),
        ),
    }));

    const result: T[] = [];
    for (let picked = 0; picked < count && pool.length > 0; picked++) {
        const total = pool.reduce((sum, p) => sum + p.weight, 0);
        let r = rng() * total;
        let chosen = pool.length - 1;
        for (let i = 0; i < pool.length; i++) {
            r -= pool[i].weight;
            if (r <= 0) {
                chosen = i;
                break;
            }
        }
        result.push(pool[chosen].item);
        pool.splice(chosen, 1);
    }
    return result;
}
