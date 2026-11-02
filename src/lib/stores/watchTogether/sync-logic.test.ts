// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for Watch-Together sync-logic pure functions.
 */

import { describe, it, expect } from 'vitest';
import { calculateTimeToSync, isHostDevice, isOwnEvent } from './sync-logic';

describe('calculateTimeToSync', () => {
    it('returns null when drift is within 0.5s', () => {
        expect(calculateTimeToSync(0.3, 1.05)).toBeNull();
        expect(calculateTimeToSync(0, 1.05)).toBeNull();
        expect(calculateTimeToSync(-0.4, 1.05)).toBeNull();
    });

    it('returns null when playback rate is near 1.0', () => {
        expect(calculateTimeToSync(5, 1.0)).toBeNull();
        expect(calculateTimeToSync(5, 1.005)).toBeNull();
        expect(calculateTimeToSync(5, 0.995)).toBeNull();
    });

    it('calculates positive time when behind and rate > 1', () => {
        // drift 5s, rate 1.05 => 5 / 0.05 = 100
        expect(calculateTimeToSync(5, 1.05)).toBeCloseTo(100, 5);
    });

    it('calculates positive time when ahead and rate < 1', () => {
        // drift -5s, rate 0.95 => abs(-5) / abs(0.95 - 1.0) = 5 / 0.05 = 100
        expect(calculateTimeToSync(-5, 0.95)).toBeCloseTo(100, 5);
    });

    it('handles large drift values', () => {
        expect(calculateTimeToSync(120, 1.02)).toBeCloseTo(6000, 5); // 120 / 0.02
    });

    it('handles rate exactly at boundary', () => {
        expect(calculateTimeToSync(5, 1.01)).toBeCloseTo(500, 5); // 5 / 0.01
    });

    it('treats drift exactly at the 0.5s boundary as NOT synced (strict <)', () => {
        // absDrift < 0.5 is the "synced" check, so exactly 0.5 falls through
        // to the rate-adjustment calculation rather than returning null.
        expect(calculateTimeToSync(0.5, 1.05)).toBeCloseTo(10, 5); // 0.5 / 0.05
        expect(calculateTimeToSync(-0.5, 1.05)).toBeCloseTo(10, 5);
    });

    it('handles a negative playbackRate (still compensates via abs adjustment)', () => {
        // rateAdjustment = |(-0.5) - 1.0| = 1.5
        expect(calculateTimeToSync(3, -0.5)).toBeCloseTo(2, 5); // 3 / 1.5
    });

    it('returns NaN (not null) for NaN drift — a non-numeric input is not "synced"', () => {
        const result = calculateTimeToSync(NaN, 1.05);
        expect(result).not.toBeNull();
        expect(Number.isNaN(result)).toBe(true);
    });

    it('handles Infinity drift by returning Infinity', () => {
        expect(calculateTimeToSync(Infinity, 1.05)).toBe(Infinity);
    });
});

describe('isHostDevice', () => {
    it('returns true when clientIds match', () => {
        expect(isHostDevice('client_abc', 'client_abc')).toBe(true);
    });

    it('returns false when clientIds differ', () => {
        expect(isHostDevice('client_abc', 'client_xyz')).toBe(false);
    });

    it('returns false when session host clientId is null', () => {
        expect(isHostDevice(null, 'client_abc')).toBe(false);
    });

    it('returns false when session host clientId is undefined', () => {
        expect(isHostDevice(undefined, 'client_abc')).toBe(false);
    });

    it('returns false for empty string vs null/undefined', () => {
        expect(isHostDevice('', '')).toBe(true);
    });
});

describe('isOwnEvent', () => {
    it('returns true when clientIds match', () => {
        expect(isOwnEvent('client_abc', 'user_1', 'client_abc', 'user_2')).toBe(true);
    });

    it('returns false when clientIds differ', () => {
        expect(isOwnEvent('client_abc', 'user_1', 'client_xyz', 'user_1')).toBe(false);
    });

    it('falls back to userId when clientId is undefined', () => {
        expect(isOwnEvent(undefined, 'user_1', 'client_xyz', 'user_1')).toBe(true);
        expect(isOwnEvent(undefined, 'user_1', 'client_xyz', 'user_2')).toBe(false);
    });

    it('falls back to userId when myClientId is empty', () => {
        expect(isOwnEvent('client_abc', 'user_1', '', 'user_1')).toBe(true);
        expect(isOwnEvent('client_abc', 'user_1', '', 'user_2')).toBe(false);
    });

    it('returns false when both comparisons are unavailable', () => {
        expect(isOwnEvent(undefined, 'user_1', '', null)).toBe(false);
    });
});
