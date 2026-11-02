// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Client-side Playback Telemetry
 *
 * Collects and reports playback quality metrics to the server.
 * Supports both HLS.js and native HLS (Safari).
 */

import * as playbackApi from '$lib/api/playback';
import { apiUrl } from '$lib/shared/api-urls.js';
import type { DeliveryWindow } from './delivery-window-aggregator';

export type ClientMetricType =
    | 'bandwidth_estimate'
    | 'buffer_health'
    | 'rebuffer_event'
    | 'rebuffer_duration'
    | 'quality_switch'
    | 'playback_stall'
    | 'buffer_starvation'
    | 'playback_start'
    | 'playback_error'
    | 'seeking'
    | 'media_bitrate'
    | 'reconnect_event'
    | 'media_stalled'
    | 'delivery_window'; // receiver-timed 30 s delivery window (value = achieved bps; metadata = spec Part 1)

/** Reconnect lifecycle phases carried in a `reconnect_event`'s metadata. */
export type ReconnectPhase = 'recovering' | 'attempt' | 'recovered' | 'terminal';

/** Structured metadata for a `reconnect_event`. */
export interface ReconnectTelemetryMeta {
    /** Trigger cause for an 'attempt' (network | stall | session-expired). */
    cause?: string;
    /** Recovery action taken for an 'attempt'. */
    action?: 'nudge' | 'rebuild';
    /** Attempt index (also mirrored into `value` for MAX() aggregation). */
    attempt?: number;
    /** Playback engine ('hls_js' | 'native_hls'). */
    engine?: string;
    /** Why a 'terminal' happened (e.g. 'retries-exhausted'). */
    reason?: string;
}

export interface TelemetryEvent {
    type: ClientMetricType;
    value: number;
    metadata?: Record<string, unknown>;
    timestamp: number;
}

export interface TelemetryConfig {
    playSessionId: string;
    deviceId?: string;
    clientType: 'hls_js' | 'native_hls';
    /** Interval for reporting buffer health (ms) */
    bufferHealthInterval?: number;
    /** Interval for reporting bandwidth (ms) */
    bandwidthReportInterval?: number;
    /** Max events before auto-flush */
    maxBufferSize?: number;
    /** Interval for auto-flush (ms) */
    flushInterval?: number;
}

const DEFAULT_CONFIG = {
    bufferHealthInterval: 5000, // Report buffer health every 5s
    bandwidthReportInterval: 10000, // Report bandwidth every 10s
    maxBufferSize: 50, // Flush when buffer reaches 50 events
    flushInterval: 10000, // Auto-flush every 10s
};

// Full config with all required fields except deviceId which remains optional
type FullTelemetryConfig = Required<Omit<TelemetryConfig, 'deviceId'>> &
    Pick<TelemetryConfig, 'deviceId'>;

/**
 * Seconds of contiguous buffered media ahead of the playhead, or 0 when the
 * playhead sits outside every buffered range (nothing to play next).
 *
 * Deliberately the range CONTAINING currentTime, not the last range's end: after
 * a seek the buffer can hold a far-ahead island whose end is minutes away while
 * the playhead has nothing, and reporting that as buffer health would describe
 * the exact stall it is meant to detect as healthy.
 */
export function bufferAheadSeconds(videoElement: HTMLVideoElement): number {
    const buffered = videoElement.buffered;
    const currentTime = videoElement.currentTime;

    for (let i = 0; i < buffered.length; i++) {
        if (currentTime >= buffered.start(i) && currentTime <= buffered.end(i)) {
            return buffered.end(i) - currentTime;
        }
    }
    return 0;
}

/**
 * Round for transport. `record()` String()-coerces metadata and the server reads
 * each value back only if it matches `^-?[0-9]+(\.[0-9]+)?$` — so a value that
 * stringifies in exponent form (`1e-7`, which a raw buffered-range subtraction
 * can easily produce) would be silently read as NULL. Three decimals keeps every
 * field we send in plain decimal form with room to spare.
 */
function roundForMetadata(value: number): number {
    return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0;
}

/**
 * Client-side telemetry collector
 */
export class PlaybackTelemetry {
    private config: FullTelemetryConfig;
    private events: TelemetryEvent[] = [];
    private flushTimer: ReturnType<typeof setInterval> | null = null;
    private bufferHealthTimer: ReturnType<typeof setInterval> | null = null;
    private lastBufferHealth: number = 0;
    private rebufferStartTime: number | null = null;
    private isDestroyed = false;

    constructor(config: TelemetryConfig) {
        this.config = {
            ...DEFAULT_CONFIG,
            ...config,
        };

        // Start auto-flush timer
        this.flushTimer = setInterval(() => {
            void this.flush();
        }, this.config.flushInterval);
    }

    /**
     * Get the playSessionId this telemetry instance is tracking
     */
    get playSessionId(): string {
        return this.config.playSessionId;
    }

    /**
     * Start tracking buffer health on a video element
     */
    startBufferTracking(videoElement: HTMLVideoElement): void {
        if (this.bufferHealthTimer) {
            clearInterval(this.bufferHealthTimer);
        }

        this.bufferHealthTimer = setInterval(() => {
            if (this.isDestroyed) return;

            const buffered = videoElement.buffered;
            const currentTime = videoElement.currentTime;
            const bufferHealth = bufferAheadSeconds(videoElement);

            // Only record if buffer health changed significantly
            if (Math.abs(bufferHealth - this.lastBufferHealth) > 0.5) {
                this.record('buffer_health', bufferHealth, {
                    currentTime,
                    bufferedEnd: buffered.length > 0 ? buffered.end(buffered.length - 1) : 0,
                });
                this.lastBufferHealth = bufferHealth;
            }
        }, this.config.bufferHealthInterval);
    }

    /**
     * Record a telemetry event
     */
    record(type: ClientMetricType, value: number, metadata?: Record<string, unknown>): void {
        if (this.isDestroyed) return;

        // Coerce metadata values to strings to match telemetry schema
        const stringMetadata = metadata
            ? Object.fromEntries(Object.entries(metadata).map(([k, v]) => [k, String(v)]))
            : undefined;

        this.events.push({
            type,
            value,
            metadata: stringMetadata,
            timestamp: Date.now(),
        });

        // Auto-flush if buffer is full
        if (this.events.length >= this.config.maxBufferSize) {
            void this.flush();
        }
    }

    /**
     * Record bandwidth estimate from HLS.js
     */
    recordBandwidth(bandwidthBps: number): void {
        this.record('bandwidth_estimate', bandwidthBps);
    }

    /**
     * Record quality level switch
     */
    recordQualitySwitch(
        newLevel: number,
        metadata?: { bitrate?: number; bandwidth?: number },
    ): void {
        this.record('quality_switch', newLevel, metadata);
    }

    /**
     * Record rebuffer start (call when video starts waiting)
     */
    recordRebufferStart(currentTime: number): void {
        this.rebufferStartTime = Date.now();
        this.record('rebuffer_event', 0, { position: currentTime });
    }

    /**
     * Record rebuffer end (call when video resumes playing)
     */
    recordRebufferEnd(currentTime: number): void {
        if (this.rebufferStartTime) {
            const duration = Date.now() - this.rebufferStartTime;
            this.record('rebuffer_duration', duration, {
                position: currentTime,
            });
            this.rebufferStartTime = null;
        }
    }

    /**
     * Record buffer starvation (buffer ran empty)
     */
    recordBufferStarvation(bufferBefore: number): void {
        this.record('buffer_starvation', bufferBefore);
    }

    /**
     * Record playback stall
     */
    recordPlaybackStall(durationMs: number, reason?: string): void {
        this.record('playback_stall', durationMs, { reason });
    }

    /**
     * Record playback start
     */
    recordPlaybackStart(startTime: number): void {
        this.record('playback_start', startTime);
    }

    /**
     * Record playback error
     */
    recordError(errorType: string, message: string): void {
        this.record('playback_error', 1, { errorType, message });
    }

    /**
     * Record seek event
     */
    recordSeek(fromTime: number, toTime: number): void {
        this.record('seeking', toTime - fromTime, {
            from: fromTime,
            to: toTime,
        });
    }

    /**
     * Record media bitrate (required bitrate for content)
     */
    recordMediaBitrate(bitrateBps: number): void {
        this.record('media_bitrate', bitrateBps);
    }

    /**
     * Record a reconnection lifecycle event — every ReconnectController state
     * transition ('recovering' / 'recovered' / 'terminal') and every recovery
     * 'attempt' (with its cause + nudge-vs-rebuild action). Closes the blind
     * spot where a nudge-forever recovery loop (buffer starvation on hls.js
     * that only an F5 cleared) was invisible to server telemetry: `value`
     * carries the attempt index so a single query can see "N attempts, all
     * nudges, never terminal".
     */
    /**
     * The media element's `stalled` event — the UA tried to fetch media data and
     * got none. Distinct from `playback_stall`, which carries a measured stall
     * DURATION and feeds the total-stall-time aggregate; this is a point event
     * with no duration, so folding it into that metric would corrupt the sum.
     * Recorded because Safari can emit `stalled` WITHOUT a companion `waiting`,
     * which is the case that was previously invisible after the fact.
     */
    recordMediaStalled(bufferHealthSeconds: number): void {
        this.record('media_stalled', bufferHealthSeconds);
    }

    /**
     * Record one closed receiver-timed delivery window.
     *
     * `value` carries the achieved bits/s so the per-session aggregate can take
     * percentiles over it directly. The metadata key spellings are a CONTRACT
     * with `delivery-windows.queries.ts`: it reads each one by exact name, and
     * anything else (a rename, a camelCase slip) reads back as NULL — "unknown"
     * — with no error anywhere. `overdue`/`stalls` are intentionally absent:
     * those come from the AVPlayer reporter, which knows its own deadlines; the
     * web player has nothing honest to put there.
     */
    recordDeliveryWindow(w: DeliveryWindow, bufferAheadSec: number, engine: 'hls_js'): void {
        this.record('delivery_window', w.throughputBps, {
            bytes: Math.round(w.bytes),
            segments: w.segments,
            mediaSec: roundForMetadata(w.mediaSec),
            transferMs: roundForMetadata(w.transferMs),
            wallMaxMs: roundForMetadata(w.wallMaxMs),
            ttfbMaxMs: roundForMetadata(w.ttfbMaxMs),
            minSegBps: Math.round(w.minSegBps),
            bufferAheadSec: roundForMetadata(bufferAheadSec),
            engine,
        });
    }

    recordReconnect(phase: ReconnectPhase, metadata?: ReconnectTelemetryMeta): void {
        // Drop undefined fields — record() String()-coerces metadata, so a
        // missing `reason`/`cause` would otherwise be stored as "undefined".
        const clean: Record<string, unknown> = { phase };
        if (metadata) {
            for (const [k, v] of Object.entries(metadata)) {
                if (v !== undefined) clean[k] = v;
            }
        }
        this.record('reconnect_event', metadata?.attempt ?? 0, clean);
    }

    /**
     * Flush events to server
     */
    async flush(): Promise<void> {
        if (this.isDestroyed || this.events.length === 0) return;

        const eventsToSend = this.events;
        this.events = [];

        try {
            await playbackApi.flushTelemetry({
                playbackSessionId: this.config.playSessionId,
                deviceId: this.config.deviceId,
                clientType: this.config.clientType,
                events: eventsToSend,
            });
        } catch (error) {
            // On failure, re-add events to buffer (but limit size)
            if (this.events.length + eventsToSend.length <= this.config.maxBufferSize * 2) {
                this.events = [...eventsToSend, ...this.events];
            }
            console.error('Failed to send telemetry:', error);
        }
    }

    /**
     * Flush events via sendBeacon (for page unload - reliable delivery)
     * Returns true if sendBeacon was used, false if no events to send
     */
    flushViaBeacon(): boolean {
        if (this.events.length === 0) return false;

        const eventsToSend = this.events;
        this.events = [];

        const blob = new Blob(
            [
                JSON.stringify({
                    playbackSessionId: this.config.playSessionId,
                    deviceId: this.config.deviceId,
                    clientType: this.config.clientType,
                    events: eventsToSend,
                }),
            ],
            { type: 'application/json' },
        );

        const queued = navigator.sendBeacon(apiUrl('internal', '/playback/telemetry'), blob);
        if (!queued) {
            // The user agent refused to queue the beacon (payload over its size
            // limit, or the queue is full). The events were already detached
            // above, so without putting them back they are lost outright —
            // which is worst exactly when it matters most, since a long
            // recovery incident is what produces both a big buffer and an
            // unload. Restore them ahead of anything recorded since, so a later
            // flush (or a subsequent beacon) can still deliver them.
            this.events = [...eventsToSend, ...this.events];
        }
        return queued;
    }

    /**
     * Destroy telemetry collector
     */
    async destroy(): Promise<void> {
        // Stop the timers FIRST so nothing new is collected or scheduled while
        // the final flush is in flight.
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }

        if (this.bufferHealthTimer) {
            clearInterval(this.bufferHealthTimer);
            this.bufferHealthTimer = null;
        }

        try {
            // Final flush BEFORE marking destroyed. `flush()` returns
            // immediately when `isDestroyed`, so setting the flag first (as this
            // did) made the final flush a silent no-op: everything buffered
            // since the last 10 s auto-flush was dropped, including the closing
            // delivery window recorded by TelemetryController.destroy() on the
            // endCurrentSession() path (quality switch, item change, user stop).
            //
            // `flush()` detaches the buffer before awaiting, so a record() that
            // lands during the in-flight request goes into a FRESH buffer —
            // drain it too. Bounded, because a failed flush re-queues its own
            // events and would otherwise spin here forever.
            for (let attempt = 0; attempt < 2 && this.events.length > 0; attempt++) {
                await this.flush();
            }
        } finally {
            // Always reached, so a throw cannot leave a live instance with dead
            // timers that silently collects events nothing will ever send.
            this.isDestroyed = true;
        }
    }

    /**
     * Destroy telemetry collector using sendBeacon for reliable final flush
     * Use this during page unload (onDestroy, beforeunload) where regular fetch might be cancelled
     */
    destroyViaBeacon(): void {
        this.isDestroyed = true;

        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }

        if (this.bufferHealthTimer) {
            clearInterval(this.bufferHealthTimer);
            this.bufferHealthTimer = null;
        }

        // Final flush via sendBeacon (fire-and-forget, reliable during page unload)
        this.flushViaBeacon();
    }
}

/**
 * Create telemetry collector for HLS.js playback
 */
export function createHlsJsTelemetry(playSessionId: string, deviceId?: string): PlaybackTelemetry {
    return new PlaybackTelemetry({
        playSessionId,
        deviceId,
        clientType: 'hls_js',
    });
}

/**
 * Create telemetry collector for native HLS (Safari) playback
 */
export function createNativeHlsTelemetry(
    playSessionId: string,
    deviceId?: string,
): PlaybackTelemetry {
    return new PlaybackTelemetry({
        playSessionId,
        deviceId,
        clientType: 'native_hls',
    });
}
