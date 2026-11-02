// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `get_series_episodes` assistant tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSeriesEpisodesTool } from './get-series-episodes.tool.js';
import type { AssistantToolContext } from './types.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';
import type { SeriesEpisodeRow } from '../../database/queries/episode-detail.queries.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

vi.mock('../../database/queries/assistant-rag.queries.js', () => ({
    searchMediaByTitle: vi.fn(),
}));
vi.mock('../../database/queries/episode-detail.queries.js', () => ({
    getSeriesEpisodesWithWatchState: vi.fn(),
}));

import { searchMediaByTitle } from '../../database/queries/assistant-rag.queries.js';
import { getSeriesEpisodesWithWatchState } from '../../database/queries/episode-detail.queries.js';
import { assistantTestUser } from './test-context.js';

const TEST_USER_ID: UserId = toUserId('00000000-0000-0000-0000-000000000001');

function makeCtx(): AssistantToolContext {
    return {
        sql: {} as never,
        userId: TEST_USER_ID,
        userIsAdmin: false,
        user: assistantTestUser(),
        writesAllowed: false,
        accessCtx: {
            username: 'alice',
            deniedGroupIds: null,
            ageRating: null,
            liveTvAllowed: true,
            showUnavailableMedia: true,
        },
        embedQuery: async () => '[0]',
    };
}

const series = {
    media_id: 'uuid-hafentage',
    media_type: 'tv',
    title: 'Kapitäns Große Pause',
} as unknown as AssistantMovieRow;

const eps = [
    { season_number: 1, episode_number: 1, title: 'Pilot', is_watched: true },
    {
        season_number: 1,
        episode_number: 2,
        title: 'The New Kid',
        is_watched: false,
    },
    {
        season_number: 1,
        episode_number: 3,
        title: 'Rainy Days',
        is_watched: false,
    },
] as unknown as SeriesEpisodeRow[];

describe('getSeriesEpisodesTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns unwatched episodes + counts for a resolved series', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([series]);
        vi.mocked(getSeriesEpisodesWithWatchState).mockResolvedValue(eps);

        const result = await getSeriesEpisodesTool.execute(
            { title: 'Kapitäns große pause' },
            makeCtx(),
        );
        const d = JSON.parse(result.summaryForModel);
        expect(d.found).toBe(true);
        expect(d.totalEpisodes).toBe(3);
        expect(d.watchedCount).toBe(1);
        expect(d.unwatchedCount).toBe(2);
        expect(d.unwatched.map((e: { title: string }) => e.title)).toEqual([
            'The New Kid',
            'Rainy Days',
        ]);
        // Resolves watch state for the calling user against the series UUID.
        const call = vi.mocked(getSeriesEpisodesWithWatchState).mock.calls[0];
        expect(call[1]).toBe('uuid-hafentage');
        expect(call[2]).toBe(TEST_USER_ID);
    });

    it('reports not-found when the series does not resolve', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([]);
        const result = await getSeriesEpisodesTool.execute({ title: 'Nope' }, makeCtx());
        expect(JSON.parse(result.summaryForModel).found).toBe(false);
    });
});
