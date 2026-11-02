// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `search_music` assistant tool.
 * Mocks the backing query — no real DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { toUserId } from '$lib/shared/user-id.js';
import { searchMusicTool } from './search-music.tool.js';
import type { AssistantToolContext } from './types.js';
import type { MusicSearchResult } from '../../database/queries/search.queries.js';

vi.mock('../../database/queries/search.queries.js', () => ({
    searchMusic: vi.fn(),
}));

import { searchMusic } from '../../database/queries/search.queries.js';
import { assistantTestUser } from './test-context.js';

function makeCtx(): AssistantToolContext {
    return {
        sql: {} as never,
        userId: toUserId(randomUUID()),
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

const daft = {
    id: 'k1',
    title: 'Find Lanterns',
    media_type: 'track',
    artist_name: 'Dusk Harbor',
    album_title: 'Quiet Harbor Memories',
    year: 2013,
} as unknown as MusicSearchResult;

describe('searchMusicTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns music as a text summary with artist/album, no cards', async () => {
        vi.mocked(searchMusic).mockResolvedValue([daft]);

        const result = await searchMusicTool.execute({ query: 'dusk harbor' }, makeCtx());

        expect(result.media).toBeUndefined();
        const summary = JSON.parse(result.summaryForModel);
        // `count` → `returnedCount` + an always-present page marker (see
        // result-counts.ts): a bare `count` beside a list kept being relayed as
        // a library total ("wir haben 10 Filme") no matter what the prompt said.
        expect(summary.returnedCount).toBe(1);
        expect(summary.results[0]).toMatchObject({
            title: 'Find Lanterns',
            type: 'track',
            artist: 'Dusk Harbor',
            album: 'Quiet Harbor Memories',
            year: 2013,
        });
    });

    it('threads access scope and limit into searchMusic', async () => {
        vi.mocked(searchMusic).mockResolvedValue([]);
        await searchMusicTool.execute({ query: 'lo-fi', limit: 5 }, makeCtx());
        const call = vi.mocked(searchMusic).mock.calls[0];
        expect(call[1]).toBe('lo-fi');
        expect(call[2]).toBe(5);
        // Fourth positional arg is the required MediaAccessBoundary, projected
        // from the tool context's access context.
        expect(call[3]).toEqual({
            library: { kind: 'denyGroups', ids: ['g1'] },
            age: { kind: 'any' },
        });
    });
});
