// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the `get_watchlist` assistant tool.
 * Mocks the backing query — no real DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWatchlistTool } from './get-watchlist.tool.js';
import { toUserId } from '$lib/shared/user-id.js';
import type { AssistantToolContext } from './types.js';
import type { WatchlistMediaRow } from '../../database/queries/watchlist-media.queries.js';

const ALICE = toUserId('a1ce0000-0000-4000-a000-000000000000');

vi.mock('../../database/queries/watchlist-media.queries.js', () => ({
    getUserWatchlistMedia: vi.fn(),
}));

import { getUserWatchlistMedia } from '../../database/queries/watchlist-media.queries.js';
import { assistantTestUser } from './test-context.js';

function makeCtx(): AssistantToolContext {
    return {
        sql: {} as never,
        userId: ALICE,
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

const movie = {
    media_id: 'm1',
    primary_ext_id: '603',
    media_type: 'movie',
    title: 'The Lantern',
    is_available: true,
    can_request: false,
    release_date: new Date('1999-03-31T00:00:00Z'),
} as unknown as WatchlistMediaRow;

const show = {
    media_id: 't1',
    primary_ext_id: '1396',
    media_type: 'tv',
    title: 'Drifting Clouds',
    is_available: true,
    can_request: false,
    release_date: '2008-01-01',
} as unknown as WatchlistMediaRow;

const track = {
    media_id: 'k1',
    primary_ext_id: 'x',
    media_type: 'track',
    title: 'Some Song',
    is_available: true,
    can_request: false,
    release_date: null,
} as unknown as WatchlistMediaRow;

describe('getWatchlistTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns saved movie/tv as cards and excludes non-video types', async () => {
        vi.mocked(getUserWatchlistMedia).mockResolvedValue([movie, show, track]);

        const result = await getWatchlistTool.execute({}, makeCtx());

        expect(result.media).toHaveLength(2); // track excluded
        const titles = result.media?.map((m) => m.title);
        expect(titles).toContain('The Lantern');
        expect(titles).toContain('Drifting Clouds');
        expect(titles).not.toContain('Some Song');
        // `count` → `returnedCount` + an always-present page marker (see
        // result-counts.ts): a bare `count` beside a list kept being relayed as
        // a library total ("wir haben 10 Filme") no matter what the prompt said.
        expect(JSON.parse(result.summaryForModel).returnedCount).toBe(2);
    });

    it('coerces a Date release_date to a YYYY-MM-DD string', async () => {
        vi.mocked(getUserWatchlistMedia).mockResolvedValue([movie]);
        const result = await getWatchlistTool.execute({}, makeCtx());
        expect(result.media?.[0].release_date).toBe('1999-03-31');
    });

    it('honours an explicit mediaType filter', async () => {
        vi.mocked(getUserWatchlistMedia).mockResolvedValue([movie, show]);
        const result = await getWatchlistTool.execute({ mediaType: 'tv' }, makeCtx());
        expect(result.media).toHaveLength(1);
        expect(result.media?.[0].title).toBe('Drifting Clouds');
    });

    it('threads access scope into the backing query', async () => {
        vi.mocked(getUserWatchlistMedia).mockResolvedValue([]);
        await getWatchlistTool.execute({}, makeCtx());
        const call = vi.mocked(getUserWatchlistMedia).mock.calls[0];
        expect(call[1]).toBe(ALICE);
        expect(call[2].deniedGroupIds).toEqual(['g1']);
    });
});
