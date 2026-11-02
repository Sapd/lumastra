// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { formatEpisodeRangeCode } from './playback-display';

describe('formatEpisodeRangeCode', () => {
    it('formats a single episode without a range', () => {
        expect(formatEpisodeRangeCode(2, 20)).toBe('S02E20');
        expect(formatEpisodeRangeCode(2, 20, undefined)).toBe('S02E20');
    });

    it('formats a combined two-parter as a range', () => {
        expect(formatEpisodeRangeCode(2, 20, 21)).toBe('S02E20-E21');
    });

    it('keeps the file range when entering on the LAST episode of a combined file', () => {
        // Hafentage S02E20E21: opening "Dance Lessons" (E21) must still read E20-E21,
        // not E21-E21 — the start comes from the file, not the open episode.
        expect(formatEpisodeRangeCode(2, 20, 21)).toBe('S02E20-E21');
    });

    it('never emits a degenerate range', () => {
        expect(formatEpisodeRangeCode(2, 21, 21)).toBe('S02E21');
        expect(formatEpisodeRangeCode(2, 21, 20)).toBe('S02E21');
    });

    it('pads season and episode numbers to two digits', () => {
        expect(formatEpisodeRangeCode(1, 5, 6)).toBe('S01E05-E06');
        expect(formatEpisodeRangeCode(11, 13, 16)).toBe('S11E13-E16');
    });

    it('falls back to season 1 / episode 1 for missing numbers', () => {
        expect(formatEpisodeRangeCode(undefined, undefined)).toBe('S01E01');
    });
});
