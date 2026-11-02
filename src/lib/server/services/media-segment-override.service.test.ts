// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    validateOverrideTimes,
    readPlausibilityConfig,
    mergeManualCandidates,
    explainWithheldOverride,
} from './media-segment-override.service.js';
import type { MediaSegmentCandidate } from '$lib/server/database/queries/media-segment-candidates.queries.js';
import type { DetectionMethod } from '$lib/server/tasks/builtin/native/intro-analyzer/types.js';
import { resolveSegments } from '$lib/server/tasks/builtin/native/intro-analyzer/resolve.js';

const DURATION = 2832.672;

function candidate(
    method: DetectionMethod,
    type: MediaSegmentCandidate['type'],
    startTime: number,
    endTime: number,
): MediaSegmentCandidate {
    return {
        type,
        method,
        startTime,
        endTime,
        confidence: 0.5,
        detectorVersion: 3,
        snappedToChapter: false,
    };
}

describe('validateOverrideTimes', () => {
    it('accepts a boundary inside the file', () => {
        expect(validateOverrideTimes(2789.412, DURATION, DURATION)).toBeNull();
    });

    it('rejects a negative start rather than clamping it to zero', () => {
        const rejection = validateOverrideTimes(-1, 60, DURATION);
        expect(rejection?.reason).toBe('negative-start');
    });

    it('rejects a zero-length or inverted range', () => {
        expect(validateOverrideTimes(60, 60, DURATION)?.reason).toBe('non-positive-duration');
        expect(validateOverrideTimes(90, 60, DURATION)?.reason).toBe('non-positive-duration');
    });

    it('rejects an end past the file duration', () => {
        expect(validateOverrideTimes(10, DURATION + 5, DURATION)?.reason).toBe('end-past-duration');
    });

    it('tolerates the float32/container slack the gate allows', () => {
        // `real` columns and ffprobe's container duration disagree by fractions
        // of a second; refusing that would reject correct tail-anchored answers.
        expect(validateOverrideTimes(10, DURATION + 0.4, DURATION)).toBeNull();
    });

    it('rejects non-finite bounds', () => {
        expect(validateOverrideTimes(Number.NaN, 60, DURATION)?.reason).toBe('non-finite-bounds');
    });
});

describe('readPlausibilityConfig', () => {
    it('mirrors the analyzer defaults when nothing is configured', () => {
        expect(readPlausibilityConfig({})).toEqual({
            minSegmentDuration: 15,
            maxIntroDuration: 120,
            introWindowMaxSec: 600,
            maxPlausibleCreditsDuration: 150,
            maxPlausibleMovieCreditsDuration: 900,
            outroMinStartFraction: 0.8,
        });
    });

    it('honours operator settings', () => {
        const config = readPlausibilityConfig({
            maxPlausibleCreditsDuration: 150,
            outroMinStartFraction: 0.7,
        });
        expect(config.maxPlausibleCreditsDuration).toBe(150);
        expect(config.outroMinStartFraction).toBe(0.7);
    });

    it('falls back on out-of-range or malformed values', () => {
        const config = readPlausibilityConfig({
            maxPlausibleCreditsDuration: -5,
            outroMinStartFraction: '0.9',
            minSegmentDuration: Number.NaN,
        });
        expect(config.maxPlausibleCreditsDuration).toBe(150);
        expect(config.outroMinStartFraction).toBe(0.8);
        expect(config.minSegmentDuration).toBe(15);
    });
});

describe('mergeManualCandidates', () => {
    const override = {
        type: 'Outro' as const,
        startTime: 2789.412,
        endTime: DURATION,
        confidence: 1,
    };

    it('keeps a manual candidate of another type', () => {
        // replaceCandidatesForMethod clears the whole method, so setting an
        // Outro must restate the Intro or the operator's other answer is lost.
        const merged = mergeManualCandidates([candidate('manual', 'Intro', 0, 90)], override);
        expect(merged.manual).toHaveLength(2);
        expect(merged.manual.map((c) => c.type).sort()).toEqual(['Intro', 'Outro']);
    });

    it('replaces a manual candidate of the same type', () => {
        const merged = mergeManualCandidates([candidate('manual', 'Outro', 100, 200)], override);
        expect(merged.manual).toHaveLength(1);
        expect(merged.manual[0].startTime).toBe(2789.412);
    });

    it('does not rewrite stale-manual when there is no tombstone for this type', () => {
        const merged = mergeManualCandidates([candidate('stale-manual', 'Intro', 0, 90)], override);
        expect(merged.staleManual).toBeNull();
    });

    it('supersedes a stale-manual tombstone of the same type, sparing other types', () => {
        const merged = mergeManualCandidates(
            [
                candidate('stale-manual', 'Outro', 100, 200),
                candidate('stale-manual', 'Intro', 0, 90),
            ],
            override,
        );
        expect(merged.staleManual).not.toBeNull();
        expect(merged.staleManual?.map((c) => c.type)).toEqual(['Intro']);
    });

    it('ignores detector candidates entirely', () => {
        // Detector evidence lives under its own method and is replaced by the
        // pass that owns it; the override must not touch it.
        const merged = mergeManualCandidates(
            [candidate('blackframe', 'Outro', 2632.672, DURATION)],
            override,
        );
        expect(merged.manual).toEqual([override]);
        expect(merged.staleManual).toBeNull();
    });
});

describe('override resolution', () => {
    const config = readPlausibilityConfig({});
    const ctx = { durationSeconds: DURATION, isMovie: false };

    it('outranks the blackframe row it was written to correct', () => {
        const resolved = resolveSegments(
            [
                {
                    type: 'Outro',
                    method: 'blackframe',
                    startTime: 2632.672,
                    endTime: DURATION,
                },
                { type: 'Outro', method: 'manual', startTime: 2789.412, endTime: DURATION },
            ],
            ctx,
            config,
        );
        expect(resolved).toHaveLength(1);
        expect(resolved[0].method).toBe('manual');
        expect(resolved[0].startTime).toBe(2789.412);
    });

    it('overrules the episode credits cap — that is what an override is for', () => {
        // The 90s cap is a heuristic aimed at detectors. An operator setting a
        // 200s credit roll on a long finale is deliberately overruling it, and
        // withholding their answer would make the feature useless in exactly
        // the case it exists for. Structural checks still apply (see below).
        const override = {
            type: 'Outro' as const,
            method: 'manual' as const,
            startTime: DURATION - 200,
            endTime: DURATION,
        };
        const resolved = resolveSegments([override], ctx, config);
        expect(resolved).toHaveLength(1);
        expect(resolved[0].method).toBe('manual');
    });

    it('still withholds an override that is not a real region of the file', () => {
        const override = {
            type: 'Outro' as const,
            method: 'manual' as const,
            startTime: DURATION + 500,
            endTime: DURATION + 900,
        };
        expect(resolveSegments([override], ctx, config)).toHaveLength(0);
        expect(explainWithheldOverride(override, ctx, config).rule).toBe('end-past-duration');
    });

    it('reports the overlap arbitration when the times themselves are fine', () => {
        // Plausible on its own, so the operator must be told the reason is the
        // OTHER segment, not the numbers they typed.
        const override = {
            type: 'Intro' as const,
            method: 'manual' as const,
            startTime: 10,
            endTime: 90,
        };
        expect(explainWithheldOverride(override, ctx, config).rule).toBe('intro-outro-overlap');
    });

    it('a demoted override never resolves', () => {
        const resolved = resolveSegments(
            [{ type: 'Outro', method: 'stale-manual', startTime: 2789.412, endTime: DURATION }],
            ctx,
            config,
        );
        expect(resolved).toHaveLength(0);
    });
});
