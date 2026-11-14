// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for get_top_music and get_music_picks (text-only music tools).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AssistantToolContext } from './types.js';
import { toUserId } from '$lib/shared/user-id.js';

const TEST_USER_ID = toUserId('00000000-0000-0000-0000-000000000001');

vi.mock('../../database/queries/music-quick-picks.queries.js', () => ({
    getMostPlayedTracks: vi.fn(),
}));
vi.mock('../../services/music/quick-picks.service.js', () => ({
    getQuickPicks: vi.fn(),
    hasMusicListeningHistory: vi.fn(),
}));

import { getTopMusicTool } from './get-top-music.tool.js';
import { getMusicPicksTool } from './get-music-picks.tool.js';
import { getMostPlayedTracks } from '../../database/queries/music-quick-picks.queries.js';
import {
    getQuickPicks,
    hasMusicListeningHistory,
} from '../../services/music/quick-picks.service.js';
import { assistantTestUser } from './test-context.js';

function makeCtx(): AssistantToolContext {
    return {
        sql: {} as never,
        userId: TEST_USER_ID,
        userIsAdmin: false,
        user: assistantTestUser(),
        writesAllowed: false,
        accessCtx: {
            username: 'alice',
            deniedGroupIds: ['g1'],
            ageRating: null,
            liveTvAllowed: true,
            showUnavailableMedia: true,
        },
        embedQuery: async () => '[0]',
    };
}

describe('getTopMusicTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns the most-played tracks with artist/album', async () => {
        vi.mocked(getMostPlayedTracks).mockResolvedValue([
            {
                title: 'Find Lanterns',
                artist_title: 'Dusk Harbor',
                album_title: 'Quiet Harbor Memories',
            },
        ] as unknown as Awaited<ReturnType<typeof getMostPlayedTracks>>);

        const result = await getTopMusicTool.execute({}, makeCtx());
        const summary = JSON.parse(result.summaryForModel);
        // `count` → `returnedCount` + an always-present page marker (see
        // result-counts.ts): a bare `count` beside a list kept being relayed as
        // a library total ("wir haben 10 Filme") no matter what the prompt said.
        expect(summary.returnedCount).toBe(1);
        expect(summary.tracks[0]).toMatchObject({
            title: 'Find Lanterns',
            artist: 'Dusk Harbor',
        });
        expect(result.media).toBeUndefined();
        expect(vi.mocked(getMostPlayedTracks).mock.calls[0][1]).toBe(TEST_USER_ID);
    });
});

describe('getMusicPicksTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns personalized picks and threads access scope', async () => {
        vi.mocked(hasMusicListeningHistory).mockResolvedValue(true);
        vi.mocked(getQuickPicks).mockResolvedValue([
            {
                title: 'Instant Crush',
                artist_title: 'Dusk Harbor',
                album_title: 'Quiet Harbor Memories',
                bucket: 'taste-similar',
            },
        ] as unknown as Awaited<ReturnType<typeof getQuickPicks>>);

        const result = await getMusicPicksTool.execute({}, makeCtx());
        const summary = JSON.parse(result.summaryForModel);
        expect(summary.picks[0]).toMatchObject({
            title: 'Instant Crush',
            reason: 'taste-similar',
        });
        // access object is the 5th arg (sql, userId, target, excludeIds, access)
        const call = vi.mocked(getQuickPicks).mock.calls[0];
        expect(call[1]).toBe(TEST_USER_ID);
        expect(call[4].deniedGroupIds).toEqual(['g1']);
    });
});
