// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `get_watch_history` assistant tool.
 *
 * Mocks the backing query module — no real DB, no network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getWatchHistoryTool } from './get-watch-history.tool.js';
import type { AssistantToolContext } from './types.js';
import type { WatchedItemWithTitleRow } from '../../database/queries/user-watch-history.queries.js';
import { toUserId } from '$lib/shared/user-id.js';

vi.mock('../../database/queries/user-watch-history.queries.js', () => ({
    getRecentWatchedWithTitles: { all: vi.fn() },
}));

import { getRecentWatchedWithTitles } from '../../database/queries/user-watch-history.queries.js';
import { assistantTestUser } from './test-context.js';

const TEST_USER_ID = toUserId('00000000-0000-0000-0000-000000000001');

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
        tmdb_id: '1',
        media_type: 'movie',
        title: 'Get Out',
        watched_at: new Date('2024-01-15T10:00:00Z'),
    },
    {
        tmdb_id: '2',
        media_type: 'tv',
        title: 'Starhaven',
        watched_at: new Date('2024-01-14T10:00:00Z'),
    },
] as unknown as WatchedItemWithTitleRow[];

describe('getWatchHistoryTool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns a summary with count 2 and correct result shapes', async () => {
        vi.mocked(getRecentWatchedWithTitles.all).mockResolvedValue(fakeRows);

        const result = await getWatchHistoryTool.execute({}, makeCtx());

        expect(result.media).toBeUndefined();

        const summary = JSON.parse(result.summaryForModel);
        // `count` → `returnedCount` + an always-present page marker (see
        // result-counts.ts): a bare `count` beside a list kept being relayed as
        // a library total ("wir haben 10 Filme") no matter what the prompt said.
        expect(summary.returnedCount).toBe(2);
        expect(summary.results).toHaveLength(2);
        expect(summary.results[0].title).toBe('Get Out');
        expect(summary.results[0].mediaType).toBe('movie');
        expect(summary.results[0].watchedAt).toBe('2024-01-15T10:00:00.000Z');
        expect(summary.results[1].title).toBe('Starhaven');
        expect(summary.results[1].mediaType).toBe('tv');

        expect(getRecentWatchedWithTitles.all).toHaveBeenCalledTimes(1);
        const callArg = vi.mocked(getRecentWatchedWithTitles.all).mock.calls[0][1];
        expect(callArg.userId).toBe(TEST_USER_ID);
        expect(callArg.limit).toBe(20);
        // Both axes are projected from accessCtx. This caller has no age
        // ceiling (ageRating: null), so `any` here is the REAL boundary, not a
        // dropped one — see the age-ceiling test below.
        expect(callArg.access).toEqual({
            library: { kind: 'denyGroups', ids: ['g1'] },
            age: { kind: 'any' },
        });
    });

    // A de-escalated plugin-bridge principal reaches this tool with a REAL
    // maxAgeRating (deEscalateUser pins 13 for an admin) while isAgeRestricted
    // stays false, so runAssistant does not refuse it. The tool used to hardcode
    // `age: { kind: 'any' }`, handing that caller titles above its own ceiling.
    it('applies the caller’s age ceiling instead of dropping the age axis', async () => {
        vi.mocked(getRecentWatchedWithTitles.all).mockResolvedValue(fakeRows);
        const ctx = makeCtx();

        await getWatchHistoryTool.execute(
            {},
            {
                ...ctx,
                accessCtx: {
                    ...ctx.accessCtx,
                    ageRating: { maxAgeRating: 13, allowUnrated: false },
                },
            },
        );

        const callArg = vi.mocked(getRecentWatchedWithTitles.all).mock.calls[0][1];
        expect(callArg.access.age).toEqual({
            kind: 'limit',
            maxAgeRating: 13,
            allowUnrated: false,
        });
    });

    it('filters by mediaType in JS and over-fetches from the backing query', async () => {
        vi.mocked(getRecentWatchedWithTitles.all).mockResolvedValue(fakeRows);

        const result = await getWatchHistoryTool.execute({ mediaType: 'movie' }, makeCtx());

        const summary = JSON.parse(result.summaryForModel);
        expect(summary.returnedCount).toBe(1);
        expect(summary.results).toHaveLength(1);
        expect(summary.results[0].title).toBe('Get Out');
        expect(summary.results[0].mediaType).toBe('movie');

        expect(getRecentWatchedWithTitles.all).toHaveBeenCalledTimes(1);
        const callArg = vi.mocked(getRecentWatchedWithTitles.all).mock.calls[0][1];
        expect(callArg.userId).toBe(TEST_USER_ID);
        expect(callArg.limit).toBe(50);
    });
});
