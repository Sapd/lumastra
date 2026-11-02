// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TelemetryController — owns PlaybackTelemetry lifecycle, native rebuffer tracking,
 * and throttled bandwidth recording.
 *
 * Extracted from PlayerController to isolate telemetry concerns.
 */

import { getDeviceId } from './device-id';
import { bufferAheadSeconds, createHlsJsTelemetry, createNativeHlsTelemetry } from './telemetry';
import type { PlaybackTelemetry, ReconnectPhase, ReconnectTelemetryMeta } from './telemetry';
import { createTelemetryResetValues } from './playback-restart';
import { playerStore } from './playerStore.svelte';
import {
    DeliveryWindowAggregator,
    type FragmentDeliverySample,
} from './delivery-window-aggregator';

export interface TelemetryControllerDeps {
    isSafari: boolean;
    getVideoElement: () => HTMLVideoElement | undefined;
    log: (...args: unknown[]) => void;
}

export class TelemetryController {
    private playbackTelemetry: PlaybackTelemetry | null = null;
    nativeRebufferStartTime: number | null = null;
    hasNativePlaybackStarted: boolean = false;
    lastNativeSeekTime: number = 0;
    lastBandwidthRecordTime: number = 0;
    seekStartPosition: number | null = null;

    /**
     * Folds per-fragment delivery samples into 30 s windows. One aggregator per
     * play session: window boundaries live on the performance.now() clock, so
     * carrying a half-full window across a session swap would attribute one
     * session's bytes to the next one (and a restart's first fragments to the
     * link conditions of the session that just ended).
     */
    private deliveryWindows = new DeliveryWindowAggregator();

    /** Buffer-ahead at the last delivered fragment, for the final partial window. */
    private lastBufferAheadSec = 0;

    private readonly deps: TelemetryControllerDeps;

    constructor(deps: TelemetryControllerDeps) {
        this.deps = deps;
    }

    /**
     * Ensure a telemetry instance exists for the current play session.
     * Recreates if the session ID has changed.
     */
    ensure(): PlaybackTelemetry | null {
        const state = playerStore.getState();
        if (state.isLive) {
            // Retire the outgoing VOD instance before live events can reach it.
            // Its final window still belongs to that VOD session.
            this.destroyViaBeacon();
            return null;
        }
        if (!state.playSessionId) return null;

        if (this.playbackTelemetry) {
            if (this.playbackTelemetry.playSessionId === state.playSessionId) {
                return this.playbackTelemetry;
            }
            this.deps.log(' Telemetry session mismatch, recreating', {
                old: this.playbackTelemetry.playSessionId,
                new: state.playSessionId,
            });
            // The open window belongs to the session being closed — record it
            // there, then start the next session with an empty aggregator.
            this.recordFinalDeliveryWindow(this.playbackTelemetry);
            this.playbackTelemetry.destroyViaBeacon();
            this.playbackTelemetry = null;
            this.lastBufferAheadSec = 0;
        }

        const deviceId = getDeviceId();
        this.playbackTelemetry = this.deps.isSafari
            ? createNativeHlsTelemetry(state.playSessionId, deviceId)
            : createHlsJsTelemetry(state.playSessionId, deviceId);

        const video = this.deps.getVideoElement();
        if (video) {
            this.playbackTelemetry.startBufferTracking(video);
        }

        this.deps.log(' Telemetry initialized', {
            playSessionId: state.playSessionId,
            clientType: this.deps.isSafari ? 'native_hls' : 'hls_js',
        });
        return this.playbackTelemetry;
    }

    /**
     * Record bandwidth at most once every 10 seconds.
     */
    recordBandwidthThrottled(bandwidth: number): void {
        const now = Date.now();
        if (now - this.lastBandwidthRecordTime >= 10000) {
            this.lastBandwidthRecordTime = now;
            const telemetry = this.ensure();
            if (telemetry) {
                telemetry.recordBandwidth(bandwidth);
            }
        }
    }

    recordError(type: string, message: string): void {
        const telemetry = this.ensure();
        if (telemetry) {
            telemetry.recordError(type, message);
        }
    }

    recordSeek(from: number, to: number): void {
        const telemetry = this.ensure();
        if (telemetry) {
            telemetry.recordSeek(from, to);
        }
    }

    recordBufferStarvation(bufferHealth: number): void {
        const telemetry = this.ensure();
        if (telemetry) {
            telemetry.recordBufferStarvation(bufferHealth);
        }
    }

    recordRebufferStart(currentTime: number): void {
        const telemetry = this.ensure();
        if (telemetry) {
            telemetry.recordRebufferStart(currentTime);
        }
    }

    recordRebufferEnd(currentTime: number): void {
        const telemetry = this.ensure();
        if (telemetry) {
            telemetry.recordRebufferEnd(currentTime);
        }
    }

    recordMediaStalled(bufferHealth: number): void {
        const telemetry = this.ensure();
        if (telemetry) {
            telemetry.recordMediaStalled(bufferHealth);
        }
    }

    recordReconnect(phase: ReconnectPhase, metadata?: ReconnectTelemetryMeta): void {
        const telemetry = this.ensure();
        if (telemetry) {
            telemetry.recordReconnect(phase, metadata);
        }
    }

    /**
     * Feed one completed hls.js fragment download. Telemetry is written only
     * when this sample CLOSES a 30 s window — per-segment rows would be
     * thousands an hour and would still have to be windowed to mean anything.
     *
     * Only the hls.js path produces samples (native HLS exposes no such event),
     * which is why the engine tag is a constant here.
     */
    recordFragmentDelivery(sample: FragmentDeliverySample, bufferAheadSec: number): void {
        // ensure() FIRST, before the sample lands: if the play session changed,
        // the open window's bytes belong to the session that just ended, and
        // ensure() closes it into THAT session's telemetry. Pushing first would
        // report the old link's window against the new session.
        const telemetry = this.ensure();
        // Unattributed fragments (including Live TV) must not enter a window
        // that a later VOD session could flush under its own session ID.
        if (!telemetry) return;
        this.lastBufferAheadSec = bufferAheadSec;

        const closed = this.deliveryWindows.push(sample);
        if (closed) {
            telemetry.recordDeliveryWindow(closed, bufferAheadSec, 'hls_js');
        }
    }

    /**
     * Close the open delivery window and record it, so the last (partial) window
     * of a session is not silently dropped — which would be exactly the window
     * containing whatever made the viewer stop watching.
     *
     * Takes the telemetry instance rather than calling ensure(): the callers are
     * teardown paths that must write into the instance being torn down, not
     * resurrect one for a session that has already gone.
     */
    private recordFinalDeliveryWindow(telemetry: PlaybackTelemetry | null): void {
        const closed = this.deliveryWindows.flush();
        if (!closed || !telemetry) return;

        // The element is often already detached at teardown; fall back to the
        // last value a fragment was delivered under rather than claiming 0.
        const video = this.deps.getVideoElement();
        const bufferAheadSec = video ? bufferAheadSeconds(video) : this.lastBufferAheadSec;
        telemetry.recordDeliveryWindow(closed, bufferAheadSec, 'hls_js');
    }

    flushViaBeacon(): void {
        if (this.playbackTelemetry) {
            this.playbackTelemetry.flushViaBeacon();
        }
    }

    resetTrackingState(): void {
        const resetValues = createTelemetryResetValues();
        this.nativeRebufferStartTime = resetValues.nativeRebufferStartTime;
        this.seekStartPosition = resetValues.seekStartPosition;
        this.hasNativePlaybackStarted = resetValues.hasNativePlaybackStarted;
        this.lastNativeSeekTime = resetValues.lastNativeSeekTime;
        this.lastBandwidthRecordTime = 0;
        // A new play session measures a new link: drop any half-full window
        // rather than mixing two sessions' bytes into one throughput number.
        this.deliveryWindows = new DeliveryWindowAggregator();
        this.lastBufferAheadSec = 0;
    }

    async destroy(): Promise<void> {
        const outgoing = this.playbackTelemetry;
        if (outgoing) this.recordFinalDeliveryWindow(outgoing);
        // Detach before the network flush: a new session can initialize its
        // telemetry while the outgoing session is still awaiting its request.
        this.playbackTelemetry = null;
        this.resetTrackingState();
        await outgoing?.destroy();
    }

    destroyViaBeacon(): void {
        if (this.playbackTelemetry) {
            this.recordFinalDeliveryWindow(this.playbackTelemetry);
            this.playbackTelemetry.destroyViaBeacon();
            this.playbackTelemetry = null;
        }
        this.resetTrackingState();
    }
}
