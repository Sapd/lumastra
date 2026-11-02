// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Adaptive Bitrate Management
 *
 * Handles automatic quality switching based on network bandwidth:
 * - Bandwidth measurement and smoothing
 * - Quality switch decisions (up/down)
 * - Cooldown periods to prevent oscillation
 * - Buffer stall handling
 */

import {
    INITIAL_STABILITY_PERIOD,
    SWITCH_DOWN_COOLDOWN,
    SWITCH_UP_COOLDOWN,
    BANDWIDTH_SAMPLE_COUNT,
    MIN_SAMPLES_BEFORE_SWITCH,
    MIN_ADAPTIVE_BITRATE,
} from './player-utils';

// ============================================================================
// Types
// ============================================================================

export interface AdaptiveBitrateState {
    /** Current adaptive bitrate (null = source quality) */
    currentBitrate: number | null;
    /** Rolling window of bandwidth samples */
    bandwidthSamples: number[];
    /** Timestamp of last quality switch */
    lastSwitchTime: number;
    /** Direction of last switch */
    lastSwitchDirection: 'up' | 'down' | null;
    /** When playback started (for stability period) */
    playbackStartTime: number;
}

export interface QualitySwitchResult {
    /** Whether a switch should occur */
    shouldSwitch: boolean;
    /** New bitrate to switch to (if shouldSwitch is true) */
    newBitrate: number | null;
    /** Direction of the switch */
    direction: 'up' | 'down' | null;
    /** Reason for the switch (for toast messages) */
    reason?: string;
}

export interface AdaptiveBitrateConfig {
    /** Source bitrate of the media */
    sourceBitrate: number;
    /** Quality mode ('auto' enables adaptive) */
    qualityMode: 'original' | 'auto' | 'fixed' | 'audio-only';
    /** Callback for logging */
    log: (...args: unknown[]) => void;
    /** Optional timing overrides (from server config) */
    timing?: {
        /** Initial stability period before switching (ms) */
        stabilityPeriodMs?: number;
        /** Cooldown after switching down (ms) */
        downCooldownMs?: number;
        /** Cooldown after switching up (ms) */
        upCooldownMs?: number;
        /** Number of bandwidth samples to average */
        bandwidthSamples?: number;
        /** Minimum samples before first switch */
        minSamplesBeforeSwitch?: number;
        /** Minimum bitrate for adaptive switching (bps) */
        minAdaptiveBitrate?: number;
    };
}

// ============================================================================
// State Management
// ============================================================================

/**
 * Create initial adaptive bitrate state
 */
export function createAdaptiveBitrateState(): AdaptiveBitrateState {
    return {
        currentBitrate: null,
        bandwidthSamples: [],
        lastSwitchTime: 0,
        lastSwitchDirection: null,
        playbackStartTime: 0,
    };
}

/**
 * Reset adaptive bitrate state (e.g., when starting new playback)
 */
export function resetAdaptiveBitrateState(state: AdaptiveBitrateState): AdaptiveBitrateState {
    return {
        ...state,
        bandwidthSamples: [],
        lastSwitchTime: 0,
        lastSwitchDirection: null,
        playbackStartTime: Date.now(),
    };
}

/**
 * Set playback start time (for initial stability period)
 */
export function setPlaybackStartTime(
    state: AdaptiveBitrateState,
    time: number = Date.now(),
): AdaptiveBitrateState {
    return {
        ...state,
        playbackStartTime: time,
    };
}

// ============================================================================
// Quality Switch Logic
// ============================================================================

/**
 * Check if a quality switch is needed based on measured bandwidth
 */
export function checkQualitySwitch(
    state: AdaptiveBitrateState,
    measuredBandwidth: number,
    config: AdaptiveBitrateConfig,
): { result: QualitySwitchResult; newState: AdaptiveBitrateState } {
    const { sourceBitrate, qualityMode, log, timing } = config;

    // Get timing values from config or use defaults
    const stabilityPeriod = timing?.stabilityPeriodMs ?? INITIAL_STABILITY_PERIOD;
    const downCooldown = timing?.downCooldownMs ?? SWITCH_DOWN_COOLDOWN;
    const upCooldown = timing?.upCooldownMs ?? SWITCH_UP_COOLDOWN;
    const bandwidthSampleCount = timing?.bandwidthSamples ?? BANDWIDTH_SAMPLE_COUNT;
    const minSamplesBeforeSwitch = timing?.minSamplesBeforeSwitch ?? MIN_SAMPLES_BEFORE_SWITCH;
    const minBitrate = timing?.minAdaptiveBitrate ?? MIN_ADAPTIVE_BITRATE;

    // Only process in auto mode
    if (qualityMode !== 'auto') {
        return {
            result: { shouldSwitch: false, newBitrate: null, direction: null },
            newState: state,
        };
    }

    const now = Date.now();

    // Current playing bitrate (null means source quality)
    const currentPlayingBitrate = state.currentBitrate || sourceBitrate;

    // Calculate smoothed bandwidth (uses sample count from config)
    const updatedSamples = [...state.bandwidthSamples, measuredBandwidth];
    if (updatedSamples.length > bandwidthSampleCount) {
        updatedSamples.shift();
    }
    const sorted = [...updatedSamples].sort((a, b) => a - b);
    const smoothedBandwidth = sorted[Math.floor(sorted.length / 2)];
    const targetBitrate = Math.floor(smoothedBandwidth * 0.8); // 80% of smoothed bandwidth

    // Update state with new samples
    let newState: AdaptiveBitrateState = {
        ...state,
        bandwidthSamples: updatedSamples,
    };

    // Wait for initial stability period before ANY switching (except critical)
    const timeSinceStart = now - state.playbackStartTime;
    const criticallyLow = targetBitrate < currentPlayingBitrate * 0.3; // Less than 30% = critical

    if (timeSinceStart < stabilityPeriod && !criticallyLow) {
        return {
            result: { shouldSwitch: false, newBitrate: null, direction: null },
            newState,
        };
    }

    // Need minimum samples before making any decision
    if (updatedSamples.length < minSamplesBeforeSwitch && !criticallyLow) {
        return {
            result: { shouldSwitch: false, newBitrate: null, direction: null },
            newState,
        };
    }

    // Check cooldown (different for up vs down)
    const timeSinceLastSwitch = now - state.lastSwitchTime;
    const cooldown = state.lastSwitchDirection === 'up' ? upCooldown : downCooldown;

    if (state.lastSwitchTime > 0 && timeSinceLastSwitch < cooldown && !criticallyLow) {
        return {
            result: { shouldSwitch: false, newBitrate: null, direction: null },
            newState,
        };
    }

    // Determine if we need to switch
    const needsSwitchDown = targetBitrate < currentPlayingBitrate * 0.85; // Below 85% of current

    // Only switch UP if we previously switched down AND have lots of headroom
    const canSwitchUp =
        state.currentBitrate !== null && // Only if we previously reduced
        state.currentBitrate < sourceBitrate &&
        targetBitrate > currentPlayingBitrate * 1.5 && // 50% more available
        updatedSamples.length >= bandwidthSampleCount;

    if (needsSwitchDown) {
        // Already at minimum
        if (state.currentBitrate && state.currentBitrate <= minBitrate) {
            return {
                result: {
                    shouldSwitch: false,
                    newBitrate: null,
                    direction: null,
                },
                newState,
            };
        }

        // Calculate new bitrate (clamp to minimum)
        const clampedBitrate = Math.max(targetBitrate, minBitrate);

        // If same as current, skip
        if (clampedBitrate === state.currentBitrate) {
            return {
                result: {
                    shouldSwitch: false,
                    newBitrate: null,
                    direction: null,
                },
                newState,
            };
        }

        log(' Adaptive: Switching DOWN', {
            from: (currentPlayingBitrate / 1000000).toFixed(1) + ' Mbps',
            to: (clampedBitrate / 1000000).toFixed(1) + ' Mbps',
            smoothed: (smoothedBandwidth / 1000000).toFixed(1) + ' Mbps',
            samples: updatedSamples.length,
            reason: criticallyLow ? 'critically low bandwidth' : 'bandwidth insufficient',
        });

        newState = {
            ...newState,
            currentBitrate: clampedBitrate,
            lastSwitchTime: now,
            lastSwitchDirection: 'down',
        };

        const mbps = (clampedBitrate / 1000000).toFixed(1);
        return {
            result: {
                shouldSwitch: true,
                newBitrate: clampedBitrate,
                direction: 'down',
                reason: `Quality ↓ ${mbps} Mbps`,
            },
            newState,
        };
    } else if (canSwitchUp) {
        // Step up gradually - max 50% increase at a time
        const stepUpBitrate = Math.min(currentPlayingBitrate * 1.5, targetBitrate, sourceBitrate);

        log(' Adaptive: Switching UP', {
            from: (currentPlayingBitrate / 1000000).toFixed(1) + ' Mbps',
            to: (stepUpBitrate / 1000000).toFixed(1) + ' Mbps',
            smoothed: (smoothedBandwidth / 1000000).toFixed(1) + ' Mbps',
        });

        // If stepping up to source, set to null (means "source quality")
        const newBitrate = stepUpBitrate >= sourceBitrate ? null : stepUpBitrate;

        newState = {
            ...newState,
            currentBitrate: newBitrate,
            lastSwitchTime: now,
            lastSwitchDirection: 'up',
        };

        const mbps = (stepUpBitrate / 1000000).toFixed(1);
        return {
            result: {
                shouldSwitch: true,
                newBitrate: newBitrate,
                direction: 'up',
                reason: `Quality ↑ ${mbps} Mbps`,
            },
            newState,
        };
    }

    return {
        result: { shouldSwitch: false, newBitrate: null, direction: null },
        newState,
    };
}

/**
 * Handle buffer stall - force quality reduction
 */
export function handleBufferStall(
    state: AdaptiveBitrateState,
    config: AdaptiveBitrateConfig,
): { result: QualitySwitchResult; newState: AdaptiveBitrateState } {
    const { sourceBitrate, qualityMode, log, timing } = config;
    const minBitrate = timing?.minAdaptiveBitrate ?? MIN_ADAPTIVE_BITRATE;

    // Only handle in auto mode
    if (qualityMode !== 'auto') {
        return {
            result: { shouldSwitch: false, newBitrate: null, direction: null },
            newState: state,
        };
    }

    const currentBitrate = state.currentBitrate || sourceBitrate;

    // Already at minimum
    if (state.currentBitrate && state.currentBitrate <= minBitrate) {
        log(' Already at minimum bitrate, cannot reduce further');
        return {
            result: { shouldSwitch: false, newBitrate: null, direction: null },
            newState: state,
        };
    }

    // Reduce by 50% on buffer stall
    const reducedBitrate = Math.floor(currentBitrate * 0.5);
    const clampedBitrate = Math.max(reducedBitrate, minBitrate);

    log(' Adaptive: Forcing quality reduction due to buffer stall', {
        from: (currentBitrate / 1000000).toFixed(1) + ' Mbps',
        to: (clampedBitrate / 1000000).toFixed(1) + ' Mbps',
        atFloor: clampedBitrate === minBitrate,
    });

    const newState: AdaptiveBitrateState = {
        ...state,
        currentBitrate: clampedBitrate,
        lastSwitchTime: Date.now(),
        lastSwitchDirection: 'down',
    };

    const mbps = (clampedBitrate / 1000000).toFixed(1);
    return {
        result: {
            shouldSwitch: true,
            newBitrate: clampedBitrate,
            direction: 'down',
            reason: `Buffering ↓ ${mbps} Mbps`,
        },
        newState,
    };
}

/**
 * Clear bandwidth samples (e.g., after seeking)
 */
export function clearBandwidthSamples(state: AdaptiveBitrateState): AdaptiveBitrateState {
    return {
        ...state,
        bandwidthSamples: [],
        playbackStartTime: Date.now(),
    };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Format bitrate for display
 */
export function formatBitrateMbps(bitrate: number | null, sourceBitrate: number): string {
    if (bitrate === null) {
        return 'Source (' + (sourceBitrate / 1000000).toFixed(1) + ' Mbps)';
    }
    return (bitrate / 1000000).toFixed(1) + ' Mbps';
}

/**
 * Check if currently at source quality
 */
export function isAtSourceQuality(state: AdaptiveBitrateState): boolean {
    return state.currentBitrate === null;
}

/**
 * Get effective bitrate (current or source)
 */
export function getEffectiveBitrate(state: AdaptiveBitrateState, sourceBitrate: number): number {
    return state.currentBitrate || sourceBitrate;
}
