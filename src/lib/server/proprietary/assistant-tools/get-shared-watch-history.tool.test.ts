// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import { getSharedWatchHistoryTool } from './get-shared-watch-history.tool.js';
import type { AssistantToolContext } from './types.js';

vi.mock('../../database/queries/user-watch-history.queries.js', () => ({
    getSharedRecentWatchedWithTitles: { all: vi.fn() },
}));

import { getSharedRecentWatchedWithTitles } from '../../database/queries/user-watch-history.queries.js';
import { assistantTestUser } from './test-context.js';

const viewerId = toUserId('00000000-0000-0000-0000-000000000001');
function makeCtx(): AssistantToolContext {
    return {
        sql: {} as never,
        userId: viewerId,
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

describe('getSharedWatchHistoryTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('passes the viewer boundary and never exposes the reason for no results', async () => {
        vi.mocked(getSharedRecentWatchedWithTitles.all).mockResolvedValue([]);

        const result = await getSharedWatchHistoryTool.execute({ username: 'Alex' }, makeCtx());

        expect(JSON.parse(result.summaryForModel)).toEqual(
            // `count` → `returnedCount` (see result-counts.ts).
            expect.objectContaining({ username: 'Alex', returnedCount: 0 }),
        );
        expect(result.summaryForModel).not.toContain('opted out');
        expect(getSharedRecentWatchedWithTitles.all).toHaveBeenCalledWith(expect.anything(), {
            viewerId,
            username: 'Alex',
            limit: 20,
            access: { library: { kind: 'denyGroups', ids: ['g1'] }, age: { kind: 'any' } },
        });
    });

    // Defense in depth. Today socialWatchHistoryViewable requires !restricted and
    // a non-restricted caller carrying an age ceiling is refused the assistant
    // outright (isAgeRestricted), so no live principal reaches this with a
    // ceiling. That makes the hardcoded `age: { kind: 'any' }` a latent hole
    // rather than an active leak — it opens the moment either gate is relaxed,
    // and it would expose ANOTHER person's above-ceiling titles by name.
    it('applies the caller’s age ceiling instead of dropping the age axis', async () => {
        vi.mocked(getSharedRecentWatchedWithTitles.all).mockResolvedValue([]);
        const ctx = makeCtx();

        await getSharedWatchHistoryTool.execute(
            { username: 'Alex' },
            {
                ...ctx,
                accessCtx: {
                    ...ctx.accessCtx,
                    ageRating: { maxAgeRating: 13, allowUnrated: false },
                },
            },
        );

        const callArg = vi.mocked(getSharedRecentWatchedWithTitles.all).mock.calls[0][1];
        expect(callArg.access.age).toEqual({
            kind: 'limit',
            maxAgeRating: 13,
            allowUnrated: false,
        });
    });

    it('filters a requested media type after a bounded over-fetch', async () => {
        vi.mocked(getSharedRecentWatchedWithTitles.all).mockResolvedValue([
            { media_type: 'movie', title: 'Haze', watched_at: new Date('2024-01-01') },
            { media_type: 'tv', title: 'Starhaven', watched_at: new Date('2024-01-02') },
        ] as never);

        const result = await getSharedWatchHistoryTool.execute(
            { username: 'Alex', mediaType: 'movie', limit: 1 },
            makeCtx(),
        );

        expect(JSON.parse(result.summaryForModel).results).toEqual([
            expect.objectContaining({ title: 'Haze', mediaType: 'movie' }),
        ]);
        expect(vi.mocked(getSharedRecentWatchedWithTitles.all).mock.calls[0][1].limit).toBe(3);
    });
});
