// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { pickAirDateEpisode } from './air-date-episode.js';

const ep = (id: string, season_number: number) => ({ id, season_number });

describe('pickAirDateEpisode', () => {
    it('takes the only episode that aired that day', () => {
        expect(pickAirDateEpisode([ep('a', 7)], undefined)?.id).toBe('a');
    });

    it('finds nothing when nothing aired', () => {
        expect(pickAirDateEpisode([], 7)).toBeNull();
    });

    it('lets the season folder pick between two same-day episodes', () => {
        expect(pickAirDateEpisode([ep('a', 6), ep('b', 7)], 7)?.id).toBe('b');
    });

    it('prefers the only regular episode over a same-day special', () => {
        expect(pickAirDateEpisode([ep('special', 0), ep('regular', 7)], undefined)?.id).toBe(
            'regular',
        );
        expect(pickAirDateEpisode([ep('special', 0), ep('regular', 7)], 2021)?.id).toBe('regular');
    });

    it('takes the special for a file in the Specials folder', () => {
        expect(pickAirDateEpisode([ep('special', 0), ep('regular', 7)], 0)?.id).toBe('special');
    });

    it('declines two regular episodes the folder cannot tell apart', () => {
        expect(pickAirDateEpisode([ep('a', 7), ep('b', 7)], 7)).toBeNull();
        expect(pickAirDateEpisode([ep('a', 6), ep('b', 7)], undefined)).toBeNull();
        expect(pickAirDateEpisode([ep('a', 6), ep('b', 7)], 2021)).toBeNull();
    });
});
