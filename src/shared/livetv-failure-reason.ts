// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Typed reasons why a Live TV channel will not play, shared by the stream proxy,
 * the app and the native (Rust) proxy contract tests.
 *
 * Design: docs/superpowers/specs/2026-10-20-livetv-failure-taxonomy-design.md (repo root).
 * The classification rules are pinned by `livetv-failure-reasons.fixture.json`
 * next to this file; the native conformance suite replays the same fixture.
 *
 * CRITICAL: import-free — the stream proxy bundles this file.
 */

export const LIVETV_FAILURE_REASONS = [
    'channel_offline',
    'provider_auth_failed',
    'provider_connection_limit',
    'provider_unreachable',
    'geo_blocked',
    'no_video',
    'encoder_failed',
    'all_feeds_failed',
    'upstream_stalled',
] as const;

export type LiveTvFailureReason = (typeof LIVETV_FAILURE_REASONS)[number];

export interface LiveTvFailureReasonPolicy {
    /** HTTP status the app answers a failed START with. */
    readonly status: number;
    /** Whether a client may retry automatically. */
    readonly retryable: boolean;
    /** Suggested wait before a retry, when retryable. */
    readonly retryAfterMs?: number;
}

export const LIVETV_FAILURE_POLICY: Readonly<
    Record<LiveTvFailureReason, LiveTvFailureReasonPolicy>
> = {
    channel_offline: { status: 502, retryable: false },
    provider_auth_failed: { status: 502, retryable: false },
    provider_connection_limit: { status: 503, retryable: true, retryAfterMs: 30_000 },
    provider_unreachable: { status: 504, retryable: true, retryAfterMs: 10_000 },
    geo_blocked: { status: 502, retryable: false },
    no_video: { status: 502, retryable: false },
    encoder_failed: { status: 500, retryable: true, retryAfterMs: 5_000 },
    // retryable / retryAfterMs are computed from the per-feed reasons (combineFeedFailures).
    all_feeds_failed: { status: 502, retryable: false },
    upstream_stalled: { status: 502, retryable: true, retryAfterMs: 3_000 },
};

export function isLiveTvFailureReason(value: unknown): value is LiveTvFailureReason {
    return (
        typeof value === 'string' && (LIVETV_FAILURE_REASONS as readonly string[]).includes(value)
    );
}

/** One failed attempt on one URL of a station (primary = index 0, then backups). */
export interface LiveTvFeedFailure {
    /** Index into the join's `streamUrls`. */
    index: number;
    /** Feed (livetv_channels.id) for that URL, when the app sent `feedIds`. */
    feedId?: string;
    reason: Exclude<LiveTvFailureReason, 'all_feeds_failed'>;
    /** Provider HTTP status, when the failure came from an HTTP answer. */
    upstreamStatus?: number;
}

/** Proxy → app body for a failed join (502) and for HLS routes on a failed channel (410). */
export interface LiveTvChannelFailedBody {
    error: 'channel_failed';
    reason: LiveTvFailureReason;
    retryable: boolean;
    retryAfterMs?: number;
    /** Join and heartbeat only; never on HLS routes (those reach players). */
    feedsTried?: LiveTvFeedFailure[];
}

/** A reason one URL (feed) can fail with; `all_feeds_failed` only describes a whole station. */
export type LiveTvFeedFailureReason = Exclude<LiveTvFailureReason, 'all_feeds_failed'>;

/** Which FFmpeg process produced a stderr tail. */
export type LiveTvStderrSource = 'ingest' | 'egress' | 'adaptive-egress';

/**
 * Reasons that end an attempt before it ever connected, without waiting for the
 * degraded window: the provider answered, and the answer will not change on a retry
 * of the same URL. `provider_unreachable` is absent on purpose: a timeout or refused
 * connect fails over only once the attempt has died.
 */
export const LIVETV_IMMEDIATE_FAILOVER_REASONS: readonly LiveTvFeedFailureReason[] = [
    'channel_offline',
    'provider_auth_failed',
    'provider_connection_limit',
    'geo_blocked',
    'no_video',
];

/** Upstream bodies are matched on their first 512 characters only. */
export const LIVETV_BODY_SNIPPET_MAX = 512;

const GEO_BODY =
    /geo[-_ ]?(?:block|restrict|locat)|(?:not available|unavailable|blocked|restricted) in your (?:country|region)|country not allowed|region not supported/;
const LIMIT_BODY =
    /max(?:imum)?[\s_-]*(?:connections?|streams?)|connection[\s_-]*limit|too[\s_-]*many[\s_-]*(?:connections|users)/;

export function liveTvFailurePolicyFor(reason: LiveTvFailureReason): LiveTvFailureReasonPolicy {
    return LIVETV_FAILURE_POLICY[reason];
}

/**
 * A provider's HTTP answer (as seen by the upstream relay). Returns null for an answer
 * that is not a failure (< 400).
 */
export function classifyUpstreamResponse(
    status: number,
    bodySnippet?: string,
): LiveTvFeedFailureReason | null {
    if (!Number.isInteger(status) || status < 400) return null;
    const body = (bodySnippet ?? '').slice(0, LIVETV_BODY_SNIPPET_MAX).toLowerCase();
    if (status === 401 || status === 403) {
        if (GEO_BODY.test(body)) return 'geo_blocked';
        if (LIMIT_BODY.test(body)) return 'provider_connection_limit';
        return 'provider_auth_failed';
    }
    if (status === 404 || status === 410) return 'channel_offline';
    if (status === 451) return 'geo_blocked';
    if (status === 429 || status === 458 || status === 509) return 'provider_connection_limit';
    if (status === 503 && LIMIT_BODY.test(body)) return 'provider_connection_limit';
    if (status === 408 || status >= 500) return 'provider_unreachable';
    return 'channel_offline';
}

/**
 * The relay's own refusal (`GuardFailure` and the generic relay error): timeouts,
 * failed connects, the private-URL policy, and playlists it could not rewrite.
 */
export function classifyGuardFailure(
    status: number,
    diagnostic: string,
): LiveTvFeedFailureReason | null {
    if (!Number.isInteger(status) || status < 400) return null;
    if (/playlist|uri attribute/i.test(diagnostic)) return 'channel_offline';
    return 'provider_unreachable';
}

const STDERR_RULES: ReadonlyArray<{ pattern: RegExp; reason: LiveTvFeedFailureReason }> = [
    {
        pattern: /server returned 40[13]\b|401 unauthorized|403 forbidden/,
        reason: 'provider_auth_failed',
    },
    {
        pattern: /server returned 40[4]\b|404 not found|server returned 410\b/,
        reason: 'channel_offline',
    },
    { pattern: /server returned 5(?:\d\d|xx)\b/, reason: 'provider_unreachable' },
    {
        pattern:
            /connection refused|failed to resolve hostname|connection timed out|network is unreachable|no route to host|connection reset by peer|\btls\b|\bssl\b|certificate/,
        reason: 'provider_unreachable',
    },
    {
        pattern:
            /does not contain any stream|stream map '(?!0:v)[^']*' matches no streams|decoder \(codec [^)]*\) not found/,
        reason: 'no_video',
    },
];

const ENCODER_STDERR = /vaapi|qsv|nvenc|cuda|error initializing output stream|conversion failed/;

/**
 * Encoder lines in an ingest that transcodes. `Conversion failed!` is left out: ingest
 * prints it after every failure, upstream ones included.
 */
const INGEST_ENCODER_STDERR = /vaapi|qsv|nvenc|cuda|error initializing output stream/;

/**
 * The tail of an FFmpeg stderr after the process died or stalled. Returns null when
 * nothing in it is recognisable.
 *
 * For ingest, the LAST recognisable line wins: FFmpeg prints the cause it gave up on
 * last, after earlier recoverable warnings. Encoder lines count for ingest only when
 * the attempt transcodes (`ctx.transcoding`); a copying ingest runs no encoder.
 *
 * `Stream map '0:v…' matches no streams` is an audio-only source (radio), which is
 * valid and therefore never `no_video`.
 */
export function classifyFfmpegStderr(
    tail: string,
    ctx: { source: LiveTvStderrSource; producedSegments: boolean; transcoding?: boolean },
): LiveTvFeedFailureReason | null {
    const text = tail.toLowerCase();
    if (ctx.source !== 'ingest') {
        return ENCODER_STDERR.test(text) ? 'encoder_failed' : null;
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        for (const rule of STDERR_RULES) {
            if (rule.pattern.test(line)) return rule.reason;
        }
        if (ctx.transcoding === true && INGEST_ENCODER_STDERR.test(line)) return 'encoder_failed';
    }
    if (!ctx.producedSegments && text.includes('invalid data found when processing input')) {
        return 'channel_offline';
    }
    return null;
}

/** What a station's start or keepalive reports once every tried URL has failed. */
export interface LiveTvCombinedFailure {
    reason: LiveTvFailureReason;
    retryable: boolean;
    retryAfterMs?: number;
}

/**
 * One reason for the whole station: a single tried URL keeps its own reason and
 * policy; several become `all_feeds_failed`, retryable when any feed's reason is,
 * after the shortest of those waits.
 */
export function combineFeedFailures(feeds: readonly LiveTvFeedFailure[]): LiveTvCombinedFailure {
    const distinct = new Set(feeds.map((feed) => feed.index));
    if (feeds.length === 0) return { reason: 'all_feeds_failed', retryable: false };
    if (distinct.size === 1) {
        const reason = feeds[feeds.length - 1].reason;
        const policy = LIVETV_FAILURE_POLICY[reason];
        return policy.retryAfterMs === undefined
            ? { reason, retryable: policy.retryable }
            : { reason, retryable: policy.retryable, retryAfterMs: policy.retryAfterMs };
    }
    let retryAfterMs: number | undefined;
    let retryable = false;
    for (const feed of feeds) {
        const policy = LIVETV_FAILURE_POLICY[feed.reason];
        if (!policy.retryable) continue;
        retryable = true;
        if (
            policy.retryAfterMs !== undefined &&
            (retryAfterMs === undefined || policy.retryAfterMs < retryAfterMs)
        ) {
            retryAfterMs = policy.retryAfterMs;
        }
    }
    return retryAfterMs === undefined
        ? { reason: 'all_feeds_failed', retryable }
        : { reason: 'all_feeds_failed', retryable, retryAfterMs };
}
