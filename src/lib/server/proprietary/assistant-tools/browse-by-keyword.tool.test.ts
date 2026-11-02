// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `browse_by_keyword` assistant tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { browseByKeywordTool } from './browse-by-keyword.tool.js';
import type { AssistantToolContext } from './types.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';
import { toUserId } from '$lib/shared/user-id.js';

const TEST_USER_ID = toUserId('00000000-0000-0000-0000-000000000001');

vi.mock('../../database/queries/assistant-rag.queries.js', () => ({
    findMediaByKeyword: vi.fn(),
}));

import { findMediaByKeyword } from '../../database/queries/assistant-rag.queries.js';
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

const knives = {
    media_id: 'm1',
    primary_ext_id: '546554',
    media_type: 'movie',
    title: 'Lanterns Out',
    is_available: true,
    can_request: false,
} as unknown as AssistantMovieRow;

describe('browseByKeywordTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns tagged titles as cards', async () => {
        vi.mocked(findMediaByKeyword).mockResolvedValue([knives]);
        const result = await browseByKeywordTool.execute(
            { keywords: ['whodunit', 'murder mystery'] },
            makeCtx(),
        );
        expect(result.media).toHaveLength(1);
        expect(result.media?.[0].title).toBe('Lanterns Out');
        // `count` → `returnedCount` + an always-present page marker (see
        // result-counts.ts): a bare `count` beside a list kept being relayed as
        // a library total ("wir haben 10 Filme") no matter what the prompt said.
        expect(JSON.parse(result.summaryForModel).returnedCount).toBe(1);
    });

    it('threads keywords (union), media-type scope and access into the query', async () => {
        vi.mocked(findMediaByKeyword).mockResolvedValue([]);
        await browseByKeywordTool.execute(
            { keywords: ['heist', 'robbery'], mediaType: 'movie' },
            makeCtx(),
        );
        const arg = vi.mocked(findMediaByKeyword).mock.calls[0][1];
        expect(arg.keywords).toEqual(['heist', 'robbery']);
        expect(arg.mediaTypes).toEqual(['movie']);
        expect(arg.userId).toBe(TEST_USER_ID);
        expect(arg.access).toEqual({
            library: { kind: 'denyGroups', ids: ['g1'] },
            age: { kind: 'any' },
        });
    });
});
