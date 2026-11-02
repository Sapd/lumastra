// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `find_by_person` assistant tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { toUserId } from '$lib/shared/user-id.js';
import { findByPersonTool } from './find-by-person.tool.js';
import type { AssistantToolContext } from './types.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';

vi.mock('../../database/queries/assistant-rag.queries.js', () => ({
    findMediaByPerson: vi.fn(),
}));

import { findMediaByPerson } from '../../database/queries/assistant-rag.queries.js';
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

const movie = {
    media_id: 'm1',
    primary_ext_id: '1',
    media_type: 'movie',
    title: 'Der Wixxer',
    is_available: true,
    can_request: false,
} as unknown as AssistantMovieRow;

describe('findByPersonTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns titles featuring the person as cards', async () => {
        vi.mocked(findMediaByPerson).mockResolvedValue([movie]);
        const result = await findByPersonTool.execute(
            { person: 'Christoph Maria Herbst' },
            makeCtx(),
        );
        expect(result.media?.[0].title).toBe('Der Wixxer');
        // `count` → `returnedCount` + an always-present page marker (see
        // result-counts.ts): a bare `count` beside a list kept being relayed as
        // a library total ("wir haben 10 Filme") no matter what the prompt said.
        expect(JSON.parse(result.summaryForModel).returnedCount).toBe(1);
    });

    it('threads person, media-type scope and access into the query', async () => {
        vi.mocked(findMediaByPerson).mockResolvedValue([]);
        await findByPersonTool.execute({ person: 'Bjarne Mädel', mediaType: 'tv' }, makeCtx());
        const arg = vi.mocked(findMediaByPerson).mock.calls[0][1];
        expect(arg.person).toBe('Bjarne Mädel');
        expect(arg.mediaTypes).toEqual(['tv']);
        expect(arg.userId).toBeDefined();
        expect(arg.access).toEqual({
            library: { kind: 'denyGroups', ids: ['g1'] },
            age: { kind: 'any' },
        });
    });
});
