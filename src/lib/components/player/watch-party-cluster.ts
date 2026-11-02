// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { WatchTogetherParticipant } from '$lib/schemas/watch-together-core-types';

export const CLUSTER_MAX_VISIBLE = 3;

/** Avatar sizes in px, indexed left-to-right (0=leftmost/smallest, 2=you/largest) */
export const CLUSTER_AVATAR_SIZES = [30, 36, 44] as const;

export interface ClusterDisplay {
    /** Ordered left-to-right for DOM rendering. Last element = you (rightmost, 44px). */
    visible: WatchTogetherParticipant[];
    /** Number of participants hidden behind the +N chip */
    overflowCount: number;
}

/**
 * Determines which avatars to display in the cluster and how many overflow.
 * Current user is always rightmost (last in the returned array).
 *
 * The same userId can appear more than once (multi-device join via distinct clientIds).
 * We show at most one self avatar — the first matching entry — to avoid duplicates
 * and keep the slot math safe.
 */
export function computeClusterDisplay(
    participants: WatchTogetherParticipant[],
    currentUserId: string,
    maxVisible: number = CLUSTER_MAX_VISIBLE,
): ClusterDisplay {
    // Cap self at 1 — same user on multiple devices still shows as one avatar
    const selfAll = participants.filter((p) => p.userId === currentUserId);
    const self = selfAll.slice(0, 1);
    const others = participants.filter((p) => p.userId !== currentUserId);

    // Take up to maxVisible from all participants
    // Prioritize showing self, then fill remaining slots with most recently joined others
    const remaining = maxVisible - self.length;
    const slotsForOthers = Math.max(0, remaining);
    // Show the most recently joined others (last N participants)
    const visibleOthers = slotsForOthers > 0 ? others.slice(-slotsForOthers) : [];
    const overflowCount = Math.max(0, others.length - visibleOthers.length);

    return {
        visible: [...visibleOthers, ...self].slice(0, maxVisible),
        overflowCount,
    };
}

/**
 * Returns the avatar diameter (px) for a given position in the visible array.
 * Index 0 = leftmost (smallest), index (visibleCount-1) = rightmost (44px = you).
 */
export function getAvatarSizeForIndex(index: number, visibleCount: number): number {
    const offset = CLUSTER_MAX_VISIBLE - visibleCount;
    const sizeIndex = index + offset;
    if (sizeIndex < 0 || sizeIndex >= CLUSTER_AVATAR_SIZES.length) {
        return CLUSTER_AVATAR_SIZES[CLUSTER_AVATAR_SIZES.length - 1];
    }
    return CLUSTER_AVATAR_SIZES[sizeIndex];
}
