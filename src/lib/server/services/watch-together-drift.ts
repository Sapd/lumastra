// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure drift-estimation helpers for Watch Together.
 *
 * Position reports arrive on independent 10-second timers. Comparing their raw
 * media positions makes the timer phase offset look like playback drift. These
 * helpers project every sample to one server-clock instant before comparing it.
 */

export interface WatchTogetherPositionSample {
    position: number;
    /** Server receipt time. Never a client wall-clock timestamp. */
    timestamp: number;
    isHost: boolean;
}

export interface WatchTogetherDriftEstimate {
    hostPosition: number | null;
    maxDrift: number;
    comparableGuests: number;
}

/**
 * Reports are sent every 10 seconds. A 15-second window admits any timer phase
 * offset while excluding disconnected/background-frozen clients promptly.
 */
export const POSITION_SAMPLE_MAX_AGE_MS = 15_000;

/**
 * Covers asymmetric request latency, scheduling jitter, and media-time sampling
 * noise. RTT estimation is deliberately unnecessary: server receipt timestamps
 * plus this margin are more robust than trusting browser wall clocks.
 */
export const DRIFT_LATENCY_TOLERANCE_SECONDS = 0.75;

function safePlaybackRate(playbackRate: number): number {
    return Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1;
}

/** Project a fresh sample to `comparisonTime` using only the server clock. */
export function projectPositionSample(
    sample: WatchTogetherPositionSample,
    comparisonTime: number,
    isPlaying: boolean,
    playbackRate: number,
): number {
    if (!isPlaying) return sample.position;

    const ageMs = Math.max(0, comparisonTime - sample.timestamp);
    return sample.position + (ageMs / 1000) * safePlaybackRate(playbackRate);
}

/**
 * Calculate maximum guest drift after aligning all fresh samples to the same
 * server-clock instant. Stale samples are ignored rather than extrapolated.
 */
export function estimateWatchTogetherDrift(
    samples: Iterable<WatchTogetherPositionSample>,
    comparisonTime: number,
    isPlaying: boolean,
    playbackRate: number,
    maxSampleAgeMs = POSITION_SAMPLE_MAX_AGE_MS,
): WatchTogetherDriftEstimate {
    const fresh = Array.from(samples).filter((sample) => {
        const ageMs = comparisonTime - sample.timestamp;
        return (
            Number.isFinite(sample.position) &&
            Number.isFinite(sample.timestamp) &&
            ageMs >= 0 &&
            ageMs <= maxSampleAgeMs
        );
    });

    const host = fresh.find((sample) => sample.isHost);
    if (!host) {
        return { hostPosition: null, maxDrift: 0, comparableGuests: 0 };
    }

    const hostPosition = projectPositionSample(host, comparisonTime, isPlaying, playbackRate);
    let maxDrift = 0;
    let comparableGuests = 0;

    for (const sample of fresh) {
        if (sample.isHost) continue;
        const guestPosition = projectPositionSample(
            sample,
            comparisonTime,
            isPlaying,
            playbackRate,
        );
        maxDrift = Math.max(maxDrift, Math.abs(guestPosition - hostPosition));
        comparableGuests++;
    }

    return { hostPosition, maxDrift, comparableGuests };
}
