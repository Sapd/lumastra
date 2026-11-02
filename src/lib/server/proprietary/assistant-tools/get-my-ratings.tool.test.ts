// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `get_my_ratings` assistant tool.
 *
 * Mocks the backing query module — no real DB, no network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getMyRatingsTool } from './get-my-ratings.tool.js';
import type { AssistantToolContext } from './types.js';
import type { UserRatingFullRow } from '../../database/queries/user-ratings.queries.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';

vi.mock('../../database/queries/user-ratings.queries.js', () => ({
    getUserRatingsFullMetadata: { all: vi.fn() },
}));

import { getUserRatingsFullMetadata } from '../../database/queries/user-ratings.queries.js';
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
            deniedGroupIds: ['g1'],
            ageRating: null,
            liveTvAllowed: true,
            showUnavailableMedia: true,
        },
        embedQuery: async () => '[0]',
    };
}

const fakeRows = [
    {
        title: 'Haze',
        media_type: 'movie',
        rating: 9,
        is_available: true,
        can_request: false,
    },
    {
        title: 'Dawn',
        media_type: 'movie',
        rating: 8,
        is_available: false,
        can_request: true,
    },
] as unknown as UserRatingFullRow[];

describe('getMyRatingsTool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns a summary with count 2 and correct result shapes', async () => {
        vi.mocked(getUserRatingsFullMetadata.all).mockResolvedValue(fakeRows);

        const result = await getMyRatingsTool.execute({}, makeCtx());

        expect(result.media).toBeUndefined();

        const summary = JSON.parse(result.summaryForModel);
        // `count` → `returnedCount` + an always-present page marker (see
        // result-counts.ts): a bare `count` beside a list kept being relayed as
        // a library total ("wir haben 10 Filme") no matter what the prompt said.
        expect(summary.returnedCount).toBe(2);
        expect(summary.results).toHaveLength(2);
        expect(summary.results[0].yourRating).toBe(9);
        expect(summary.results[0].title).toBe('Haze');
        expect(summary.results[0].mediaType).toBe('movie');
        expect(summary.results[0].isAvailable).toBe(true);
        expect(summary.results[0].canRequest).toBe(false);
        expect(summary.results[1].title).toBe('Dawn');
        expect(summary.results[1].yourRating).toBe(8);
    });

    it('threads the access boundary from ctx.accessCtx into the backing query and maps minRating to ratingMin', async () => {
        vi.mocked(getUserRatingsFullMetadata.all).mockResolvedValue([]);

        await getMyRatingsTool.execute({ minRating: 7 }, makeCtx());

        expect(getUserRatingsFullMetadata.all).toHaveBeenCalledTimes(1);
        const callArg = vi.mocked(getUserRatingsFullMetadata.all).mock.calls[0][1];
        expect(callArg.userId).toBe(TEST_USER_ID);
        expect(callArg.ratingMin).toBe(7);
        expect(callArg.limit).toBe(20);
        // The ctx's denied group must survive as a denyGroups scope — never
        // collapse to `all`, which would silently unfilter this tool.
        expect(callArg.access).toEqual({
            library: { kind: 'denyGroups', ids: ['g1'] },
            age: { kind: 'any' },
        });
    });
});
