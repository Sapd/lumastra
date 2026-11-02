// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, it, expect } from 'vitest';
import { secondsToTicks, msToTicks, ticksToMs, ticksToSeconds } from './constants';

describe('secondsToTicks', () => {
    it('converts 1 second to 10000000 ticks', () => {
        expect(secondsToTicks(1)).toBe(10_000_000);
    });

    it('converts 60 seconds to 600000000 ticks', () => {
        expect(secondsToTicks(60)).toBe(600_000_000);
    });

    it('converts float seconds and rounds to integer', () => {
        const result = secondsToTicks(7342.123);
        expect(result).toBe(Math.round(7342.123 * 10_000_000));
        expect(Number.isInteger(result)).toBe(true);
    });

    it('converts zero', () => {
        expect(secondsToTicks(0)).toBe(0);
    });

    it('converts large value (2 hour movie)', () => {
        expect(secondsToTicks(7200)).toBe(72_000_000_000);
    });
});

describe('msToTicks', () => {
    it('converts 1000ms to 10000000 ticks', () => {
        expect(msToTicks(1000)).toBe(10_000_000);
    });

    it('converts float ms and rounds to integer', () => {
        const result = msToTicks(1500.5);
        expect(result).toBe(Math.round(1500.5 * 10_000));
        expect(Number.isInteger(result)).toBe(true);
    });

    it('converts zero', () => {
        expect(msToTicks(0)).toBe(0);
    });
});

describe('ticksToMs', () => {
    it('converts 10000000 ticks to 1000ms', () => {
        expect(ticksToMs(10_000_000)).toBe(1000);
    });

    it('round trips through msToTicks', () => {
        expect(ticksToMs(msToTicks(1500))).toBe(1500);
    });
});

describe('ticksToSeconds', () => {
    it('converts 10000000 ticks to 1 second', () => {
        expect(ticksToSeconds(10_000_000)).toBe(1);
    });

    it('converts 600000000 ticks to 60 seconds', () => {
        expect(ticksToSeconds(600_000_000)).toBe(60);
    });
});
