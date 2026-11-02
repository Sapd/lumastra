// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { detectBlackFrames as ffmpegDetectBlackFrames } from '$lib/server/utils/ffmpeg-analysis.js';
import type { DetectorOutcome } from './types.js';

export interface BlackFrameConfig {
    minCreditsDuration: number;
    maxSearchDistance: number;
    maxMovieSearchDistance: number;
    minimumBlackPct: number;
    threshold: number;
    precision: number;
    maxGapBuckets: number;
}

// Starting template; per-run config is built from EffectiveConfig at call site.
export const DEFAULT_BLACKFRAME_CONFIG: BlackFrameConfig = {
    minCreditsDuration: 15,
    maxSearchDistance: 600,
    maxMovieSearchDistance: 900,
    minimumBlackPct: 50,
    threshold: 32,
    precision: 4,
    maxGapBuckets: 3,
};

/**
 * Example names are fictional; production shapes and measurements are retained.
 * A night scene can satisfy the normal 50% luma test. A sustained near-total
 * black run is materially different evidence: on the production regression
 * file the scene measures 85–95%, then the actual credits cut to 100%.
 */
const TERMINAL_BLACK_PCT = 98;
const TERMINAL_BLACK_RUN_SECONDS = 12;
const MAX_TERMINAL_BLACK_FRAME_GAP_SECONDS = 0.5;
const RAMP_BLACK_PCT = 90;
const RAMP_MIN_RISE_PCT = 8;
const MAX_BRANDED_TAIL_SECONDS = 45;
const BLACKFRAME_SAMPLE_FPS = 5;

/**
 * Walk backwards from the end of the file looking for the contiguous dark
 * region that end credits sit in, and report where it begins.
 *
 * ## Why this abstains instead of always answering
 *
 * The walk starts at EOF and extends backwards while it keeps finding black
 * buckets, bridging gaps of up to `maxGapBuckets`. It stops for exactly two
 * reasons: it found a gap wider than the bridge tolerance (a real boundary), or
 * it ran out of search window. Those two outcomes are NOT equally meaningful.
 *
 * `blackframe=amount=50:threshold=32` calls a frame black when half its pixels
 * are below luma 32 — which a dark night exterior satisfies just as well as a
 * credit roll. On Drifting Clouds S03E12 the final five minutes are a night scene
 * measuring pblack 51-69 continuously, with a largest gap of 8s against a 12s
 * bridge tolerance. The walk never terminated; it ran to the window edge and
 * the window edge was reported as the credits start — 2.5 minutes early.
 *
 * A run that reaches the edge of its own search window is a TRUNCATION, not a
 * detection: the dark region is unbounded, so its start is unknown. Reporting
 * the window edge dresses "I ran out of budget" as "the credits begin here".
 * We abstain instead, and a missing marker degrades to the player's fixed
 * end-of-file prompt — strictly better than a confidently wrong one.
 */
export async function analyzeBlackFrames(
    filePath: string,
    durationSec: number,
    config: BlackFrameConfig = DEFAULT_BLACKFRAME_CONFIG,
    ffmpegThreads?: number,
    signal?: AbortSignal,
): Promise<DetectorOutcome> {
    if (!Number.isFinite(durationSec) || durationSec <= config.minCreditsDuration * 2) {
        return { kind: 'abstain', reason: 'unusable-input' };
    }

    const {
        minimumBlackPct,
        threshold,
        precision,
        minCreditsDuration,
        maxSearchDistance,
        maxGapBuckets,
    } = config;
    if (
        !Number.isFinite(precision) ||
        precision <= 0 ||
        !Number.isFinite(maxSearchDistance) ||
        maxSearchDistance <= 0
    )
        return { kind: 'abstain', reason: 'unusable-input' };

    const maxOffsetSec = Math.min(maxSearchDistance, durationSec - minCreditsDuration);
    const searchStart = Math.max(0, durationSec - maxOffsetSec);
    const searchEnd = durationSec;

    // Ask ffmpeg for every decimated frame. The existing threshold is applied
    // below, while the complete pblack signal lets us recognise the decisive
    // cut from a very dark scene into an actually black credits plate.
    const frames = await ffmpegDetectBlackFrames(filePath, searchStart, searchEnd, {
        minimumBlackPct: 0,
        threshold,
        threads: ffmpegThreads,
        // Allow up to twice real time for the requested window. Five minutes is
        // the floor for short clips; thirty minutes caps even extreme settings.
        // The task signal still enforces cancellation and its overall deadline.
        timeout: Math.min(30 * 60_000, Math.max(5 * 60_000, maxOffsetSec * 2_000)),
        abortSignal: signal,
    });

    if (frames.length === 0) return { kind: 'abstain', reason: 'no-detection' };

    const blackFrameCounts = new Map<number, number>();
    for (const frame of frames) {
        if (frame.time < searchStart || frame.time >= searchEnd) continue;
        const bucket = Math.floor((frame.time - searchStart) / precision);
        if (frame.blackPercentage >= minimumBlackPct) {
            blackFrameCounts.set(bucket, (blackFrameCounts.get(bucket) ?? 0) + 1);
        }
    }

    /**
     * A run whose start lands this close to the window edge is treated as
     * unbounded. One bucket of margin is too tight: a run whose first bucket
     * happens to be non-black is just as unbounded as one that reaches the edge
     * exactly, so we allow the same slack the walk itself bridges.
     */
    const edgeMarginSec = precision * (maxGapBuckets + 1);
    const bucketCount = Math.ceil((searchEnd - searchStart) / precision);

    // Keep the exact frame timestamp for the high-black transition. Rounding it
    // down to the detector's four-second bookkeeping bucket turns a real fade
    // boundary into a visibly late skip point (the production E04–E06 labels
    // demonstrate this). A long contiguous run filters out one-frame flashes.
    let terminalBlackStartSec: number | null = null;
    let runStart: number | null = null;
    let previousTime: number | null = null;
    for (const frame of frames) {
        if (frame.blackPercentage < TERMINAL_BLACK_PCT) {
            runStart = null;
            previousTime = null;
            continue;
        }
        if (
            previousTime === null ||
            frame.time - previousTime > MAX_TERMINAL_BLACK_FRAME_GAP_SECONDS
        ) {
            runStart = frame.time;
        }
        previousTime = frame.time;
        if (runStart !== null && frame.time - runStart >= TERMINAL_BLACK_RUN_SECONDS) {
            terminalBlackStartSec = runStart;
            break;
        }
    }

    // Some credits end with a bright network/logo card. Find a distinct fade
    // into a sustained near-black plate so that tail can be included without
    // treating an arbitrary dark scene as credits.
    // Collect EVERY qualifying ramp rather than breaking on the first. The scan
    // runs forward from the start of a 600s/900s search window, so the first
    // match is frequently an unrelated mid-episode fade to black. Keeping only
    // that one meant the containment check below failed against the real
    // terminal run and the detector abstained on a file with perfectly good
    // credits — silently, and on exactly the branded-tail files this branch
    // exists to serve.
    const rampCandidates: number[] = [];
    runStart = null;
    previousTime = null;
    let precedingBlackPct: number | null = null;
    let rampPeakBlackPct = 0;
    for (const frame of frames) {
        if (frame.blackPercentage < RAMP_BLACK_PCT) {
            precedingBlackPct = frame.blackPercentage;
            runStart = null;
            previousTime = null;
            continue;
        }
        if (
            previousTime === null ||
            frame.time - previousTime > MAX_TERMINAL_BLACK_FRAME_GAP_SECONDS
        ) {
            runStart = frame.time;
            rampPeakBlackPct = frame.blackPercentage;
        }
        rampPeakBlackPct = Math.max(rampPeakBlackPct, frame.blackPercentage);
        previousTime = frame.time;
        if (
            runStart !== null &&
            precedingBlackPct !== null &&
            frame.time - runStart >= TERMINAL_BLACK_RUN_SECONDS &&
            rampPeakBlackPct - precedingBlackPct >= RAMP_MIN_RISE_PCT
        ) {
            if (rampCandidates[rampCandidates.length - 1] !== runStart) {
                rampCandidates.push(runStart);
            }
            // Keep scanning: a later ramp may be the one inside the terminal run.
            continue;
        }
    }

    let runStartSec: number | null = null;
    let runEndSec: number | null = null;
    let gapCount = 0;
    let terminalGapCount = 0;
    let hasBrandedTail = false;

    const finalizeRunIfLongEnough = (): DetectorOutcome | null => {
        if (runStartSec === null || runEndSec === null) return null;
        if (runEndSec - runStartSec < minCreditsDuration) return null;

        // The credits plate begins at the EARLIEST ramp that belongs to the
        // terminal run — earlier candidates are unrelated scenes, later ones sit
        // inside the roll rather than at its start.
        const rampedCreditsStartSec =
            rampCandidates.find((t) => t >= runStartSec! && t <= runEndSec!) ?? null;

        // Guards the segment ACTUALLY returned. Checking the raw backward-walk
        // run instead let a long dim run carry a terminal plate that starts only
        // TERMINAL_BLACK_RUN_SECONDS (12s) before EOF past a 15s minimum.
        const withinMinimum = (start: number): boolean => durationSec - start >= minCreditsDuration;

        if (hasBrandedTail) {
            if (
                rampedCreditsStartSec !== null &&
                rampedCreditsStartSec - searchStart <= edgeMarginSec
            ) {
                return { kind: 'abstain', reason: 'window-edge-truncated' };
            }
            if (
                rampedCreditsStartSec !== null &&
                rampedCreditsStartSec - searchStart > edgeMarginSec &&
                withinMinimum(rampedCreditsStartSec)
            ) {
                return {
                    kind: 'segment',
                    segment: {
                        type: 'Outro',
                        startTime: rampedCreditsStartSec,
                        endTime: durationSec,
                        method: 'blackframe',
                        confidence: 0.35,
                    },
                };
            }
            return null;
        }
        // A high-black transition is only meaningful when it belongs to the
        // terminal dark run we selected above. An older title card must not
        // move a later credits boundary backward, and it cannot excuse a run
        // that reached the search-window edge.
        const terminalHighBlackStart =
            terminalBlackStartSec !== null &&
            terminalBlackStartSec >= runStartSec &&
            terminalBlackStartSec <= runEndSec
                ? terminalBlackStartSec
                : null;
        const startTime = terminalHighBlackStart ?? runStartSec;
        if (runStartSec - searchStart <= edgeMarginSec) {
            // The run reached the window edge, so `runStartSec` is a truncation
            // and must never be reported (the Drifting Clouds S03E12 bug). But a
            // TERMINAL high-black transition inside that run is independent
            // evidence: it is a sustained >=98% plate that begins somewhere the
            // walk actually observed, not where the budget ran out.
            //
            // This matters on letterboxed masters. On a 2160p disc the black
            // bars alone floor pblack near 63% across ordinary content, so
            // `blackframe=amount=50` calls the entire episode dark, the backward
            // walk never finds a boundary, and it always reaches the edge —
            // abstaining on files whose credits are perfectly detectable.
            //
            // Requiring the transition to clear the edge margin too keeps the
            // original guarantee: a dark region whose start is unknown is still
            // an abstention. A scene that is merely dark (Drifting Clouds measures
            // pblack 51-69) never produces one of these at all.
            if (
                terminalHighBlackStart !== null &&
                terminalHighBlackStart - searchStart > edgeMarginSec &&
                withinMinimum(terminalHighBlackStart)
            ) {
                return {
                    kind: 'segment',
                    segment: {
                        type: 'Outro',
                        startTime: terminalHighBlackStart,
                        endTime: durationSec,
                        method: 'blackframe',
                        confidence: 0.35,
                    },
                };
            }
            return { kind: 'abstain', reason: 'window-edge-truncated' };
        }
        if (!withinMinimum(startTime)) return null;
        return {
            kind: 'segment',
            segment: {
                type: 'Outro',
                startTime,
                endTime: durationSec,
                method: 'blackframe',
                // Lowest-ranked evidence by design. A luma heuristic cannot
                // distinguish a credit roll from a dark scene; it only earns a
                // say when nothing better exists.
                confidence: 0.35,
            },
        };
    };

    // Start at the final REAL bucket. Scanning from `durationSec` creates a
    // synthetic bucket outside the ffmpeg interval because frames at searchEnd
    // are excluded above.
    for (let bucketIdx = bucketCount - 1; bucketIdx >= 0; bucketIdx--) {
        const scanTime = searchStart + bucketIdx * precision;
        const bucketDuration = Math.min(precision, searchEnd - scanTime);
        const requiredBlackFrames = Math.ceil(bucketDuration * BLACKFRAME_SAMPLE_FPS * 0.5);

        if ((blackFrameCounts.get(bucketIdx) ?? 0) >= requiredBlackFrames) {
            if (runEndSec === null) {
                runEndSec = Math.min(searchEnd, scanTime + precision);
            }
            runStartSec = scanTime;
            gapCount = 0;
        } else if (runStartSec === null) {
            terminalGapCount++;
            if (terminalGapCount > maxGapBuckets) {
                // Blackframe is tail evidence. Once the bright EOF tail exceeds
                // the same tolerance used for internal gaps, an older dark scene
                // cannot be stretched forward and called credits.
                if (terminalGapCount * precision > MAX_BRANDED_TAIL_SECONDS) {
                    return { kind: 'abstain', reason: 'no-detection' };
                }
                hasBrandedTail = true;
            }
        } else if (runStartSec !== null) {
            gapCount++;
            if (gapCount > maxGapBuckets) {
                // A gap wider than the bridge tolerance is a genuine boundary,
                // so a run banked here is bounded on both sides and trustworthy.
                const result = finalizeRunIfLongEnough();
                if (result) return result;
                // The only run connected to EOF was too short to be credits.
                // Searching past this real bright boundary would let an older
                // dark scene inherit EOF as its end and recreate the false
                // positive this detector is designed to avoid.
                return { kind: 'abstain', reason: 'no-detection' };
            }
        }
    }

    // Falling out of the loop means the walk was cut off by the window rather
    // than by a boundary — finalizeRunIfLongEnough turns that into an abstain.
    return finalizeRunIfLongEnough() ?? { kind: 'abstain', reason: 'no-detection' };
}
