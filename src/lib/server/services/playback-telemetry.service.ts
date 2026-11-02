// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Playback Telemetry Service
 *
 * Collects and stores playback quality metrics from both server-side
 * (proxy layer) and client-side (HLS.js/native HLS) sources.
 *
 * Features:
 * - Batched writes to minimize database load
 * - Automatic flush on interval or batch size
 * - Session quality aggregation
 * - Per-user and per-device statistics
 *
 * DURABILITY POLICY (best-effort, bounded): telemetry events are buffered
 * in-process and flushed on an interval / batch threshold inside a single
 * transaction. There is intentionally NO durable on-disk / Valkey queue — on a
 * hard crash any un-flushed buffer is lost, and the in-memory buffer is capped
 * (MAX_PENDING_EVENTS) so a DB outage can never grow it without bound. Quality
 * analytics are diagnostic, not billing-grade; dropping a bounded tail of
 * events under failure is an accepted trade-off. Dropped events are counted and
 * logged rather than silently discarded.
 */

import type { JSONValue, Sql } from 'postgres';
import { toUserId, type UserId } from '$lib/shared/user-id';
import { getDb } from '../database/connection.js';
import { withTx } from '../database/with-tx.js';
import { Logger } from '../utils/logger.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { TranscodeReasonSchema, type TranscodeReason } from '$lib/schemas/playback-plan.js';
import {
    classifyDeliveryInterruption,
    INTERRUPTION_MIN_WINDOWS,
    type DeliveryAggregate,
} from './playback-quality/delivery-interruption.js';
import { pruneSpeedTests } from '../database/queries/network-speed-tests.queries.js';
import { detectFormFactor } from '$lib/utils/user-agent.js';

const logger = Logger.for('PlaybackTelemetryService');

// Configuration
const FLUSH_INTERVAL_MS = 5000; // Flush every 5 seconds
const MAX_BATCH_SIZE = 100; // Flush when batch reaches this size
/**
 * Hard absolute cap on the in-memory pending buffer (L6/M8). Enforced at push
 * time so a sustained DB outage (every flush failing + re-queueing) can never
 * grow the buffer without bound. When the buffer is at this size, the newest
 * event is dropped and `droppedEventCount` is incremented. Sized to comfortably
 * hold several full batches' worth of in-flight + re-queued events.
 */
const MAX_PENDING_EVENTS = 1000;
const RETENTION_DAYS = 30; // Keep raw telemetry events for 30 days
/**
 * Retention for per-session quality rollups. These are one row per play
 * session and summarize server + client metrics; 90 days is enough to back
 * the "last three months" quality dashboards without letting the table grow
 * unbounded. Keyed off `computed_at` (set when the session stops).
 */
const SESSION_QUALITY_RETENTION_DAYS = 90;
/**
 * Retention for the daily user / device rollups. These are already collapsed
 * to one row per (user, day) / (device, day), so per-row cost is near zero —
 * the value is historical trend data. One year matches typical "yearly
 * watching summary" expectations and is still bounded.
 */
const ROLLUP_RETENTION_DAYS = 365;
/** Chunk size for batched DELETEs — same convention as pruneOldListenEvents. */
const CLEANUP_BATCH_SIZE = 10000;
const BEACON_WAIT_MS = 2000; // Wait time for client beacon to arrive on stop
/**
 * Upper bound on how long shutdown() waits for stop-time quality work. A slow
 * or wedged database must not hold pod termination until SIGKILL; quality
 * scores are best-effort, so an unfinished one is simply dropped.
 */
const SHUTDOWN_SETTLE_TIMEOUT_MS = 5000;
// Ownership (playSessionId → user_id) is immutable for a session's lifetime, so a
// per-report SELECT to verify it is pure read-amplification: it scales with report
// frequency × concurrent sessions rather than with the flush interval. Cache
// positive lookups briefly to collapse that to ~one query per session. A short TTL
// bounds memory and staleness (a hard-deleted session would still be accepted for
// telemetry until expiry — harmless for best-effort telemetry). Negatives are NOT
// cached, so a report racing session-row creation still succeeds on the next try.
const OWNERSHIP_CACHE_TTL_MS = 5 * 60 * 1000;
const OWNERSHIP_CACHE_MAX = 5000;

/**
 * Health-scoring model version stamped on every row produced by the current
 * formula (L1). Version 3 adds the RECEIVER-TIMED delivery diagnosis: when a
 * client reports `delivery_window` events, their measured p50 becomes the
 * effective bandwidth (ahead of the hls.js EWMA and the server throughput
 * estimate) and a p10 collapse against an ample p50 is named
 * `cause:delivery_interruptions` instead of falling through to
 * `client_side_stall`. Version 2 introduces TAIL-LATENCY-aware delivery penalties:
 * delivery health is driven by the p95 of per-segment delivery latency (and a
 * count-over-threshold check) instead of the arithmetic mean, because the mean
 * hides the stalls users actually feel — a session can average 400 ms yet have
 * a p95 of 3 s that causes rebuffering. Version 1 rows (historical) used the
 * mean-based formula and stay stamped 1 so the query layer never mixes
 * incomparable scores.
 */
const SCORING_MODEL_VERSION = 3;

/**
 * Scoring weights + thresholds for the v2 model. All deductions are additive
 * off a 100 baseline (floored at 0). Each named constant documents the signal
 * it penalizes; thresholds are chosen for 4–6 s HLS segments. To avoid
 * DOUBLE-COUNTING a single root cause, the tail-latency (delivery) penalty and
 * the mean-segment penalty are mutually exclusive — only the larger applies
 * (see calculateHealthScore).
 */
const SCORE = {
    /** Bandwidth ratio = effective bandwidth / required media bitrate. */
    BANDWIDTH_CRITICAL_RATIO: 0.8,
    BANDWIDTH_CRITICAL_PENALTY: 30,
    BANDWIDTH_MARGINAL_RATIO: 1.0,
    BANDWIDTH_MARGINAL_PENALTY: 15,
    BANDWIDTH_TIGHT_RATIO: 1.2,
    BANDWIDTH_TIGHT_PENALTY: 5,

    /**
     * Tail-latency (p95 of segment_delivery_ms) thresholds. p95 is the headline
     * delivery signal in v2 — it is what stalls the player.
     */
    DELIVERY_P95_CRITICAL_MS: 2000,
    DELIVERY_P95_CRITICAL_PENALTY: 20,
    DELIVERY_P95_MODERATE_MS: 1000,
    DELIVERY_P95_MODERATE_PENALTY: 10,

    /**
     * Fallback when no per-segment percentile data exists (external players):
     * fall back to the mean segment time. Mutually exclusive with the p95
     * penalty above so one slow-delivery root cause is counted once.
     */
    DELIVERY_MEAN_CRITICAL_MS: 2000,
    DELIVERY_MEAN_CRITICAL_PENALTY: 20,
    DELIVERY_MEAN_MODERATE_MS: 1000,
    DELIVERY_MEAN_MODERATE_PENALTY: 10,

    /** Each HTTP/proxy error costs this much, capped. */
    SERVER_ERROR_PER: 10,
    SERVER_ERROR_CAP: 30,

    /** Jellyfin/backend fetch latency (mean is adequate here — it's the origin). */
    JELLYFIN_SLOW_MS: 1000,
    JELLYFIN_SLOW_PENALTY: 15,
    JELLYFIN_MODERATE_MS: 500,
    JELLYFIN_MODERATE_PENALTY: 5,

    /** Client-observed rebuffering. */
    REBUFFER_PER: 15,
    REBUFFER_CAP: 40,
    LONG_REBUFFER_MS: 3000,
    LONG_REBUFFER_PENALTY: 10,

    BUFFER_STARVATION_PER: 10,
    BUFFER_STARVATION_CAP: 25,

    LOW_BUFFER_SEC: 2,
    LOW_BUFFER_PENALTY: 10,

    UNSTABLE_QUALITY_SWITCHES: 5,
    UNSTABLE_QUALITY_PENALTY: 5,

    SIGNIFICANT_STALL_MS: 5000,
    SIGNIFICANT_STALL_PENALTY: 15,

    /**
     * Receiver-timed delivery interruptions (v3). Sized to match the marginal
     * bandwidth penalty, and it exists because of an arithmetic trap: a session
     * that reports delivery windows has its bandwidth ratio computed from the
     * MEASURED p50, which for the affected signature is generously above need, where the
     * old hls.js EWMA was below it. Without a penalty of its own, diagnosing a
     * session as interrupted would SCORE IT HIGHER than leaving it undiagnosed.
     */
    DELIVERY_INTERRUPTIONS_PENALTY: 15,
} as const;

/** Percentile points computed per session from raw segment_delivery_ms events. */
type DeliveryPercentiles = {
    p50: number | null;
    p95: number | null;
    p99: number | null;
};

export type TelemetrySource = 'server' | 'client';

export type ServerMetricType =
    | 'segment_bytes'
    | 'segment_delivery_ms'
    | 'jellyfin_fetch_ms'
    | 'proxy_error'
    | 'stream_bytes'
    | 'stream_duration_ms'
    | 'media_bitrate' // Required bitrate for the content
    | 'transcoding_info'; // Transcoding metadata (value = 1, metadata contains details)

export type ClientMetricType =
    | 'bandwidth_estimate'
    | 'buffer_health'
    | 'rebuffer_event' // Rebuffering started (value = 0, will update with duration)
    | 'rebuffer_duration' // Rebuffering ended (value = duration in ms)
    | 'quality_switch'
    | 'playback_stall' // Playback stalled (value = duration in ms)
    | 'buffer_starvation' // Buffer ran empty (value = seconds starved)
    | 'playback_start'
    | 'playback_error'
    | 'seeking' // User seeking (value = seek distance in seconds)
    | 'media_bitrate' // Required bitrate from client (for native HLS)
    | 'reconnect_event' // Reconnect state-machine transition / recovery attempt (value = attempt index; metadata.phase = recovering|attempt|recovered|terminal)
    | 'media_stalled' // UA reported no media data arriving (value = buffer health seconds). Safari can emit this WITHOUT 'waiting'.
    | 'delivery_window'; // receiver-timed 30 s delivery window (value = achieved bps; metadata = spec Part 1)

export type MetricType = ServerMetricType | ClientMetricType;

export interface TelemetryEvent {
    sessionId?: number;
    playSessionId: string;
    userId?: UserId;
    deviceId?: string;
    source: TelemetrySource;
    metricType: MetricType;
    value: number;
    metadata?: Record<string, unknown>;
    recordedAt: Date;
}

export interface ClientTelemetryReport {
    playSessionId: string;
    deviceId?: string;
    clientType: 'hls_js' | 'native_hls' | 'unknown';
    events: Array<{
        type: ClientMetricType;
        value: number;
        metadata?: Record<string, unknown>;
        timestamp: number;
    }>;
}

type ServerAggregateMetrics = {
    total_bytes?: number | null;
    segment_count?: number | null;
    avg_segment_time?: number | null;
    avg_jellyfin_time?: number | null;
    error_count?: number | null;
    media_bitrate?: number | null;
    device_id?: string | null;
};

type ClientAggregateMetrics = {
    avg_bandwidth?: number | null;
    rebuffer_count?: number | null;
    total_rebuffer_duration?: number | null;
    total_stall_duration?: number | null;
    buffer_starvation_count?: number | null;
    quality_switches?: number | null;
    avg_buffer_health?: number | null;
    min_buffer_health?: number | null;
    client_media_bitrate?: number | null;
    client_type?: string | null;
    // Receiver-timed delivery windows (metric_type = 'delivery_window').
    delivery_window_count?: number | null;
    delivery_p10_bps?: number | null;
    delivery_p50_bps?: number | null;
    delivery_overdue_count?: number | null;
};

type TranscodingMetadata = {
    play_method?: string;
    is_transcoding?: boolean;
    is_video_transcoding?: boolean;
    is_audio_transcoding?: boolean;
    source_bitrate_bps?: number;
    output_bitrate_bps?: number;
    source_video_codec?: string;
    output_video_codec?: string;
    source_audio_codec?: string;
    output_audio_codec?: string;
    source_width?: number;
    source_height?: number;
    output_width?: number;
    output_height?: number;
    source_video_range?: string;
    output_video_range?: string;
    transcode_reasons?: unknown;
    transcode_reason_codes?: unknown;
    source_container?: string;
    user_agent?: string;
    is_mobile?: boolean;
    is_live?: boolean;
};

type TranscodingRow = {
    metadata: Record<string, unknown> | null;
};

/**
 * Validate the structured transcode reasons pulled from the `transcoding_info`
 * telemetry metadata (untyped JSON). Returns the well-formed `{ code, params }`
 * entries, or undefined when absent/malformed — the DB column simply stays NULL
 * for those sessions and the analytics panel skips them.
 */
function parseTranscodeReasonCodes(value: unknown): TranscodeReason[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const parsed = value
        .map((entry) => TranscodeReasonSchema.safeParse(entry))
        .filter((r): r is { success: true; data: TranscodeReason } => r.success)
        .map((r) => r.data);
    return parsed.length > 0 ? parsed : undefined;
}

type SessionContextRow = {
    device_id: string | null;
    user_agent: string | null;
    client_name: string | null;
};

type DeviceNameRow = {
    device_name: string | null;
    reported_name: string | null;
};

type UserQualitySummaryRow = {
    total_sessions: number;
    avg_health_score: number;
    total_rebuffers: number;
    avg_bandwidth_mbps: number;
};

type DeviceQualitySummaryRow = {
    total_sessions: number;
    unique_users: number;
    avg_health_score: number;
    total_rebuffers: number;
};

type QualityDailyRow = {
    date: string;
    sessions: number;
    avg_health_score: number;
    rebuffer_events: number;
};

export interface SessionQualityData {
    sessionId?: number;
    playSessionId: string;
    userId: UserId;
    deviceId?: string;
    deviceName?: string;
    clientType?: string;
    // Media info
    mediaBitrateBps?: number; // Required bitrate for the content
    // Server-side metrics
    serverBytesTotal?: number;
    serverAvgThroughputBps?: number;
    serverSegmentCount?: number;
    serverAvgSegmentTimeMs?: number;
    serverErrorCount?: number;
    jellyfinAvgFetchTimeMs?: number;
    // Client-side metrics
    clientAvgBandwidthBps?: number;
    clientRebufferCount?: number;
    clientTotalRebufferDurationMs?: number;
    clientTotalStallDurationMs?: number;
    clientBufferStarvationCount?: number;
    clientQualitySwitches?: number;
    clientAvgBufferHealthSec?: number;
    clientMinBufferHealthSec?: number;
    // Receiver-timed delivery windows (undefined when the client reported none)
    clientDeliveryWindowCount?: number;
    clientDeliveryP10Bps?: number;
    clientDeliveryP50Bps?: number;
    clientDeliveryOverdueCount?: number;
    // Transcoding metrics
    playMethod?: 'DirectPlay' | 'DirectStream' | 'Transcode';
    isTranscoding?: boolean;
    isVideoTranscoding?: boolean;
    isAudioTranscoding?: boolean;
    sourceBitrateBps?: number;
    outputBitrateBps?: number;
    sourceVideoCodec?: string;
    outputVideoCodec?: string;
    sourceAudioCodec?: string;
    outputAudioCodec?: string;
    sourceWidth?: number;
    sourceHeight?: number;
    outputWidth?: number;
    outputHeight?: number;
    sourceVideoRange?: string;
    outputVideoRange?: string;
    transcodeReasons?: string[];
    transcodeReasonCodes?: TranscodeReason[];
    sourceContainer?: string;
    compressionRatio?: number; // sourceBitrate / outputBitrate (>1 = compression)
    // Computed
    bandwidthRatio?: number; // actual / required (>1 = good, <1 = insufficient)
    healthScore?: number;
    healthIssues?: string[];
    scoringModelVersion?: number; // model version that produced healthScore (L1)
    // Per-session segment-delivery latency percentiles (ms). Null when no
    // server-side per-segment telemetry exists for the session.
    deliveryP50Ms?: number | null;
    deliveryP95Ms?: number | null;
    deliveryP99Ms?: number | null;
    // Context
    userAgent?: string;
    isMobile?: boolean;
    isLive?: boolean;
}

class PlaybackTelemetryService {
    private sql: Sql | null;
    private pendingEvents: TelemetryEvent[] = [];
    private flushInterval: ReturnType<typeof setInterval> | null = null;
    private isShuttingDown = false;
    private isFlushing = false;
    /**
     * In-flight flush promise (M6). When a flush is running, callers that need
     * complete data (computeSessionQuality) await THIS rather than no-op
     * returning, then drain whatever arrived during the flush. Cleared in the
     * flush's finally block.
     */
    private flushPromise: Promise<void> | null = null;
    /** Cumulative count of events dropped at push time due to the hard cap (L6/M8). */
    private droppedEventCount = 0;
    /**
     * Bounded cache of verified session ownership (playSessionId → user_id) to avoid
     * a per-report SELECT. Only positive results are stored (see OWNERSHIP_CACHE_TTL_MS).
     */
    private ownershipCache: Map<string, { userId: string; expiresAt: number }> = new Map();
    /**
     * Fire-and-forget quality work started on stop: Phase 2 timers that have not
     * fired yet (mapped to the run they would start) and the computes/rollups in
     * flight. settleBackgroundWork() drains both, so shutdown and tests that reset
     * the database never race a write that lands after they move on.
     */
    private pendingPhase2 = new Map<ReturnType<typeof setTimeout>, () => void>();
    private inFlightQualityWork = new Set<Promise<unknown>>();

    constructor() {
        this.sql = null;
    }

    /**
     * Check if telemetry is enabled and database is available
     */
    private isAvailable(): boolean {
        if (this.isShuttingDown) {
            return false;
        }

        if (!this.sql) {
            this.ensureSql();
        }

        return this.sql !== null;
    }

    private ensureSql(): void {
        if (this.sql) {
            return;
        }

        this.sql = getDb();

        if (this.sql && !this.flushInterval) {
            this.flushInterval = setInterval(() => {
                void this.flush();
            }, FLUSH_INTERVAL_MS);
        }
    }

    /**
     * Record a telemetry event (batched)
     */
    async record(
        playSessionId: string,
        source: TelemetrySource,
        metricType: MetricType,
        value: number,
        options?: {
            sessionId?: number;
            userId?: UserId;
            deviceId?: string;
            metadata?: Record<string, unknown>;
        },
    ): Promise<void> {
        if (!this.isAvailable()) return;

        // `playback_telemetry.play_session_id` is a uuid column. Fire-and-forget
        // callers (e.g. the HLS segment handler's proxy_error path) can pass a
        // preview/composite id like `preview-<uuid>-<millis>`, which is NOT a
        // uuid. Enqueuing it would make the batch INSERT raise 22P02, and because
        // a failed flush re-queues the whole batch at the FRONT, that one bad row
        // becomes a poison pill that blocks ALL telemetry (real playback included)
        // until the buffer overflows. Drop non-uuid ids at ingress instead.
        if (!UUID_RE.test(playSessionId)) {
            return;
        }

        this.enqueue({
            sessionId: options?.sessionId,
            playSessionId,
            userId: options?.userId,
            deviceId: options?.deviceId,
            source,
            metricType,
            value,
            metadata: options?.metadata,
            recordedAt: new Date(),
        });

        // Flush if batch is large enough
        if (this.pendingEvents.length >= MAX_BATCH_SIZE) {
            await this.flush();
        }
    }

    /**
     * Push one event onto the buffer, enforcing the hard absolute cap (L6/M8).
     * When the buffer is full the event is dropped and counted; a throttled
     * warning is emitted so an operator can see telemetry loss without log
     * spam. Telemetry is best-effort (see class doc) — dropping is acceptable.
     */
    private enqueue(event: TelemetryEvent): void {
        // Defense-in-depth: never buffer an event whose play_session_id is not a
        // uuid — the flush INSERT targets a uuid column and one bad row poisons
        // the whole re-queued batch (see the guard in record()). Callers should
        // already filter, but this is the single chokepoint every path funnels
        // through, so enforce the invariant here too.
        if (!UUID_RE.test(event.playSessionId)) {
            return;
        }
        if (this.pendingEvents.length >= MAX_PENDING_EVENTS) {
            this.droppedEventCount++;
            // Log on the first drop and then every full-batch worth of drops to
            // avoid flooding logs during a sustained DB outage.
            if (this.droppedEventCount === 1 || this.droppedEventCount % MAX_BATCH_SIZE === 0) {
                logger.warn('Telemetry buffer full — dropping events (best-effort)', {
                    droppedTotal: this.droppedEventCount,
                    bufferSize: this.pendingEvents.length,
                    cap: MAX_PENDING_EVENTS,
                });
            }
            return;
        }
        this.pendingEvents.push(event);
    }

    /**
     * Resolve (and cache) the owning user_id for a session. Returns null if the
     * session is unknown. Only positive results are cached (TTL-bounded); a miss
     * always re-queries so a report racing session-row creation isn't poisoned by
     * a cached negative.
     */
    private async resolveSessionOwner(playSessionId: string): Promise<string | null> {
        const cached = this.ownershipCache.get(playSessionId);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.userId;
        }
        const [sessionOwner] = await this.sql!<{ user_id: string }[]>`
            SELECT user_id FROM play_sessions WHERE id = ${playSessionId}
        `;
        if (!sessionOwner) {
            return null;
        }
        // Evict the oldest entry if at capacity (Map preserves insertion order).
        if (this.ownershipCache.size >= OWNERSHIP_CACHE_MAX) {
            const oldest = this.ownershipCache.keys().next().value;
            if (oldest !== undefined) this.ownershipCache.delete(oldest);
        }
        this.ownershipCache.set(playSessionId, {
            userId: sessionOwner.user_id,
            expiresAt: Date.now() + OWNERSHIP_CACHE_TTL_MS,
        });
        return sessionOwner.user_id;
    }

    /**
     * Record multiple client telemetry events from a report.
     *
     * Ownership check: verifies that the play session identified by
     * `report.playSessionId` belongs to `userId` before writing any events.
     * Returns without throwing when the session does not exist or belongs to a
     * different user — the caller should translate this to a 404-style response
     * to avoid leaking session existence.
     *
     * @returns `true` if the report was accepted, `false` if the session was
     *   not found or ownership did not match. NOTE: the return contract is
     *   "accepted for buffering", NOT "durably persisted" — when the DB is
     *   unavailable this returns `true` (callers rely on this to avoid client
     *   retry storms) but the events are dropped; a warning is logged so the
     *   drop is visible (L5). Telemetry is best-effort (see class doc).
     */
    async recordClientReport(report: ClientTelemetryReport, userId?: UserId): Promise<boolean> {
        if (!this.isAvailable()) {
            // DB down: we still return true (accepted) so the client doesn't
            // retry-storm, but the events are silently lost — log it (L5).
            logger.warn('Telemetry DB unavailable — dropping client report (best-effort)', {
                playSessionId: report.playSessionId,
                eventCount: report.events.length,
            });
            return true;
        }

        // Defensive M9 guard: a non-UUID playSessionId would make the ownership
        // SELECT below raise Postgres 22P02 (the column is uuid), bubbling as a
        // 500. Treat malformed ids as "not found" → caller returns 404.
        if (!UUID_RE.test(report.playSessionId)) {
            return false;
        }

        // Verify session ownership once per report (not per event). Cached because
        // (playSessionId → user_id) is immutable, collapsing the per-report SELECT to
        // ~one query per session under load.
        if (userId !== undefined) {
            const ownerUserId = await this.resolveSessionOwner(report.playSessionId);
            if (ownerUserId === null || ownerUserId !== userId) {
                return false;
            }
        }

        const now = Date.now();
        const ONE_DAY_MS = 24 * 60 * 60 * 1000;

        for (const event of report.events) {
            // Reject non-finite client-reported values (NaN/Infinity) before they
            // reach the buffer — the DB column is double precision and a single
            // bad row poisons AVG/percentile_cont aggregates for the whole session.
            if (!Number.isFinite(event.value)) {
                logger.debug('Dropping non-finite client-reported telemetry value', {
                    playSessionId: report.playSessionId,
                    metricType: event.type,
                    value: event.value,
                });
                continue;
            }

            // Validate timestamp - must be within last 24 hours and not in the future
            let recordedAt: Date;
            if (
                typeof event.timestamp === 'number' &&
                !isNaN(event.timestamp) &&
                event.timestamp > now - ONE_DAY_MS &&
                event.timestamp <= now + 60000 // Allow 1 minute clock skew
            ) {
                recordedAt = new Date(event.timestamp);
            } else {
                // Use current time for invalid timestamps
                recordedAt = new Date();
            }

            this.enqueue({
                playSessionId: report.playSessionId,
                userId,
                deviceId: report.deviceId,
                source: 'client',
                metricType: event.type,
                value: event.value,
                metadata: {
                    ...event.metadata,
                    clientType: report.clientType,
                },
                recordedAt,
            });
        }

        // Flush if batch is large enough
        if (this.pendingEvents.length >= MAX_BATCH_SIZE) {
            await this.flush();
        }

        return true;
    }

    /**
     * Flush pending events to the database.
     *
     * M6 (await-correct): if a flush is already in flight, callers that need
     * complete data must NOT get a silent no-op. We chain off the in-flight
     * flush and then drain whatever accumulated during it, so awaiting flush()
     * always guarantees the buffer-as-of-call-time has been attempted.
     *
     * M5/M10 (atomic single insert): each drained batch is written as ONE
     * multi-row INSERT inside a transaction (sql.begin), so it commits
     * all-or-nothing. On failure the WHOLE batch is re-queued (nothing was
     * committed → no double-count) subject to the hard cap.
     */
    async flush(): Promise<void> {
        // Chain off any in-flight flush so the caller's await reflects it.
        // Loop: after an in-flight flush settles a concurrent caller may have
        // already started the next drain — await that one too rather than
        // racing a second drain loop against it. We only start our OWN drain
        // when no flush is in flight at the moment we check.
        while (this.flushPromise) {
            await this.flushPromise;
        }
        if (!this.isAvailable() || this.pendingEvents.length === 0) return;

        const run = this.drainAndFlush();
        this.flushPromise = run;
        try {
            await run;
        } finally {
            if (this.flushPromise === run) {
                this.flushPromise = null;
            }
        }
    }

    /**
     * Drain the buffer in batches and write each as a single atomic multi-row
     * insert. Loops until the buffer is empty so events that arrived during an
     * earlier batch in the same flush still get written (M6 drain semantics).
     */
    private async drainAndFlush(): Promise<void> {
        this.isFlushing = true;
        try {
            while (this.pendingEvents.length > 0) {
                // Take up to one batch; leave the rest for the next loop turn.
                const batch = this.pendingEvents.splice(0, MAX_BATCH_SIZE);

                try {
                    await withTx(this.sql!, async (tx) => {
                        // Build rows inside the transaction so tx.json() (same
                        // serializer that runs the insert) preserves JSONB object
                        // semantics per metadata cell — a plain object would be
                        // stored as a JSON string primitive, breaking
                        // metadata->>'key' extraction downstream.
                        const rows = batch.map((e) => ({
                            session_id: e.sessionId ?? null,
                            play_session_id: e.playSessionId,
                            user_id: e.userId ?? null,
                            device_id: e.deviceId ?? null,
                            source: e.source,
                            metric_type: e.metricType,
                            value: e.value,
                            metadata: e.metadata ? tx.json(e.metadata as JSONValue) : null,
                            recorded_at: e.recordedAt,
                        }));

                        await tx`
                            INSERT INTO playback_telemetry ${tx(
                                rows,
                                'session_id',
                                'play_session_id',
                                'user_id',
                                'device_id',
                                'source',
                                'metric_type',
                                'value',
                                'metadata',
                                'recorded_at',
                            )}
                        `;
                    });
                    logger.debug('Flushed telemetry events', { count: batch.length });
                } catch (error) {
                    // Nothing committed (transaction rolled back) → re-queue the
                    // whole batch at the FRONT so ordering is preserved, subject
                    // to the hard cap. Stop draining; the next interval retries.
                    this.requeueBatch(batch);
                    logger.error('Failed to flush telemetry events', error as Error);
                    return;
                }
            }
        } finally {
            this.isFlushing = false;
        }
    }

    /**
     * Re-queue an un-committed batch at the front of the buffer, honoring the
     * hard absolute cap (L6/M8). Any events that don't fit are dropped and
     * counted — prevents unbounded growth under a sustained DB outage.
     */
    private requeueBatch(batch: TelemetryEvent[]): void {
        const capacity = MAX_PENDING_EVENTS - this.pendingEvents.length;
        if (capacity <= 0) {
            this.droppedEventCount += batch.length;
            logger.warn('Telemetry buffer full on re-queue — dropping batch (best-effort)', {
                droppedTotal: this.droppedEventCount,
                droppedNow: batch.length,
                cap: MAX_PENDING_EVENTS,
            });
            return;
        }
        if (batch.length > capacity) {
            const dropped = batch.length - capacity;
            this.droppedEventCount += dropped;
            logger.warn('Telemetry buffer near cap on re-queue — dropping overflow (best-effort)', {
                droppedTotal: this.droppedEventCount,
                droppedNow: dropped,
                cap: MAX_PENDING_EVENTS,
            });
            // Keep the most recent `capacity` events of the batch.
            batch = batch.slice(batch.length - capacity);
        }
        this.pendingEvents = [...batch, ...this.pendingEvents];
    }

    /**
     * Compute and store session quality metrics.
     *
     * @param runRollups When true (default), refreshes the daily user/device
     *   rollups after the upsert. The two-phase stop flow (M7) passes `false`
     *   for Phase 1 so the O(N) daily recompute runs exactly ONCE — in Phase 2.
     */
    async computeSessionQuality(
        playSessionId: string,
        userId: UserId,
        runRollups = true,
    ): Promise<SessionQualityData | null> {
        if (!this.isAvailable()) return null;

        // Defensive M9 guard: non-UUID ids would raise Postgres 22P02 in the
        // per-session queries below (play_session_id is uuid). Bail cleanly.
        if (!UUID_RE.test(playSessionId)) {
            return null;
        }

        try {
            // Flush any pending events first to ensure we have complete data.
            // M6: flush() now awaits the in-flight flush and drains remaining
            // events, so this genuinely guarantees the buffer is persisted.
            await this.flush();

            // L3: serialize the two-phase + multi-device compute for this
            // session under a transaction-scoped advisory lock keyed by the
            // session id, so Phase 1 can't clobber Phase 2's upsert (and
            // concurrent device computes can't interleave). The lock is held
            // for the duration of the wrapping transaction below.
            const quality = await withTx(this.sql!, async (tx) => {
                await tx`SELECT pg_advisory_xact_lock(hashtextextended(${playSessionId}, 0))`;
                return this.computeSessionQualityLocked(tx, playSessionId, userId);
            });

            // M7: fire the daily rollups exactly once, AFTER the locked upsert
            // transaction commits, and only on the rollup-owning phase. The
            // recompute is a single scan over the (newly-indexed) per-session
            // table, so it's cheap; we don't await it on the playback path.
            if (runRollups && quality) {
                this.trackQualityWork(
                    this.updateUserDailyQuality(userId).catch(() => {
                        /* Telemetry errors should not affect playback */
                    }),
                );
                if (quality.deviceId) {
                    this.trackQualityWork(
                        this.updateDeviceDailyQuality(quality.deviceId).catch(() => {
                            /* Telemetry errors should not affect playback */
                        }),
                    );
                }
            }

            return quality;
        } catch (error) {
            logger.error('Failed to compute session quality', error as Error, {
                playSessionId,
            });
            return null;
        }
    }

    /**
     * Inner body of computeSessionQuality — runs inside the advisory-locked
     * transaction (`tx`). All reads/writes use `tx` so they share the lock and
     * commit atomically with it.
     */
    private async computeSessionQualityLocked(
        sql: Sql,
        playSessionId: string,
        userId: UserId,
    ): Promise<SessionQualityData | null> {
        {
            // Get server-side metrics
            const serverMetrics = await sql<ServerAggregateMetrics[]>`
				SELECT
					SUM(CASE WHEN metric_type IN ('segment_bytes', 'stream_bytes') THEN value ELSE 0 END) as total_bytes,
					COUNT(CASE WHEN metric_type = 'segment_delivery_ms' THEN 1 END) as segment_count,
					AVG(CASE WHEN metric_type = 'segment_delivery_ms' THEN value END) as avg_segment_time,
					AVG(CASE WHEN metric_type = 'jellyfin_fetch_ms' THEN value END) as avg_jellyfin_time,
					SUM(CASE WHEN metric_type = 'proxy_error' THEN 1 ELSE 0 END) as error_count,
					MAX(CASE WHEN metric_type = 'media_bitrate' THEN value END) as media_bitrate,
					MAX(device_id) as device_id
				FROM playback_telemetry
				WHERE play_session_id = ${playSessionId}
				  AND source = 'server'
			`;

            // Get client-side metrics
            const clientMetrics = await sql<ClientAggregateMetrics[]>`
				SELECT
					AVG(CASE WHEN metric_type = 'bandwidth_estimate' THEN value END) as avg_bandwidth,
					SUM(CASE WHEN metric_type = 'rebuffer_event' THEN 1 ELSE 0 END) as rebuffer_count,
					SUM(CASE WHEN metric_type = 'rebuffer_duration' THEN value ELSE 0 END) as total_rebuffer_duration,
					SUM(CASE WHEN metric_type = 'playback_stall' THEN value ELSE 0 END) as total_stall_duration,
					SUM(CASE WHEN metric_type = 'buffer_starvation' THEN 1 ELSE 0 END) as buffer_starvation_count,
					SUM(CASE WHEN metric_type = 'quality_switch' THEN 1 ELSE 0 END) as quality_switches,
					AVG(CASE WHEN metric_type = 'buffer_health' THEN value END) as avg_buffer_health,
					MIN(CASE WHEN metric_type = 'buffer_health' THEN value END) as min_buffer_health,
					MAX(CASE WHEN metric_type = 'media_bitrate' THEN value END) as client_media_bitrate,
					-- Receiver-timed delivery windows. percentile_cont ignores NULLs, so the
					-- CASE restricts each percentile to 'delivery_window' rows.
					--
					-- The metadata column is CLIENT-CONTROLLED free-form JSON (z.record of
					-- z.unknown on the public report path), so the overdue cast MUST be
					-- guarded: a single {overdue:'abc'} — or an object value, which ->> renders
					-- as JSON text — makes ::numeric raise 22P02, which aborts THIS WHOLE
					-- SELECT, makes computeSessionQualityLocked return null, and costs that
					-- session its quality row permanently. The regex admits only plain
					-- non-negative decimals; everything else contributes NULL and SUM skips it.
					-- NB: the pattern is written with a DOUBLED backslash on purpose — in a JS
					-- template literal a lone backslash-dot collapses to a bare dot, which
					-- matches ANY character and would let '1x2' reach the cast.
					COUNT(CASE WHEN metric_type = 'delivery_window' THEN 1 END) as delivery_window_count,
					percentile_cont(0.10) WITHIN GROUP (ORDER BY CASE WHEN metric_type = 'delivery_window' THEN value END) as delivery_p10_bps,
					percentile_cont(0.50) WITHIN GROUP (ORDER BY CASE WHEN metric_type = 'delivery_window' THEN value END) as delivery_p50_bps,
					COALESCE(SUM(CASE WHEN metric_type = 'delivery_window' AND metadata->>'overdue' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (metadata->>'overdue')::numeric END), 0) as delivery_overdue_count,
					-- Prefer known player types over 'unknown' (MAX would pick 'unknown' since 'u' > 'n')
					COALESCE(
						MAX(CASE WHEN metadata->>'clientType' IN ('native_hls', 'hls_js') THEN metadata->>'clientType' END),
						MAX(metadata->>'clientType')
					) as client_type
				FROM playback_telemetry
				WHERE play_session_id = ${playSessionId}
				  AND source = 'client'
			`;

            // Get transcoding info (from the most recent transcoding_info event)
            const transcodingMetrics = await sql<TranscodingRow[]>`
				SELECT metadata
				FROM playback_telemetry
				WHERE play_session_id = ${playSessionId}
				  AND metric_type = 'transcoding_info'
				ORDER BY recorded_at DESC
				LIMIT 1
			`;

            // Per-session segment-delivery latency percentiles (L1/percentiles).
            // Computed exactly via percentile_cont over the raw server-side
            // segment_delivery_ms events. NULL when no server segment data exists
            // (external players / native HLS) — the columns stay NULL and the
            // health score falls back to the mean-segment penalty.
            const deliveryRows = await sql<
                { p50: number | null; p95: number | null; p99: number | null }[]
            >`
					SELECT
						percentile_cont(0.50) WITHIN GROUP (ORDER BY value) AS p50,
						percentile_cont(0.95) WITHIN GROUP (ORDER BY value) AS p95,
						percentile_cont(0.99) WITHIN GROUP (ORDER BY value) AS p99
					FROM playback_telemetry
					WHERE play_session_id = ${playSessionId}
					  AND source = 'server'
					  AND metric_type = 'segment_delivery_ms'
				`;
            const deliveryPercentiles: DeliveryPercentiles = {
                p50: deliveryRows[0]?.p50 != null ? Number(deliveryRows[0].p50) : null,
                p95: deliveryRows[0]?.p95 != null ? Number(deliveryRows[0].p95) : null,
                p99: deliveryRows[0]?.p99 != null ? Number(deliveryRows[0].p99) : null,
            };

            const server: ServerAggregateMetrics = serverMetrics[0] ?? {};
            const client: ClientAggregateMetrics = clientMetrics[0] ?? {};
            // Receiver-timed delivery evidence for this session (empty on clients
            // that never report 'delivery_window'). The SUM above is a PG numeric
            // (postgres.js hands it back as a string) and the client may have sent a
            // fractional overdue value, so round to an integer before it reaches the
            // `integer` column — and treat anything non-finite as no evidence.
            const overdueRaw = Number(client.delivery_overdue_count ?? 0);
            const delivery: DeliveryAggregate = {
                windowCount: Number(client.delivery_window_count ?? 0),
                p10Bps: client.delivery_p10_bps != null ? Number(client.delivery_p10_bps) : null,
                p50Bps: client.delivery_p50_bps != null ? Number(client.delivery_p50_bps) : null,
                overdueCount: Number.isFinite(overdueRaw) ? Math.round(overdueRaw) : 0,
            };
            const transcoding = (transcodingMetrics[0]?.metadata ?? {}) as TranscodingMetadata;

            // Look up the display name for this session's device.
            //
            // Three things were wrong here before:
            //   1. It read `user_provider_device_tokens` — a Jellyfin table. Jellyfin is
            //      optional, so on a Jellyfin-less install this always resolved NULL and
            //      every device in the playback-health admin view showed as "Unknown".
            //      Device identity must not be coupled to an optional integration.
            //   2. `server.device_id` is a *device_id* (client-generated, carried on
            //      play_sessions/playback_telemetry) — NOT a device_session_id. Matching
            //      it against device_session_id only ever resolved for web clients, which
            //      happen to reuse their localStorage device_id as the session id.
            //   3. The lookup MUST be scoped to the owning user. device_id is
            //      client-supplied free text, so an unscoped query let a client read back
            //      another user's device name by claiming their identifier.
            //   4. The device id itself must come from the play session, not the
            //      telemetry. Server telemetry carries the shared placeholder
            //      `lumastra-player` for most web and native sessions, which merged
            //      17 users' 31 devices into one "device" on prod (2026-09-27).
            //      The session row is also where the UA and client name live,
            //      which the device-class split below needs.
            const sessionContext = (
                await sql<SessionContextRow[]>`
					SELECT device_id, user_agent, client_name
					FROM play_sessions
					WHERE id = ${playSessionId}::uuid
					  AND user_id = ${userId}::uuid
					LIMIT 1
				`
            )[0];
            const deviceId = sessionContext?.device_id ?? server.device_id ?? undefined;

            let deviceName: string | undefined;
            let reportedName: string | undefined;
            if (deviceId) {
                const deviceNameResult = await sql<DeviceNameRow[]>`
					SELECT COALESCE(custom_name, reported_name) AS device_name, reported_name
					FROM user_devices
					WHERE device_id = ${deviceId}
					  AND user_id = ${userId}::uuid
					LIMIT 1
				`;
                deviceName = deviceNameResult[0]?.device_name ?? undefined;
                reportedName = deviceNameResult[0]?.reported_name ?? undefined;
            }

            // Device class from the same evidence the analytics SQL classifies
            // (formFactorSql). is_mobile stays NULL when nothing identifies the
            // device — it used to default to false, so every session read as
            // "desktop". The session-start metadata never carries these fields.
            const userAgent = transcoding.user_agent ?? sessionContext?.user_agent ?? undefined;
            const formFactor = detectFormFactor(
                userAgent,
                sessionContext?.client_name,
                reportedName,
            );
            const isMobile =
                formFactor === 'unknown'
                    ? (transcoding.is_mobile ?? undefined)
                    : formFactor === 'mobile' || formFactor === 'tablet';

            // Get media bitrate from either source
            const mediaBitrate = server.media_bitrate ?? client.client_media_bitrate ?? undefined;

            // Calculate throughput with safety bounds (needed for bandwidth ratio fallback)
            let avgThroughput: number | undefined;
            if (server.total_bytes && server.segment_count && server.avg_segment_time) {
                // Ensure avg_segment_time is at least 1ms to avoid division by near-zero
                const safeAvgSegmentTime = Math.max(server.avg_segment_time, 1);
                const calculatedThroughput =
                    server.total_bytes / server.segment_count / (safeAvgSegmentTime / 1000);
                // Cap at 10 Gbps to filter out obviously erroneous values
                avgThroughput = Math.min(calculatedThroughput, 10_000_000_000);
            }

            // Calculate bandwidth ratio (actual / required)
            // Precedence: the RECEIVER-TIMED measurement (delivery-window p50) wins over
            // the hls.js EWMA `bandwidth_estimate`, which in turn beats the server-side
            // throughput estimate. The p50 is what the client actually achieved over
            // whole 30 s windows; the EWMA is a per-fragment guess and the server
            // estimate only bounds what we pushed. But trust the p50 only on a sample
            // the classifier itself would trust — one or two windows is a single
            // 30-60 s slice, and letting it override the EWMA would make the headline
            // bandwidth_ratio swing on a sample too thin to carry a percentile. Below
            // that bar (and for Safari/native HLS, which reports no bandwidth at all)
            // the old fallback chain stands so every session still gets a diagnosis.
            const hasTrustedDeliveryP50 =
                delivery.windowCount >= INTERRUPTION_MIN_WINDOWS &&
                delivery.p50Bps != null &&
                delivery.p50Bps > 0;
            let bandwidthRatio: number | undefined;
            if (mediaBitrate) {
                const effectiveBandwidth = hasTrustedDeliveryP50
                    ? delivery.p50Bps
                    : client.avg_bandwidth
                      ? Number(client.avg_bandwidth)
                      : avgThroughput;
                if (effectiveBandwidth) {
                    bandwidthRatio = effectiveBandwidth / Number(mediaBitrate);
                }
            }

            // Extract isTranscoding early for health score calculation
            const isTranscoding = transcoding.is_transcoding ?? false;

            // Calculate health score and issues (including root cause diagnosis).
            // v2: delivery penalties are driven by the p95 tail latency.
            const { score, issues } = this.calculateHealthScore(
                server,
                client,
                mediaBitrate,
                bandwidthRatio,
                isTranscoding,
                deliveryPercentiles,
                delivery,
            );

            // Extract transcoding info from metadata
            // Check if we have actual transcoding data (not just empty object)
            const transcodingMeta = transcodingMetrics[0]?.metadata;
            const hasTranscodingData =
                transcodingMetrics.length > 0 &&
                transcodingMeta &&
                typeof transcodingMeta === 'object' &&
                Object.keys(transcodingMeta).length > 0;
            const sourceBitrate = transcoding.source_bitrate_bps ?? null;
            const outputBitrate = transcoding.output_bitrate_bps ?? null;
            const compressionRatio =
                sourceBitrate && outputBitrate && outputBitrate > 0
                    ? sourceBitrate / outputBitrate
                    : undefined;

            // Validate playMethod value (must be one of the allowed values)
            const rawPlayMethod =
                typeof transcoding.play_method === 'string' ? transcoding.play_method : undefined;
            const validPlayMethods = ['DirectPlay', 'DirectStream', 'Transcode'] as const;
            type PlayMethod = (typeof validPlayMethods)[number];
            const playMethod =
                rawPlayMethod && validPlayMethods.includes(rawPlayMethod as PlayMethod)
                    ? (rawPlayMethod as PlayMethod)
                    : undefined;

            const quality: SessionQualityData = {
                playSessionId,
                userId,
                deviceId,
                deviceName,
                clientType: client.client_type ?? undefined,
                mediaBitrateBps: mediaBitrate ? Number(mediaBitrate) : undefined,
                serverBytesTotal: server.total_bytes ? Number(server.total_bytes) : undefined,
                serverAvgThroughputBps: avgThroughput,
                serverSegmentCount: server.segment_count ? Number(server.segment_count) : undefined,
                serverAvgSegmentTimeMs: server.avg_segment_time
                    ? Number(server.avg_segment_time)
                    : undefined,
                serverErrorCount: server.error_count ? Number(server.error_count) : undefined,
                jellyfinAvgFetchTimeMs: server.avg_jellyfin_time
                    ? Number(server.avg_jellyfin_time)
                    : undefined,
                clientAvgBandwidthBps: client.avg_bandwidth
                    ? Number(client.avg_bandwidth)
                    : undefined,
                clientRebufferCount: client.rebuffer_count
                    ? Number(client.rebuffer_count)
                    : undefined,
                clientTotalRebufferDurationMs: client.total_rebuffer_duration
                    ? Number(client.total_rebuffer_duration)
                    : undefined,
                clientTotalStallDurationMs: client.total_stall_duration
                    ? Number(client.total_stall_duration)
                    : undefined,
                clientBufferStarvationCount: client.buffer_starvation_count
                    ? Number(client.buffer_starvation_count)
                    : undefined,
                clientQualitySwitches: client.quality_switches
                    ? Number(client.quality_switches)
                    : undefined,
                clientAvgBufferHealthSec: client.avg_buffer_health
                    ? Number(client.avg_buffer_health)
                    : undefined,
                clientMinBufferHealthSec: client.min_buffer_health
                    ? Number(client.min_buffer_health)
                    : undefined,
                // Receiver-timed delivery windows. The two percentiles stay undefined
                // when the session carries no windows, so their COALESCE upsert keeps
                // whatever an earlier pass stored; the two counts are written with
                // `= EXCLUDED.x` and default to 0 in the VALUES list, so a later pass
                // can never null a stored count out of step with the percentiles.
                clientDeliveryWindowCount: delivery.windowCount || undefined,
                clientDeliveryP10Bps:
                    delivery.windowCount > 0 ? (delivery.p10Bps ?? undefined) : undefined,
                clientDeliveryP50Bps:
                    delivery.windowCount > 0 ? (delivery.p50Bps ?? undefined) : undefined,
                clientDeliveryOverdueCount:
                    delivery.windowCount > 0 ? delivery.overdueCount : undefined,
                // Transcoding metrics - only set if we have actual data (undefined means unknown)
                playMethod,
                isTranscoding: hasTranscodingData
                    ? (transcoding.is_transcoding ?? false)
                    : undefined,
                isVideoTranscoding: hasTranscodingData
                    ? (transcoding.is_video_transcoding ?? false)
                    : undefined,
                isAudioTranscoding: hasTranscodingData
                    ? (transcoding.is_audio_transcoding ?? false)
                    : undefined,
                sourceBitrateBps: sourceBitrate ?? undefined,
                outputBitrateBps: outputBitrate ?? undefined,
                sourceVideoCodec: transcoding.source_video_codec ?? undefined,
                outputVideoCodec: transcoding.output_video_codec ?? undefined,
                sourceAudioCodec: transcoding.source_audio_codec ?? undefined,
                outputAudioCodec: transcoding.output_audio_codec ?? undefined,
                sourceWidth: transcoding.source_width ?? undefined,
                sourceHeight: transcoding.source_height ?? undefined,
                outputWidth: transcoding.output_width ?? undefined,
                outputHeight: transcoding.output_height ?? undefined,
                sourceVideoRange: transcoding.source_video_range ?? undefined,
                outputVideoRange: transcoding.output_video_range ?? undefined,
                transcodeReasons: Array.isArray(transcoding.transcode_reasons)
                    ? transcoding.transcode_reasons.filter(
                          (reason): reason is string => typeof reason === 'string',
                      )
                    : undefined,
                transcodeReasonCodes: parseTranscodeReasonCodes(transcoding.transcode_reason_codes),
                sourceContainer: transcoding.source_container ?? undefined,
                compressionRatio,
                bandwidthRatio,
                healthScore: score,
                healthIssues: issues,
                scoringModelVersion: SCORING_MODEL_VERSION,
                deliveryP50Ms: deliveryPercentiles.p50,
                deliveryP95Ms: deliveryPercentiles.p95,
                deliveryP99Ms: deliveryPercentiles.p99,
                // Context from telemetry metadata
                userAgent,
                isMobile,
                isLive: transcoding.is_live ?? false,
            };

            // Upsert quality record
            await sql`
				INSERT INTO playback_session_quality (
					play_session_id,
					user_id,
					device_id,
					device_name,
					client_type,
					media_bitrate_bps,
					scoring_model_version,
					delivery_p50_ms,
					delivery_p95_ms,
					delivery_p99_ms,
					server_bytes_total,
					server_avg_throughput_bps,
					server_segment_count,
					server_avg_segment_time_ms,
					server_error_count,
					jellyfin_avg_fetch_time_ms,
					client_avg_bandwidth_bps,
					client_rebuffer_count,
					client_total_rebuffer_duration_ms,
					client_total_stall_duration_ms,
					client_buffer_starvation_count,
					client_quality_switches,
					client_avg_buffer_health_sec,
					client_min_buffer_health_sec,
					client_delivery_window_count,
					client_delivery_p10_bps,
					client_delivery_p50_bps,
					client_delivery_overdue_count,
					bandwidth_ratio,
					health_score,
					health_issues,
					play_method,
					is_transcoding,
					is_video_transcoding,
					is_audio_transcoding,
					source_bitrate_bps,
					output_bitrate_bps,
					source_video_codec,
					output_video_codec,
					source_audio_codec,
					output_audio_codec,
					source_width,
					source_height,
					output_width,
					output_height,
					source_video_range,
					output_video_range,
					transcode_reasons,
					transcode_reason_codes,
					source_container,
					compression_ratio,
					user_agent,
					is_mobile,
					is_live
				) VALUES (
					${quality.playSessionId},
					${quality.userId},
					${quality.deviceId ?? null},
					${quality.deviceName ?? null},
					${quality.clientType ?? null},
					${quality.mediaBitrateBps ?? null},
					${quality.scoringModelVersion ?? 1},
					${quality.deliveryP50Ms != null ? Math.round(quality.deliveryP50Ms) : null},
					${quality.deliveryP95Ms != null ? Math.round(quality.deliveryP95Ms) : null},
					${quality.deliveryP99Ms != null ? Math.round(quality.deliveryP99Ms) : null},
					${quality.serverBytesTotal ?? null},
					${quality.serverAvgThroughputBps ?? null},
					${quality.serverSegmentCount ?? null},
					${quality.serverAvgSegmentTimeMs ?? null},
					${quality.serverErrorCount ?? 0},
					${quality.jellyfinAvgFetchTimeMs ?? null},
					${quality.clientAvgBandwidthBps ?? null},
					${quality.clientRebufferCount ?? 0},
					${Math.min(quality.clientTotalRebufferDurationMs ?? 0, 2147483647)},
					${Math.min(quality.clientTotalStallDurationMs ?? 0, 2147483647)},
					${quality.clientBufferStarvationCount ?? 0},
					${quality.clientQualitySwitches ?? 0},
					${quality.clientAvgBufferHealthSec ?? null},
					${quality.clientMinBufferHealthSec ?? null},
					${quality.clientDeliveryWindowCount ?? 0},
					${quality.clientDeliveryP10Bps ?? null},
					${quality.clientDeliveryP50Bps ?? null},
					${quality.clientDeliveryOverdueCount ?? 0},
					${quality.bandwidthRatio ?? null},
					${quality.healthScore ?? null},
					${quality.healthIssues ?? null},
					${quality.playMethod ?? null},
					${quality.isTranscoding ?? null},
					${quality.isVideoTranscoding ?? null},
					${quality.isAudioTranscoding ?? null},
					${quality.sourceBitrateBps ?? null},
					${quality.outputBitrateBps ?? null},
					${quality.sourceVideoCodec ?? null},
					${quality.outputVideoCodec ?? null},
					${quality.sourceAudioCodec ?? null},
					${quality.outputAudioCodec ?? null},
					${quality.sourceWidth ?? null},
					${quality.sourceHeight ?? null},
					${quality.outputWidth ?? null},
					${quality.outputHeight ?? null},
					${quality.sourceVideoRange ?? null},
					${quality.outputVideoRange ?? null},
					${quality.transcodeReasons ?? null},
					${quality.transcodeReasonCodes ? sql.json(quality.transcodeReasonCodes) : null},
					${quality.sourceContainer ?? null},
					${quality.compressionRatio ?? null},
					${quality.userAgent ?? null},
					${quality.isMobile ?? null},
					${quality.isLive ?? false}
				)
				ON CONFLICT (play_session_id) WHERE play_session_id IS NOT NULL DO UPDATE SET
					device_id = COALESCE(EXCLUDED.device_id, playback_session_quality.device_id),
					device_name = COALESCE(EXCLUDED.device_name, playback_session_quality.device_name),
					client_type = COALESCE(EXCLUDED.client_type, playback_session_quality.client_type),
					media_bitrate_bps = COALESCE(EXCLUDED.media_bitrate_bps, playback_session_quality.media_bitrate_bps),
					scoring_model_version = EXCLUDED.scoring_model_version,
					delivery_p50_ms = COALESCE(EXCLUDED.delivery_p50_ms, playback_session_quality.delivery_p50_ms),
					delivery_p95_ms = COALESCE(EXCLUDED.delivery_p95_ms, playback_session_quality.delivery_p95_ms),
					delivery_p99_ms = COALESCE(EXCLUDED.delivery_p99_ms, playback_session_quality.delivery_p99_ms),
					server_bytes_total = COALESCE(EXCLUDED.server_bytes_total, playback_session_quality.server_bytes_total),
					server_avg_throughput_bps = COALESCE(EXCLUDED.server_avg_throughput_bps, playback_session_quality.server_avg_throughput_bps),
					server_segment_count = COALESCE(EXCLUDED.server_segment_count, playback_session_quality.server_segment_count),
					server_avg_segment_time_ms = COALESCE(EXCLUDED.server_avg_segment_time_ms, playback_session_quality.server_avg_segment_time_ms),
					server_error_count = EXCLUDED.server_error_count,
					jellyfin_avg_fetch_time_ms = COALESCE(EXCLUDED.jellyfin_avg_fetch_time_ms, playback_session_quality.jellyfin_avg_fetch_time_ms),
					client_avg_bandwidth_bps = COALESCE(EXCLUDED.client_avg_bandwidth_bps, playback_session_quality.client_avg_bandwidth_bps),
					client_rebuffer_count = EXCLUDED.client_rebuffer_count,
					client_total_rebuffer_duration_ms = EXCLUDED.client_total_rebuffer_duration_ms,
					client_total_stall_duration_ms = EXCLUDED.client_total_stall_duration_ms,
					client_buffer_starvation_count = EXCLUDED.client_buffer_starvation_count,
					client_quality_switches = EXCLUDED.client_quality_switches,
					client_avg_buffer_health_sec = COALESCE(EXCLUDED.client_avg_buffer_health_sec, playback_session_quality.client_avg_buffer_health_sec),
					client_min_buffer_health_sec = LEAST(EXCLUDED.client_min_buffer_health_sec, playback_session_quality.client_min_buffer_health_sec),
					client_delivery_window_count = EXCLUDED.client_delivery_window_count,
					client_delivery_p10_bps = COALESCE(EXCLUDED.client_delivery_p10_bps, playback_session_quality.client_delivery_p10_bps),
					client_delivery_p50_bps = COALESCE(EXCLUDED.client_delivery_p50_bps, playback_session_quality.client_delivery_p50_bps),
					client_delivery_overdue_count = EXCLUDED.client_delivery_overdue_count,
					bandwidth_ratio = COALESCE(EXCLUDED.bandwidth_ratio, playback_session_quality.bandwidth_ratio),
					health_score = EXCLUDED.health_score,
					health_issues = EXCLUDED.health_issues,
					play_method = COALESCE(EXCLUDED.play_method, playback_session_quality.play_method),
					is_transcoding = COALESCE(EXCLUDED.is_transcoding, playback_session_quality.is_transcoding),
					is_video_transcoding = COALESCE(EXCLUDED.is_video_transcoding, playback_session_quality.is_video_transcoding),
					is_audio_transcoding = COALESCE(EXCLUDED.is_audio_transcoding, playback_session_quality.is_audio_transcoding),
					source_bitrate_bps = COALESCE(EXCLUDED.source_bitrate_bps, playback_session_quality.source_bitrate_bps),
					output_bitrate_bps = COALESCE(EXCLUDED.output_bitrate_bps, playback_session_quality.output_bitrate_bps),
					source_video_codec = COALESCE(EXCLUDED.source_video_codec, playback_session_quality.source_video_codec),
					output_video_codec = COALESCE(EXCLUDED.output_video_codec, playback_session_quality.output_video_codec),
					source_audio_codec = COALESCE(EXCLUDED.source_audio_codec, playback_session_quality.source_audio_codec),
					output_audio_codec = COALESCE(EXCLUDED.output_audio_codec, playback_session_quality.output_audio_codec),
					source_width = COALESCE(EXCLUDED.source_width, playback_session_quality.source_width),
					source_height = COALESCE(EXCLUDED.source_height, playback_session_quality.source_height),
					output_width = COALESCE(EXCLUDED.output_width, playback_session_quality.output_width),
					output_height = COALESCE(EXCLUDED.output_height, playback_session_quality.output_height),
					source_video_range = COALESCE(EXCLUDED.source_video_range, playback_session_quality.source_video_range),
					output_video_range = COALESCE(EXCLUDED.output_video_range, playback_session_quality.output_video_range),
					transcode_reasons = COALESCE(EXCLUDED.transcode_reasons, playback_session_quality.transcode_reasons),
					transcode_reason_codes = COALESCE(EXCLUDED.transcode_reason_codes, playback_session_quality.transcode_reason_codes),
					source_container = COALESCE(EXCLUDED.source_container, playback_session_quality.source_container),
					compression_ratio = COALESCE(EXCLUDED.compression_ratio, playback_session_quality.compression_ratio),
					user_agent = COALESCE(EXCLUDED.user_agent, playback_session_quality.user_agent),
					is_mobile = COALESCE(EXCLUDED.is_mobile, playback_session_quality.is_mobile),
					is_live = COALESCE(EXCLUDED.is_live, playback_session_quality.is_live),
					updated_at = NOW()
			`;

            // M7: the daily rollups are NOT fired here. They are intentionally
            // deferred to the caller (computeSessionQuality), which runs them
            // exactly ONCE — only when runRollups is true (Phase 2 of the stop
            // flow), and only AFTER this advisory-locked transaction commits so
            // the rollup recompute sees this session's freshly-upserted row.
            return quality;
        }
    }

    /**
     * Calculate health score, identify issues, and diagnose root causes.
     *
     * SCORING MODEL v2 (SCORING_MODEL_VERSION): additive deductions off a 100
     * baseline, floored at 0. The key change from v1 is DELIVERY latency: v2
     * penalizes the p95 TAIL of per-segment delivery latency rather than the
     * arithmetic mean, because the mean hides the spikes that actually stall the
     * player. When percentile data is absent (external players) we fall back to
     * the mean-segment penalty. The tail-latency penalty and the mean-segment
     * fallback are MUTUALLY EXCLUSIVE so the single "slow delivery" root cause is
     * not counted twice. All weights/thresholds are the named SCORE constants.
     *
     * Root causes diagnosed (can have multiple):
     * - cause:slow_client_connection - Client bandwidth insufficient for stream
     * - cause:transcoding_bottleneck - Jellyfin transcoding can't keep up
     * - cause:slow_backend_storage - Jellyfin disk/NAS is slow (no transcoding)
     * - cause:slow_server_delivery - Network path from server to client is slow
     * - cause:network_instability - Variable network causing jitter/packet loss
     * - cause:delivery_interruptions - Receiver-timed windows show a link that is
     *   usually ample (p50 ≥ 1.5x need) yet periodically collapses (p10 < 0.8x need),
     *   or AVPlayer reported 3+ overdue segment downloads — checked BEFORE the
     *   fallback so measured sessions never default to client_side_stall
     * - cause:client_side_stall - Rebuffer/starvation with ample bandwidth headroom
     *   (e.g. a backgrounded/throttled tab, decode stall) — not a network problem
     * - cause:server_errors - HTTP errors from server
     * - cause:unknown - Issue detected but insufficient data to diagnose
     */
    private calculateHealthScore(
        server: ServerAggregateMetrics,
        client: ClientAggregateMetrics,
        mediaBitrate?: number,
        bandwidthRatio?: number,
        isTranscoding?: boolean,
        delivery?: DeliveryPercentiles,
        deliveryWindows?: DeliveryAggregate,
    ): { score: number; issues: string[] } {
        let score = 100;
        const issues: string[] = [];

        // Track metrics for root cause diagnosis
        const jellyfinTime = server.avg_jellyfin_time
            ? Number(server.avg_jellyfin_time)
            : undefined;
        const segmentTime = server.avg_segment_time ? Number(server.avg_segment_time) : undefined;
        // v2 headline delivery signal: the p95 tail of segment-delivery latency.
        const deliveryP95 = delivery?.p95 != null ? delivery.p95 : undefined;
        const serverErrors = server.error_count ? Number(server.error_count) : 0;
        const rebufferCount = client.rebuffer_count ? Number(client.rebuffer_count) : 0;
        const bufferStarvationCount = client.buffer_starvation_count
            ? Number(client.buffer_starvation_count)
            : 0;
        const hasPlaybackIssue = rebufferCount > 0 || bufferStarvationCount > 0;

        // The "effective" delivery latency used for root-cause diagnosis: prefer
        // the tail (p95), fall back to the mean. This is what downstream slow-
        // delivery diagnosis keys on so it stays consistent with the penalty.
        const effectiveDeliveryMs = deliveryP95 ?? segmentTime;

        // Calculate network delivery time (delivery latency minus Jellyfin fetch
        // time) using the effective (tail-preferred) delivery latency.
        const networkDeliveryTime =
            effectiveDeliveryMs && jellyfinTime && effectiveDeliveryMs > jellyfinTime
                ? effectiveDeliveryMs - jellyfinTime
                : undefined;

        // Bandwidth ratio scoring (actual bandwidth vs required)
        if (bandwidthRatio !== undefined) {
            if (bandwidthRatio < SCORE.BANDWIDTH_CRITICAL_RATIO) {
                score -= SCORE.BANDWIDTH_CRITICAL_PENALTY;
                issues.push('insufficient_bandwidth');
            } else if (bandwidthRatio < SCORE.BANDWIDTH_MARGINAL_RATIO) {
                score -= SCORE.BANDWIDTH_MARGINAL_PENALTY;
                issues.push('marginal_bandwidth');
            } else if (bandwidthRatio < SCORE.BANDWIDTH_TIGHT_RATIO) {
                score -= SCORE.BANDWIDTH_TIGHT_PENALTY;
                issues.push('tight_bandwidth');
            }
        }

        // DELIVERY-LATENCY scoring (v2). Prefer the p95 tail; fall back to the
        // mean only when no percentile data exists. These two branches are
        // mutually exclusive so one slow-delivery root cause isn't double-counted.
        if (deliveryP95 !== undefined) {
            if (deliveryP95 > SCORE.DELIVERY_P95_CRITICAL_MS) {
                score -= SCORE.DELIVERY_P95_CRITICAL_PENALTY;
                issues.push('slow_segment_delivery');
            } else if (deliveryP95 > SCORE.DELIVERY_P95_MODERATE_MS) {
                score -= SCORE.DELIVERY_P95_MODERATE_PENALTY;
                issues.push('moderate_segment_delay');
            }
        } else if (segmentTime !== undefined) {
            if (segmentTime > SCORE.DELIVERY_MEAN_CRITICAL_MS) {
                score -= SCORE.DELIVERY_MEAN_CRITICAL_PENALTY;
                issues.push('slow_segment_delivery');
            } else if (segmentTime > SCORE.DELIVERY_MEAN_MODERATE_MS) {
                score -= SCORE.DELIVERY_MEAN_MODERATE_PENALTY;
                issues.push('moderate_segment_delay');
            }
        }

        if (serverErrors > 0) {
            score -= Math.min(SCORE.SERVER_ERROR_CAP, serverErrors * SCORE.SERVER_ERROR_PER);
            issues.push('server_errors');
        }

        if (jellyfinTime && jellyfinTime > SCORE.JELLYFIN_SLOW_MS) {
            score -= SCORE.JELLYFIN_SLOW_PENALTY;
            issues.push('slow_jellyfin_response');
        } else if (jellyfinTime && jellyfinTime > SCORE.JELLYFIN_MODERATE_MS) {
            score -= SCORE.JELLYFIN_MODERATE_PENALTY;
            issues.push('moderate_jellyfin_delay');
        }

        // Client-side scoring
        if (rebufferCount > 0) {
            score -= Math.min(SCORE.REBUFFER_CAP, rebufferCount * SCORE.REBUFFER_PER);
            issues.push('rebuffering');
        }

        if (
            client.total_rebuffer_duration &&
            client.total_rebuffer_duration > SCORE.LONG_REBUFFER_MS
        ) {
            score -= SCORE.LONG_REBUFFER_PENALTY;
            issues.push('long_rebuffer_duration');
        }

        if (bufferStarvationCount > 0) {
            score -= Math.min(
                SCORE.BUFFER_STARVATION_CAP,
                bufferStarvationCount * SCORE.BUFFER_STARVATION_PER,
            );
            issues.push('buffer_starvation');
        }

        if (client.min_buffer_health != null && client.min_buffer_health < SCORE.LOW_BUFFER_SEC) {
            score -= SCORE.LOW_BUFFER_PENALTY;
            issues.push('low_buffer');
        }

        if (client.quality_switches && client.quality_switches > SCORE.UNSTABLE_QUALITY_SWITCHES) {
            score -= SCORE.UNSTABLE_QUALITY_PENALTY;
            issues.push('unstable_quality');
        }

        if (
            client.total_stall_duration &&
            client.total_stall_duration > SCORE.SIGNIFICANT_STALL_MS
        ) {
            score -= SCORE.SIGNIFICANT_STALL_PENALTY;
            issues.push('significant_stalls');
        }

        // ROOT CAUSE DIAGNOSIS
        // Only diagnose if there were actual playback issues
        // Multiple causes can be identified (not mutually exclusive)
        if (hasPlaybackIssue) {
            let diagnosedCause = false;

            // 1. Server errors are a definitive cause
            if (serverErrors > 0) {
                issues.push('cause:server_errors');
                diagnosedCause = true;
            }

            // 2. Client bandwidth insufficient for stream
            // Use stricter threshold (<1.0) for diagnosis - if you have less bandwidth than needed
            if (bandwidthRatio !== undefined && bandwidthRatio < 1.0) {
                issues.push('cause:slow_client_connection');
                diagnosedCause = true;
            }

            // 3. Jellyfin/backend is slow (check thresholds based on severity)
            // For HLS with 4-6s segments, Jellyfin fetch should be well under 2 seconds
            if (jellyfinTime && jellyfinTime > 800) {
                if (isTranscoding) {
                    // Transcoding is active and Jellyfin is slow - transcoding bottleneck
                    issues.push('cause:transcoding_bottleneck');
                } else {
                    // No transcoding, so it's storage/disk access
                    issues.push('cause:slow_backend_storage');
                }
                diagnosedCause = true;
            }

            // 4. Network delivery is slow (separate from Jellyfin time).
            // Uses the effective (p95-tail-preferred) delivery latency so the
            // diagnosis tracks the same tail signal the penalty uses.
            if (networkDeliveryTime && networkDeliveryTime > 500) {
                issues.push('cause:slow_server_delivery');
                diagnosedCause = true;
            } else if (!jellyfinTime && effectiveDeliveryMs && effectiveDeliveryMs > 1500) {
                // Fallback: if we only have delivery latency and it's slow
                issues.push('cause:slow_server_delivery');
                diagnosedCause = true;
            }

            // 5. High quality switches suggest network instability
            const qualitySwitches = client.quality_switches ? Number(client.quality_switches) : 0;
            if (qualitySwitches > 3 && bandwidthRatio !== undefined && bandwidthRatio > 1.0) {
                // Bandwidth is sufficient but quality is unstable - network jitter
                issues.push('cause:network_instability');
                diagnosedCause = true;
            }

            // 5b. Delivery interruptions: the link is usually ample and periodically
            // collapses. Checked before the fallback so a session that HAS receiver-
            // timed evidence never lands in client_side_stall by default.
            if (deliveryWindows && classifyDeliveryInterruption(deliveryWindows, mediaBitrate)) {
                // The penalty and the issue tag both matter: see
                // DELIVERY_INTERRUPTIONS_PENALTY for why a diagnosed session
                // would otherwise outscore an undiagnosed one.
                score -= SCORE.DELIVERY_INTERRUPTIONS_PENALTY;
                issues.push('delivery_interruptions');
                issues.push('cause:delivery_interruptions');
                diagnosedCause = true;
            }

            // 6. Unhandled cause - we have issues but none of the above tests fired.
            // This happens when:
            // - No server-side metrics (external player)
            // - No client bandwidth data (native HLS without estimates)
            // - Metrics look fine but still had issues
            //
            // Prod 2026-08-18: a paused, backgrounded browser tab stopped sending
            // heartbeats/segment requests for several minutes (browser timer
            // throttling, not the network) and the server reaped the idle
            // transcode job. That session had bandwidthRatio ~30-37x the required
            // rate — nothing wrong with the network — yet fell through to here and
            // got mislabeled 'network_instability' just because *some* metric
            // existed. Ample bandwidth headroom actively rules the network OUT, so
            // don't blame it by default: only do that when bandwidth data is
            // actually consistent with contention (missing, or below the "tight"
            // threshold already used for scoring above). A healthy ratio with an
            // otherwise-undiagnosed stall points at the CLIENT (backgrounded tab,
            // decode stall, paused-session heartbeat gap) instead.
            if (!diagnosedCause) {
                const hasSufficientData =
                    bandwidthRatio !== undefined ||
                    jellyfinTime !== undefined ||
                    effectiveDeliveryMs !== undefined;

                if (!hasSufficientData) {
                    // Not enough data to diagnose
                    issues.push('cause:unknown');
                } else if (
                    bandwidthRatio !== undefined &&
                    bandwidthRatio >= SCORE.BANDWIDTH_TIGHT_RATIO
                ) {
                    // Bandwidth was ample — the network isn't the bottleneck.
                    issues.push('cause:client_side_stall');
                } else {
                    // We have data but nothing stands out - likely intermittent network issues
                    issues.push('cause:network_instability');
                }
            }
        }

        return { score: Math.max(0, score), issues };
    }

    /**
     * Update daily user quality rollup
     */
    async updateUserDailyQuality(userId: UserId, date: Date = new Date()): Promise<void> {
        if (!this.isAvailable()) return;

        const dateStr = date.toISOString().split('T')[0];

        try {
            await this.sql!`
				INSERT INTO user_playback_quality (
					user_id,
					date,
					total_sessions,
					internal_player_sessions,
					external_player_sessions,
					total_bytes_streamed,
					avg_health_score,
					sum_health_score,
					min_health_score,
					rebuffer_events,
					quality_switches,
					server_errors,
					sessions_with_issues,
					avg_bandwidth_bps,
					min_bandwidth_bps,
					max_bandwidth_bps,
					transcode_sessions,
					direct_play_sessions,
					direct_stream_sessions,
					avg_compression_ratio,
					mobile_sessions,
					desktop_sessions,
					live_sessions,
					vod_sessions
				)
				SELECT
					${userId},
					${dateStr}::DATE,
					COUNT(*)::INTEGER,
					COUNT(CASE WHEN client_type IN ('hls_js', 'native_hls') THEN 1 END)::INTEGER,
					COUNT(CASE WHEN client_type IS NULL OR client_type NOT IN ('hls_js', 'native_hls') THEN 1 END)::INTEGER,
					COALESCE(SUM(server_bytes_total), 0)::BIGINT,
					AVG(health_score),
					COALESCE(SUM(health_score), 0)::BIGINT,
					MIN(health_score),
					COALESCE(SUM(client_rebuffer_count), 0)::INTEGER,
					COALESCE(SUM(client_quality_switches), 0)::INTEGER,
					COALESCE(SUM(server_error_count), 0)::INTEGER,
					COUNT(CASE WHEN array_length(health_issues, 1) > 0 THEN 1 END)::INTEGER,
					AVG(client_avg_bandwidth_bps),
					MIN(client_avg_bandwidth_bps),
					MAX(client_avg_bandwidth_bps),
					COUNT(CASE WHEN play_method = 'Transcode' THEN 1 END)::INTEGER,
					COUNT(CASE WHEN play_method = 'DirectPlay' THEN 1 END)::INTEGER,
					COUNT(CASE WHEN play_method = 'DirectStream' THEN 1 END)::INTEGER,
					AVG(compression_ratio),
					COUNT(CASE WHEN is_mobile = TRUE THEN 1 END)::INTEGER,
					COUNT(CASE WHEN is_mobile = FALSE THEN 1 END)::INTEGER,
					COUNT(CASE WHEN is_live = TRUE THEN 1 END)::INTEGER,
					COUNT(CASE WHEN is_live = FALSE THEN 1 END)::INTEGER
				FROM playback_session_quality
				WHERE user_id = ${userId}
				  AND computed_at::DATE = ${dateStr}::DATE
				ON CONFLICT (user_id, date) DO UPDATE SET
					total_sessions = EXCLUDED.total_sessions,
					internal_player_sessions = EXCLUDED.internal_player_sessions,
					external_player_sessions = EXCLUDED.external_player_sessions,
					total_bytes_streamed = EXCLUDED.total_bytes_streamed,
					avg_health_score = EXCLUDED.avg_health_score,
					sum_health_score = EXCLUDED.sum_health_score,
					min_health_score = EXCLUDED.min_health_score,
					rebuffer_events = EXCLUDED.rebuffer_events,
					quality_switches = EXCLUDED.quality_switches,
					server_errors = EXCLUDED.server_errors,
					sessions_with_issues = EXCLUDED.sessions_with_issues,
					avg_bandwidth_bps = EXCLUDED.avg_bandwidth_bps,
					min_bandwidth_bps = EXCLUDED.min_bandwidth_bps,
					max_bandwidth_bps = EXCLUDED.max_bandwidth_bps,
					transcode_sessions = EXCLUDED.transcode_sessions,
					direct_play_sessions = EXCLUDED.direct_play_sessions,
					direct_stream_sessions = EXCLUDED.direct_stream_sessions,
					avg_compression_ratio = EXCLUDED.avg_compression_ratio,
					mobile_sessions = EXCLUDED.mobile_sessions,
					desktop_sessions = EXCLUDED.desktop_sessions,
					live_sessions = EXCLUDED.live_sessions,
					vod_sessions = EXCLUDED.vod_sessions,
					updated_at = NOW()
			`;
        } catch (error) {
            logger.error('Failed to update user daily quality', error as Error, {
                userId,
                date: dateStr,
            });
        }
    }

    /**
     * Update daily device quality rollup
     */
    async updateDeviceDailyQuality(deviceId: string, date: Date = new Date()): Promise<void> {
        if (!this.isAvailable()) return;

        const dateStr = date.toISOString().split('T')[0];

        try {
            await this.sql!`
				INSERT INTO device_playback_quality (
					device_id,
					device_name,
					client_type,
					date,
					total_sessions,
					unique_users,
					total_bytes_streamed,
					avg_health_score,
					sum_health_score,
					min_health_score,
					rebuffer_events,
					quality_switches,
					server_errors,
					sessions_with_issues,
					avg_bandwidth_bps,
					min_bandwidth_bps,
					max_bandwidth_bps,
					transcode_sessions,
					direct_play_sessions,
					direct_stream_sessions,
					avg_compression_ratio,
					is_mobile,
					user_agent,
					live_sessions,
					vod_sessions
				)
				SELECT
					${deviceId},
					MAX(device_name),
					MAX(client_type),
					${dateStr}::DATE,
					COUNT(*)::INTEGER,
					COUNT(DISTINCT user_id)::INTEGER,
					COALESCE(SUM(server_bytes_total), 0)::BIGINT,
					AVG(health_score),
					COALESCE(SUM(health_score), 0)::BIGINT,
					MIN(health_score),
					COALESCE(SUM(client_rebuffer_count), 0)::INTEGER,
					COALESCE(SUM(client_quality_switches), 0)::INTEGER,
					COALESCE(SUM(server_error_count), 0)::INTEGER,
					COUNT(CASE WHEN array_length(health_issues, 1) > 0 THEN 1 END)::INTEGER,
					AVG(client_avg_bandwidth_bps),
					MIN(client_avg_bandwidth_bps),
					MAX(client_avg_bandwidth_bps),
					COUNT(CASE WHEN play_method = 'Transcode' THEN 1 END)::INTEGER,
					COUNT(CASE WHEN play_method = 'DirectPlay' THEN 1 END)::INTEGER,
					COUNT(CASE WHEN play_method = 'DirectStream' THEN 1 END)::INTEGER,
					AVG(compression_ratio),
					-- M7: most-common is_mobile via ordered-set aggregate (single scan,
					-- no correlated subquery). mode() picks the most frequent value.
					mode() WITHIN GROUP (ORDER BY is_mobile),
					-- M7: most-recent non-null user_agent folded into the same scan —
					-- order by computed_at DESC, drop nulls, take the first.
					(array_agg(user_agent ORDER BY computed_at DESC) FILTER (WHERE user_agent IS NOT NULL))[1],
					COUNT(CASE WHEN is_live = TRUE THEN 1 END)::INTEGER,
					COUNT(CASE WHEN is_live = FALSE THEN 1 END)::INTEGER
				FROM playback_session_quality
				WHERE device_id = ${deviceId}
				  AND computed_at::DATE = ${dateStr}::DATE
				ON CONFLICT (device_id, date) DO UPDATE SET
					device_name = COALESCE(EXCLUDED.device_name, device_playback_quality.device_name),
					client_type = COALESCE(EXCLUDED.client_type, device_playback_quality.client_type),
					total_sessions = EXCLUDED.total_sessions,
					unique_users = EXCLUDED.unique_users,
					total_bytes_streamed = EXCLUDED.total_bytes_streamed,
					avg_health_score = EXCLUDED.avg_health_score,
					sum_health_score = EXCLUDED.sum_health_score,
					min_health_score = EXCLUDED.min_health_score,
					rebuffer_events = EXCLUDED.rebuffer_events,
					quality_switches = EXCLUDED.quality_switches,
					server_errors = EXCLUDED.server_errors,
					sessions_with_issues = EXCLUDED.sessions_with_issues,
					avg_bandwidth_bps = EXCLUDED.avg_bandwidth_bps,
					min_bandwidth_bps = EXCLUDED.min_bandwidth_bps,
					max_bandwidth_bps = EXCLUDED.max_bandwidth_bps,
					transcode_sessions = EXCLUDED.transcode_sessions,
					direct_play_sessions = EXCLUDED.direct_play_sessions,
					direct_stream_sessions = EXCLUDED.direct_stream_sessions,
					avg_compression_ratio = EXCLUDED.avg_compression_ratio,
					is_mobile = COALESCE(EXCLUDED.is_mobile, device_playback_quality.is_mobile),
					user_agent = COALESCE(EXCLUDED.user_agent, device_playback_quality.user_agent),
					live_sessions = EXCLUDED.live_sessions,
					vod_sessions = EXCLUDED.vod_sessions,
					updated_at = NOW()
			`;
        } catch (error) {
            logger.error('Failed to update device daily quality', error as Error, {
                deviceId,
                date: dateStr,
            });
        }
    }

    /**
     * Get quality statistics for a user
     */
    async getUserQualityStats(
        userId: UserId,
        days: number = 7,
    ): Promise<{
        summary: {
            totalSessions: number;
            avgHealthScore: number;
            totalRebuffers: number;
            avgBandwidthMbps: number;
        };
        daily: Array<{
            date: string;
            sessions: number;
            avgHealthScore: number;
            rebufferEvents: number;
        }>;
    } | null> {
        if (!this.isAvailable()) return null;

        try {
            // Calculate date cutoff
            const dateCutoff = new Date();
            dateCutoff.setDate(dateCutoff.getDate() - days);
            const dateCutoffStr = dateCutoff.toISOString().split('T')[0];

            // M1: session-weight the health score (SUM(sum_health_score)/SUM(total_sessions))
            // instead of AVG-ing the daily means, so this drawer summary matches
            // getUsersWithIssues. Falls back to 100 when there are no sessions.
            const summary = await this.sql!<UserQualitySummaryRow[]>`
				SELECT
					COALESCE(SUM(total_sessions), 0)::INTEGER as total_sessions,
					COALESCE(SUM(sum_health_score)::float / NULLIF(SUM(total_sessions), 0), 100) as avg_health_score,
					COALESCE(SUM(rebuffer_events), 0)::INTEGER as total_rebuffers,
					COALESCE(AVG(avg_bandwidth_bps), 0) / 1000000 as avg_bandwidth_mbps
				FROM user_playback_quality
				WHERE user_id = ${userId}
				  AND date >= ${dateCutoffStr}::DATE
			`;

            const daily = await this.sql!<QualityDailyRow[]>`
				SELECT
					date::TEXT,
					total_sessions as sessions,
					avg_health_score,
					rebuffer_events
				FROM user_playback_quality
				WHERE user_id = ${userId}
				  AND date >= ${dateCutoffStr}::DATE
				ORDER BY date DESC
			`;

            return {
                summary: {
                    totalSessions: summary[0]?.total_sessions ?? 0,
                    avgHealthScore: summary[0]?.avg_health_score ?? 100,
                    totalRebuffers: summary[0]?.total_rebuffers ?? 0,
                    avgBandwidthMbps: summary[0]?.avg_bandwidth_mbps ?? 0,
                },
                daily: daily.map((d) => ({
                    date: d.date,
                    sessions: d.sessions,
                    avgHealthScore: d.avg_health_score,
                    rebufferEvents: d.rebuffer_events,
                })),
            };
        } catch (error) {
            logger.error('Failed to get user quality stats', error as Error, {
                userId,
            });
            return null;
        }
    }

    /**
     * Get quality statistics for a device
     */
    async getDeviceQualityStats(
        deviceId: string,
        days: number = 7,
    ): Promise<{
        summary: {
            totalSessions: number;
            uniqueUsers: number;
            avgHealthScore: number;
            totalRebuffers: number;
        };
        daily: Array<{
            date: string;
            sessions: number;
            avgHealthScore: number;
            rebufferEvents: number;
        }>;
    } | null> {
        if (!this.isAvailable()) return null;

        try {
            // Calculate date cutoff
            const dateCutoff = new Date();
            dateCutoff.setDate(dateCutoff.getDate() - days);
            const dateCutoffStr = dateCutoff.toISOString().split('T')[0];

            // M1: session-weight the health score the same way as the user summary
            // / getDevicesWithIssues, instead of AVG-ing the daily means.
            const summary = await this.sql!<DeviceQualitySummaryRow[]>`
				SELECT
					COALESCE(SUM(total_sessions), 0)::INTEGER as total_sessions,
					COALESCE(SUM(unique_users), 0)::INTEGER as unique_users,
					COALESCE(SUM(sum_health_score)::float / NULLIF(SUM(total_sessions), 0), 100) as avg_health_score,
					COALESCE(SUM(rebuffer_events), 0)::INTEGER as total_rebuffers
				FROM device_playback_quality
				WHERE device_id = ${deviceId}
				  AND date >= ${dateCutoffStr}::DATE
			`;

            const daily = await this.sql!<QualityDailyRow[]>`
				SELECT
					date::TEXT,
					total_sessions as sessions,
					avg_health_score,
					rebuffer_events
				FROM device_playback_quality
				WHERE device_id = ${deviceId}
				  AND date >= ${dateCutoffStr}::DATE
				ORDER BY date DESC
			`;

            return {
                summary: {
                    totalSessions: summary[0]?.total_sessions ?? 0,
                    uniqueUsers: summary[0]?.unique_users ?? 0,
                    avgHealthScore: summary[0]?.avg_health_score ?? 100,
                    totalRebuffers: summary[0]?.total_rebuffers ?? 0,
                },
                daily: daily.map((d) => ({
                    date: d.date,
                    sessions: d.sessions,
                    avgHealthScore: d.avg_health_score,
                    rebufferEvents: d.rebuffer_events,
                })),
            };
        } catch (error) {
            logger.error('Failed to get device quality stats', error as Error, {
                deviceId,
            });
            return null;
        }
    }

    /**
     * Cleanup old telemetry data across all retention tiers:
     *  - `playback_telemetry`         (raw events, 30d)
     *  - `playback_session_quality`   (per-session rollup, 90d)
     *  - `network_speed_tests`        (client-timed speed tests, 90d)
     *  - `user_playback_quality`      (daily rollup, 365d)
     *  - `device_playback_quality`    (daily rollup, 365d)
     *
     * Every DELETE is batched (LIMIT in a do-while loop) — matches the pattern
     * used by `pruneOldListenEvents`. This keeps lock windows short and lets
     * an abort signal short-circuit between batches.
     *
     * Returns the total number of rows deleted across all tables.
     */
    async cleanup(abortSignal?: AbortSignal): Promise<number> {
        if (!this.isAvailable()) return 0;

        const sql = this.sql!;
        let total = 0;

        try {
            const now = new Date();

            // Raw telemetry events (30d, keyed on recorded_at TIMESTAMPTZ)
            const telemetryCutoff = new Date(now);
            telemetryCutoff.setDate(telemetryCutoff.getDate() - RETENTION_DAYS);
            const telemetryDeleted = await deleteInBatches(
                async () => sql`
                    DELETE FROM playback_telemetry
                    WHERE id IN (
                        SELECT id FROM playback_telemetry
                        WHERE recorded_at < ${telemetryCutoff}
                        LIMIT ${CLEANUP_BATCH_SIZE}
                    )
                `,
                abortSignal,
            );
            total += telemetryDeleted;

            // Per-session quality rollup (90d, keyed on computed_at TIMESTAMPTZ)
            if (!abortSignal?.aborted) {
                const sessionCutoff = new Date(now);
                sessionCutoff.setDate(sessionCutoff.getDate() - SESSION_QUALITY_RETENTION_DAYS);
                const sessionDeleted = await deleteInBatches(
                    async () => sql`
                        DELETE FROM playback_session_quality
                        WHERE id IN (
                            SELECT id FROM playback_session_quality
                            WHERE computed_at < ${sessionCutoff}
                            LIMIT ${CLEANUP_BATCH_SIZE}
                        )
                    `,
                    abortSignal,
                );
                total += sessionDeleted;
            }

            // Client-timed speed tests (90d, keyed on created_at TIMESTAMPTZ).
            // Shares SESSION_QUALITY_RETENTION_DAYS deliberately: both are
            // per-event diagnostic rows behind the same "last three months"
            // dashboards, and a measured line speed is a household fingerprint
            // that has no business outliving the quality data it explains.
            if (!abortSignal?.aborted) {
                const speedTestCutoff = new Date(now);
                speedTestCutoff.setDate(speedTestCutoff.getDate() - SESSION_QUALITY_RETENTION_DAYS);
                const speedTestsDeleted = await deleteInBatches(
                    async () => ({
                        count: await pruneSpeedTests(sql, speedTestCutoff, CLEANUP_BATCH_SIZE),
                    }),
                    abortSignal,
                );
                total += speedTestsDeleted;
            }

            // Daily user rollup (365d, keyed on `date` DATE)
            if (!abortSignal?.aborted) {
                const userCutoff = new Date(now);
                userCutoff.setDate(userCutoff.getDate() - ROLLUP_RETENTION_DAYS);
                const userDateStr = userCutoff.toISOString().slice(0, 10);
                const userDeleted = await deleteInBatches(
                    async () => sql`
                        DELETE FROM user_playback_quality
                        WHERE id IN (
                            SELECT id FROM user_playback_quality
                            WHERE date < ${userDateStr}::date
                            LIMIT ${CLEANUP_BATCH_SIZE}
                        )
                    `,
                    abortSignal,
                );
                total += userDeleted;
            }

            // Daily device rollup (365d, keyed on `date` DATE)
            if (!abortSignal?.aborted) {
                const deviceCutoff = new Date(now);
                deviceCutoff.setDate(deviceCutoff.getDate() - ROLLUP_RETENTION_DAYS);
                const deviceDateStr = deviceCutoff.toISOString().slice(0, 10);
                const deviceDeleted = await deleteInBatches(
                    async () => sql`
                        DELETE FROM device_playback_quality
                        WHERE id IN (
                            SELECT id FROM device_playback_quality
                            WHERE date < ${deviceDateStr}::date
                            LIMIT ${CLEANUP_BATCH_SIZE}
                        )
                    `,
                    abortSignal,
                );
                total += deviceDeleted;
            }

            if (total > 0) {
                logger.info('Cleaned up old telemetry data', {
                    totalDeleted: total,
                    wasAborted: abortSignal?.aborted === true,
                });
            }

            return total;
        } catch (error) {
            logger.error('Failed to cleanup telemetry data', error as Error);
            return total;
        }
    }

    /**
     * Compute session quality metrics when playback stops.
     *
     * Uses two-phase computation to handle race condition with client beacon:
     * 1. Immediate (Phase 1): Captures server-side metrics from HLS proxy
     * 2. Delayed (Phase 2): Captures client-side beacon data after BEACON_WAIT_MS
     *
     * The client sends final telemetry via navigator.sendBeacon() on page unload,
     * which includes clientType ('hls_js' or 'native_hls'). This beacon may arrive
     * after the stop event triggers quality computation.
     *
     * The UPSERT in computeSessionQuality uses COALESCE to merge Phase 2 data
     * without overwriting existing values (e.g., clientType from periodic flushes).
     *
     * This method is fire-and-forget - it doesn't block and handles its own errors.
     *
     * @param playSessionId - The unique session identifier
     * @param userId - The user who played the content
     */
    computeSessionQualityOnStop(playSessionId: string, userId: UserId): void {
        // Phase 1: Immediate computation for server metrics
        // This captures HLS proxy metrics (bytes, segment times, errors)
        // For sessions >10s, clientType is often already available from periodic flushes.
        // M7: runRollups=false — Phase 2 owns the single daily rollup recompute
        // so the O(N) full-day aggregate runs once per stop, not twice.
        this.trackQualityWork(
            this.computeSessionQuality(playSessionId, userId, false).catch(() => {
                /* Telemetry errors should not affect playback - phase 2 handles final computation */
            }),
        );

        // Phase 2: Delayed computation to capture client beacon data
        // The beacon contains clientType, bandwidth estimates, rebuffer events
        // 2 second delay allows beacon to arrive even on slower networks
        const runPhase2 = (): void => {
            const phase2 = this.computeSessionQuality(playSessionId, userId)
                .then((quality) => {
                    if (quality) {
                        logger.debug('Computed session quality (final)', {
                            playSessionId,
                            healthScore: quality.healthScore,
                            clientType: quality.clientType || 'unknown',
                            issues: quality.healthIssues?.length || 0,
                        });
                    }
                })
                .catch((err) => {
                    logger.error('Failed to compute session quality', err as Error, {
                        playSessionId,
                    });
                });
            this.trackQualityWork(phase2);
        };
        const timer = setTimeout(() => {
            this.pendingPhase2.delete(timer);
            runPhase2();
        }, BEACON_WAIT_MS);
        this.pendingPhase2.set(timer, runPhase2);
    }

    private trackQualityWork(work: Promise<unknown>): void {
        this.inFlightQualityWork.add(work);
        const done = (): void => {
            this.inFlightQualityWork.delete(work);
        };
        void work.then(done, done);
    }

    /**
     * Finish all stop-time quality work now: start any Phase 2 still waiting out
     * BEACON_WAIT_MS (it scores what has arrived so far) and wait until every
     * compute and the rollups they start have settled.
     *
     * With `timeoutMs`, gives up after that long and resolves `false` (the work
     * keeps running in the background); otherwise resolves `true` once drained.
     */
    async settleBackgroundWork(timeoutMs?: number): Promise<boolean> {
        for (const [timer, runPhase2] of this.pendingPhase2) {
            clearTimeout(timer);
            this.pendingPhase2.delete(timer);
            runPhase2();
        }
        const drain = async (): Promise<true> => {
            // Loop: a settling compute can start its rollups, which join the set.
            while (this.inFlightQualityWork.size > 0) {
                await Promise.allSettled([...this.inFlightQualityWork]);
            }
            return true;
        };
        if (timeoutMs === undefined) return drain();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timedOut = new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
        });
        try {
            return await Promise.race([drain(), timedOut]);
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * Score sessions that were reaped (CRASHED/KILLED) by the watchdog rather
     * than stopped through the normal COMPLETED path (M3 — selection bias fix).
     *
     * Quality rows were historically only written on the COMPLETED/stop path,
     * so crashed/killed sessions never got scored — biasing fleet health
     * upward (the worst sessions, the ones that crashed, were invisible). The
     * watchdog's bulk UPDATE marks rows CRASHED/KILLED without per-row callbacks,
     * so this method self-discovers them: it finds recently-terminated sessions
     * in the window that still lack a `playback_session_quality` row and runs
     * the SAME single-shot scoring as the stop path against their already-
     * flushed raw telemetry (raw events flush every 5s, so the data exists).
     *
     * Designed to be called once per reaper tick. Bounded by `limit` so a large
     * sweep can't stampede the DB; the next tick picks up any remainder.
     *
     * @returns the number of sessions scored.
     */
    async scoreReapedSessions(windowMinutes = 60, limit = 200): Promise<number> {
        if (!this.isAvailable()) return 0;

        try {
            // Find terminal-by-watchdog sessions in the window that have NOT yet
            // been scored. play_sessions.id is the play_session_id used by the
            // quality table; user_id is the stable users.id UUID.
            //
            // FIX 3b: only consider sessions that actually have flushed raw
            // telemetry. A crashed/killed session with ZERO telemetry rows would
            // be scored ~100 by calculateHealthScore (it starts at 100 with no
            // penalties) — a "perfect" score for a session that died, which
            // defeats the entire point of scoring reaped sessions. The EXISTS
            // guard skips them so no misleading quality row is written.
            const rows = await this.sql!<{ id: string; user_id: string }[]>`
                SELECT ps.id, ps.user_id
                FROM play_sessions ps
                WHERE ps.status IN ('CRASHED', 'KILLED')
                  AND ps.stopped_at >= now() - make_interval(mins => ${windowMinutes})
                  AND NOT EXISTS (
                      SELECT 1 FROM playback_session_quality q
                      WHERE q.play_session_id = ps.id
                  )
                  AND EXISTS (
                      SELECT 1 FROM playback_telemetry t
                      WHERE t.play_session_id = ps.id
                  )
                ORDER BY ps.stopped_at DESC
                LIMIT ${limit}
            `;

            // FIX 3a: do NOT run the daily rollup recompute per session. With
            // runRollups=true, scoring N reaped sessions for the same
            // (user|device, day) fires N identical full-day rollup recomputes in
            // one tick (undercutting M7's "recompute once" guarantee). Instead
            // score each session with runRollups=false, collect the affected
            // user / device ids, then run ONE deduplicated rollup pass after the
            // loop. computeSessionQuality stamps computed_at = NOW() on the new
            // rows, so the relevant rollup day is today's UTC date (the default
            // updateUser/DeviceDailyQuality date) — matching the per-session path.
            let scored = 0;
            const affectedUserIds = new Set<string>();
            const affectedDeviceIds = new Set<string>();
            for (const row of rows) {
                // Single-shot (no two-phase beacon wait — the session already
                // ended uncleanly so no client beacon is coming).
                const quality = await this.computeSessionQuality(
                    row.id,
                    toUserId(row.user_id),
                    false,
                ).catch(() => null);
                if (quality) {
                    scored++;
                    affectedUserIds.add(row.user_id);
                    if (quality.deviceId) affectedDeviceIds.add(quality.deviceId);
                }
            }

            // Deduplicated rollup pass: one recompute per distinct user/device.
            for (const userId of affectedUserIds) {
                await this.updateUserDailyQuality(toUserId(userId)).catch(() => {
                    /* Telemetry errors should not affect the reaper tick */
                });
            }
            for (const deviceId of affectedDeviceIds) {
                await this.updateDeviceDailyQuality(deviceId).catch(() => {
                    /* Telemetry errors should not affect the reaper tick */
                });
            }

            if (scored > 0) {
                logger.info('Scored reaped (crashed/killed) sessions', {
                    scored,
                    candidates: rows.length,
                    rolledUpUsers: affectedUserIds.size,
                    rolledUpDevices: affectedDeviceIds.size,
                    windowMinutes,
                });
            }
            return scored;
        } catch (error) {
            logger.error('Failed to score reaped sessions', error as Error);
            return 0;
        }
    }

    /**
     * Graceful shutdown - finish stop-time quality work, flush pending events
     */
    async shutdown(): Promise<void> {
        // Before isShuttingDown: computeSessionQuality is a no-op once it is set.
        // Bounded: a wedged DB must not stall pod termination.
        const settled = await this.settleBackgroundWork(SHUTDOWN_SETTLE_TIMEOUT_MS);
        if (!settled) {
            logger.warn('Playback telemetry: stop-time quality work still running at shutdown', {
                timeoutMs: SHUTDOWN_SETTLE_TIMEOUT_MS,
                inFlight: this.inFlightQualityWork.size,
            });
        }
        this.isShuttingDown = true;

        if (this.flushInterval) {
            clearInterval(this.flushInterval);
            this.flushInterval = null;
        }

        // Final flush
        await this.flush();
        logger.info('Playback telemetry service shut down');
    }
}

// Singleton instance
export const playbackTelemetryService = new PlaybackTelemetryService();

/**
 * Run a bounded DELETE in a do-while loop until the batch returns < the
 * batch size or the abort signal fires. The runner callback is expected to
 * return a `postgres` result with `.count` (rows deleted). Mirrors the
 * pattern in `pruneOldListenEvents`.
 */
async function deleteInBatches(
    runner: () => Promise<{ count: number }>,
    abortSignal?: AbortSignal,
): Promise<number> {
    let total = 0;
    let batchCount: number;
    do {
        if (abortSignal?.aborted) break;
        const result = await runner();
        batchCount = result.count;
        total += batchCount;
    } while (batchCount >= CLEANUP_BATCH_SIZE);
    return total;
}
