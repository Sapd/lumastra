// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Client side of the typed Live TV failure contract.
 *
 * A failed start (problem+json), a keepalive 410 with `reason: 'failed'` and the
 * `failure` block of a playback-session state all carry one taxonomy code from
 * `src/shared/livetv-failure-reason.ts`. This module turns those bodies into one
 * typed value and never throws: a body that does not carry a known code yields `null`
 * so the caller falls back to its generic path.
 *
 * Design: docs/superpowers/specs/2026-10-20-livetv-failure-taxonomy-design.md
 */

import { z } from 'zod';
import {
    LIVETV_FAILURE_POLICY,
    isLiveTvFailureReason,
    type LiveTvFailureReason,
} from '../../shared/livetv-failure-reason.js';

export {
    LIVETV_FAILURE_REASONS,
    isLiveTvFailureReason,
} from '../../shared/livetv-failure-reason.js';
export type { LiveTvFailureReason } from '../../shared/livetv-failure-reason.js';

/** The nine taxonomy reasons plus the app's own "Live TV proxy is down" (503). */
export type LiveTvFailureCode = LiveTvFailureReason | 'dependency_unavailable';

export function isLiveTvFailureCode(value: unknown): value is LiveTvFailureCode {
    return value === 'dependency_unavailable' || isLiveTvFailureReason(value);
}

/** One feed of a station that was tried (admins only; ids and names, never URLs). */
export interface LiveTvFeedTried {
    feedId?: string;
    feedName?: string;
    reason: LiveTvFailureReason;
    upstreamStatus?: number;
}

export interface LiveTvFailureInfo {
    kind: 'failure';
    code: LiveTvFailureCode;
    retryable: boolean;
    retryAfterMs?: number;
    feedsTried?: LiveTvFeedTried[];
}

const FeedTriedSchema = z.object({
    feedId: z.string().optional(),
    feedName: z.string().optional(),
    reason: z.string(),
    upstreamStatus: z.number().optional(),
});

const FailureFieldsSchema = z.object({
    retryable: z.boolean().optional(),
    retryAfterMs: z.number().finite().nonnegative().optional(),
    feedsTried: z.array(z.unknown()).optional(),
});

/**
 * Fields of a problem+json body: `failure: { retryable, feedsTried? }` plus the standard
 * `retryAfter` in seconds. Read into the millisecond form `build` works in.
 */
function problemFields(record: Record<string, unknown>): unknown {
    const failure = record.failure;
    const ext =
        typeof failure === 'object' && failure !== null && !Array.isArray(failure)
            ? (failure as Record<string, unknown>)
            : {};
    const retryAfter = record.retryAfter;
    return {
        ...ext,
        ...(typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 0
            ? { retryAfterMs: retryAfter * 1000 }
            : {}),
    };
}

const DEPENDENCY_UNAVAILABLE_POLICY = { retryable: true, retryAfterMs: 5_000 } as const;

function defaultPolicy(code: LiveTvFailureCode): { retryable: boolean; retryAfterMs?: number } {
    return code === 'dependency_unavailable'
        ? DEPENDENCY_UNAVAILABLE_POLICY
        : LIVETV_FAILURE_POLICY[code];
}

function parseFeedsTried(raw: unknown[] | undefined): LiveTvFeedTried[] | undefined {
    if (!raw) return undefined;
    const feeds: LiveTvFeedTried[] = [];
    for (const entry of raw) {
        const parsed = FeedTriedSchema.safeParse(entry);
        // A feed without a taxonomy reason cannot be shown; all_feeds_failed never nests.
        if (
            !parsed.success ||
            !isLiveTvFailureReason(parsed.data.reason) ||
            parsed.data.reason === 'all_feeds_failed'
        )
            continue;
        feeds.push({
            reason: parsed.data.reason,
            ...(parsed.data.feedId !== undefined ? { feedId: parsed.data.feedId } : {}),
            ...(parsed.data.feedName !== undefined ? { feedName: parsed.data.feedName } : {}),
            ...(parsed.data.upstreamStatus !== undefined
                ? { upstreamStatus: parsed.data.upstreamStatus }
                : {}),
        });
    }
    return feeds.length > 0 ? feeds : undefined;
}

/**
 * Build a failure from a code and the optional fields next to it. Missing
 * `retryable` / `retryAfterMs` fall back to the shared policy for that code.
 */
function build(code: LiveTvFailureCode, fields: unknown): LiveTvFailureInfo {
    const parsed = FailureFieldsSchema.safeParse(fields);
    const data = parsed.success ? parsed.data : {};
    const policy = defaultPolicy(code);
    const retryable = data.retryable ?? policy.retryable;
    const retryAfterMs = data.retryAfterMs ?? (retryable ? policy.retryAfterMs : undefined);
    const feedsTried = parseFeedsTried(data.feedsTried);
    return {
        kind: 'failure',
        code,
        retryable,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        ...(feedsTried ? { feedsTried } : {}),
    };
}

/**
 * Parse a problem+json body (start failure, keepalive 410 `failed`, HLS 410) into a
 * failure. `null` when the body is not an object or its `code` is not a taxonomy code.
 */
export function parseLiveTvFailureProblem(body: unknown): LiveTvFailureInfo | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const record = body as Record<string, unknown>;
    if (!isLiveTvFailureCode(record.code)) return null;
    return build(record.code, problemFields(record));
}

/**
 * Parse the `failure` block of `GET /livetv/playback-sessions/{id}`:
 * `{ code, retryable, retryAfterMs?, at }`. `null` when absent or malformed.
 */
export function parseLiveTvSessionFailure(body: unknown): LiveTvFailureInfo | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
    const failure = (body as Record<string, unknown>).failure;
    if (typeof failure !== 'object' || failure === null || Array.isArray(failure)) return null;
    const record = failure as Record<string, unknown>;
    if (!isLiveTvFailureCode(record.code)) return null;
    return build(record.code, record);
}
