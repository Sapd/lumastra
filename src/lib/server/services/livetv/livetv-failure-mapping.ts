// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure mapping between the stream proxy's failure bodies and the app's typed failures.
 * Design: docs/superpowers/specs/2026-10-20-livetv-failure-taxonomy-design.md
 */

import type { LiveTvFeedTried } from '$lib/server/api/problem.js';
import {
    LIVETV_FAILURE_POLICY,
    isLiveTvFailureReason,
    type LiveTvFailureReason,
    type LiveTvFeedFailure,
} from '../../../../shared/livetv-failure-reason.js';

/** A feed of the station, in the order its URL was sent to the proxy. */
export interface StationFeedRef {
    id: string;
    name: string;
}

/** The resolved facts of one failure, ready for a problem+json. */
export interface LiveTvFailureFacts {
    reason: LiveTvFailureReason;
    retryable: boolean;
    retryAfterMs?: number;
    feedsTried: LiveTvFeedTried[];
}

/**
 * Proxy `feedsTried` indexes point into the `streamUrls` the app sent. Translate them to
 * feed ids and names from the app's own list only: an entry whose index maps to no feed is
 * dropped, and a feed id the proxy supplies is never echoed.
 */
export function translateFeedsTried(
    raw: ReadonlyArray<LiveTvFeedFailure> | undefined,
    feeds: ReadonlyArray<StationFeedRef>,
): LiveTvFeedTried[] {
    if (!raw) return [];
    const out: LiveTvFeedTried[] = [];
    for (const entry of raw) {
        if (!isLiveTvFailureReason(entry?.reason)) continue;
        const feed =
            Number.isInteger(entry.index) && entry.index >= 0 ? feeds[entry.index] : undefined;
        if (!feed) continue;
        out.push({
            feedId: feed.id,
            ...(feed.name ? { feedName: feed.name } : {}),
            reason: entry.reason,
            ...(typeof entry.upstreamStatus === 'number'
                ? { upstreamStatus: entry.upstreamStatus }
                : {}),
        });
    }
    return out;
}

/** Retryable / retryAfterMs from the proxy when it sent them, else from the policy. */
export function failureFacts(
    reason: LiveTvFailureReason,
    proxy: { retryable?: boolean; retryAfterMs?: number },
    feedsTried: LiveTvFeedTried[],
): LiveTvFailureFacts {
    const policy = LIVETV_FAILURE_POLICY[reason];
    const retryable = proxy.retryable ?? policy.retryable;
    const retryAfterMs = proxy.retryAfterMs ?? (retryable ? policy.retryAfterMs : undefined);
    return {
        reason,
        retryable,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        feedsTried,
    };
}

/** What the legacy proxy error strings mean in the taxonomy; undefined when they say nothing about the feed. */
export function reasonForLegacyProxyError(error: string): LiveTvFailureReason | undefined {
    switch (error) {
        case 'spawn_failed':
            return 'encoder_failed';
        case 'source_unreachable':
            return 'provider_unreachable';
        // `channel_not_found` means the proxy lost or tore down its state for the channel (not that
        // the channel is offline), and `no_segments` is only ever answered to an HLS playlist
        // request, never to a join. Neither is a verdict about the feed: they stay unmapped.
        default:
            return undefined;
    }
}

/** The legacy flat code a Jellyfin-compat route still reports for a typed failure. */
export function legacyCodeForReason(
    reason: LiveTvFailureReason,
): 'spawn_failed' | 'source_unreachable' | 'no_segments' {
    if (reason === 'encoder_failed') return 'spawn_failed';
    if (reason === 'provider_unreachable') return 'source_unreachable';
    return 'no_segments';
}
