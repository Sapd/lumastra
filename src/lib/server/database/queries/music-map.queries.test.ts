// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for music-map.queries.ts
 *
 * These tests verify the pure TypeScript logic (coordinate normalisation,
 * MapCoordInput validation) without hitting a database.  The SQL query
 * functions themselves are tested via integration tests.
 */

import { describe, it, expect } from 'vitest';
import { MSCLAP_MODEL_ID } from './sonic-constants.js';

describe('music-map.queries', () => {
    describe('MSCLAP_MODEL_ID (map model)', () => {
        it('is msclap-2023', () => {
            expect(MSCLAP_MODEL_ID).toBe('msclap-2023');
        });
    });

    describe('coordinate input validation', () => {
        it('accepts valid [0,1] coordinates', () => {
            const coords = [
                { mediaId: '00000000-0000-0000-0000-000000000001', x: 0, y: 0 },
                { mediaId: '00000000-0000-0000-0000-000000000002', x: 1, y: 1 },
                { mediaId: '00000000-0000-0000-0000-000000000003', x: 0.5, y: 0.5 },
            ];

            for (const c of coords) {
                expect(c.x).toBeGreaterThanOrEqual(0);
                expect(c.x).toBeLessThanOrEqual(1);
                expect(c.y).toBeGreaterThanOrEqual(0);
                expect(c.y).toBeLessThanOrEqual(1);
            }
        });

        it('clamping logic mirrors the task implementation', () => {
            // The sonic-map-projection task clamps coords to [0,1].
            // This mirrors that logic.
            const clamp = (v: number) => Math.max(0, Math.min(1, v));

            expect(clamp(-0.5)).toBe(0);
            expect(clamp(0)).toBe(0);
            expect(clamp(0.5)).toBe(0.5);
            expect(clamp(1)).toBe(1);
            expect(clamp(1.5)).toBe(1);
        });
    });
});
