// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/components/player/volume-control.test.ts
import { describe, test, expect } from 'vitest';
import { applyVolumeCurve, inverseVolumeCurve, type VolumeCurve } from './volume-control';

describe('applyVolumeCurve', () => {
    test('linear: passes through unchanged', () => {
        expect(applyVolumeCurve(0, 'linear')).toBe(0);
        expect(applyVolumeCurve(0.5, 'linear')).toBe(0.5);
        expect(applyVolumeCurve(1.0, 'linear')).toBe(1.0);
    });

    test('quadratic: applies x² transformation', () => {
        expect(applyVolumeCurve(0, 'quadratic')).toBe(0);
        expect(applyVolumeCurve(0.5, 'quadratic')).toBe(0.25);
        expect(applyVolumeCurve(0.7, 'quadratic')).toBeCloseTo(0.49);
        expect(applyVolumeCurve(1.0, 'quadratic')).toBe(1.0);
    });

    test('quartic: applies x⁴ transformation', () => {
        expect(applyVolumeCurve(0, 'quartic')).toBe(0);
        expect(applyVolumeCurve(0.5, 'quartic')).toBe(0.0625);
        expect(applyVolumeCurve(0.84, 'quartic')).toBeCloseTo(0.5, 1);
        expect(applyVolumeCurve(1.0, 'quartic')).toBe(1.0);
    });

    test('clamps out-of-range values', () => {
        expect(applyVolumeCurve(-0.1, 'quadratic')).toBe(0);
        expect(applyVolumeCurve(1.5, 'quadratic')).toBe(1);
        expect(applyVolumeCurve(-1, 'quartic')).toBe(0);
        expect(applyVolumeCurve(2, 'quartic')).toBe(1);
    });

    test('defaults to linear for unknown curve', () => {
        // @ts-expect-error - testing runtime behavior with invalid value
        expect(applyVolumeCurve(0.5, 'unknown')).toBe(0.5);
    });
});

describe('inverseVolumeCurve', () => {
    test('linear: passes through unchanged', () => {
        expect(inverseVolumeCurve(0, 'linear')).toBe(0);
        expect(inverseVolumeCurve(0.5, 'linear')).toBe(0.5);
        expect(inverseVolumeCurve(1.0, 'linear')).toBe(1.0);
    });

    test('quadratic: applies √x transformation', () => {
        expect(inverseVolumeCurve(0, 'quadratic')).toBe(0);
        expect(inverseVolumeCurve(0.25, 'quadratic')).toBe(0.5);
        expect(inverseVolumeCurve(0.49, 'quadratic')).toBeCloseTo(0.7);
        expect(inverseVolumeCurve(1.0, 'quadratic')).toBe(1.0);
    });

    test('quartic: applies ⁴√x transformation', () => {
        expect(inverseVolumeCurve(0, 'quartic')).toBe(0);
        expect(inverseVolumeCurve(0.0625, 'quartic')).toBe(0.5);
        expect(inverseVolumeCurve(0.5, 'quartic')).toBeCloseTo(0.84, 1);
        expect(inverseVolumeCurve(1.0, 'quartic')).toBe(1.0);
    });

    test('clamps out-of-range values', () => {
        expect(inverseVolumeCurve(-0.1, 'quadratic')).toBe(0);
        expect(inverseVolumeCurve(1.5, 'quadratic')).toBe(1);
    });

    test('reverses applyVolumeCurve correctly', () => {
        const curves: VolumeCurve[] = ['linear', 'quadratic', 'quartic'];
        const testValues = [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1.0];

        curves.forEach((curve) => {
            testValues.forEach((value) => {
                const transformed = applyVolumeCurve(value, curve);
                const reversed = inverseVolumeCurve(transformed, curve);
                expect(reversed).toBeCloseTo(value, 10);
            });
        });
    });
});
