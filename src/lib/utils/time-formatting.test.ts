// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { formatRelativeTime, runTimeTicksToSeconds } from './time-formatting';
import { convertSecondsToHoursAndMinutes } from '../../utility';

function extractCount(formatted: string): number {
    const match = formatted.match(/\d+/);
    if (!match) throw new Error(`no numeral found in "${formatted}"`);
    return Number(match[0]);
}

describe('formatRelativeTime', () => {
    it('never reports a zero count at the weeks/months boundary (28-29 days)', () => {
        for (const days of [28, 29]) {
            const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
            expect(extractCount(formatRelativeTime(date))).toBeGreaterThan(0);
        }
    });

    it('never reports a zero count at the months/years boundary (360-364 days)', () => {
        for (const days of [360, 361, 362, 363, 364]) {
            const date = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
            expect(extractCount(formatRelativeTime(date))).toBeGreaterThan(0);
        }
    });

    it('rolls over cleanly to months at day 30 and years at day 365', () => {
        const thirtyDays = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        expect(extractCount(formatRelativeTime(thirtyDays))).toBe(1);

        const oneYear = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
        expect(extractCount(formatRelativeTime(oneYear))).toBe(1);
    });
});

describe('runTimeTicksToSeconds', () => {
    it('converts Jellyfin ticks to SECONDS, not minutes', () => {
        // 45-minute episode: 45 * 60 * 10_000_000 ticks.
        expect(runTimeTicksToSeconds(45 * 60 * 10_000_000)).toBe(45 * 60);
    });

    it('round-trips through the modal duration renderer for a sub-hour episode', () => {
        // Regression: episode modals divided by an extra 60, handing MINUTES to
        // a seconds-typed prop. 45 read as seconds floors to 0h 0m -> "00m".
        const seconds = runTimeTicksToSeconds(45 * 60 * 10_000_000);
        expect(seconds).toBeDefined();
        expect(convertSecondsToHoursAndMinutes(seconds as number)).toBe('45m');
    });

    it('handles a feature-length runtime', () => {
        expect(runTimeTicksToSeconds(94 * 60 * 10_000_000)).toBe(94 * 60);
        expect(convertSecondsToHoursAndMinutes(94 * 60)).toBe('1h 34m');
    });

    it('returns undefined for missing/zero ticks so callers fall back to enrichment', () => {
        expect(runTimeTicksToSeconds(0)).toBeUndefined();
        expect(runTimeTicksToSeconds(undefined)).toBeUndefined();
        expect(runTimeTicksToSeconds(null)).toBeUndefined();
    });
});
