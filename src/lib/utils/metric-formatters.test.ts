// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { formatFileSize, formatBytes, formatElapsed, formatUptime } from './metric-formatters';

describe('formatFileSize', () => {
    it('formats bytes', () => {
        expect(formatFileSize(500)).toBe('500 B');
    });

    it('formats kilobytes', () => {
        expect(formatFileSize(1_500)).toBe('2 KB');
    });

    it('formats megabytes', () => {
        expect(formatFileSize(52_428_800)).toBe('52 MB');
    });

    it('formats gigabytes', () => {
        expect(formatFileSize(4_500_000_000)).toBe('4.5 GB');
    });

    it('formats terabytes', () => {
        expect(formatFileSize(2_200_000_000_000)).toBe('2.2 TB');
    });

    it('handles zero', () => {
        expect(formatFileSize(0)).toBe('0 B');
    });

    it('renders a dash for a missing, corrupt or negative size', () => {
        expect(formatFileSize(Number.NaN)).toBe('—');
        expect(formatFileSize(null as unknown as number)).toBe('—');
        expect(formatFileSize(-5)).toBe('—');
        expect(formatFileSize(Number.POSITIVE_INFINITY)).toBe('—');
    });

    it('steps up a unit when rounding would carry to 1000', () => {
        expect(formatFileSize(999_600_000)).toBe('1.0 GB');
        expect(formatFileSize(999_950)).toBe('1 MB');
        expect(formatFileSize(999.6)).toBe('1 KB');
    });

    it('has a PB tier', () => {
        expect(formatFileSize(2e15)).toBe('2.0 PB');
    });
});

describe('formatBytes (bandwidth)', () => {
    it('formats bytes per second', () => {
        expect(formatBytes(500)).toBe('500 B/s');
    });

    it('formats KB/s', () => {
        expect(formatBytes(2048)).toBe('2.0 KB/s');
    });

    it('formats MB/s', () => {
        expect(formatBytes(5_242_880)).toBe('5.00 MB/s');
    });
});

describe('formatElapsed', () => {
    it('formats seconds', () => {
        expect(formatElapsed(45)).toBe('45s');
    });

    it('formats minutes and seconds', () => {
        expect(formatElapsed(125)).toBe('2m 5s');
    });

    it('formats hours and minutes', () => {
        expect(formatElapsed(3665)).toBe('1h 1m');
    });
});

describe('formatUptime', () => {
    it('formats minutes', () => {
        expect(formatUptime(300)).toBe('5m');
    });

    it('formats hours and minutes', () => {
        expect(formatUptime(7200)).toBe('2h 0m');
    });

    it('formats days and hours', () => {
        expect(formatUptime(90000)).toBe('1d 1h');
    });
});
