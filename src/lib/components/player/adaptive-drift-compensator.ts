// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Adaptive Drift Compensator for Watch Together
 *
 * Uses a "finish-time alignment" strategy to minimize playback rate changes:
 *
 * Core insight: Instead of constantly adjusting rate to match position,
 * calculate the rate needed for guest to finish at the same time as host.
 * This gives a single, stable rate that rarely needs to change.
 *
 * Example:
 *   Host at 1:00:00, movie is 2:00:00 → 1:00:00 remaining
 *   Guest at 0:59:50 (10s behind) → 1:00:10 remaining
 *   Required rate = 1:00:10 / 1:00:00 = 1.00278x
 *
 * That tiny 0.28% adjustment is imperceptible and stays constant!
 *
 * States:
 * - MEASURING: Gathering initial drift data (first few seconds after join)
 * - CALIBRATING: Calculating optimal rate
 * - LOCKED: Rate is set, periodic recalibration if drift accumulates
 *
 * The key difference from velocity-based approaches:
 * - Velocity-based: React to drift changes, adjust rate continuously
 * - Finish-time: Calculate once, stay locked, only adjust if change > threshold
 *
 * Since browser playback isn't perfectly constant, we periodically re-evaluate
 * (default every 30 seconds) but only apply changes if they exceed the minimum
 * threshold (default 0.3%) to avoid micro-stutters.
 */

export type SyncState = 'measuring' | 'calibrating' | 'locked';

export interface DriftSample {
    time: number;
    drift: number; // positive = behind host, negative = ahead
    guestPosition: number;
    hostPosition: number;
}

export interface SyncAction {
    action: 'none' | 'seek' | 'rate';
    rate?: number;
    seekTarget?: number;
}

export interface AdaptiveDriftCompensatorConfig {
    /** Duration to gather initial samples (ms) - can be short since we just need stable readings */
    measureDuration: number;
    /** Minimum samples before calibrating */
    minSamplesForCalibration: number;
    /** Drift threshold for hard seek (seconds) - only intervention during locked state */
    hardSeekThreshold: number;
    /** Minimum time between hard seeks while the player settles (ms) */
    hardSeekCooldown: number;
    /** Maximum rate adjustment from 1.0 (e.g., 0.05 = 5%) */
    maxRateAdjustment: number;
    /** Overshoot for seeks to compensate for seek latency (seconds) */
    seekLatencyOffset: number;
    /** Minimum remaining time to apply rate adjustment (seconds) - don't adjust near end */
    minRemainingTime: number;
    /** If true, use finish-time calculation; if false, use drift-velocity */
    useFinishTimeSync: boolean;
    /** Sample retention for drift velocity fallback (ms) */
    sampleRetention: number;
    /** Initial recalibration interval after entering locked state (ms) */
    initialRecalibrationInterval: number;
    /** Maximum recalibration interval (ms) - interval doubles each time until this */
    maxRecalibrationInterval: number;
    /** Minimum rate change to actually apply (avoids micro-adjustments) */
    minRateChangeThreshold: number;
    /** Minimum projected finish time difference to trigger recalibration (seconds) */
    minFinishTimeDiff: number;
    /** Target time to sync up (seconds) - sync over 5 min instead of entire movie */
    targetSyncTime: number;
}

export const DEFAULT_CONFIG: AdaptiveDriftCompensatorConfig = {
    measureDuration: 5000, // 5s to gather stable readings
    minSamplesForCalibration: 3,
    hardSeekThreshold: 5.0, // More lenient - finish-time handles larger drifts gracefully
    hardSeekCooldown: 6000,
    maxRateAdjustment: 0.05, // Max 5% rate change
    seekLatencyOffset: 0.25, // 250ms overshoot on seeks
    minRemainingTime: 60, // Don't adjust in last minute
    useFinishTimeSync: true, // Default to finish-time strategy
    sampleRetention: 30000, // 30s for velocity fallback
    initialRecalibrationInterval: 10000, // First check after 10s
    maxRecalibrationInterval: 60000, // Max 60s between checks
    minRateChangeThreshold: 0.003, // Only apply if change > 0.3%
    minFinishTimeDiff: 1.5, // Only recalibrate if finish time would differ by > 1.5s
    targetSyncTime: 300, // Sync within 5 minutes (more aggressive than finish-time)
};

export class AdaptiveDriftCompensator {
    private state: SyncState = 'measuring';
    private currentRate = 1.0;
    private originalRate = 1.0; // User's preferred playback rate
    private samples: DriftSample[] = [];
    private stateEntryTime: number;
    private mediaDuration: number | null = null;
    private config: AdaptiveDriftCompensatorConfig;
    private lastCalibrationInfo: {
        guestPosition: number;
        hostPosition: number;
        calculatedRate: number;
        method: 'finish-time' | 'drift-velocity';
    } | null = null;
    private lastRecalibrationTime = 0;
    private currentRecalibrationInterval: number;
    private lastHardSeekTime = Number.NEGATIVE_INFINITY;

    // For testing - allow injecting current time
    private timeProvider: () => number;

    constructor(config?: Partial<AdaptiveDriftCompensatorConfig>, timeProvider?: () => number) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.timeProvider = timeProvider ?? (() => performance.now());
        this.stateEntryTime = this.timeProvider();
        this.currentRecalibrationInterval = this.config.initialRecalibrationInterval;
    }

    /**
     * Set the media duration (required for finish-time sync).
     * Usually obtained from video.duration after metadata loads.
     */
    setMediaDuration(duration: number): void {
        this.mediaDuration = duration;
    }

    /**
     * Set the user's preferred playback rate (e.g., 1.0, 1.25, 1.5).
     * Compensation will be applied relative to this rate.
     */
    setOriginalRate(rate: number): void {
        this.originalRate = rate;
        // If we're locked, recalibrate with new base rate
        if (this.state === 'locked') {
            this.forceRecalibrate();
        }
    }

    /**
     * Process a drift measurement and return the recommended action.
     *
     * @param drift Current drift in seconds (positive = behind host, negative = ahead)
     * @param guestPosition Current guest position in seconds
     * @param hostPosition Current host position in seconds
     * @returns Action to take: 'none', 'seek', or 'rate' change
     */
    update(drift: number, guestPosition: number, hostPosition: number): SyncAction {
        const now = this.timeProvider();

        // Add sample
        this.samples.push({ time: now, drift, guestPosition, hostPosition });

        // Prune old samples
        this.samples = this.samples.filter((s) => s.time > now - this.config.sampleRetention);

        // Hard seek if way off (any state)
        if (Math.abs(drift) > this.config.hardSeekThreshold) {
            if (now - this.lastHardSeekTime < this.config.hardSeekCooldown) {
                return { action: 'none' };
            }
            this.lastHardSeekTime = now;
            this.transitionTo('measuring', now);
            this.samples = [];
            const seekTarget = hostPosition + this.config.seekLatencyOffset;
            return { action: 'seek', seekTarget };
        }

        switch (this.state) {
            case 'measuring':
                return this.handleMeasuring(now);
            case 'calibrating':
                return this.handleCalibrating(now);
            case 'locked':
                return this.handleLocked(now, guestPosition, hostPosition);
        }
    }

    private handleMeasuring(now: number): SyncAction {
        // If original rate changed (e.g., host changed playback speed),
        // apply it immediately so we're at the right base rate while measuring
        if (Math.abs(this.currentRate - this.originalRate) > 0.0001) {
            this.currentRate = this.originalRate;
            return { action: 'rate', rate: this.originalRate };
        }

        const measureTime = now - this.stateEntryTime;

        // Need enough measurement time and samples
        if (
            measureTime < this.config.measureDuration ||
            this.samples.length < this.config.minSamplesForCalibration
        ) {
            return { action: 'none' };
        }

        // Ready to calibrate
        this.transitionTo('calibrating', now);
        return this.handleCalibrating(now);
    }

    private handleCalibrating(_now: number): SyncAction {
        // Get latest positions from most recent sample
        const latest = this.samples[this.samples.length - 1];
        if (!latest) {
            return { action: 'none' };
        }

        let newRate: number;
        let method: 'finish-time' | 'drift-velocity';

        // Try finish-time calculation if we have duration
        if (this.config.useFinishTimeSync && this.mediaDuration && this.mediaDuration > 0) {
            const result = this.calculateFinishTimeRate(
                latest.guestPosition,
                latest.hostPosition,
                this.mediaDuration,
            );
            newRate = result.rate;
            method = 'finish-time';
        } else {
            // Fall back to drift-velocity calculation
            newRate = this.calculateDriftVelocityRate();
            method = 'drift-velocity';
        }

        // Store calibration info for debugging
        this.lastCalibrationInfo = {
            guestPosition: latest.guestPosition,
            hostPosition: latest.hostPosition,
            calculatedRate: newRate,
            method,
        };

        // Transition to locked
        const now = this.timeProvider();
        this.transitionTo('locked', now);
        this.lastRecalibrationTime = now; // Start recalibration timer
        this.currentRecalibrationInterval = this.config.initialRecalibrationInterval; // Reset backoff
        this.samples = []; // Fresh start for monitoring

        // Only report rate change if meaningfully different
        if (Math.abs(newRate - this.currentRate) > 0.0005) {
            this.currentRate = newRate;
            return { action: 'rate', rate: this.currentRate };
        }

        return { action: 'none' };
    }

    private handleLocked(now: number, guestPosition: number, hostPosition: number): SyncAction {
        // In locked state, we mostly stay constant but periodically re-evaluate
        // Hard seek check is done in update() before this

        // Check if it's time for periodic recalibration (exponential backoff: 10s, 20s, 40s, 60s max)
        if (
            this.currentRecalibrationInterval > 0 &&
            now - this.lastRecalibrationTime > this.currentRecalibrationInterval &&
            this.mediaDuration &&
            this.mediaDuration > 0
        ) {
            const guestRemaining = this.mediaDuration - guestPosition;
            const hostRemaining = this.mediaDuration - hostPosition;

            // Calculate projected finish time difference at current rate
            // Guest finishes in: guestRemaining / currentRate
            // Host finishes in: hostRemaining / originalRate
            const guestFinishTime = guestRemaining / this.currentRate;
            const hostFinishTime = hostRemaining / this.originalRate;
            const finishTimeDiff = Math.abs(guestFinishTime - hostFinishTime);

            // Only recalibrate if finish time would differ by more than threshold
            if (finishTimeDiff > this.config.minFinishTimeDiff) {
                // Recalculate optimal rate
                const result = this.calculateFinishTimeRate(
                    guestPosition,
                    hostPosition,
                    this.mediaDuration,
                );
                const rateChange = Math.abs(result.rate - this.currentRate);

                // Only apply if change is significant enough (avoids micro-stutters)
                // With targetSyncTime=300s, even small drifts give noticeable rate changes
                if (rateChange > this.config.minRateChangeThreshold) {
                    this.currentRate = result.rate;
                    this.lastRecalibrationTime = now;
                    this.lastCalibrationInfo = {
                        guestPosition,
                        hostPosition,
                        calculatedRate: result.rate,
                        method: 'finish-time',
                    };
                    // Reset interval after a rate change (something significant happened)
                    this.currentRecalibrationInterval = this.config.initialRecalibrationInterval;
                    return { action: 'rate', rate: this.currentRate };
                }
            }

            // No change needed - increase interval (exponential backoff)
            this.lastRecalibrationTime = now;
            this.currentRecalibrationInterval = Math.min(
                this.currentRecalibrationInterval * 2,
                this.config.maxRecalibrationInterval,
            );
        }

        return { action: 'none' };
    }

    /**
     * Calculate rate needed for guest to sync with host.
     *
     * Uses targetSyncTime (default 5 min) for more aggressive sync.
     * Formula: guestRate = originalRate + drift / syncWallTime
     *
     * Example: Guest 10s behind, sync in 300s
     *   rate = 1.0 + 10 / 300 = 1.0333x (3.3% faster)
     */
    private calculateFinishTimeRate(
        guestPosition: number,
        hostPosition: number,
        duration: number,
    ): { rate: number; guestRemaining: number; hostRemaining: number } {
        const hostRemaining = duration - hostPosition;
        const guestRemaining = duration - guestPosition;
        const drift = hostPosition - guestPosition; // positive = guest behind

        // Near end of video - don't adjust
        if (hostRemaining < this.config.minRemainingTime) {
            return { rate: this.originalRate, guestRemaining, hostRemaining };
        }

        // Avoid division issues
        if (hostRemaining <= 0) {
            return { rate: this.originalRate, guestRemaining, hostRemaining };
        }

        // targetSyncTime is wall time, so cap it by remaining wall time
        // rather than remaining media time when playback is not 1x.
        const syncTime = Math.min(this.config.targetSyncTime, hostRemaining / this.originalRate);

        // Calculate required rate to close the drift within syncTime
        // Add exactly enough media-seconds/second to close drift in syncTime.
        const requiredRate = this.originalRate + drift / syncTime;

        // Clamp to reasonable bounds
        const clampedRate = this.clamp(
            requiredRate,
            this.originalRate * (1 - this.config.maxRateAdjustment),
            this.originalRate * (1 + this.config.maxRateAdjustment),
        );

        return { rate: clampedRate, guestRemaining, hostRemaining };
    }

    /**
     * Calculate rate based on drift velocity (fallback when duration unknown).
     * Uses linear regression to find drift trend.
     */
    private calculateDriftVelocityRate(): number {
        if (this.samples.length < 2) {
            return this.originalRate;
        }

        const n = this.samples.length;
        const t0 = this.samples[0].time;

        let sumT = 0;
        let sumD = 0;
        let sumTD = 0;
        let sumT2 = 0;

        for (const sample of this.samples) {
            const t = (sample.time - t0) / 1000; // Convert to seconds
            const d = sample.drift;
            sumT += t;
            sumD += d;
            sumTD += t * d;
            sumT2 += t * t;
        }

        // Linear regression slope
        const denominator = n * sumT2 - sumT * sumT;
        if (Math.abs(denominator) < 0.0001) {
            return this.originalRate;
        }

        const driftVelocity = (n * sumTD - sumT * sumD) / denominator;

        // Convert to rate adjustment
        const adjustment = this.clamp(
            driftVelocity,
            -this.config.maxRateAdjustment,
            this.config.maxRateAdjustment,
        );

        return this.originalRate * (1.0 + adjustment);
    }

    private transitionTo(newState: SyncState, now: number): void {
        this.state = newState;
        this.stateEntryTime = now;
    }

    private clamp(value: number, min: number, max: number): number {
        return Math.min(Math.max(value, min), max);
    }

    // === Public getters for testing and debugging ===

    getState(): SyncState {
        return this.state;
    }

    getRate(): number {
        return this.currentRate;
    }

    getOriginalRate(): number {
        return this.originalRate;
    }

    getSampleCount(): number {
        return this.samples.length;
    }

    getConfig(): AdaptiveDriftCompensatorConfig {
        return { ...this.config };
    }

    getMediaDuration(): number | null {
        return this.mediaDuration;
    }

    getLastCalibrationInfo(): typeof this.lastCalibrationInfo {
        return this.lastCalibrationInfo;
    }

    /** Reset to initial state */
    reset(): void {
        this.state = 'measuring';
        this.currentRate = this.originalRate;
        this.samples = [];
        this.stateEntryTime = this.timeProvider();
        this.lastCalibrationInfo = null;
        this.currentRecalibrationInterval = this.config.initialRecalibrationInterval;
        this.lastHardSeekTime = Number.NEGATIVE_INFINITY;
    }

    /** Force recalibration (e.g., after host seeks, or user changes playback speed) */
    forceRecalibrate(): void {
        this.transitionTo('measuring', this.timeProvider());
        this.samples = [];
        this.currentRecalibrationInterval = this.config.initialRecalibrationInterval;
    }

    /**
     * Immediate calibration after a seek - skips measuring phase.
     * Use when you already know exact positions (e.g., after receiving a seek event).
     * Returns the rate action to apply.
     */
    calibrateImmediately(guestPosition: number, hostPosition: number): SyncAction {
        const now = this.timeProvider();

        // If no duration, just use original rate
        if (!this.mediaDuration || this.mediaDuration <= 0) {
            this.transitionTo('locked', now);
            this.currentRecalibrationInterval = this.config.initialRecalibrationInterval;
            this.lastRecalibrationTime = now;
            this.currentRate = this.originalRate;
            this.samples = [];
            return { action: 'rate', rate: this.originalRate };
        }

        const drift = Math.abs(hostPosition - guestPosition);

        // If drift is very small, just use original rate
        if (drift < 0.5) {
            this.transitionTo('locked', now);
            this.currentRecalibrationInterval = this.config.initialRecalibrationInterval;
            this.lastRecalibrationTime = now;
            this.currentRate = this.originalRate;
            this.samples = [];
            return { action: 'rate', rate: this.originalRate };
        }

        // Calculate finish-time rate
        const result = this.calculateFinishTimeRate(
            guestPosition,
            hostPosition,
            this.mediaDuration,
        );

        this.transitionTo('locked', now);
        this.currentRecalibrationInterval = this.config.initialRecalibrationInterval;
        this.lastRecalibrationTime = now;
        this.currentRate = result.rate;
        this.lastCalibrationInfo = {
            guestPosition,
            hostPosition,
            calculatedRate: result.rate,
            method: 'finish-time',
        };
        this.samples = [];

        return { action: 'rate', rate: result.rate };
    }

    /** Get current recalibration interval (for debugging) */
    getRecalibrationInterval(): number {
        return this.currentRecalibrationInterval;
    }
}
