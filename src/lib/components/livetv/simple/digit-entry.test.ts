// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, afterEach } from 'vitest';
import { DIGIT_COMMIT_MS, DigitEntry } from './digit-entry.svelte.js';

describe('DigitEntry', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('waits for a second digit when one can follow, then tunes', () => {
        vi.useFakeTimers();
        const tuned: number[] = [];
        const entry = new DigitEntry(
            (n) => tuned.push(n),
            () => 24,
        );
        entry.push('1');
        vi.advanceTimersByTime(DIGIT_COMMIT_MS - 100);
        expect(tuned).toEqual([]);
        entry.push('6');
        vi.advanceTimersByTime(700);
        expect(tuned).toEqual([16]);
        expect(entry.digits).toBe('');
    });

    it('tunes quickly when no further digit is possible', () => {
        vi.useFakeTimers();
        const tuned: number[] = [];
        const entry = new DigitEntry(
            (n) => tuned.push(n),
            () => 8,
        );
        entry.push('5');
        vi.advanceTimersByTime(700);
        expect(tuned).toEqual([5]);
    });

    it('Enter tunes at once and Escape cancels; 0 alone does nothing', () => {
        vi.useFakeTimers();
        const tuned: number[] = [];
        const entry = new DigitEntry(
            (n) => tuned.push(n),
            () => 30,
        );
        entry.push('2');
        entry.commit();
        expect(tuned).toEqual([2]);
        entry.push('3');
        entry.cancel();
        vi.advanceTimersByTime(DIGIT_COMMIT_MS + 100);
        expect(tuned).toEqual([2]);
        entry.push('0');
        entry.commit();
        expect(tuned).toEqual([2]);
    });
});

describe('DigitEntry overflow', () => {
    it('ignores a third digit instead of shifting the number', () => {
        vi.useFakeTimers();
        const tuned: number[] = [];
        const entry = new DigitEntry(
            (n) => tuned.push(n),
            () => 30,
        );
        entry.push('1');
        entry.push('2');
        entry.push('3');
        vi.advanceTimersByTime(700);
        expect(tuned).toEqual([12]);
        vi.useRealTimers();
    });
});
