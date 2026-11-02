// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wire contract for failure events emitted by the Rust Live TV proxy. The proxy
 * pushes JSON onto Valkey; the app drains it into livetv_stream_failure_events.
 * Rust maintains its matching wire structures in native/livetv-proxy/.
 */

/** Which FFmpeg process died. */
export type LiveTvFailureSource = 'ingest' | 'egress' | 'adaptive-egress';

/**
 * `spawn_failed` — the child process never started (bad FFMPEG_PATH, EMFILE).
 * `crashed`      — it started and then exited in a way the manager classifies as
 *                  a failure. Deliberately EXCLUDES every intentional teardown
 *                  path; see the recorder call sites for the exact guards.
 * `stalled`      — an ingest attempt the proxy gave up on while FFmpeg was still
 *                  running, or that ended with exit 0 (no data, a refusing
 *                  provider, an ended stream). One per attempt, never in addition
 *                  to a `crashed` event for the same attempt.
 * `exhausted`    — every URL of the station failed; the channel is now terminal.
 */
export type LiveTvFailureOutcome = 'spawn_failed' | 'crashed' | 'stalled' | 'exhausted';

/** Same values as `LiveTvFailureReason` in `livetv-failure-reason.ts`. */
export type LiveTvFailureEventReason =
    | 'channel_offline'
    | 'provider_auth_failed'
    | 'provider_connection_limit'
    | 'provider_unreachable'
    | 'geo_blocked'
    | 'no_video'
    | 'encoder_failed'
    | 'all_feeds_failed'
    | 'upstream_stalled';

export interface LiveTvFailureEvent {
    /** Idempotency key. The drain inserts ON CONFLICT DO NOTHING, so a retried
     *  or concurrently-drained batch cannot produce duplicate rows. */
    eventUid: string;
    /** `livetv_channels.id` as the app handed it to the proxy on join. */
    channelId: string;
    /** ISO-8601. Set by the proxy — the drain can run minutes later. */
    occurredAt: string;
    source: LiveTvFailureSource;
    outcome: LiveTvFailureOutcome;
    exitCode: number | null;
    signal: string | null;
    /** Egress rung / adaptive output id, when the failure is rung-scoped. */
    rungId: string | null;
    /** The stderr tail the manager was already keeping in memory and throwing away. */
    stderrTail: string;
    /** `StreamProbeResult` for ingest failures; null for egress. */
    probe: unknown;
    /** `TranscodeDecision` for ingest failures; null for egress. */
    decision: unknown;
    /** Typed reason, when the proxy could classify the failure. */
    reason?: LiveTvFailureEventReason;
    /** Provider HTTP status behind the failure, when it came from an HTTP answer. */
    upstreamStatus?: number;
    /** Index into the join's `streamUrls` of the URL that failed (ingest only). */
    streamUrlIndex?: number;
    /** Feed (`livetv_channels.id`) of that URL, when the app sent `feedIds`. */
    feedId?: string;
}

/**
 * Valkey list the proxy pushes onto and the app drains.
 *
 * MUST NOT match any prefix in the app's `COORDINATION_KEY_PREFIXES`
 * (`src/lib/server/cache/valkey.ts`) — notably `livetv:v1:`. The proxy writes with a
 * raw RESP client pointed at CACHE_URL and has no notion of the coordination split,
 * so a key the app routes to TASK_CACHE_URL would be drained from an instance
 * nothing ever wrote to, and every event would silently disappear.
 *
 * Deliberately carries no TTL: under the default `volatile-lru` only keys WITH an
 * expiry are evictable, so an un-expiring capped list survives memory pressure.
 */
export const LIVETV_FAILURE_QUEUE_KEY = 'livetv:failures:pending';

/**
 * Hard cap on the queue, enforced by the proxy with an LTRIM after every push.
 * A proxy whose app-side drain is broken must not grow a Valkey list without
 * bound — dropping the OLDEST events is the correct loss mode here, because a
 * channel that is failing in a loop makes every entry a near-duplicate.
 */
export const LIVETV_FAILURE_QUEUE_MAX = 500;
