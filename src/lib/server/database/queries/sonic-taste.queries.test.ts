// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the Rocchio sonic taste profile logic.
 *
 * Tests are fully isolated (no database, no real sql).
 * They exercise the math exported from sonic-taste.queries.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

// ---------------------------------------------------------------------------
// Import the pure math helpers we want to verify directly.
// ---------------------------------------------------------------------------
import {
    parseEmbeddingText,
    computeWeightedCentroid,
    dotProduct,
    ROCCHIO_BETA,
    LOVED_WEIGHT,
    PLAY_CAP,
    DECAY_HALF_LIFE,
    NEG_DECAY_HALF_LIFE,
    NEG_CENTROID_THRESHOLD,
} from './sonic-taste.queries.js';

// Also import the full public API so we can test cold-start via mocking.
// We do NOT use vi.mock at module level; instead each test that needs a fake
// SQL calls computeSonicTasteVector with a hand-rolled mock sql.
import { computeSonicTasteVector, getSonicTastePicks } from './sonic-taste.queries.js';
// Imported statically, NOT with `await import()` inside the test body. Vitest bills
// module transform to whichever test triggers it, and this module pulls a large
// graph — measured at ~10s of a 30s budget on a cold cache, which tips over the
// timeout once the full suite is transforming in parallel. That produced a test
// that passed alone and failed in CI. At file scope the cost lands on file load
// instead, where it is not charged to any single test. Safe to hoist: the module
// has no import-time side effects (its cache handles are all acquired inside
// functions).
import { getScaledBucketTargets } from '../../services/music/quick-picks.service.js';
import { denyAllAccess, unrestrictedAccess } from './builders/media-access-boundary.js';

// ---------------------------------------------------------------------------
// Helper factories
// ---------------------------------------------------------------------------

/** Build a normalised 3-dim test vector. */
function vec3(x: number, y: number, z: number): number[] {
    const mag = Math.sqrt(x * x + y * y + z * z);
    return mag === 0 ? [0, 0, 0] : [x / mag, y / mag, z / mag];
}

/** Serialise a vector to pgvector text format. */
function toVecText(v: number[]): string {
    return `[${v.join(',')}]`;
}

// ---------------------------------------------------------------------------
// parseEmbeddingText
// ---------------------------------------------------------------------------

describe('parseEmbeddingText', () => {
    it('parses a 3-dim pgvector text to number array', () => {
        expect(parseEmbeddingText('[1.0,2.0,3.0]')).toEqual([1.0, 2.0, 3.0]);
    });

    it('handles negative values', () => {
        expect(parseEmbeddingText('[-0.5,0.25,-0.125]')).toEqual([-0.5, 0.25, -0.125]);
    });

    it('handles scientific notation values', () => {
        // Number() parses 1e-10 correctly
        const result = parseEmbeddingText('[1e-10,2e-10]');
        expect(result[0]).toBeCloseTo(1e-10, 20);
    });

    it('round-trips a serialised vector', () => {
        const original = [0.1, -0.2, 0.3, 0.4];
        const text = toVecText(original);
        const parsed = parseEmbeddingText(text);
        for (let i = 0; i < original.length; i++) {
            expect(parsed[i]).toBeCloseTo(original[i], 10);
        }
    });
});

// ---------------------------------------------------------------------------
// computeWeightedCentroid
// ---------------------------------------------------------------------------

describe('computeWeightedCentroid', () => {
    it('returns null for empty input', () => {
        expect(computeWeightedCentroid([])).toBeNull();
    });

    it('returns null when all weights are zero', () => {
        expect(
            computeWeightedCentroid([
                { embedding: [1, 0, 0], weight: 0 },
                { embedding: [0, 1, 0], weight: 0 },
            ]),
        ).toBeNull();
    });

    it('returns the single embedding when there is one item (weight 1)', () => {
        const emb = [0.6, 0.8, 0.0];
        const result = computeWeightedCentroid([{ embedding: emb, weight: 1 }]);
        expect(result).not.toBeNull();
        result!.forEach((v, i) => expect(v).toBeCloseTo(emb[i], 10));
    });

    it('computes unweighted mean for equal weights', () => {
        const result = computeWeightedCentroid([
            { embedding: [1, 0], weight: 1 },
            { embedding: [0, 1], weight: 1 },
        ]);
        expect(result).not.toBeNull();
        expect(result![0]).toBeCloseTo(0.5, 10);
        expect(result![1]).toBeCloseTo(0.5, 10);
    });

    it('applies higher weight correctly', () => {
        // weight=3 on [1,0,0] vs weight=1 on [0,1,0]
        // centroid = (3*[1,0,0] + 1*[0,1,0]) / 4 = [0.75, 0.25, 0.0]
        const result = computeWeightedCentroid([
            { embedding: [1, 0, 0], weight: 3 },
            { embedding: [0, 1, 0], weight: 1 },
        ]);
        expect(result).not.toBeNull();
        expect(result![0]).toBeCloseTo(0.75, 10);
        expect(result![1]).toBeCloseTo(0.25, 10);
        expect(result![2]).toBeCloseTo(0.0, 10);
    });

    it('loved tracks with LOVED_WEIGHT pull the centroid harder', () => {
        // Simulates the real Rocchio: loved [1,0] at weight 3, played [0,1] at weight 1
        const result = computeWeightedCentroid([
            { embedding: [1, 0], weight: LOVED_WEIGHT }, // loved
            { embedding: [0, 1], weight: 1 }, // played
        ]);
        expect(result).not.toBeNull();
        // Loved dimension (0) should be > played dimension (1)
        expect(result![0]).toBeGreaterThan(result![1]);
        expect(result![0]).toBeCloseTo(LOVED_WEIGHT / (LOVED_WEIGHT + 1), 10);
    });
});

// ---------------------------------------------------------------------------
// dotProduct
// ---------------------------------------------------------------------------

describe('dotProduct', () => {
    it('returns 1 for identical unit vectors', () => {
        const v = vec3(1, 0, 0);
        expect(dotProduct(v, v)).toBeCloseTo(1, 10);
    });

    it('returns 0 for orthogonal vectors', () => {
        const a = vec3(1, 0, 0);
        const b = vec3(0, 1, 0);
        expect(dotProduct(a, b)).toBeCloseTo(0, 10);
    });

    it('returns -1 for opposing unit vectors', () => {
        const a = vec3(1, 0, 0);
        const b = vec3(-1, 0, 0);
        expect(dotProduct(a, b)).toBeCloseTo(-1, 10);
    });

    it('handles mismatched lengths by truncating to shorter', () => {
        expect(dotProduct([1, 0, 0], [1, 0])).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// Rocchio math / constants sanity checks
// ---------------------------------------------------------------------------

describe('Rocchio constants', () => {
    it('ROCCHIO_BETA is between 0 and 1', () => {
        expect(ROCCHIO_BETA).toBeGreaterThan(0);
        expect(ROCCHIO_BETA).toBeLessThan(1);
    });

    it('LOVED_WEIGHT is > 1 (loved tracks pull harder than plays)', () => {
        expect(LOVED_WEIGHT).toBeGreaterThan(1);
    });

    it('PLAY_CAP is a positive integer', () => {
        expect(PLAY_CAP).toBeGreaterThan(0);
        expect(Number.isInteger(PLAY_CAP)).toBe(true);
    });

    it('DECAY_HALF_LIFE is positive', () => {
        expect(DECAY_HALF_LIFE).toBeGreaterThan(0);
    });

    it('NEG_CENTROID_THRESHOLD is between 0.5 and 1', () => {
        expect(NEG_CENTROID_THRESHOLD).toBeGreaterThan(0.5);
        expect(NEG_CENTROID_THRESHOLD).toBeLessThanOrEqual(1.0);
    });

    it('exp-decay at rank 0 is 1.0', () => {
        const weight = Math.exp(-0 * (Math.LN2 / DECAY_HALF_LIFE));
        expect(weight).toBeCloseTo(1.0, 10);
    });

    it('exp-decay at rank DECAY_HALF_LIFE is ≈ 0.5', () => {
        const weight = Math.exp(-DECAY_HALF_LIFE * (Math.LN2 / DECAY_HALF_LIFE));
        expect(weight).toBeCloseTo(0.5, 5);
    });

    it('NEG_DECAY_HALF_LIFE is positive', () => {
        expect(NEG_DECAY_HALF_LIFE).toBeGreaterThan(0);
    });

    it('negative exp-decay at rank NEG_DECAY_HALF_LIFE is ≈ 0.5', () => {
        const weight = Math.exp(-NEG_DECAY_HALF_LIFE * (Math.LN2 / NEG_DECAY_HALF_LIFE));
        expect(weight).toBeCloseTo(0.5, 5);
    });
});

// ---------------------------------------------------------------------------
// Negative-arm recency decay: stale negatives must steer LESS than fresh ones
// ---------------------------------------------------------------------------

describe('negative-arm recency decay', () => {
    /** Reproduce the rank-decay weighting the negative arm applies. */
    function negWeight(rank: number): number {
        return Math.exp(-rank * (Math.LN2 / NEG_DECAY_HALF_LIFE));
    }

    it('rank-0 (most recent) negative has full weight, later ranks fade monotonically', () => {
        expect(negWeight(0)).toBeCloseTo(1.0, 10);
        expect(negWeight(1)).toBeLessThan(negWeight(0));
        expect(negWeight(30)).toBeLessThan(negWeight(10));
        expect(negWeight(30)).toBeGreaterThan(0); // never fully zero
    });

    it('a fresh negative dominates the decayed negative centroid over a stale one', () => {
        // Two opposing negatives: fresh at rank 0 ([1,0]), stale far down ([0,1]).
        // The decayed centroid must lean toward the FRESH negative's direction.
        const fresh = { embedding: [1, 0], weight: negWeight(0) };
        const stale = { embedding: [0, 1], weight: negWeight(40) };
        const centroid = computeWeightedCentroid([fresh, stale])!;
        expect(centroid).not.toBeNull();
        // dim-0 (fresh) component must exceed dim-1 (stale) component.
        expect(centroid[0]).toBeGreaterThan(centroid[1]);
    });
});

// ---------------------------------------------------------------------------
// computeSonicTasteVector — cold start
// ---------------------------------------------------------------------------

describe('computeSonicTasteVector cold-start', () => {
    it('returns null when there are no loved tracks and no play history with embeddings', async () => {
        // sql that always returns empty arrays
        let callCount = 0;
        const sql = vi.fn((..._args: unknown[]) => {
            callCount++;
            return Promise.resolve([]);
        }) as unknown as postgres.Sql;

        const result = await computeSonicTasteVector(sql as never, 'user-1' as UserId);
        expect(result).toBeNull();
        expect(callCount).toBeGreaterThan(0); // sql was actually called
    });

    it('returns null when there are loved tracks but none have embeddings', async () => {
        // First call (loved embeddings arm): empty
        // Second call (loved IDs for exclusion): empty
        // Third call (played arm): empty
        const sql = vi.fn(() => Promise.resolve([])) as unknown as postgres.Sql;

        const result = await computeSonicTasteVector(sql as never, 'user-cold' as UserId);
        expect(result).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Rocchio normalisation: the taste vector should be a unit vector
// ---------------------------------------------------------------------------

describe('Rocchio vector normalisation', () => {
    it('output of normalizeVector (from embedding-utils) is unit length', async () => {
        const { normalizeVector } = await import('$lib/server/utils/embedding-utils.js');
        const raw = [3, 4, 0]; // magnitude = 5
        const normed = normalizeVector(raw);
        const mag = Math.sqrt(normed.reduce((s, v) => s + v * v, 0));
        expect(mag).toBeCloseTo(1.0, 10);
    });

    it('subtracting beta * normalised negative from positive and renormalising is still unit', async () => {
        const { normalizeVector, subtractVectors } =
            await import('$lib/server/utils/embedding-utils.js');
        const posNorm = normalizeVector([1, 0, 0]);
        const negNorm = normalizeVector([0, 1, 0]);
        const rocchio = subtractVectors(posNorm, negNorm, ROCCHIO_BETA);
        const final = normalizeVector(rocchio);
        const mag = Math.sqrt(final.reduce((s, v) => s + v * v, 0));
        expect(mag).toBeCloseTo(1.0, 8);
    });

    it('rocchio taste moves towards positive and away from negative', async () => {
        const { normalizeVector, subtractVectors } =
            await import('$lib/server/utils/embedding-utils.js');
        // pos = [1, 0, 0], neg = [0, 1, 0]
        const pos = normalizeVector([1, 0, 0]);
        const neg = normalizeVector([0, 1, 0]);
        const rocchio = normalizeVector(subtractVectors(pos, neg, ROCCHIO_BETA));

        // taste should have a larger component on dim-0 (towards pos) and
        // a negative or zero component on dim-1 (away from neg)
        expect(rocchio[0]).toBeGreaterThan(0.5); // definitely biased toward pos
        expect(rocchio[1]).toBeLessThan(0); // negative centroid pushes dim-1 negative
    });
});

// ---------------------------------------------------------------------------
// getSonicTastePicks — cold start returns empty
// ---------------------------------------------------------------------------

describe('getSonicTastePicks cold-start', () => {
    it('returns empty array when computeSonicTasteVector returns null', async () => {
        // All queries return empty → taste vector = null
        const sql = vi.fn(() => Promise.resolve([])) as unknown as postgres.Sql;

        const result = await getSonicTastePicks(
            sql as never,
            'user-1' as UserId,
            10,
            unrestrictedAccess(),
        );

        expect(result).toEqual([]);
    });

    it('short-circuits a denyAll boundary WITHOUT issuing a single query', async () => {
        // Guard for the DENY-ALL note in the module's access boundary contract:
        // denyAll must return [] before the Rocchio round trips, the negative
        // centroid round trip, and the transaction + ANN scan that could only
        // ever return nothing.
        const sql = vi.fn(() => Promise.resolve([])) as unknown as postgres.Sql;

        const result = await getSonicTastePicks(
            sql as never,
            'user-1' as UserId,
            10,
            denyAllAccess(),
        );

        expect(result).toEqual([]);
        expect(sql).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// getScaledBucketTargets — sonic-taste bucket stays at 0 unless features on
// ---------------------------------------------------------------------------

describe('getScaledBucketTargets — sonic-taste allocation', () => {
    it('sonic-taste gets its additive own-slot allocation and the total is preserved', async () => {
        const targets = getScaledBucketTargets(24);
        // 'sonic-taste' is now ADDITIVE (own slot, base weight 3) — no longer 0.
        expect(targets['sonic-taste']).toBeGreaterThan(0);
        // taste-similar still gets its allocation
        expect(targets['taste-similar']).toBeGreaterThan(0);
        // total should equal the requested target
        const total = Object.values(targets).reduce((s, n) => s + n, 0);
        expect(total).toBe(24);
    });
});
