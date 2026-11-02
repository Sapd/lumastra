// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for ContentAffinityService — pure decision logic only.
 */

import { describe, it, expect } from 'vitest';
import { computeClusterAffinity } from './content-affinity.service';

describe('computeClusterAffinity', () => {
    describe('kids', () => {
        it('returns false when totalCount is 0', () => {
            expect(
                computeClusterAffinity({ kidsCount: 0, animeCount: 0, totalCount: 0 }).kids,
            ).toBe(false);
        });

        it('returns false when kidsCount is below the minimum count threshold', () => {
            // 1/2 = 0.5 ratio (well above 0.15) but kidsCount < 2
            expect(
                computeClusterAffinity({ kidsCount: 1, animeCount: 0, totalCount: 2 }).kids,
            ).toBe(false);
        });

        it('returns false when ratio is below the minimum ratio threshold', () => {
            // kidsCount >= 2, but 2/20 = 0.10 < 0.15
            expect(
                computeClusterAffinity({ kidsCount: 2, animeCount: 0, totalCount: 20 }).kids,
            ).toBe(false);
        });

        it('returns true exactly at both thresholds', () => {
            // kidsCount = 3 (>= MIN_KIDS_COUNT), 3/20 = 0.15 (== MIN_KIDS_RATIO)
            expect(
                computeClusterAffinity({ kidsCount: 3, animeCount: 0, totalCount: 20 }).kids,
            ).toBe(true);
        });

        it('returns true when comfortably above both thresholds', () => {
            expect(
                computeClusterAffinity({ kidsCount: 5, animeCount: 0, totalCount: 10 }).kids,
            ).toBe(true);
        });

        it('returns false when kidsCount equals totalCount but below the count minimum', () => {
            expect(
                computeClusterAffinity({ kidsCount: 1, animeCount: 0, totalCount: 1 }).kids,
            ).toBe(false);
        });

        it('returns true when kidsCount equals totalCount and above the count minimum', () => {
            expect(
                computeClusterAffinity({ kidsCount: 2, animeCount: 0, totalCount: 2 }).kids,
            ).toBe(true);
        });
    });

    describe('anime', () => {
        it('returns false when animeCount is 0', () => {
            expect(
                computeClusterAffinity({ kidsCount: 0, animeCount: 0, totalCount: 0 }).anime,
            ).toBe(false);
        });

        it('returns false when animeCount is below the minimum count threshold', () => {
            expect(
                computeClusterAffinity({ kidsCount: 0, animeCount: 1, totalCount: 50 }).anime,
            ).toBe(false);
        });

        it('returns true at exactly the minimum count threshold, regardless of ratio', () => {
            // 2/100 = 0.02 — would fail the kids-style ratio gate, but anime has none.
            expect(
                computeClusterAffinity({ kidsCount: 0, animeCount: 2, totalCount: 100 }).anime,
            ).toBe(true);
        });

        it('returns true when comfortably above the count minimum', () => {
            expect(
                computeClusterAffinity({ kidsCount: 0, animeCount: 10, totalCount: 10 }).anime,
            ).toBe(true);
        });
    });
});
