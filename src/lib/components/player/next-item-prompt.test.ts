// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * When the next-episode prompt is due — the same rule as the Apple apps'
 * NextEpisodePrompt.isDue, so a party behaves alike whoever hosts it.
 */
import { describe, it, expect } from 'vitest';
import { isNextItemPromptDue } from './player-utils';

const due = (
    currentTime: number,
    outroStarts: number[],
    { duration = 2700, leadSeconds = 0, noOutroFallbackSeconds = 30 } = {},
) =>
    isNextItemPromptDue({
        currentTime,
        duration,
        outroStarts,
        leadSeconds,
        noOutroFallbackSeconds,
    });

describe('isNextItemPromptDue', () => {
    it('comes up when the credits start, shifted by the lead', () => {
        expect(due(2579, [2580])).toBe(false);
        expect(due(2580, [2580])).toBe(true);
        expect(due(2565, [2580], { leadSeconds: 15 })).toBe(true);
        expect(due(2585, [2580], { leadSeconds: -10 })).toBe(false);
        expect(due(2590, [2580], { leadSeconds: -10 })).toBe(true);
    });

    it('uses the earliest credits segment, whatever the order', () => {
        expect(due(2500, [2600, 2500])).toBe(true);
    });

    it('ignores credits detected in the first half (mis-detection)', () => {
        // Honoring it held the prompt and its auto-advance up for most of the episode.
        expect(due(600, [500])).toBe(false);
        expect(due(2700 - 30, [500])).toBe(true);
    });

    it('a false early Outro does not hide the real credits', () => {
        expect(due(600, [500, 2580])).toBe(false);
        expect(due(2580, [500, 2580])).toBe(true);
    });

    it('without credits: only the last fallback seconds, never before the midpoint', () => {
        expect(due(2700 - 31, [])).toBe(false);
        expect(due(2700 - 30, [])).toBe(true);
        expect(due(10, [], { duration: 40 })).toBe(false);
        expect(due(20, [], { duration: 40 })).toBe(true);
        expect(due(2699, [], { noOutroFallbackSeconds: 0 })).toBe(false);
    });
});
