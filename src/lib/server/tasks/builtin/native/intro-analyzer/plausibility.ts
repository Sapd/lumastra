// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { DetectedSegment } from './types.js';

/**
 * The orchestration-layer plausibility gate.
 *
 * Every detector's output passes through here before anything is persisted, so
 * a detector added later inherits the invariants for free instead of
 * re-deriving them. The motivating failure: blackframe walked backwards from
 * EOF through five minutes of night footage, ran out of search window, and
 * reported the window edge (200 s of "credits") as a detection. No detector-local
 * check catches that class, because from inside the detector the answer looks
 * like any other run of black buckets.
 *
 * The gate judges only what is *plausible*, never what is *correct* — it cannot
 * tell a good boundary from a boundary that is 3 s off. Its whole job is to drop
 * answers that no real episode could produce.
 */

export interface PlausibilityConfig {
    /** Shortest segment worth storing at all (existing setting). */
    minSegmentDuration: number;
    /** Longest plausible Intro (existing setting). */
    maxIntroDuration: number;
    /** An Intro must be over by this offset (existing setting). */
    introWindowMaxSec: number;
    /**
     * Longest plausible closing-credits run for an *episode*. Deliberately
     * distinct from `maxCreditsDuration`, which sizes the blackframe/chromaprint
     * *search window*: widening how far a detector looks must never widen what
     * answer is accepted.
     */
    maxPlausibleCreditsDuration: number;
    /** Same, for movies — a feature credit roll is legitimately many minutes. */
    maxPlausibleMovieCreditsDuration: number;
    /**
     * Smallest `start / duration` at which a segment may still be read as
     * closing credits, for episodes. See OUTRO CAP below — this is not an
     * independent knob, it is the term that usually binds.
     */
    outroMinStartFraction: number;
}

export interface PlausibilityContext {
    /** File duration in seconds — the same clock every detector works in. */
    durationSeconds: number;
    /** Movies get the wider credits bound and no start-fraction constraint. */
    isMovie: boolean;
}

export interface PlausibilityRejection {
    ok: false;
    /** Stable kebab-case rule id — safe to grep for and to aggregate on. */
    rule: string;
    /** Human-readable numbers behind the rejection, for the caller's log line. */
    detail: string;
}

export type PlausibilityVerdict = { ok: true } | PlausibilityRejection;

/**
 * Rules that impeach the FILE rather than one candidate.
 *
 * A structural rejection says the segment cannot describe a real region of a
 * real file — the runtime is unknown, the bounds are not finite, the segment
 * ends past the end. Nothing about that is specific to the detector that
 * produced it, so every other candidate for the same item is equally suspect
 * and the resolver is right to drop the whole type.
 *
 * Everything NOT listed here is POLICY: a heuristic about what a plausible
 * intro or credit roll looks like. Those bounds are operator-tunable and known
 * to be wrong on real content — which is exactly why `manual` is exempt from
 * them (see checkPlausibility). A policy rejection impeaches ONE witness, so
 * the resolver may fall back to the next candidate instead of abstaining.
 */
export const STRUCTURAL_RULES: ReadonlySet<string> = new Set([
    'unknown-duration',
    'non-finite-bounds',
    'negative-start',
    'non-positive-duration',
    'end-past-duration',
]);

export function isStructuralRejection(verdict: PlausibilityRejection): boolean {
    return STRUCTURAL_RULES.has(verdict.rule);
}

/**
 * `media_segments.start_time` / `end_time` are `real` (float32). A boundary
 * that was exactly the file duration when computed can come back a few hundred
 * microseconds past it, and ffprobe's container duration disagrees with the
 * last decodable frame anyway. Half a second of slack absorbs both without
 * being large enough to let a genuinely overlong segment through.
 */
export const DURATION_EPSILON_SEC = 0.5;

function fmtSec(value: number): string {
    return `${Math.round(value * 1000) / 1000}s`;
}

/**
 * Judge one detected segment against the file it came from.
 *
 * OUTRO CAP — why it is one derived number and not two settings.
 *
 * `start / duration >= outroMinStartFraction` and "credits are at most N
 * seconds" are the *same constraint expressed twice*. For a tail-anchored
 * segment (`end == duration`, which is what every credits detector produces)
 * requiring the start past 80 % of runtime is exactly a 20 %-of-runtime length
 * cap: a 22-minute episode binds at 264 s, so a `maxPlausibleCreditsDuration`
 * of 300 is unreachable there and an operator raising it would see no effect.
 * Left as two independent checks the pair fights silently — one rejects, the
 * other is dead config.
 *
 * So the position rule is folded into the length rule algebraically:
 *
 *     start >= f * duration   <=>   (end - start) <= end - f * duration
 *
 * and the effective cap becomes `min(maxPlausibleCreditsDuration,
 * end - f * duration)`. The rewrite is exact rather than an approximation, and
 * it keeps working for a segment that does not end at EOF: a 264 s "Outro" at
 * 100 s into a 1320 s episode yields a negative cap and is rejected, where a
 * bare 20 %-of-runtime cap would have waved it through.
 *
 * Movies are exempt from the fraction term entirely — a ten-minute credit roll
 * is normal and the start fraction of a short film's credits can sit well below
 * 0.80 — so they get `maxPlausibleMovieCreditsDuration` flat.
 */
export function checkPlausibility(
    segment: DetectedSegment,
    ctx: PlausibilityContext,
    config: PlausibilityConfig,
): PlausibilityVerdict {
    const { durationSeconds } = ctx;
    const { startTime, endTime } = segment;

    // Without a trustworthy runtime there is nothing to be plausible *against*:
    // every bound below is relative to it. Refusing to vouch is the honest
    // answer, and detectors already require a duration to run at all.
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
        return {
            ok: false,
            rule: 'unknown-duration',
            detail: `file duration ${String(durationSeconds)} is not a usable runtime`,
        };
    }

    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
        return {
            ok: false,
            rule: 'non-finite-bounds',
            detail: `start=${String(startTime)} end=${String(endTime)}`,
        };
    }

    if (startTime < 0) {
        return {
            ok: false,
            rule: 'negative-start',
            detail: `start ${fmtSec(startTime)} is before the file begins`,
        };
    }

    // Covers inverted and zero-length in one rule: both mean the detector did
    // not actually bound a region.
    if (endTime <= startTime) {
        return {
            ok: false,
            rule: 'non-positive-duration',
            detail: `start ${fmtSec(startTime)} >= end ${fmtSec(endTime)}`,
        };
    }

    if (endTime > durationSeconds + DURATION_EPSILON_SEC) {
        return {
            ok: false,
            rule: 'end-past-duration',
            detail: `end ${fmtSec(endTime)} exceeds duration ${fmtSec(durationSeconds)} by more than ${fmtSec(DURATION_EPSILON_SEC)}`,
        };
    }

    // Everything above is STRUCTURAL: the segment must describe a real region of
    // a real file, and no evidence of any kind is exempt from that. Everything
    // below is POLICY — heuristics about what a plausible intro or credit roll
    // looks like, which exist to stop a DETECTOR from emitting garbage.
    //
    // A human is not a detector. The policy bounds are exactly what an operator
    // reaches for the override to overrule: a genuinely long finale credit roll,
    // or a short cold-open intro, is precisely the case the automatic bounds get
    // wrong. Applying them to `manual` would make the override silently useless
    // in the situations it exists for.
    if (segment.method === 'manual') return { ok: true };

    const segmentDuration = endTime - startTime;
    if (segmentDuration < config.minSegmentDuration) {
        return {
            ok: false,
            rule: 'below-min-duration',
            detail: `${fmtSec(segmentDuration)} < minSegmentDuration ${fmtSec(config.minSegmentDuration)}`,
        };
    }

    if (segment.type === 'Outro') {
        const positionCap = endTime - config.outroMinStartFraction * durationSeconds;
        const effectiveMax = ctx.isMovie
            ? config.maxPlausibleMovieCreditsDuration
            : Math.min(config.maxPlausibleCreditsDuration, positionCap);

        if (segmentDuration > effectiveMax) {
            const bound = ctx.isMovie
                ? `maxPlausibleMovieCreditsDuration ${fmtSec(config.maxPlausibleMovieCreditsDuration)}`
                : positionCap < config.maxPlausibleCreditsDuration
                  ? `start fraction ${config.outroMinStartFraction} of ${fmtSec(durationSeconds)}`
                  : `maxPlausibleCreditsDuration ${fmtSec(config.maxPlausibleCreditsDuration)}`;
            return {
                ok: false,
                rule: 'outro-too-long',
                detail: `Outro ${fmtSec(segmentDuration)} exceeds effective cap ${fmtSec(effectiveMax)} (bound by ${bound})`,
            };
        }
    }

    if (segment.type === 'Intro') {
        if (endTime > config.introWindowMaxSec) {
            return {
                ok: false,
                rule: 'intro-outside-window',
                detail: `Intro ends at ${fmtSec(endTime)}, past introWindowMaxSec ${fmtSec(config.introWindowMaxSec)}`,
            };
        }
        if (segmentDuration > config.maxIntroDuration) {
            return {
                ok: false,
                rule: 'intro-too-long',
                detail: `Intro ${fmtSec(segmentDuration)} exceeds maxIntroDuration ${fmtSec(config.maxIntroDuration)}`,
            };
        }
    }

    // Recap / Preview / Commercial intentionally stop at the generic bounds.
    // There is no evidence in the corpus for a tighter length or position rule
    // on them, and a cap invented here would abstain on real segments.
    return { ok: true };
}

/**
 * Keep only the plausible segments, reporting every drop.
 *
 * `onReject` is how the caller gets its `logger.warn` naming the rule — a
 * silently discarded detection is indistinguishable from a detector that never
 * fired, which is exactly how the 26 % Outro anomaly went unnoticed for months.
 */
export function filterPlausible(
    segments: DetectedSegment[],
    ctx: PlausibilityContext,
    config: PlausibilityConfig,
    onReject?: (segment: DetectedSegment, verdict: PlausibilityRejection) => void,
): DetectedSegment[] {
    const kept: DetectedSegment[] = [];
    for (const segment of segments) {
        const verdict = checkPlausibility(segment, ctx, config);
        if (verdict.ok) {
            kept.push(segment);
        } else {
            onReject?.(segment, verdict);
        }
    }
    return kept;
}
