// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { AdminChannel, AdminChannelCategory } from '$lib/schemas/livetv.js';

/**
 * Why a channel row does or does not reach viewers.
 *
 * The admin list renders every channel, but viewers get ONE channel per backup
 * group (`shownGroupMember` in livetv-channels.queries.ts): the group's primary
 * when it reaches viewers, else its best reachable feed (normal before
 * transcoded/mobile, then quality, then lowest sortOrder, then id). Without this, a withheld row shows the same green "visible" eye as a live
 * one — the gap that hid the MTK backup-group bug.
 */
export type ChannelViewerStatus =
    /** Viewers receive this channel. */
    | { kind: 'shown' }
    /** Not visible, and nothing else to explain — the eye icon already says it. */
    | { kind: 'none' }
    /**
     * Visible, but another feed of its backup group is what viewers get.
     * `shownName` is absent when that feed is outside the current payload (e.g. a
     * `?sourceId=`-filtered view) — the row is still withheld, we just can't name
     * what supersedes it.
     */
    | { kind: 'superseded'; shownName?: string }
    /** Visible, but its category is hidden. */
    | { kind: 'category-hidden' };

export interface ChannelIndex {
    /** Every channel in the payload, by id. */
    byId: ReadonlyMap<string, AdminChannel>;
    /** Ids of categories that are themselves visible. */
    visibleCategoryIds: ReadonlySet<string>;
    /** Per backup group, the channel viewers get (absent: no feed reaches viewers). */
    shownByGroup: ReadonlyMap<string, string>;
}

function isReachableIn(channel: AdminChannel, visibleCategoryIds: ReadonlySet<string>): boolean {
    if (!channel.isVisible) return false;
    if (channel.categoryId === undefined) return true;
    return visibleCategoryIds.has(channel.categoryId);
}

/**
 * Twin of DEGRADED_FEED_PATTERN in livetv-channels.queries.ts (the viewer query):
 * a transcoded, mobile, backup or low-quality feed. The query tests the playlist
 * title; the admin list only has the display name, which differs only for a
 * channel the admin renamed.
 */
const DEGRADED_FEED_RE =
    /[([]\s*((local|ʟᴏᴄᴀʟ)\s+)?(transcoded|ᴛʀᴀɴsᴄᴏᴅᴇᴅ|mobile?|ᴍᴏʙɪʟ|backup|low\s*quali[a-z]*)\s*[\])]\s*$|low\s*quali[a-z]*\s*$/i;

const QUALITY_RANK: Record<string, number> = { uhd: 0, fhd: 1, hd: 2, sd: 3 };

/** A transcoded, mobile, backup or low-quality feed (the viewer query ranks it last). */
export function isDegradedFeedName(name: string): boolean {
    return DEGRADED_FEED_RE.test(name);
}

/** uhd 0 .. sd 3, unknown 4: lower is better, as in the viewer query. */
export function qualityRank(tier: string | undefined): number {
    return QUALITY_RANK[tier ?? ''] ?? 4;
}

/**
 * Mirrors shownGroupMember's ORDER BY: the primary, then a normal feed before a
 * degraded one, then quality (uhd..sd, unknown last), then sortOrder, then id.
 */
function beats(a: AdminChannel, b: AdminChannel): boolean {
    const aPrimary = a.groupPrimaryChannelId === a.id;
    const bPrimary = b.groupPrimaryChannelId === b.id;
    if (aPrimary !== bPrimary) return aPrimary;
    const aDegraded = isDegradedFeedName(a.name);
    const bDegraded = isDegradedFeedName(b.name);
    if (aDegraded !== bDegraded) return bDegraded;
    const aQuality = qualityRank(a.qualityTier);
    const bQuality = qualityRank(b.qualityTier);
    if (aQuality !== bQuality) return aQuality < bQuality;
    if (a.sortOrder !== b.sortOrder) return a.sortOrder < b.sortOrder;
    return a.id < b.id;
}

/** Sort comparator in the viewer query's rank: the feed viewers get first. */
export function compareGroupFeeds(a: AdminChannel, b: AdminChannel): number {
    if (beats(a, b)) return -1;
    return beats(b, a) ? 1 : 0;
}

export function buildChannelIndex(categories: readonly AdminChannelCategory[]): ChannelIndex {
    const byId = new Map<string, AdminChannel>();
    const visibleCategoryIds = new Set<string>();
    for (const category of categories) {
        if (category.isVisible) visibleCategoryIds.add(category.id);
        for (const channel of category.channels) byId.set(channel.id, channel);
    }
    const winners = new Map<string, AdminChannel>();
    for (const channel of byId.values()) {
        const groupId = channel.backupGroupId;
        if (groupId === undefined || !isReachableIn(channel, visibleCategoryIds)) continue;
        const best = winners.get(groupId);
        if (!best || beats(channel, best)) winners.set(groupId, channel);
    }
    const shownByGroup = new Map([...winners].map(([groupId, ch]) => [groupId, ch.id]));
    return { byId, visibleCategoryIds, shownByGroup };
}

function displayName(channel: AdminChannel): string {
    return channel.adminDisplayName ?? channel.name;
}

export function getChannelViewerStatus(
    channel: AdminChannel,
    categoryIsVisible: boolean,
    index: ChannelIndex,
): ChannelViewerStatus {
    if (!channel.isVisible) return { kind: 'none' };
    if (!categoryIsVisible) return { kind: 'category-hidden' };

    const groupId = channel.backupGroupId;
    if (groupId === undefined) return { kind: 'shown' };

    // A primary outside this payload (source-filtered view) would win if visible;
    // we cannot tell, so name nothing but still mark the row withheld.
    const primaryId = channel.groupPrimaryChannelId;
    if (primaryId !== undefined && primaryId !== channel.id && !index.byId.has(primaryId)) {
        return { kind: 'superseded' };
    }

    const shownId = index.shownByGroup.get(groupId);
    if (shownId === undefined || shownId === channel.id) return { kind: 'shown' };
    const shown = index.byId.get(shownId);
    return { kind: 'superseded', shownName: shown ? displayName(shown) : undefined };
}
