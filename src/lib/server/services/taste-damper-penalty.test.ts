// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the shared computeDamperPenalty helper — the per-candidate
 * mean-centered MAX-pool used by every JS scoring path (For-You keyword rows
 * and the AI-suggestion engine that powers the home hero).
 */

import { describe, it, expect } from 'vitest';
import { computeDamperPenalty, type DamperContext } from './taste-damper.service.js';

function ctx(
    dampers: Array<{ vec: number[]; weight: number }>,
    mean: number[] | null = null,
): DamperContext {
    return { dampers, mean, hash: 'h' };
}

describe('computeDamperPenalty', () => {
    it('returns 0 for no damper / null / empty embedding', () => {
        expect(computeDamperPenalty(null, [1, 0, 0])).toBe(0);
        expect(computeDamperPenalty(ctx([]), [1, 0, 0])).toBe(0);
        expect(computeDamperPenalty(ctx([{ vec: [1, 0, 0], weight: 1 }]), null)).toBe(0);
        expect(computeDamperPenalty(ctx([{ vec: [1, 0, 0], weight: 1 }]), [])).toBe(0);
    });

    it('max-pool: high for an aligned item, ~0 for an orthogonal one', () => {
        const c = ctx([
            { vec: [1, 0, 0], weight: 1 },
            { vec: [0, 1, 0], weight: 1 },
        ]);
        expect(computeDamperPenalty(c, [1, 0, 0])).toBeCloseTo(1, 5);
        expect(computeDamperPenalty(c, [0, 1, 0])).toBeCloseTo(1, 5); // multi-modal: both
        expect(computeDamperPenalty(c, [0, 0, 1])).toBeLessThan(0.01);
    });

    it('decayed weight scales the penalty', () => {
        const c = ctx([{ vec: [1, 0, 0], weight: 0.5 }]);
        expect(computeDamperPenalty(c, [1, 0, 0])).toBeCloseTo(0.5, 5);
    });

    it('parses a pgvector-text embedding', () => {
        const c = ctx([{ vec: [1, 0, 0], weight: 1 }]);
        expect(computeDamperPenalty(c, '[1,0,0]')).toBeCloseTo(1, 5);
    });

    it('never penalizes below zero (clamps negative cosine)', () => {
        const c = ctx([{ vec: [1, 0, 0], weight: 1 }]);
        expect(computeDamperPenalty(c, [-1, 0, 0])).toBe(0);
    });

    it('computes a TRUE cosine of mean-centered vectors (not a bare dot product)', () => {
        // Non-unit, mean-centered operands: a bare dot product (the old bug)
        // would return < 1 here; true cosine returns 1.
        const mean = [0.5, 0.5, 0];
        // Damper vec follows the context-build contract: unit-normalized centered
        // vector. For item [1,0,0]: ([1,0,0]-mean)=[0.5,-0.5,0] → normalized.
        const dvec = [Math.SQRT1_2, -Math.SQRT1_2, 0];
        const c = ctx([{ vec: dvec, weight: 1 }], mean);
        // Item identical to the damper's source → cosine 1 (bare dot would be ~0.707).
        expect(computeDamperPenalty(c, [1, 0, 0])).toBeCloseTo(1, 5);
        // Item whose centered vector ([0,0,1]) is orthogonal to dvec → 0.
        expect(computeDamperPenalty(c, [0.5, 0.5, 1])).toBeCloseTo(0, 5);
    });

    it('dimension mismatch with the mean falls back to raw cosine (no NaN)', () => {
        const c = ctx([{ vec: [1, 0, 0], weight: 1 }], [0.1, 0.1]); // mean shorter than item
        const p = computeDamperPenalty(c, [1, 0, 0]);
        expect(Number.isFinite(p)).toBe(true);
        expect(p).toBeGreaterThan(0);
    });
});
