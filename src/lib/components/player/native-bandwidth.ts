// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Native Bandwidth Estimation
 *
 * Estimates download bandwidth for native HLS playback (Safari, native players)
 * by tracking buffer growth over time. When hls.js is active, it handles
 * bandwidth estimation via fragment loading instead.
 *
 * Extracted from VideoPlayer.svelte for reusability.
 */

import { BUFFER_THRESHOLDS, TIMING } from './timing-constants';

/**
 * Configuration for bandwidth estimation thresholds
 */
export interface BandwidthThresholds {
    /** Consider buffer fully loaded at this coverage ratio (0-1) */
    fullyLoaded: number;
    /** Minimum buffer growth to measure bandwidth (seconds) */
    minGrowthS: number;
    /** Minimum time to measure growth over (seconds) */
    minTimeElapsedS: number;
    /** Maximum time window for measurement (seconds) */
    maxTimeElapsedS: number;
    /** Sanity check - buffer can't grow faster than this ratio */
    maxGrowthRatio: number;
}

/**
 * Bandwidth estimation result
 */
export interface BandwidthSample {
    /** Estimated bandwidth in bits per second */
    bandwidth: number;
    /** Timestamp when sample was taken */
    timestamp: number;
}

/**
 * Dependencies for bandwidth estimation
 */
export interface NativeBandwidthDeps {
    /** Get the current video bitrate (fallback if unknown) */
    getVideoBitrate: () => number;
    /** Set the estimated download bandwidth */
    setDownloadBandwidth: (bandwidth: number | null) => void;
    /** Record bandwidth to telemetry (optional) */
    recordBandwidthTelemetry?: (bandwidth: number) => void;
}

/**
 * Default thresholds from BUFFER_THRESHOLDS constants
 */
export const DEFAULT_THRESHOLDS: BandwidthThresholds = {
    fullyLoaded: BUFFER_THRESHOLDS.FULLY_LOADED,
    minGrowthS: BUFFER_THRESHOLDS.MIN_GROWTH_S,
    minTimeElapsedS: BUFFER_THRESHOLDS.MIN_TIME_ELAPSED_S,
    maxTimeElapsedS: BUFFER_THRESHOLDS.MAX_TIME_ELAPSED_S,
    maxGrowthRatio: BUFFER_THRESHOLDS.MAX_GROWTH_RATIO,
};

/** Minimum valid bandwidth (1 Mbps) */
const MIN_VALID_BANDWIDTH = 1_000_000;

/** Maximum valid bandwidth (1 Gbps) - higher is likely measurement error */
const MAX_VALID_BANDWIDTH = 1_000_000_000;

/** Default video bitrate fallback (10 Mbps) */
const DEFAULT_VIDEO_BITRATE = 10_000_000;

/** Number of samples to keep for averaging */
const MAX_SAMPLES = 8;

/** Minimum samples required before reporting bandwidth */
const MIN_SAMPLES_FOR_REPORT = 3;

/**
 * Conservative factor applied to measured bandwidth before reporting.
 * Buffer-growth measurements overestimate during initial burst downloads
 * (browser prebuffers faster than sustained rate). 0.85 keeps estimates
 * realistic without under-reporting at steady state.
 */
const CONSERVATIVE_FACTOR = 0.85;

/**
 * Create a native bandwidth estimator for buffer-growth-based bandwidth detection
 *
 * @param deps - Dependencies for bandwidth updates and telemetry
 * @param thresholds - Optional custom thresholds
 */
export function createNativeBandwidthEstimator(
    deps: NativeBandwidthDeps,
    thresholds: BandwidthThresholds = DEFAULT_THRESHOLDS,
) {
    // Internal state
    let lastBufferEnd = 0;
    let lastBufferTime = 0;
    let samples: number[] = [];
    let lastTelemetryTime = 0;

    /**
     * Reset bandwidth tracking state
     * Call when switching videos or streams
     */
    function reset(): void {
        lastBufferEnd = 0;
        lastBufferTime = 0;
        samples = [];
        deps.setDownloadBandwidth(null);
    }

    /**
     * Get current bandwidth samples
     */
    function getSamples(): readonly number[] {
        return samples;
    }

    /**
     * Get the current average bandwidth estimate
     * @returns Average bandwidth in bps, or null if insufficient samples
     */
    function getEstimate(): number | null {
        if (samples.length < MIN_SAMPLES_FOR_REPORT) {
            return null;
        }
        return (samples.reduce((a, b) => a + b, 0) / samples.length) * CONSERVATIVE_FACTOR;
    }

    /**
     * Process a progress event from the video element
     * Call this from the video's 'progress' event handler
     *
     * @param buffered - TimeRanges from video.buffered
     * @param duration - Video duration in seconds
     * @param isHlsActive - Whether hls.js is handling playback
     */
    function onProgress(buffered: TimeRanges | null, duration: number, isHlsActive: boolean): void {
        // Only estimate bandwidth for native playback (no hls.js)
        // When using hls.js, PlaybackManager handles bandwidth estimation via fragment loading
        if (isHlsActive || !buffered || buffered.length === 0) {
            return;
        }

        if (!duration || !isFinite(duration) || duration <= 0) {
            return;
        }

        const now = performance.now();
        const currentBufferEnd = buffered.end(buffered.length - 1);

        // Don't estimate bandwidth if video is fully or nearly buffered (small files)
        // This prevents wildly inflated estimates when a small file buffers instantly
        const bufferCoverage = currentBufferEnd / duration;
        if (bufferCoverage > thresholds.fullyLoaded) {
            // Video is fully buffered - don't update bandwidth (would be misleading)
            lastBufferEnd = currentBufferEnd;
            lastBufferTime = now;
            return;
        }

        // Calculate how much buffer was added since last check
        if (lastBufferEnd > 0 && lastBufferTime > 0) {
            const bufferGrowth = currentBufferEnd - lastBufferEnd; // seconds of video
            const timeElapsed = (now - lastBufferTime) / 1000; // seconds of real time

            // Only calculate if buffer growth and time elapsed are within valid ranges
            const growthRatio = bufferGrowth / timeElapsed;
            const isValidMeasurement =
                bufferGrowth > thresholds.minGrowthS &&
                timeElapsed > thresholds.minTimeElapsedS &&
                timeElapsed < thresholds.maxTimeElapsedS &&
                growthRatio < thresholds.maxGrowthRatio;

            if (isValidMeasurement) {
                // Estimate bitrate based on buffer growth
                // buffer growth (s) / time elapsed (s) = download ratio
                // download ratio * video bitrate ≈ download bandwidth
                const videoBitrate = deps.getVideoBitrate() || DEFAULT_VIDEO_BITRATE;

                // If we downloaded X seconds of video in Y seconds of real time,
                // bandwidth = (X / Y) * bitrate
                const estimatedBandwidth = growthRatio * videoBitrate;

                // Sanity check: bandwidth should be between 1 Mbps and 1 Gbps
                // Higher than 1 Gbps is almost certainly a measurement error
                if (
                    estimatedBandwidth > MIN_VALID_BANDWIDTH &&
                    estimatedBandwidth < MAX_VALID_BANDWIDTH
                ) {
                    // Add to samples (keep last N)
                    samples.push(estimatedBandwidth);
                    if (samples.length > MAX_SAMPLES) {
                        samples.shift();
                    }

                    // Use average of samples for stability, with conservative factor
                    // to discount burst-inflated early readings
                    const avgBandwidth =
                        (samples.reduce((a, b) => a + b, 0) / samples.length) * CONSERVATIVE_FACTOR;

                    // Only update if we have enough samples
                    if (samples.length >= MIN_SAMPLES_FOR_REPORT) {
                        deps.setDownloadBandwidth(avgBandwidth);

                        // Record bandwidth to telemetry (throttled)
                        if (deps.recordBandwidthTelemetry) {
                            const telemetryNow = Date.now();
                            if (telemetryNow - lastTelemetryTime >= TIMING.TELEMETRY_THROTTLE_MS) {
                                lastTelemetryTime = telemetryNow;
                                deps.recordBandwidthTelemetry(avgBandwidth);
                            }
                        }
                    }
                }
            }
        }

        lastBufferEnd = currentBufferEnd;
        lastBufferTime = now;
    }

    return {
        reset,
        onProgress,
        getSamples,
        getEstimate,
    };
}

/**
 * Type for the bandwidth estimator instance
 */
export type NativeBandwidthEstimator = ReturnType<typeof createNativeBandwidthEstimator>;
