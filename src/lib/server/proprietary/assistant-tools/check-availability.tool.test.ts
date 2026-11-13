// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the `check_availability` assistant tool.
 *
 * Mocks the backing query module — no real DB, no network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import { checkAvailabilityTool } from './check-availability.tool.js';
import type { AssistantToolContext } from './types.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';

const TEST_USER_ID = toUserId('aaaaaaaa-0000-0000-0000-000000000001');

vi.mock('../../database/queries/assistant-rag.queries.js', () => ({
    searchMediaByTitle: vi.fn(),
}));

import { searchMediaByTitle } from '../../database/queries/assistant-rag.queries.js';
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

const fakeMatrix = {
    media_id: 'm1',
    primary_ext_id: '603',
    media_type: 'movie',
    title: 'The Lantern',
    is_available: true,
    can_request: false,
    release_date: '1999-01-01',
} as unknown as AssistantMovieRow;

describe('checkAvailabilityTool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns the found item and a summary with count 1', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([fakeMatrix]);

        const result = await checkAvailabilityTool.execute({ title: 'The Lantern' }, makeCtx());

        expect(result.media).toHaveLength(1);
        expect(result.media?.[0].title).toBe('The Lantern');

        const summary = JSON.parse(result.summaryForModel);
        // `count` → `returnedCount` + an always-present page marker (see
        // result-counts.ts): a bare `count` beside a list kept being relayed as
        // a library total ("wir haben 10 Filme") no matter what the prompt said.
        expect(summary.returnedCount).toBe(1);
        expect(summary.results).toHaveLength(1);
        expect(summary.results[0].title).toBe('The Lantern');
    });

    it('threads deniedGroupIds and ageRating from ctx.accessCtx into the backing query', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([fakeMatrix]);

        await checkAvailabilityTool.execute({ title: 'The Lantern' }, makeCtx());

        expect(searchMediaByTitle).toHaveBeenCalledTimes(1);
        const callArg = vi.mocked(searchMediaByTitle).mock.calls[0][1];
        expect(callArg.access).toEqual({
            library: { kind: 'denyGroups', ids: ['g1'] },
            age: { kind: 'any' },
        });
    });

    it('returns empty media and a summary with count 0 when nothing is found', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([]);

        const result = await checkAvailabilityTool.execute(
            { title: 'Nonexistent Movie' },
            makeCtx(),
        );

        expect(result.media).toHaveLength(0);

        const summary = JSON.parse(result.summaryForModel);
        expect(summary.returnedCount).toBe(0);
        expect(summary.results).toHaveLength(0);
    });
});
