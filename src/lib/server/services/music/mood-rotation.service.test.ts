// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect } from 'vitest';
import type { MoodChip } from '$lib/constants/music-moods';
import { pickDailyMoodShelves } from './mood-rotation.service';

const MOODS: MoodChip[] = [
    { label: 'Chill', genre: 'chill', emoji: '\u{1f60c}' },
    { label: 'Workout', genre: 'workout', emoji: '\u{1f4aa}' },
    { label: 'Focus', genre: 'focus', emoji: '\u{1f3af}' },
    { label: 'Party', genre: 'party', emoji: '\u{1f389}' },
    { label: 'Energetic', genre: 'energetic', emoji: '⚡' },
    { label: 'Sad', genre: 'sad', emoji: '\u{1f327}' },
    { label: 'Happy', genre: 'happy', emoji: '\u{1f60a}' },
    { label: 'Romantic', genre: 'romantic', emoji: '\u{1f495}' },
];

describe('pickDailyMoodShelves', () => {
    test('same date + user always returns the same picks', () => {
        const first = pickDailyMoodShelves(MOODS, '2026-07-06', 'user-1', 2);
        const second = pickDailyMoodShelves(MOODS, '2026-07-06', 'user-1', 2);
        expect(second).toEqual(first);
    });

    test('always returns the requested count of distinct moods', () => {
        const picks = pickDailyMoodShelves(MOODS, '2026-07-06', 'user-1', 2);
        expect(picks).toHaveLength(2);
        expect(new Set(picks.map((p) => p.genre)).size).toBe(2);
    });

    test('a different date can produce a different selection', () => {
        const seen = new Set<string>();
        for (let day = 1; day <= 28; day++) {
            const dateKey = `2026-07-${String(day).padStart(2, '0')}`;
            const picks = pickDailyMoodShelves(MOODS, dateKey, 'user-1', 2);
            seen.add(picks.map((p) => p.genre).join(','));
        }
        // Over 28 different days, the rotation should not always land on the
        // exact same pair — if it did, this would indicate the date isn't
        // actually feeding the seed.
        expect(seen.size).toBeGreaterThan(1);
    });

    test('a different user can produce a different selection for the same date', () => {
        const seen = new Set<string>();
        for (let i = 0; i < 20; i++) {
            const picks = pickDailyMoodShelves(MOODS, '2026-07-06', `user-${i}`, 2);
            seen.add(picks.map((p) => p.genre).join(','));
        }
        expect(seen.size).toBeGreaterThan(1);
    });

    test('returns fewer entries when the mood pool is smaller than count', () => {
        const picks = pickDailyMoodShelves(MOODS.slice(0, 1), '2026-07-06', 'user-1', 2);
        expect(picks).toHaveLength(1);
    });
});
