// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure (non-reactive) helpers for reconciling a category's channel list after a drag.
 * Kept out of channel-store.svelte.ts so the local Set/Map temporaries here aren't
 * (wrongly) flagged as reactive state, and so the logic is trivially unit-testable.
 */

import type { AdminChannel, AdminChannelCategory } from '$lib/schemas/livetv.js';

/**
 * What a pane shows: a search and, unless "Show hidden channels" is on, only
 * visible channels. A plain string is a search alone (nothing hidden filtered).
 */
export interface PaneFilter {
    query: string;
    hideHidden: boolean;
    /** Hidden channels shown anyway: rows hidden in this session stay in view. */
    keep?: ReadonlySet<string>;
    /** Only feeds whose playback health is "offline". */
    offlineOnly?: boolean;
}

/** A pane's filter with its search trimmed and lowercased. */
export function normalizeFilter(filter: string | PaneFilter): PaneFilter {
    const f: PaneFilter =
        typeof filter === 'string' ? { query: filter, hideHidden: false } : filter;
    return {
        query: f.query.trim().toLowerCase(),
        hideHidden: f.hideHidden,
        keep: f.keep,
        offlineOnly: f.offlineOnly,
    };
}

function isFiltering(filter: PaneFilter): boolean {
    return filter.query !== '' || filter.hideHidden || filter.offlineOnly === true;
}

/**
 * Does a channel show in a pane with this (normalized) filter? Mirrors the pane.
 * A hidden channel left out of the view stays anchored to the visible channel
 * before it, so moving "X HD" carries its hidden "X HD²" along.
 */
export function channelMatches(ch: AdminChannel, filter: string | PaneFilter): boolean {
    const { query, hideHidden, keep, offlineOnly } =
        typeof filter === 'string'
            ? { query: filter, hideHidden: false, keep: undefined, offlineOnly: false }
            : filter;
    if (hideHidden && !ch.isVisible && !keep?.has(ch.id)) return false;
    if (offlineOnly && ch.health?.state !== 'offline') return false;
    if (!query) return true;
    return (
        ch.name.toLowerCase().includes(query) ||
        (ch.adminDisplayName?.toLowerCase().includes(query) ?? false)
    );
}

/** Keep the first occurrence of each id (guards against a rare double-finalize duplication). */
export function dedupeById(channels: AdminChannel[]): AdminChannel[] {
    const seen = new Set<string>();
    const out: AdminChannel[] = [];
    for (const ch of channels) {
        if (seen.has(ch.id)) continue;
        seen.add(ch.id);
        out.push(ch);
    }
    return out;
}

/**
 * Reconcile a category's FULL channel list after a drag finalize whose payload only
 * reflects the channels VISIBLE in the dragging pane.
 *
 * - `fullOld`        — the category's committed full channel list (pre-finalize).
 * - `payloadVisible` — the dropped/reordered visible channels, in their new order. May
 *                      include a channel dragged in from another category, and excludes
 *                      any visible channel dragged out. Shadow placeholder already stripped.
 * - `query`          — the dragging pane's filter (lowercased search, or a PaneFilter
 *                      that also leaves hidden channels out); '' means nothing is hidden.
 *
 * Channels hidden by the filter keep their position by anchoring to the visible channel
 * that preceded them in `fullOld` (so the full ordering survives a filtered drag).
 */
export function reconcileCategoryChannels(
    fullOld: AdminChannel[],
    payloadVisible: AdminChannel[],
    query: string | PaneFilter,
): AdminChannel[] {
    // Unfiltered: the visible payload IS the full list.
    if (!isFiltering(normalizeFilter(query))) return dedupeById(payloadVisible);

    const visibleSet = new Set(
        fullOld.filter((ch) => channelMatches(ch, query)).map((ch) => ch.id),
    );
    const payloadIds = new Set(payloadVisible.map((ch) => ch.id));

    // Map each hidden channel to the nearest preceding VISIBLE channel in fullOld.
    const frontHidden: AdminChannel[] = [];
    const hiddenByAnchor = new Map<string, AdminChannel[]>();
    const allHidden: AdminChannel[] = [];
    let lastVisibleId: string | null = null;
    for (const ch of fullOld) {
        if (visibleSet.has(ch.id)) {
            lastVisibleId = ch.id;
        } else {
            allHidden.push(ch);
            // Anchor to the preceding visible channel only if it survived the drag.
            if (lastVisibleId !== null && payloadIds.has(lastVisibleId)) {
                const bucket = hiddenByAnchor.get(lastVisibleId);
                if (bucket) bucket.push(ch);
                else hiddenByAnchor.set(lastVisibleId, [ch]);
            } else {
                frontHidden.push(ch);
            }
        }
    }

    const result: AdminChannel[] = [...frontHidden];
    for (const ch of payloadVisible) {
        result.push(ch);
        const trailing = hiddenByAnchor.get(ch.id);
        if (trailing) result.push(...trailing);
    }
    // Safety net: never drop a hidden channel even if anchoring missed it.
    const included = new Set(result.map((ch) => ch.id));
    for (const ch of allHidden) if (!included.has(ch.id)) result.push(ch);

    return dedupeById(result);
}

/**
 * Plan a multi-select group move. svelte-dnd-action only moves the grabbed "leader"
 * channel; this computes the result of moving the WHOLE selected group as one
 * contiguous block to where the leader was dropped.
 *
 * - `categories`        — current full category list.
 * - `groupIds`          — selected channel ids, in visual (top-to-bottom) order.
 * - `leaderId`          — the grabbed channel (drop position anchor).
 * - `destCategoryId`    — category the leader was dropped into ('uncategorized' sentinel ok).
 * - `destPayloadVisible`— the destination zone's visible channels after the drop (leader only;
 *                         followers were never moved by the library). Shadow already stripped.
 * - `query`             — destination pane's lowercased search ('' = nothing hidden).
 *
 * Returns a NEW categories array: the group is removed from every source category and
 * inserted as a block at the leader's drop slot in the destination, with each moved
 * channel's categoryId rewritten to the destination.
 */
export function planGroupMove(
    categories: AdminChannelCategory[],
    groupIds: string[],
    leaderId: string,
    destCategoryId: string,
    destPayloadVisible: AdminChannel[],
    query: string | PaneFilter,
    uncategorizedId: string,
): AdminChannelCategory[] {
    const groupSet = new Set(groupIds);

    // Gather the group's channel objects from the store, in the given group order.
    const byId = new Map<string, AdminChannel>();
    for (const cat of categories) {
        for (const ch of cat.channels) if (groupSet.has(ch.id)) byId.set(ch.id, ch);
    }
    const destCid = destCategoryId === uncategorizedId ? undefined : destCategoryId;
    const groupChannels = groupIds
        .map((id) => byId.get(id))
        .filter((ch): ch is AdminChannel => ch !== undefined)
        .map((ch) => ({ ...ch, categoryId: destCid }));

    // Where the group goes among the destination's visible (non-group) channels.
    const visibleSansGroup = destPayloadVisible.filter((c) => !groupSet.has(c.id));
    const leaderIdx = destPayloadVisible.findIndex((c) => c.id === leaderId);
    const precedingNonGroup = destPayloadVisible
        .slice(0, Math.max(0, leaderIdx))
        .filter((c) => !groupSet.has(c.id)).length;
    const newVisible = [
        ...visibleSansGroup.slice(0, precedingNonGroup),
        ...groupChannels,
        ...visibleSansGroup.slice(precedingNonGroup),
    ];

    const destCat = categories.find((c) => c.id === destCategoryId);
    if (!destCat) return categories;
    const destFullSansGroup = destCat.channels.filter((c) => !groupSet.has(c.id));
    const newDestFull = reconcileCategoryChannels(destFullSansGroup, newVisible, query);

    return categories.map((cat) => {
        if (cat.id === destCategoryId) return { ...cat, channels: newDestFull };
        const filtered = cat.channels.filter((c) => !groupSet.has(c.id));
        return filtered.length === cat.channels.length ? cat : { ...cat, channels: filtered };
    });
}

/**
 * Plan a drag-free relocation (context menu "move to top/bottom/category"). Moves `ids`
 * (in the given visual order) out of every source category and into `destCategoryId` at the
 * top or bottom, restamping each moved channel's categoryId. Pure.
 */
export function planMoveToCategory(
    categories: AdminChannelCategory[],
    ids: string[],
    destCategoryId: string,
    position: 'top' | 'bottom',
    uncategorizedId: string,
): AdminChannelCategory[] {
    const set = new Set(ids);
    const byId = new Map<string, AdminChannel>();
    for (const cat of categories) {
        for (const ch of cat.channels) if (set.has(ch.id)) byId.set(ch.id, ch);
    }
    const destCid = destCategoryId === uncategorizedId ? undefined : destCategoryId;
    const moving = ids
        .map((id) => byId.get(id))
        .filter((ch): ch is AdminChannel => ch !== undefined)
        .map((ch) => ({ ...ch, categoryId: destCid }));

    return categories.map((cat) => {
        const kept = cat.channels.filter((c) => !set.has(c.id));
        if (cat.id === destCategoryId) {
            return {
                ...cat,
                channels: position === 'top' ? [...moving, ...kept] : [...kept, ...moving],
            };
        }
        return kept.length === cat.channels.length ? cat : { ...cat, channels: kept };
    });
}

/**
 * Move each of `ids` to the top or bottom of ITS OWN category (no category change),
 * preserving the selected channels' relative order. Used by the context-menu "Move to
 * top/bottom" so a multi-category selection doesn't get yanked into one category. Pure.
 */
export function planMoveToOwnEdge(
    categories: AdminChannelCategory[],
    ids: string[],
    position: 'top' | 'bottom',
): AdminChannelCategory[] {
    const set = new Set(ids);
    return categories.map((cat) => {
        const moving = cat.channels.filter((c) => set.has(c.id));
        if (moving.length === 0) return cat;
        const kept = cat.channels.filter((c) => !set.has(c.id));
        return {
            ...cat,
            channels: position === 'top' ? [...moving, ...kept] : [...kept, ...moving],
        };
    });
}

/**
 * The reorder rows to save: channels whose position or category changed since
 * `before` (all of them without a baseline). Sending every channel of a large
 * lineup (12k, ~1.3 MB) hit the request size cap.
 */
export function changedChannelUpdates(
    before: AdminChannelCategory[] | null,
    after: AdminChannelCategory[],
    uncategorizedId: string,
): Array<{ id: string; sortOrder: number; categoryId: string | null }> {
    const prev = new Map<string, { categoryId: string; index: number; sortOrder: number }>();
    for (const cat of before ?? []) {
        cat.channels.forEach((ch, index) =>
            prev.set(ch.id, { categoryId: cat.id, index, sortOrder: ch.sortOrder }),
        );
    }
    const updates: Array<{ id: string; sortOrder: number; categoryId: string | null }> = [];
    for (const cat of after) {
        // The uncategorized bucket is a UI-only sentinel -> category_id NULL.
        const categoryId = cat.id === uncategorizedId ? null : cat.id;
        cat.channels.forEach((ch, index) => {
            const was = prev.get(ch.id);
            // Unchanged only if it stayed put AND its stored sortOrder already is that
            // index: imported or merged lineups can have gapped or tied sort orders.
            if (
                before &&
                was &&
                was.categoryId === cat.id &&
                was.index === index &&
                was.sortOrder === index
            )
                return;
            updates.push({ id: ch.id, sortOrder: index, categoryId });
        });
    }
    return updates;
}

/**
 * A category drag hands back the pane's category objects, whose channel lists
 * may be filtered (hidden channels left out). Take only their order and keep
 * the full categories, so a drag in a filtered pane never drops channels.
 */
export function withFullChannels(
    current: AdminChannelCategory[],
    reordered: AdminChannelCategory[],
): AdminChannelCategory[] {
    const byId = new Map(current.map((c) => [c.id, c]));
    return reordered.map((item) => byId.get(item.id) ?? item);
}

/**
 * A large category renders only its first `windowLength` rows, and the drag zone
 * works on that window. Put the window's new order back in front of the rows that
 * were not rendered, so a drag inside the window keeps every channel after it.
 * A channel dragged in from elsewhere is in `windowPayload` and leaves the tail.
 */
export function mergeWindowedPayload(
    fullVisible: AdminChannel[],
    windowPayload: AdminChannel[],
    windowLength: number,
): AdminChannel[] {
    if (fullVisible.length <= windowLength) return windowPayload;
    const inWindow = new Set(windowPayload.map((ch) => ch.id));
    return [
        ...windowPayload,
        ...fullVisible.slice(windowLength).filter((ch) => !inWindow.has(ch.id)),
    ];
}

/**
 * `ids` plus the hidden channels that directly follow each of them in its category
 * (a station's lower-quality feeds hidden behind its main feed), in list order.
 * Used when hidden channels are left out of view, so a move carries them along the
 * way a drag inside the category already does (reconcileCategoryChannels).
 */
export function withHiddenFollowers(
    categories: AdminChannelCategory[],
    ids: string[],
    isHidden: (ch: AdminChannel) => boolean = (ch) => !ch.isVisible,
): string[] {
    const wanted = new Set(ids);
    const followers = new Map<string, string[]>();
    for (const cat of categories) {
        let anchor: string | null = null;
        for (const ch of cat.channels) {
            if (wanted.has(ch.id)) {
                anchor = ch.id;
            } else if (anchor && isHidden(ch)) {
                const list = followers.get(anchor);
                if (list) list.push(ch.id);
                else followers.set(anchor, [ch.id]);
            } else {
                anchor = null;
            }
        }
    }
    const result: string[] = [];
    for (const id of ids) result.push(id, ...(followers.get(id) ?? []));
    return result;
}

export type CategoryMove = 'up' | 'down' | 'top' | 'bottom';

/**
 * Move one category up/down one place or to the top/bottom of the order. Only
 * the order changes: each category keeps its full channel list. Returns the same
 * array when nothing moves (already first/last, unknown id).
 */
export function planCategoryMove(
    categories: AdminChannelCategory[],
    categoryId: string,
    move: CategoryMove,
): AdminChannelCategory[] {
    const from = categories.findIndex((c) => c.id === categoryId);
    if (from < 0) return categories;
    const last = categories.length - 1;
    const to = move === 'up' ? from - 1 : move === 'down' ? from + 1 : move === 'top' ? 0 : last;
    if (to < 0 || to > last || to === from) return categories;
    const next = [...categories];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
}

/**
 * Put the categories in `orderedIds` order (a drag in the category rail). Ids
 * not listed (none, normally) keep their relative order after the listed ones.
 */
export function orderCategoriesByIds(
    categories: AdminChannelCategory[],
    orderedIds: string[],
): AdminChannelCategory[] {
    const byId = new Map(categories.map((c) => [c.id, c]));
    const listed = orderedIds
        .map((id) => byId.get(id))
        .filter((c): c is AdminChannelCategory => c !== undefined);
    const seen = new Set(listed.map((c) => c.id));
    return [...listed, ...categories.filter((c) => !seen.has(c.id))];
}
