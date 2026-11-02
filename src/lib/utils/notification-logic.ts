// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Notification Logic Utilities
 *
 * Pure functions for notification business logic:
 * - Status aggregation
 * - Progress calculation
 * - Filtering and sorting
 */

import type {
    RequestStatus,
    SeasonStatus,
    DownloadProgress,
    RequestNotification,
} from '$lib/types/notifications';
import { getLeastCompleteStatus, isDownloadingStatus } from '$lib/shared/request-status';

/**
 * Parse a human-readable size string (e.g. "4.5 GB", "512 MB", "1.2 TB") into
 * a byte count for weighting. Returns undefined when the string is missing or
 * unparseable so callers can fall back to equal weighting.
 */
function parseSizeToBytes(size: string | undefined): number | undefined {
    if (!size) return undefined;
    const match = /([\d.]+)\s*(B|KB|MB|GB|TB|PB)?/i.exec(size.trim());
    if (!match) return undefined;
    const value = Number.parseFloat(match[1]);
    if (Number.isNaN(value)) return undefined;
    const unit = (match[2] ?? 'B').toUpperCase();
    const multipliers: Record<string, number> = {
        B: 1,
        KB: 1e3,
        MB: 1e6,
        GB: 1e9,
        TB: 1e12,
        PB: 1e15,
    };
    return value * (multipliers[unit] ?? 1);
}

/**
 * Calculate aggregate (headline) status from multiple season statuses.
 *
 * Uses WORST-CASE / least-complete aggregation (intent (b) in
 * $lib/shared/request-status): when seasons are at mixed stages we surface the
 * least-complete one so the user sees that work is still in flight (e.g. a show
 * with 9 available + 1 downloading seasons reports "downloading").
 *
 * NOTE (M9): the headline status alone is NOT sufficient to decide whether to
 * show a Play affordance — the widget must independently check whether ANY
 * season is available (see RequestNotificationWidget). Do not infer "no play"
 * from a non-available headline.
 */
export function calculateAggregateStatus(seasonStatuses: SeasonStatus[]): RequestStatus | null {
    if (seasonStatuses.length === 0) return null;
    return getLeastCompleteStatus(seasonStatuses.map((s) => s.status));
}

/**
 * Calculate aggregate download progress from multiple downloading seasons.
 *
 * L9: byte-weighted aggregation. A 20 GB season at 10% and a 1 GB season at
 * 100% should NOT report a flat 55% mean — the big download dominates the
 * real completion. We weight each season's percentage by its total size (in
 * bytes, parsed from the `size` string); seasons missing a size fall back to
 * equal weight.
 *
 * 0%-but-downloading seasons (queued / just-started) ARE included in the
 * denominator so the headline doesn't jump to a misleadingly high number while
 * other seasons haven't started — previously they were filtered out entirely.
 */
export function calculateAggregateDownloadProgress(
    seasonStatuses: SeasonStatus[],
): DownloadProgress | undefined {
    // Include any season that is in download flight OR carries download
    // progress data — even at 0% — so just-queued seasons count toward the
    // aggregate denominator.
    const downloadingSeasons = seasonStatuses.filter(
        (s) => s.download !== undefined || isDownloadingStatus(s.status) || s.status === 'paused',
    );

    if (downloadingSeasons.length === 0) return undefined;

    let weightedSum = 0;
    let totalWeight = 0;

    for (const s of downloadingSeasons) {
        const percentage = s.download?.percentage ?? 0;
        // Weight by total size when known; otherwise equal weight (1). A parsed
        // size of 0 (e.g. the server's "0 MB" for a just-grabbed/unsized item)
        // must NOT collapse the weight to 0 — that would silently drop the
        // season from the denominator and inflate the aggregate percentage.
        const bytes = parseSizeToBytes(s.download?.size);
        const weight = bytes && bytes > 0 ? bytes : 1;
        weightedSum += percentage * weight;
        totalWeight += weight;
    }

    if (totalWeight === 0) return undefined;

    const avgPercentage = Math.round(weightedSum / totalWeight);

    return { percentage: avgPercentage };
}

/**
 * Check if a notification should be shown based on dismissal status
 */
export function shouldShowNotification(
    requestId: string,
    requestedAt: string | number,
    dismissedAt: string | undefined,
    sessionDismissedIds: Set<string>,
): boolean {
    // Check session dismissal first (immediate feedback)
    if (sessionDismissedIds.has(requestId)) {
        return false;
    }

    // Check server dismissal with timestamp comparison
    if (!dismissedAt) {
        return true; // Not dismissed
    }

    // If request was created AFTER the dismissal, show it (user re-requested)
    const requestTime =
        typeof requestedAt === 'number' ? requestedAt : new Date(requestedAt).getTime();
    const dismissTime = new Date(dismissedAt).getTime();

    // Fail open on malformed timestamps — better to show a stale-looking
    // notification than to silently hide a fresh one. This guards against
    // bad clock data from upstream services or corrupted server payloads.
    if (Number.isNaN(requestTime) || Number.isNaN(dismissTime)) return true;

    return requestTime > dismissTime;
}

/**
 * Dismissal check across EVERY key shape an item may have been dismissed under.
 *
 * `shouldShowNotification` above answers for one key. That is not enough on its
 * own, because a single request can carry a dismissal written by any of three
 * surfaces under two different key shapes (see
 * `$lib/shared/request-dismissal-key.ts`) — so asking about only the shape this
 * surface happens to write is how a real dismissal gets missed.
 *
 * `every` is the right quantifier: a hit on ANY key hides the item, while the
 * per-key `requestedAt > dismissedAt` comparison still lets a genuine
 * re-request bring it back. `keys` being empty means the item has no derivable
 * identity at all — fail open and show it rather than hiding it forever.
 */
export function shouldShowNotificationForKeys(
    keys: readonly string[],
    requestedAt: string | number,
    dismissedMap: ReadonlyMap<string, string>,
    sessionDismissedIds: Set<string>,
): boolean {
    if (keys.length === 0) return true;
    return keys.every((key) =>
        shouldShowNotification(key, requestedAt, dismissedMap.get(key), sessionDismissedIds),
    );
}

/**
 * Check if a notification has expired
 * Available notifications expire after 24 hours
 */
export function hasNotificationExpired(
    notification: RequestNotification,
    expireHours: number = 24,
): boolean {
    if (notification.status !== 'available') return false;
    if (!notification.shownAt) return false;

    const ageMs = Date.now() - notification.shownAt;
    const maxAgeMs = expireHours * 60 * 60 * 1000;

    return ageMs > maxAgeMs;
}

/**
 * Filter out expired available notifications
 */
export function filterExpiredNotifications(
    notifications: RequestNotification[],
    expireHours: number = 24,
): RequestNotification[] {
    return notifications.filter((n) => !hasNotificationExpired(n, expireHours));
}

/**
 * Check if at least one season is available
 */
export function hasAvailableSeason(seasonStatuses: SeasonStatus[]): boolean {
    return seasonStatuses.some((s) => s.jellyfinLibraryId);
}

/**
 * Get Jellyfin ID from season statuses (first available season)
 */
export function getJellyfinIdFromSeasons(seasonStatuses: SeasonStatus[]): string | undefined {
    return seasonStatuses.find((s) => s.jellyfinLibraryId)?.jellyfinLibraryId;
}

/**
 * Check if notification status is "notable" (should trigger shownAt timestamp)
 */
export function isNotableStatus(status: RequestStatus): boolean {
    const notableStatuses: RequestStatus[] = [
        'downloading',
        'importing',
        'available',
        'unavailable',
    ];
    return notableStatuses.includes(status);
}
