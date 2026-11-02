// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Retry rules for a typed Live TV failure.
 *
 * Only a failure the server marks `retryable` is retried on its own. The wait before
 * retry n (1-based) is `max(retryAfterMs, 2^n s)`, never more than 30 s, and there are
 * at most four automatic retries; after that the viewer sees a terminal card.
 */

import type { LiveTvFailureCode, LiveTvFeedTried } from '$lib/api/livetv-failure-problem.js';

export const LIVETV_FAILURE_MAX_AUTO_RETRIES = 4;
export const LIVETV_FAILURE_MAX_DELAY_MS = 30_000;

/** What the failure card shows. `unknown` = an error without a taxonomy code. */
export interface LiveTvFailureView {
    code: LiveTvFailureCode | 'unknown';
    retryable: boolean;
    retryAfterMs?: number;
    feedsTried?: LiveTvFeedTried[];
    /** Automatic retries already made for this channel. */
    attempts: number;
    /** Epoch ms of the next automatic retry; undefined once exhausted, cancelled or not retryable. */
    retryAt?: number;
}

/** Wait before automatic retry number `attempt` (1-based). */
export function liveTvRetryDelayMs(attempt: number, retryAfterMs?: number): number {
    const backoff = 2 ** Math.max(1, attempt) * 1000;
    return Math.min(LIVETV_FAILURE_MAX_DELAY_MS, Math.max(retryAfterMs ?? 0, backoff));
}

/**
 * The next automatic retry for a failure after `attemptsMade` retries, or `null` when
 * none is allowed (not retryable, or the budget is spent).
 */
export function nextLiveTvRetry(
    failure: { retryable: boolean; retryAfterMs?: number },
    attemptsMade: number,
): { attempt: number; delayMs: number } | null {
    if (!failure.retryable) return null;
    if (attemptsMade >= LIVETV_FAILURE_MAX_AUTO_RETRIES) return null;
    const attempt = attemptsMade + 1;
    return { attempt, delayMs: liveTvRetryDelayMs(attempt, failure.retryAfterMs) };
}

/** The station after `currentId` in lineup order, wrapping; `undefined` when there is no other. */
export function nextStationId(
    stations: readonly { id: string }[],
    currentId: string,
): string | undefined {
    if (stations.length === 0) return undefined;
    const index = stations.findIndex((s) => s.id === currentId);
    const next = stations[(index + 1) % stations.length];
    return next && next.id !== currentId ? next.id : undefined;
}
