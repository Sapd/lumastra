// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Display helpers for a feed's playback health (admin Live TV).
 * Design: docs/superpowers/specs/2026-10-20-livetv-failure-taxonomy-design.md ("Admin: health per feed").
 */

import * as m from '$lib/paraglide/messages.js';
import type { LiveTvChannelHealth } from '$lib/schemas/livetv-failures.js';
import { isLiveTvFailureReason } from '$lib/api/livetv-failure-problem.js';
import { liveTvFailureReasonLabel } from '$lib/components/player/livetv-failure-presentation.js';
import { relativeTime } from '$lib/utils/relative-time.js';

/** Health states that deserve a badge: `ok` and a missing health show nothing. */
export type FeedHealthIssue = 'failing' | 'offline';

export function feedHealthIssue(health: LiveTvChannelHealth | undefined): FeedHealthIssue | null {
    return health && health.state !== 'ok' ? health.state : null;
}

/** True when a feed has reached the "offline" state (3+ failures in a row). */
export function isFeedOffline(health: LiveTvChannelHealth | undefined): boolean {
    return health?.state === 'offline';
}

export function feedHealthStateLabel(issue: FeedHealthIssue): string {
    return issue === 'offline' ? m.admin_livetv_health_offline() : m.admin_livetv_health_failing();
}

/** Label of the last typed failure, or null for an unknown/missing code. */
export function feedHealthReasonLabel(health: LiveTvChannelHealth): string | null {
    return isLiveTvFailureReason(health.lastReason)
        ? liveTvFailureReasonLabel(health.lastReason)
        : null;
}

/**
 * "<reason label> · <relative time>" (either part may be missing), then the failure count.
 * Used as the badge tooltip and as the secondary text.
 */
export function feedHealthDetail(health: LiveTvChannelHealth, now: number = Date.now()): string {
    const parts: string[] = [];
    const reason = feedHealthReasonLabel(health);
    if (reason) parts.push(reason);
    const when = health.lastFailureAt ? relativeTime(health.lastFailureAt, now) : '';
    if (when) parts.push(when);
    const lead = parts.join(' · ');
    const count = m.admin_livetv_health_failures({ count: health.consecutiveFailures });
    return lead ? `${lead} · ${count}` : count;
}

/** True when any of these feeds is offline and none is not (all members offline). */
export function allFeedsOffline(
    members: readonly { health?: LiveTvChannelHealth | undefined }[],
): boolean {
    return members.length > 0 && members.every((member) => isFeedOffline(member.health));
}
