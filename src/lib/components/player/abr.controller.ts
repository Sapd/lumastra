// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AbrController — owns AdaptiveBitrateState, NativeBandwidthEstimator,
 * and quality switch logic.
 *
 * Extracted from PlayerController to isolate adaptive bitrate concerns.
 */

import {
    createAdaptiveBitrateState,
    checkQualitySwitch as checkAdaptiveSwitch,
    handleBufferStall as handleAdaptiveBufferStall,
    clearBandwidthSamples as clearAdaptiveSamples,
    type AdaptiveBitrateState,
} from './adaptive-bitrate';
import { createNativeBandwidthEstimator, type NativeBandwidthEstimator } from './native-bandwidth';
import { playerStore, type QualityMode } from './playerStore.svelte';
import { TIMING } from './timing-constants';
import { abrTiming } from '$lib/stores/client-tuning';

export interface AbrControllerDeps {
    /** Bitrate for ABR quality switching decisions (fallback 20 Mbps) */
    getMediaSourceBitrate: () => number;
    /** Bitrate for native bandwidth estimator (fallback 10 Mbps) */
    getVideoBitrateForEstimator: () => number;
    getQualityMode: () => QualityMode;
    /**
     * Live TV: hls.js switches between the server's adaptive rungs itself. This
     * controller's switch restarts playback through the VOD path, which on a live
     * stream tears the channel down (black picture) instead of lowering quality.
     */
    isLive: () => boolean;
    onQualitySwitch: (targetBitrate: number) => void;
    onShowToast: (reason: string, direction: 'up' | 'down', duration: number) => void;
    log: (...args: unknown[]) => void;
    ensureTelemetry: () => { recordBandwidth: (bw: number) => void } | null;
}

export class AbrController {
    adaptiveBitrateState: AdaptiveBitrateState = createAdaptiveBitrateState();
    private bandwidthEstimator: NativeBandwidthEstimator | null = null;

    private readonly deps: AbrControllerDeps;

    constructor(deps: AbrControllerDeps) {
        this.deps = deps;
    }

    get currentBitrate(): number | null {
        return this.adaptiveBitrateState.currentBitrate;
    }

    checkQualitySwitch(measuredBandwidth: number): void {
        if (this.deps.isLive()) return;
        const sourceBitrate = this.deps.getMediaSourceBitrate();

        const { result, newState } = checkAdaptiveSwitch(
            this.adaptiveBitrateState,
            measuredBandwidth,
            {
                sourceBitrate,
                qualityMode: this.deps.getQualityMode(),
                log: this.deps.log,
                timing: abrTiming(),
            },
        );

        this.adaptiveBitrateState = newState;
        this.handleSwitchResult(result, sourceBitrate);
    }

    handleBufferStall(): void {
        if (this.deps.isLive()) return;
        const sourceBitrate = this.deps.getMediaSourceBitrate();

        const { result, newState } = handleAdaptiveBufferStall(this.adaptiveBitrateState, {
            sourceBitrate,
            qualityMode: this.deps.getQualityMode(),
            log: this.deps.log,
            timing: abrTiming(),
        });

        this.adaptiveBitrateState = newState;
        this.handleSwitchResult(result, sourceBitrate);
    }

    private handleSwitchResult(
        result: {
            shouldSwitch: boolean;
            newBitrate?: number | null;
            reason?: string | null;
            direction?: 'up' | 'down' | null;
        },
        sourceBitrate: number,
    ): void {
        if (!result.shouldSwitch || result.newBitrate == null) return;

        if (result.reason) {
            const direction = result.direction ?? 'down';
            this.deps.onShowToast(result.reason, direction, TIMING.TOAST_DURATION_MS);
        }

        const targetBitrate = result.newBitrate ?? sourceBitrate;
        this.deps.onQualitySwitch(targetBitrate);
    }

    clearSamples(): void {
        this.adaptiveBitrateState = clearAdaptiveSamples(this.adaptiveBitrateState);
    }

    ensureBandwidthEstimator(): NativeBandwidthEstimator {
        if (!this.bandwidthEstimator) {
            this.bandwidthEstimator = createNativeBandwidthEstimator({
                getVideoBitrate: () => this.deps.getVideoBitrateForEstimator(),
                setDownloadBandwidth: (bw: number | null) => playerStore.setDownloadBandwidth(bw),
                recordBandwidthTelemetry: (bw: number) => {
                    const telemetry = this.deps.ensureTelemetry();
                    if (telemetry) {
                        telemetry.recordBandwidth(bw);
                    }
                },
            });
        }
        return this.bandwidthEstimator;
    }

    onPlaybackStart(): void {
        this.adaptiveBitrateState = {
            ...this.adaptiveBitrateState,
            playbackStartTime: Date.now(),
        };
    }

    reset(): void {
        this.adaptiveBitrateState = createAdaptiveBitrateState();
    }

    resetBandwidthTracking(): void {
        this.ensureBandwidthEstimator().reset();
    }
}
