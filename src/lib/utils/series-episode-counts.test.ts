// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    formatSeriesCounts,
    formatSeriesProgress,
    seriesCountBadge,
} from './series-episode-counts';
import * as m from '$lib/paraglide/messages';

describe('series count presentation', () => {
    it('shows a partial playable remainder, never provider totals in the badge', () => {
        expect(
            seriesCountBadge(
                {
                    episodeCount: 60,
                    availableEpisodeCount: 24,
                    watchedEpisodeCount: 12,
                    unwatchedEpisodeCount: 12,
                },
                'series',
            ),
        ).toEqual({ text: '12', label: '12 unwatched episodes', complete: false });
    });
    it('completes only a positive playable set, including season cards', () => {
        for (const type of ['series', 'season']) {
            expect(
                seriesCountBadge({ availableEpisodeCount: 24, unwatchedEpisodeCount: 0 }, type)
                    ?.complete,
            ).toBe(true);
            expect(
                seriesCountBadge({ availableEpisodeCount: 0, unwatchedEpisodeCount: 0 }, type),
            ).toBeUndefined();
            expect(seriesCountBadge({}, type)).toBeUndefined();
        }
    });
    it('keeps totals and watch progress distinct and formats plurals', () => {
        const counts = {
            seasonCount: 1,
            episodeCount: 60,
            availableEpisodeCount: 24,
            watchedEpisodeCount: 12,
            unwatchedEpisodeCount: 12,
        };
        expect(formatSeriesCounts(counts, 'series')).toBe('1 season · 60 episodes');
        expect(formatSeriesCounts(counts, 'series', true)).toBe('60 episodes');
        expect(formatSeriesProgress(counts, 'series')).toBe(
            '24 available episodes · 12 watched episodes · 12 unwatched episodes',
        );
        expect(formatSeriesCounts({ seasonCount: 3 }, 'series', true)).toBe('3 seasons');
        expect(formatSeriesCounts({}, 'series')).toBe('');
        expect(m.series_seasons_count({ count: 1 }, { locale: 'de' })).toBe('1 Staffel');
        expect(m.series_episodes_count({ count: 2 }, { locale: 'de' })).toBe('2 Episoden');
    });
    it('does not show series information on movies, episodes, or audio', () => {
        for (const type of ['movie', 'episode', 'track', 'album', 'audiobook']) {
            const counts = {
                seasonCount: 3,
                episodeCount: 24,
                availableEpisodeCount: 24,
                unwatchedEpisodeCount: 3,
            };
            expect(formatSeriesCounts(counts, type)).toBe('');
            expect(formatSeriesProgress(counts, type)).toBe('');
            expect(seriesCountBadge(counts, type)).toBeUndefined();
        }
    });
});
