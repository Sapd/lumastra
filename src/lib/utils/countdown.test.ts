// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { formatCountdown } from './countdown.js';

describe('formatCountdown', () => {
    it('returns 0:00 for zero', () => {
        expect(formatCountdown(0)).toBe('0:00');
    });

    it('returns 0:00 for negative durations', () => {
        expect(formatCountdown(-5_000)).toBe('0:00');
    });

    it('rounds up sub-second durations (so a live countdown never shows 0:00 while active)', () => {
        expect(formatCountdown(500)).toBe('00:01');
    });

    it('formats 1 minute as 01:00', () => {
        expect(formatCountdown(60_000)).toBe('01:00');
    });

    it('formats 59:59 without an hour prefix', () => {
        // 59 min 59 s = 3599 s → 59:59
        expect(formatCountdown(3_599_000)).toBe('59:59');
    });

    it('adds an hour prefix at exactly 1 hour', () => {
        expect(formatCountdown(3_600_000)).toBe('1h 00:00');
    });

    it('formats 1h 30:15', () => {
        // 1 h 30 min 15 s = 5415 s
        expect(formatCountdown(5_415_000)).toBe('1h 30:15');
    });

    it('handles multi-hour durations', () => {
        // 24 h exactly
        expect(formatCountdown(24 * 60 * 60_000)).toBe('24h 00:00');
    });
});
