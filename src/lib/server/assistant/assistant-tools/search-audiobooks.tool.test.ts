// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the `search_audiobooks` assistant tool.
 *
 * Security review 4, C9 (2026-09-18): this tool used to call
 * `audiobookshelfClient.search()` directly, bypassing the library-group/age
 * boundary its sibling tool (`get_audiobook_progress`) and the canonical
 * `/search` route both enforce. It now goes through `getAudiobookEntries`
 * (the same boundary-scoped query module `get_audiobook_progress` reads
 * from), threading `searchAccessBoundary(ctx.accessCtx)` the same way that
 * sibling's own test asserts (see "threads the caller access boundary" in
 * `get-audiobook-progress.tool.test.ts`). The real-Postgres proof that a
 * denied library group yields no hit for a search query lives in
 * `audiobook-browse.queries.integration.test.ts`'s `describe('search')` →
 * `'is scoped by the same access boundary as the grid'` — it exercises
 * `getAudiobookEntries` (this tool's own query call) with `query` set and a
 * `deniedGroupIds` boundary built via the same `restrictedAccess()` helper
 * `searchAccessBoundary()` wraps, and asserts zero entries. There is no
 * separate `search-audiobooks.tool.integration.test.ts` — this file covers
 * wiring and degradation only, per Global Constraint 2 (a mock cannot prove
 * a SQL predicate; that proof belongs at the query-module seam, not
 * duplicated here against a second throwaway database).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import { searchAudiobooksTool } from './search-audiobooks.tool.js';
import type { AssistantToolContext } from './types.js';

const TEST_USER_ID = toUserId('aaaaaaaa-0000-0000-0000-000000000001');

vi.mock('../../database/queries/audiobook-browse.queries.js', () => ({
    getAudiobookEntries: vi.fn(),
}));
vi.mock('../../config.js', () => ({
    features: { audiobooks: true },
}));

import { getAudiobookEntries } from '../../database/queries/audiobook-browse.queries.js';
import { features } from '../../config.js';
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

describe('searchAudiobooksTool', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (features as { audiobooks: boolean }).audiobooks = true;
    });

    it('returns audiobook matches when configured', async () => {
        vi.mocked(getAudiobookEntries).mockResolvedValue({
            entries: [
                {
                    kind: 'book',
                    mediaId: 'm1',
                    absItemId: 'ab1',
                    title: 'Dawn',
                    seriesName: null,
                    seriesSequence: null,
                    bookCount: 1,
                    year: 1965,
                    runtimeSeconds: 1000,
                    authors: ['Frank Herbert'],
                    narrators: [],
                    addedAt: null,
                    libraryGroupId: 'g0',
                    resumePositionMs: null,
                    durationMs: null,
                    isFinished: false,
                    finishedCount: 0,
                },
            ],
            totalCount: 1,
        });

        const result = await searchAudiobooksTool.execute({ query: 'Dawn' }, makeCtx());
        const d = JSON.parse(result.summaryForModel);
        expect(d.available).toBe(true);
        expect(d.found).toBe(true);
        expect(d.results[0].title).toBe('Dawn');
        expect(d.results[0].author).toBe('Frank Herbert');
    });

    it('reports unavailable when audiobooks are not configured', async () => {
        (features as { audiobooks: boolean }).audiobooks = false;
        const result = await searchAudiobooksTool.execute({ query: 'Dawn' }, makeCtx());
        expect(JSON.parse(result.summaryForModel).available).toBe(false);
        expect(getAudiobookEntries).not.toHaveBeenCalled();
    });

    it('degrades gracefully when the query fails', async () => {
        vi.mocked(getAudiobookEntries).mockRejectedValue(new Error('down'));
        const result = await searchAudiobooksTool.execute({ query: 'Dawn' }, makeCtx());
        expect(JSON.parse(result.summaryForModel).error).toBe(true);
    });

    // The property C9 is about: the caller's real access boundary must reach
    // the query, not a permissive default. Mirrors
    // get-audiobook-progress.tool.test.ts's "threads the caller access boundary".
    it('threads the caller access boundary into getAudiobookEntries', async () => {
        vi.mocked(getAudiobookEntries).mockResolvedValue({ entries: [], totalCount: 0 });

        await searchAudiobooksTool.execute({ query: 'Dawn' }, makeCtx());

        expect(vi.mocked(getAudiobookEntries).mock.calls[0][1]).toMatchObject({
            query: 'Dawn',
            access: { library: { kind: 'denyGroups', ids: ['g1'] }, age: { kind: 'any' } },
        });
    });
});
