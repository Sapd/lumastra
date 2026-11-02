// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import {
    enrichSeriesEpisodeCounts,
    type EpisodeCountTarget,
} from './series-episode-counts.service';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary';
import { getSeriesEpisodeCountsBatch } from '$lib/server/database/queries/series-episode-counts.queries';
vi.mock('$lib/server/database/queries/series-episode-counts.queries', () => ({
    getSeriesEpisodeCountsBatch: vi.fn(),
}));
const sql = {} as postgres.Sql;
const id = '10000000-0000-0000-0000-000000000001';
describe('count response enrichment', () => {
    it('batches canonical IDs once, scopes the user, and preserves missing/zero distinctions', async () => {
        vi.mocked(getSeriesEpisodeCountsBatch).mockResolvedValue([
            {
                id,
                seasonCount: 3,
                episodeCount: 60,
                availableEpisodeCount: 0,
                watchedEpisodeCount: 0,
                unwatchedEpisodeCount: 0,
            },
        ]);
        const targets: EpisodeCountTarget[] = [
            { id, type: 'series' },
            { id, type: 'series' },
            { id, type: 'movie' },
            { id: 'tmdb:123:series', type: 'series' },
        ];
        const access = unrestrictedAccess();
        await enrichSeriesEpisodeCounts(sql, targets, 'viewer', access);
        expect(getSeriesEpisodeCountsBatch).toHaveBeenLastCalledWith(sql, [id], 'viewer', access);
        expect(targets[0].availableEpisodeCount).toBe(0);
        expect(targets[2].episodeCount).toBeUndefined();
        expect(targets[3].episodeCount).toBeUndefined();
        vi.mocked(getSeriesEpisodeCountsBatch).mockResolvedValue([]);
        const missing: EpisodeCountTarget = { id, type: 'series' };
        await enrichSeriesEpisodeCounts(sql, [missing], 'viewer', access);
        expect(missing.availableEpisodeCount).toBeUndefined();
    });
    it('does not add personal state without a viewer', async () => {
        vi.mocked(getSeriesEpisodeCountsBatch).mockResolvedValue([
            {
                id,
                seasonCount: null,
                episodeCount: null,
                availableEpisodeCount: 0,
                watchedEpisodeCount: 0,
                unwatchedEpisodeCount: 0,
            },
        ]);
        const target: EpisodeCountTarget = { id, type: 'series' };
        await enrichSeriesEpisodeCounts(sql, [target], null, unrestrictedAccess());
        expect(target.episodeCount).toBeUndefined();
        expect(target.watchedEpisodeCount).toBeUndefined();
        expect(target.unwatchedEpisodeCount).toBeUndefined();
    });
});

describe('optional counts and independently known totals', () => {
    it('preserves the larger positive metadata total and removes unknown zero totals', async () => {
        vi.mocked(getSeriesEpisodeCountsBatch).mockResolvedValue([
            {
                id,
                seasonCount: 1,
                episodeCount: 2,
                availableEpisodeCount: 2,
                watchedEpisodeCount: 0,
                unwatchedEpisodeCount: 2,
            },
        ]);
        const positive: EpisodeCountTarget = {
            id,
            type: 'season',
            seasonCount: 3,
            episodeCount: 12,
        };
        await enrichSeriesEpisodeCounts(sql, [positive], 'viewer', unrestrictedAccess());
        expect(positive).toMatchObject({ seasonCount: 3, episodeCount: 12 });
        vi.mocked(getSeriesEpisodeCountsBatch).mockResolvedValue([
            {
                id,
                seasonCount: null,
                episodeCount: null,
                availableEpisodeCount: 0,
                watchedEpisodeCount: 0,
                unwatchedEpisodeCount: 0,
            },
        ]);
        const unknown: EpisodeCountTarget = { id, type: 'series', seasonCount: 0, episodeCount: 0 };
        await enrichSeriesEpisodeCounts(sql, [unknown], 'viewer', unrestrictedAccess());
        expect(unknown.seasonCount).toBeUndefined();
        expect(unknown.episodeCount).toBeUndefined();
    });
    it('fails softly without stale personal counts or fabricated availability', async () => {
        vi.mocked(getSeriesEpisodeCountsBatch).mockRejectedValueOnce(
            new Error('count query unavailable'),
        );
        const target: EpisodeCountTarget = {
            id,
            type: 'series',
            seasonCount: 0,
            episodeCount: 60,
            availableEpisodeCount: 24,
            watchedEpisodeCount: 24,
            unwatchedEpisodeCount: 0,
        };
        await expect(
            enrichSeriesEpisodeCounts(sql, [target], 'viewer', unrestrictedAccess()),
        ).resolves.toBeUndefined();
        expect(target.episodeCount).toBe(60);
        expect(target.seasonCount).toBeUndefined();
        expect(target.availableEpisodeCount).toBeUndefined();
        expect(target.watchedEpisodeCount).toBeUndefined();
        expect(target.unwatchedEpisodeCount).toBeUndefined();
    });
});
