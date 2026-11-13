// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for `resolveTitleForWrite` — the single title→UUID step every
 * write tool goes through. Mocks the backing query (no DB), so these assert
 * the ARGUMENTS threaded down and the disambiguation policy, nothing about SQL.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import type { AssistantToolContext } from './types.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';

vi.mock('../../database/queries/assistant-rag.queries.js', () => ({
    searchMediaByTitle: vi.fn(),
}));

import { searchMediaByTitle } from '../../database/queries/assistant-rag.queries.js';
import { resolveTitleForWrite } from './resolve-title.js';
import { assistantTestUser } from './test-context.js';

const ALICE = toUserId('a1ce0000-0000-4000-a000-000000000000');

function makeCtx(): AssistantToolContext {
    return {
        sql: {} as never,
        userId: ALICE,
        userIsAdmin: false,
        user: assistantTestUser(),
        writesAllowed: true,
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

function row(over: Partial<AssistantMovieRow>): AssistantMovieRow {
    return {
        media_id: 'uuid-1',
        primary_ext_id: '550',
        title: 'Fenwick',
        media_type: 'movie',
        release_date: '1996-01-01',
        is_available: true,
        can_request: false,
        ...over,
    } as AssistantMovieRow;
}

describe('resolveTitleForWrite', () => {
    beforeEach(() => vi.clearAllMocks());

    it('threads the access boundary into the backing query', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([row({})]);
        await resolveTitleForWrite(makeCtx(), { title: 'Fenwick' });
        const params = vi.mocked(searchMediaByTitle).mock.calls[0][1];
        expect(params.access.library).toEqual({ kind: 'denyGroups', ids: ['g1'] });
        // More than one candidate, always — ambiguity cannot be SEEN at LIMIT 1.
        expect(params.limit).toBeGreaterThan(1);
    });

    it('returns not_found when the access-scoped query returns nothing', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([]);
        const res = await resolveTitleForWrite(makeCtx(), { title: 'Nope' });
        expect(res.kind).toBe('not_found');
    });

    it('returns the single match', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([row({ media_id: 'u-1' })]);
        const res = await resolveTitleForWrite(makeCtx(), { title: 'Fenwick' });
        expect(res.kind).toBe('match');
        if (res.kind === 'match') expect(res.row.media_id).toBe('u-1');
    });

    it('refuses to guess between a same-named film and series', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            row({ media_id: 'movie-1', media_type: 'movie', release_date: '1996-01-01' }),
            row({ media_id: 'tv-1', media_type: 'tv', release_date: '2014-01-01' }),
        ]);
        const res = await resolveTitleForWrite(makeCtx(), { title: 'Fenwick' });
        expect(res.kind).toBe('ambiguous');
        if (res.kind === 'ambiguous') {
            expect(res.candidates).toHaveLength(2);
            expect(res.candidates.map((c) => c.mediaType)).toEqual(['movie', 'series']);
        }
    });

    it('a mediaType hint resolves the film/series collision', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            row({ media_id: 'movie-1', media_type: 'movie' }),
            row({ media_id: 'tv-1', media_type: 'tv', release_date: '2014-01-01' }),
        ]);
        const res = await resolveTitleForWrite(makeCtx(), { title: 'Fenwick', mediaType: 'tv' });
        expect(res.kind).toBe('match');
        if (res.kind === 'match') expect(res.row.media_id).toBe('tv-1');
    });

    it('refuses to guess between two same-titled remakes from different years', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            row({ media_id: 'a', title: 'The Thread', release_date: '1982-01-01' }),
            row({ media_id: 'b', title: 'The Thread', release_date: '2011-01-01' }),
        ]);
        const res = await resolveTitleForWrite(makeCtx(), { title: 'The Thread' });
        expect(res.kind).toBe('ambiguous');
    });

    it('sees a remake hiding behind two duplicate rows of the same work', async () => {
        // The check used to compare only rows[0] against rows[1]. Duplicate
        // catalog rows of ONE work (same type, same year) read as "no
        // ambiguity" and the genuinely different third row never got looked
        // at — so the write silently landed on whichever came first.
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            row({ media_id: 'a1', title: 'The Thread', release_date: '1982-01-01' }),
            row({ media_id: 'a2', title: 'The Thread', release_date: '1982-01-01' }),
            row({ media_id: 'b', title: 'The Thread', release_date: '2011-01-01' }),
        ]);
        const res = await resolveTitleForWrite(makeCtx(), { title: 'The Thread' });
        expect(res.kind).toBe('ambiguous');
        if (res.kind === 'ambiguous') {
            expect(res.candidates).toHaveLength(3);
        }
    });

    it('still matches when every same-titled row is the same work', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            row({ media_id: 'a1', title: 'Fenwick', release_date: '1996-01-01' }),
            row({ media_id: 'a2', title: 'Fenwick', release_date: '1996-01-01' }),
        ]);
        const res = await resolveTitleForWrite(makeCtx(), { title: 'Fenwick' });
        expect(res.kind).toBe('match');
        if (res.kind === 'match') expect(res.row.media_id).toBe('a1');
    });

    it('does not call a longer, differently-named title ambiguous', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            row({ media_id: 'a', title: 'Cloud Runner', release_date: '1982-01-01' }),
            row({ media_id: 'b', title: 'Cloud Runner 2049', release_date: '2017-01-01' }),
        ]);
        const res = await resolveTitleForWrite(makeCtx(), { title: 'Cloud Runner' });
        expect(res.kind).toBe('match');
        if (res.kind === 'match') expect(res.row.media_id).toBe('a');
    });

    it('treats punctuation and case differences as the SAME title', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            row({ media_id: 'a', title: 'HARB-E', release_date: '2008-01-01' }),
            row({ media_id: 'b', title: 'Harb E', release_date: '2015-01-01' }),
        ]);
        const res = await resolveTitleForWrite(makeCtx(), { title: 'HARB-E' });
        expect(res.kind).toBe('ambiguous');
    });

    it('passes the year through so the query narrows before we ever see rows', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([row({})]);
        await resolveTitleForWrite(makeCtx(), { title: 'Fenwick', year: 1996 });
        expect(vi.mocked(searchMediaByTitle).mock.calls[0][1].year).toBe(1996);
    });
});
