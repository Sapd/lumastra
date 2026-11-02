// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    computeBlendCompatibility,
    computeEnergyContinuity,
    mixabilityAdjustment,
    type MixabilityWeights,
} from './music-queue-scoring.js';

const DEFAULT_WEIGHTS: MixabilityWeights = { blendWeight: 0.04, energyWeight: 0.04 };

describe('computeBlendCompatibility — M_bpm', () => {
    it('identical BPM scores 1', () => {
        const result = computeBlendCompatibility({ bpm: 120 }, { bpm: 120 });
        expect(result).toBeCloseTo(1, 5);
    });

    it('half/double-time candidates are treated as gap 0 (fully mixable)', () => {
        // 195 vs 97.5 is exactly half-time — a DJ pitches/loops around it.
        const result = computeBlendCompatibility({ bpm: 195 }, { bpm: 97.5 });
        expect(result).toBeCloseTo(1, 5);
    });

    it('a 15% gap scores ~0.7', () => {
        const result = computeBlendCompatibility({ bpm: 100 }, { bpm: 115 });
        expect(result).toBeCloseTo(0.7, 5);
    });

    it('a >=50% gap (no near-multiple) scores 0', () => {
        // 100 -> 300: nearest of {1x, 2x, 0.5x} is 0.5x (150), still a 50% gap.
        const result = computeBlendCompatibility({ bpm: 100 }, { bpm: 300 });
        expect(result).toBeCloseTo(0, 5);
    });

    it('is not computed when current bpm is missing', () => {
        expect(computeBlendCompatibility({}, { bpm: 120 })).toBeNull();
    });

    it('is not computed when candidate bpm is missing', () => {
        expect(computeBlendCompatibility({ bpm: 120 }, {})).toBeNull();
    });

    it('is not computed when current bpm is 0', () => {
        expect(computeBlendCompatibility({ bpm: 0 }, { bpm: 120 })).toBeNull();
    });

    it('is not computed when candidate bpm is 0 (Essentia extraction-failed sentinel)', () => {
        // Without the candidate-side > 0 guard this would score gap=1 → 0,
        // i.e. maximum incompatibility for what is actually missing data.
        expect(computeBlendCompatibility({ bpm: 120 }, { bpm: 0 })).toBeNull();
    });
});

describe('computeBlendCompatibility — M_key', () => {
    it('a harmonically compatible pair contributes 1', () => {
        const result = computeBlendCompatibility({ key: 'C' }, { key: 'G' });
        expect(result).toBeCloseTo(1, 5);
    });

    it('an incompatible pair contributes 0', () => {
        const result = computeBlendCompatibility({ key: 'C' }, { key: 'Db' });
        expect(result).toBeCloseTo(0, 5);
    });

    it('missing key on either side excludes the key component from the mean', () => {
        // Only bpm is computable here — identical bpm, no key on the candidate.
        const result = computeBlendCompatibility({ bpm: 120, key: 'C' }, { bpm: 120 });
        expect(result).toBeCloseTo(1, 5);
    });

    it('averages bpm and key components when both are computable', () => {
        // bpm identical (1.0) + incompatible key (0) => mean 0.5
        const result = computeBlendCompatibility({ bpm: 120, key: 'C' }, { bpm: 120, key: 'Db' });
        expect(result).toBeCloseTo(0.5, 5);
    });
});

describe('computeBlendCompatibility — neither component computable', () => {
    it('returns null when both bpm and key are missing on both sides', () => {
        expect(computeBlendCompatibility({}, {})).toBeNull();
    });
});

describe('computeEnergyContinuity', () => {
    it('returns 1 - |delta| when both sides present', () => {
        expect(computeEnergyContinuity(0.8, 0.8)).toBeCloseTo(1, 5);
        expect(computeEnergyContinuity(0.8, 0.5)).toBeCloseTo(0.7, 5);
        expect(computeEnergyContinuity(0.2, 0.9)).toBeCloseTo(0.3, 5);
    });

    it('returns null when either side is missing', () => {
        expect(computeEnergyContinuity(undefined, 0.5)).toBeNull();
        expect(computeEnergyContinuity(0.5, undefined)).toBeNull();
        expect(computeEnergyContinuity(undefined, undefined)).toBeNull();
    });
});

describe('mixabilityAdjustment — neutrality', () => {
    it('is exactly 0 when both inputs are null (all data missing)', () => {
        expect(mixabilityAdjustment(null, null, DEFAULT_WEIGHTS)).toBe(0);
    });
});

describe('mixabilityAdjustment — centering', () => {
    it('worst case (blend 0, energy 0) scores -(blendWeight + energyWeight)', () => {
        const result = mixabilityAdjustment(0, 0, DEFAULT_WEIGHTS);
        expect(result).toBeCloseTo(
            -(DEFAULT_WEIGHTS.blendWeight + DEFAULT_WEIGHTS.energyWeight),
            10,
        );
    });

    it('perfect case (blend 1, energy 1) scores +(blendWeight + energyWeight)', () => {
        const result = mixabilityAdjustment(1, 1, DEFAULT_WEIGHTS);
        expect(result).toBeCloseTo(DEFAULT_WEIGHTS.blendWeight + DEFAULT_WEIGHTS.energyWeight, 10);
    });
});

describe('mixabilityAdjustment — blendWeight 0 (crossfade=0 hard-cut client)', () => {
    const HARD_CUT_WEIGHTS: MixabilityWeights = { blendWeight: 0, energyWeight: 0.04 };

    it('BPM/key (blend) has zero influence regardless of value', () => {
        expect(mixabilityAdjustment(0, null, HARD_CUT_WEIGHTS)).toBe(0);
        expect(mixabilityAdjustment(1, null, HARD_CUT_WEIGHTS)).toBe(0);
    });

    it('energy continuity still applies', () => {
        const worst = mixabilityAdjustment(0, 0, HARD_CUT_WEIGHTS);
        const best = mixabilityAdjustment(1, 1, HARD_CUT_WEIGHTS);
        expect(worst).toBeCloseTo(-0.04, 10);
        expect(best).toBeCloseTo(0.04, 10);
    });
});

describe('Wellerman regression — similarity decides, mixability only tiebreaks', () => {
    it('a higher-similarity, worst-mixability candidate outscores a lower-similarity, perfect-mixability one', () => {
        // Candidate A: strong CLAP similarity (0.80), worst possible mixability
        // (e.g. a rap track after a sea shanty — no BPM/key/energy alignment).
        const candidateA = { id: 'a', similarity: 0.8, blendCompat: 0, energyContinuity: 0 };
        // Candidate B: weaker similarity (0.55), perfect mixability.
        const candidateB = { id: 'b', similarity: 0.55, blendCompat: 1, energyContinuity: 1 };
        const pool = [candidateA, candidateB];

        const scored = pool.map((c) => ({
            ...c,
            score:
                c.similarity +
                mixabilityAdjustment(c.blendCompat, c.energyContinuity, DEFAULT_WEIGHTS),
        }));

        // Nothing is filtered out — the old hard gate could reject A outright
        // (leaving only B, or an empty pool); the new scoring never drops a
        // candidate, so the pool size is unchanged.
        expect(scored).toHaveLength(pool.length);

        const scoredA = scored.find((c) => c.id === 'a')!;
        const scoredB = scored.find((c) => c.id === 'b')!;
        expect(scoredA.score).toBeGreaterThan(scoredB.score);

        // The adjustment span must stay a small tiebreak relative to the
        // similarity gap between A and B (0.25) — it can nudge ordering
        // among near-equal candidates, never overturn a clear similarity gap.
        const maxAdjustmentSpan = 2 * (DEFAULT_WEIGHTS.blendWeight + DEFAULT_WEIGHTS.energyWeight);
        expect(maxAdjustmentSpan).toBeLessThan(0.2);
    });
});
