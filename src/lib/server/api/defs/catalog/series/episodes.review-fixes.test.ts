// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { EpisodesQuery, episodePreview } from './episodes.js';
import type { SeriesEpisodeRow } from '$lib/server/database/queries/episode-detail.queries.js';

describe('EpisodesQuery bounds', () => {
    it.each(['season', 'episode', 'absolute'])('rejects %s above int32', (key) => {
        expect(EpisodesQuery.safeParse({ [key]: '2147483648' }).success).toBe(false);
        expect(EpisodesQuery.safeParse({ [key]: '2147483647' }).success).toBe(true);
    });
});

describe('episodePreview season handle', () => {
    const row = (over: Partial<SeriesEpisodeRow>): SeriesEpisodeRow =>
        ({
            id: '22222222-2222-4222-8222-222222222222',
            series_id: '11111111-1111-4111-8111-111111111111',
            season_id: '33333333-3333-4333-8333-333333333333',
            season_number: 1,
            episode_number: 1,
            ordering: 'dvd',
            has_file: true,
            ...over,
        }) as SeriesEpisodeRow;

    it('builds a virtual handle for a valid non-standard ordering', () => {
        expect(episodePreview(row({}), {}).context?.seasonId).toMatch(/^vseason:/);
    });

    it('falls back to the physical season id instead of throwing', () => {
        const p = episodePreview(row({ season_number: null as never }), {});
        expect(p.context?.seasonId).toBe('33333333-3333-4333-8333-333333333333');
        const q = episodePreview(row({ ordering: 'weird' as never }), {});
        expect(q.context?.seasonId).toBe('33333333-3333-4333-8333-333333333333');
    });
});
