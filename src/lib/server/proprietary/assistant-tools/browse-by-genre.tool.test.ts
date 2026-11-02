// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `browse_by_genre` assistant tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { browseByGenreTool } from './browse-by-genre.tool.js';
import { toUserId } from '$lib/shared/user-id.js';
import type { AssistantToolContext } from './types.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';

const ALICE = toUserId('a1ce0000-0000-4000-a000-000000000000');

vi.mock('../../database/queries/assistant-rag.queries.js', () => ({
    findMediaByGenre: vi.fn(),
}));

import { findMediaByGenre } from '../../database/queries/assistant-rag.queries.js';
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

const show = {
    media_id: 't1',
    primary_ext_id: '456',
    media_type: 'tv',
    title: 'Bluey',
    is_available: true,
    can_request: false,
} as unknown as AssistantMovieRow;

describe('browseByGenreTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns genre matches as cards', async () => {
        vi.mocked(findMediaByGenre).mockResolvedValue([show]);
        const result = await browseByGenreTool.execute(
            { genres: ['Kids', 'Family'], mediaType: 'tv' },
            makeCtx(),
        );
        expect(result.media?.[0].title).toBe('Bluey');
        // `count` → `returnedCount` + an always-present page marker (see
        // result-counts.ts): a bare `count` beside a list kept being relayed as
        // a library total ("wir haben 10 Filme") no matter what the prompt said.
        expect(JSON.parse(result.summaryForModel).returnedCount).toBe(1);
    });

    it('threads genres (union), media-type scope and access into the query', async () => {
        vi.mocked(findMediaByGenre).mockResolvedValue([]);
        await browseByGenreTool.execute(
            { genres: ['Kids', 'Family', 'Animation'], mediaType: 'tv' },
            makeCtx(),
        );
        const arg = vi.mocked(findMediaByGenre).mock.calls[0][1];
        expect(arg.genres).toEqual(['Kids', 'Family', 'Animation']);
        expect(arg.mediaTypes).toEqual(['tv']);
        expect(arg.userId).toBe(ALICE);
        expect(arg.access).toEqual({
            library: { kind: 'denyGroups', ids: ['g1'] },
            age: { kind: 'any' },
        });
    });
});
