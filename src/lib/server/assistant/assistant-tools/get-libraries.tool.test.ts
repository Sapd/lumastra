// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the `get_libraries` assistant tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import { getLibrariesTool } from './get-libraries.tool.js';
import type { AssistantToolContext } from './types.js';

const TEST_USER_ID = toUserId('aaaaaaaa-0000-0000-0000-000000000001');

vi.mock('../../database/queries/library-groups.queries.js', () => ({
    getLibraryGroupsWithCounts: vi.fn(),
}));

import { getLibraryGroupsWithCounts } from '../../database/queries/library-groups.queries.js';
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
            ageRating: { maxAgeRating: 13, allowUnrated: false },
            liveTvAllowed: true,
            showUnavailableMedia: true,
        },
        embedQuery: async () => '[0]',
    };
}

describe('getLibrariesTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('lists libraries with counts and media types', async () => {
        vi.mocked(getLibraryGroupsWithCounts).mockResolvedValue([
            {
                name: 'Movies',
                item_count: 1200,
                media_types: ['movie'],
                browsable_item_count: 1200,
            },
            {
                name: 'Music',
                item_count: 5000,
                media_types: ['artist', 'album', 'track'],
                browsable_item_count: 0,
            },
        ] as unknown as Awaited<ReturnType<typeof getLibraryGroupsWithCounts>>);

        const result = await getLibrariesTool.execute({}, makeCtx());
        const summary = JSON.parse(result.summaryForModel);
        // `count` → `returnedCount` + an always-present page marker (see
        // result-counts.ts): a bare `count` beside a list kept being relayed as
        // a library total ("wir haben 10 Filme") no matter what the prompt said.
        expect(summary.returnedCount).toBe(2);
        expect(summary.libraries[0]).toMatchObject({
            name: 'Movies',
            itemCount: 1200,
        });
        expect(result.media).toBeUndefined();
    });

    it('threads denied groups and max age rating into the query', async () => {
        vi.mocked(getLibraryGroupsWithCounts).mockResolvedValue([]);
        await getLibrariesTool.execute({}, makeCtx());
        const call = vi.mocked(getLibraryGroupsWithCounts).mock.calls[0];
        expect(call[1]).toEqual(['g1']);
        expect(call[2]).toBe(13);
    });
});
