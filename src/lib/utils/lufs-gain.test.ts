// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { computeLufsGain, applyLufsGain } from './lufs-gain';

describe('computeLufsGain', () => {
    it('returns 1.0 when track is exactly at target LUFS', () => {
        expect(computeLufsGain(-14)).toBeCloseTo(1.0, 5);
    });

    it('attenuates tracks louder than target', () => {
        // -8 LUFS is 6 dB hotter than -14 → gain = 10^(-6/20) ≈ 0.501
        const gain = computeLufsGain(-8);
        expect(gain).toBeCloseTo(0.501, 2);
        expect(gain).toBeLessThan(1.0);
    });

    it('boosts tracks quieter than target', () => {
        // -20 LUFS is 6 dB quieter than -14 → gain = 10^(6/20) ≈ 1.995
        const gain = computeLufsGain(-20);
        expect(gain).toBeCloseTo(1.995, 2);
        expect(gain).toBeGreaterThan(1.0);
    });

    it('clamps very loud tracks at MIN_LUFS_GAIN (0.25)', () => {
        // -2 LUFS is 12 dB over target → gain = 10^(-12/20) ≈ 0.251, near floor
        expect(computeLufsGain(-2)).toBeCloseTo(0.25, 1);
        // Even louder: clamped to 0.25
        expect(computeLufsGain(0)).toBe(0.25);
        expect(computeLufsGain(6)).toBe(0.25);
    });

    it('clamps very quiet tracks at MAX_LUFS_GAIN (2.0)', () => {
        // -26 LUFS is 12 dB under target → gain = 10^(12/20) ≈ 3.98, capped at 2.0
        expect(computeLufsGain(-26)).toBe(2.0);
        expect(computeLufsGain(-40)).toBe(2.0);
    });

    it('returns 1.0 when loudnessLufs is undefined', () => {
        expect(computeLufsGain(undefined)).toBe(1.0);
    });

    it('accepts custom target LUFS', () => {
        // Track at -16, target -16 → no adjustment
        expect(computeLufsGain(-16, -16)).toBeCloseTo(1.0, 5);
        // Track at -14, target -16 → attenuate by 2 dB
        const gain = computeLufsGain(-14, -16);
        expect(gain).toBeCloseTo(Math.pow(10, -2 / 20), 4);
    });
});

describe('applyLufsGain', () => {
    it('scales user volume by LUFS gain', () => {
        // userVolume=0.8, track at -14 LUFS (no adjustment) → 0.8
        expect(applyLufsGain(0.8, -14)).toBeCloseTo(0.8, 5);
    });

    it('clamps effective volume to [0, 1]', () => {
        // userVolume=0.9, very quiet track → boost would exceed 1.0
        expect(applyLufsGain(0.9, -40)).toBe(1.0);
    });

    it('produces 0 for userVolume=0 regardless of LUFS', () => {
        expect(applyLufsGain(0, -8)).toBe(0);
        expect(applyLufsGain(0, -30)).toBe(0);
    });

    it('returns userVolume unchanged when loudnessLufs is undefined', () => {
        expect(applyLufsGain(0.7, undefined)).toBeCloseTo(0.7, 5);
    });

    it('attenuates user volume for loud tracks', () => {
        // userVolume=0.8, track at -8 LUFS (6 dB hot) → 0.8 * 0.501 ≈ 0.401
        const result = applyLufsGain(0.8, -8);
        expect(result).toBeCloseTo(0.8 * Math.pow(10, (-14 - -8) / 20), 3);
        expect(result).toBeLessThan(0.8);
    });
});
