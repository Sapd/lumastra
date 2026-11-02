// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure helpers translating between the playlist view's *in-memory* collapse
 * tracking (keyed by block-LEADER item ids) and the *persisted* representation
 * (keyed by STABLE series/season keys).
 *
 * Why two representations:
 * - The playlist UI tracks collapse by the leader item id of each contiguous
 *   series/season block (so the same series split into two blocks can collapse
 *   independently, and drag-grouping works off the leader).
 * - Persistence must survive reorders/removals, where leader ids change. The
 *   stable key (a provider-agnostic series key, or `${seriesKey}-S${n}` for a
 *   season) does not, so that is what we store server-side.
 *
 * These functions are intentionally dependency-free and side-effect-free so the
 * key-translation logic — the riskiest part of the feature — is unit testable
 * in isolation from Svelte.
 */

export interface CollapsedGroups {
    /** Stable series keys that are collapsed. */
    series: string[];
    /** Stable season keys (`${seriesKey}-S${n}`) that are collapsed. */
    season: string[];
}

export const EMPTY_COLLAPSED_GROUPS: CollapsedGroups = { series: [], season: [] };

/**
 * Build the persisted stable-key representation from the in-memory collapsed
 * leader-id sets. Leader ids that no longer resolve to an item (e.g. the leader
 * was removed) or to a group key are dropped. Keys are de-duplicated.
 */
export function leaderIdsToCollapsedGroups<T extends { id: number }>(
    items: readonly T[],
    collapsedSeriesLeaderIds: Iterable<number>,
    collapsedSeasonLeaderIds: Iterable<number>,
    seriesKeyOf: (item: T) => string | null,
    seasonKeyOf: (item: T) => string | null,
): CollapsedGroups {
    const byId = new Map<number, T>();
    for (const item of items) byId.set(item.id, item);

    const series = new Set<string>();
    for (const id of collapsedSeriesLeaderIds) {
        const item = byId.get(id);
        const key = item ? seriesKeyOf(item) : null;
        if (key) series.add(key);
    }

    const season = new Set<string>();
    for (const id of collapsedSeasonLeaderIds) {
        const item = byId.get(id);
        const key = item ? seasonKeyOf(item) : null;
        if (key) season.add(key);
    }

    return { series: [...series], season: [...season] };
}

/**
 * Resolve a persisted stable-key representation back to the current block-leader
 * ids, for the items in their current order. Every block leader whose key is in
 * the persisted set is collapsed — so a series appearing in two separate blocks
 * is restored in both. Non-leader items and unknown keys are ignored.
 *
 * @param seriesLeaderOf maps an item id to its series-block leader id
 * @param seasonLeaderOf maps an item id to its season-block leader id
 */
export function collapsedGroupsToLeaderIds<T extends { id: number }>(
    items: readonly T[],
    groups: CollapsedGroups,
    seriesKeyOf: (item: T) => string | null,
    seasonKeyOf: (item: T) => string | null,
    seriesLeaderOf: (id: number) => number | undefined,
    seasonLeaderOf: (id: number) => number | undefined,
): { series: number[]; season: number[] } {
    const seriesKeys = new Set(groups.series);
    const seasonKeys = new Set(groups.season);

    const series: number[] = [];
    const season: number[] = [];

    for (const item of items) {
        // Only collapse block LEADERS — the UI keys collapse by leader id, and a
        // non-leader id would never be checked by the render.
        if (seriesLeaderOf(item.id) === item.id) {
            const key = seriesKeyOf(item);
            if (key && seriesKeys.has(key)) series.push(item.id);
        }
        if (seasonLeaderOf(item.id) === item.id) {
            const key = seasonKeyOf(item);
            if (key && seasonKeys.has(key)) season.push(item.id);
        }
    }

    return { series, season };
}
