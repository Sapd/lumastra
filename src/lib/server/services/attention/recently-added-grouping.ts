// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RecentlyAddedRow } from '$lib/server/database/queries/attention.queries';
import type { RecentlyAddedItem } from '$lib/schemas/api-attention-responses';

/**
 * Episodes of one series that arrived further apart than this are separate
 * imports and get separate rows, so an episode from last week does not read as
 * "added 5 min ago" next to tonight's batch.
 */
export const RECENTLY_ADDED_BURST_GAP_MS = 24 * 60 * 60 * 1000;

interface Burst {
    lead: RecentlyAddedRow;
    rows: RecentlyAddedRow[];
    /** addedAt of the oldest row so far, epoch ms. */
    oldestMs: number;
}

function toItem(row: RecentlyAddedRow): RecentlyAddedItem {
    return {
        id: row.id,
        title: row.title,
        type: row.mediaType,
        year: row.year ?? undefined,
        images: { poster: `/api/image/catalog/${row.id}/poster` },
        addedAt: row.addedAt,
        seriesId: row.seriesId ?? undefined,
        seriesTitle: row.seriesTitle ?? undefined,
        seasonNumber: row.seasonNumber ?? undefined,
        episodeNumber: row.episodeNumber ?? undefined,
    };
}

function burstToItem(burst: Burst): RecentlyAddedItem {
    const item = toItem(burst.lead);
    if (burst.rows.length < 2) return item;

    const perSeason = new Map<number, Set<number>>();
    for (const row of burst.rows) {
        if (row.seasonNumber == null) continue;
        const set = perSeason.get(row.seasonNumber) ?? new Set<number>();
        if (row.episodeNumber != null) set.add(row.episodeNumber);
        perSeason.set(row.seasonNumber, set);
    }
    item.episodeCount = burst.rows.length;
    item.seasons = [...perSeason.entries()]
        .sort(([a], [b]) => a - b)
        .map(([season, eps]) => ({ season, episodes: [...eps].sort((a, b) => a - b) }));
    return item;
}

/**
 * Collapse episodes of one series that arrived together into a single item,
 * placed where its newest episode sits. Rows must be newest-first (as
 * `getRecentlyAddedForOps` returns them). Grouping is by series id, never by
 * title: two shows can share a name.
 */
export function groupRecentlyAdded(
    rows: RecentlyAddedRow[],
    maxItems: number,
): RecentlyAddedItem[] {
    const bursts: Burst[] = [];
    const openBySeries = new Map<string, Burst>();

    for (const row of rows) {
        const ms = Date.parse(row.addedAt);
        const seriesId = row.mediaType === 'episode' ? row.seriesId : null;
        const open = seriesId ? openBySeries.get(seriesId) : undefined;
        if (open && open.oldestMs - ms <= RECENTLY_ADDED_BURST_GAP_MS) {
            open.rows.push(row);
            open.oldestMs = ms;
            continue;
        }
        // The list is capped by rows, so once it is full only joins can still matter.
        if (bursts.length >= maxItems) continue;
        const burst: Burst = { lead: row, rows: [row], oldestMs: ms };
        bursts.push(burst);
        if (seriesId) openBySeries.set(seriesId, burst);
    }

    return bursts.map(burstToItem);
}
