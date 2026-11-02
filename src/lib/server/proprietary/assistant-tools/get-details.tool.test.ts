// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `get_details` assistant tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDetailsTool } from './get-details.tool.js';
import type { AssistantToolContext } from './types.js';
import type { AssistantMovieRow } from '../../database/queries/assistant-rag.queries.js';
import { toUserId } from '$lib/shared/user-id.js';

const TEST_USER_ID = toUserId('00000000-0000-0000-0000-000000000001');

vi.mock('../../database/queries/assistant-rag.queries.js', () => ({
    searchMediaByTitle: vi.fn(),
    getAllProviderKeywords: vi.fn(),
}));
vi.mock('../../database/queries/media-details.queries.js', () => ({
    getMediaDetailByUuid: vi.fn(),
}));
vi.mock('../../database/queries/media-lookup.queries.js', () => ({
    getMediaDetailsById: vi.fn(),
}));
vi.mock('../../database/queries/library-groups.queries.js', () => ({
    getMediaItemLibraryNames: vi.fn(),
}));

import {
    searchMediaByTitle,
    getAllProviderKeywords,
} from '../../database/queries/assistant-rag.queries.js';
import { getMediaDetailByUuid } from '../../database/queries/media-details.queries.js';
import { getMediaDetailsById } from '../../database/queries/media-lookup.queries.js';
import { getMediaItemLibraryNames } from '../../database/queries/library-groups.queries.js';
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

const seriesMatch = {
    media_id: 'uuid-1',
    primary_ext_id: '1396',
    media_type: 'tv',
    title: 'Drifting Clouds',
    is_available: true,
    can_request: false,
} as unknown as AssistantMovieRow;

describe('getDetailsTool', () => {
    // The mediaType argument was a no-op: searchMediaByTitle ended in LIMIT 1,
    // so `matches` never held more than one row to choose between.
    // The model cites `ref` to make a title clickable. get_details emitted no
    // ref at all, so it improvised `ref:0:movie` — a dead link on the flagship
    // "tell me about X" path, even though the id was available.
    it('returns a citable ref built from the resolved title id', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            {
                media_id: 'm1',
                primary_ext_id: '872585',
                media_type: 'movie',
                title: 'Orionkeeper',
            },
        ] as never);
        vi.mocked(getAllProviderKeywords).mockResolvedValue([]);
        vi.mocked(getMediaDetailByUuid).mockResolvedValue(null as never);
        vi.mocked(getMediaDetailsById).mockResolvedValue(null as never);
        vi.mocked(getMediaItemLibraryNames).mockResolvedValue([]);

        const result = await getDetailsTool.execute({ title: 'Orionkeeper' }, makeCtx());

        expect(JSON.parse(result.summaryForModel).ref).toBe('872585:movie');
    });

    // The card's mediaType is the PUBLIC vocabulary, and resolveMovieByRef
    // compares `${id}:${card.mediaType}` — so a series ref must say 'series'.
    // ':tv' matches nothing and renders as a dead link.
    it('emits a series ref in the public vocabulary, not the DB one', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            { media_id: 'm2', primary_ext_id: '60573', media_type: 'tv', title: 'Starhaven' },
        ] as never);
        vi.mocked(getAllProviderKeywords).mockResolvedValue([]);
        vi.mocked(getMediaDetailByUuid).mockResolvedValue(null as never);
        vi.mocked(getMediaDetailsById).mockResolvedValue(null as never);
        vi.mocked(getMediaItemLibraryNames).mockResolvedValue([]);

        const result = await getDetailsTool.execute({ title: 'Starhaven' }, makeCtx());

        expect(JSON.parse(result.summaryForModel).ref).toBe('60573:series');
    });

    it('asks for several candidates so mediaType can actually disambiguate', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([
            { media_id: 'm-film', media_type: 'movie', title: 'Fenwick' },
            { media_id: 'm-series', media_type: 'tv', title: 'Fenwick' },
        ] as never);

        vi.mocked(getAllProviderKeywords).mockResolvedValue([]);
        vi.mocked(getMediaDetailByUuid).mockResolvedValue(null as never);
        vi.mocked(getMediaDetailsById).mockResolvedValue(null as never);
        vi.mocked(getMediaItemLibraryNames).mockResolvedValue([]);

        const result = await getDetailsTool.execute(
            { title: 'Fenwick', mediaType: 'tv' },
            makeCtx(),
        );

        // ...and the series row, not the film, is what gets described.
        expect(JSON.parse(result.summaryForModel).mediaType).toBe('tv');

        expect(vi.mocked(searchMediaByTitle).mock.calls.at(-1)?.[1].limit).toBeGreaterThan(1);
    });
    beforeEach(() => vi.clearAllMocks());

    it('aggregates rich detail incl. tags, languages, library, season/episode counts', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([seriesMatch]);
        vi.mocked(getMediaDetailByUuid).mockResolvedValue({
            title: 'Drifting Clouds',
            media_type: 'tv',
            release_date: '2008',
            overview: 'A chemistry teacher...',
            genres: ['Drama', 'Crime'],
            keywords: ['whodunit', 'antihero'],
            actors: ['Bryan Cranston', 'Aaron Paul'],
            directors: ['Vince Gilligan'],
            runtime_minutes: 49,
            certification: 'TV-MA',
            imdb_rating: 9.5,
            season_count: 5,
            episode_count: 62,
            status: 'Ended',
        } as unknown as Awaited<ReturnType<typeof getMediaDetailByUuid>>);
        vi.mocked(getMediaDetailsById).mockResolvedValue({
            audio_languages: ['en', 'es'],
            subtitle_languages: ['en', 'de'],
        } as unknown as Awaited<ReturnType<typeof getMediaDetailsById>>);
        vi.mocked(getMediaItemLibraryNames).mockResolvedValue(['TV Shows']);
        // Rich tags come from ALL provider rows (mdblist), not just the detail
        // row — include a tag absent from getMediaDetailByUuid.keywords.
        vi.mocked(getAllProviderKeywords).mockResolvedValue([
            'whodunit',
            'murder mystery',
            'antihero',
        ]);

        const result = await getDetailsTool.execute({ title: 'Drifting Clouds' }, makeCtx());

        const d = JSON.parse(result.summaryForModel);
        expect(d.found).toBe(true);
        expect(d.tags).toContain('whodunit');
        expect(d.tags).toContain('murder mystery'); // from a non-detail provider row
        expect(d.genres).toContain('Crime');
        expect(d.cast).toContain('Bryan Cranston');
        expect(d.audioLanguages).toEqual(['en', 'es']);
        expect(d.subtitleLanguages).toEqual(['en', 'de']);
        expect(d.libraries).toEqual(['TV Shows']);
        expect(d.seasonCount).toBe(5);
        expect(d.episodeCount).toBe(62);
        expect(result.media).toHaveLength(1); // resolved item as a card
    });

    it('resolves through the access-scoped title search', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([seriesMatch]);
        vi.mocked(getMediaDetailByUuid).mockResolvedValue(null);
        vi.mocked(getMediaDetailsById).mockResolvedValue(null);
        vi.mocked(getMediaItemLibraryNames).mockResolvedValue([]);
        vi.mocked(getAllProviderKeywords).mockResolvedValue([]);

        await getDetailsTool.execute({ title: 'Drifting Clouds' }, makeCtx());
        const call = vi.mocked(searchMediaByTitle).mock.calls[0];
        expect(call[1].access).toEqual({
            library: { kind: 'denyGroups', ids: ['g1'] },
            age: { kind: 'any' },
        });
        // Library-name lookup is access-scoped (denied groups passed through).
        expect(vi.mocked(getMediaItemLibraryNames).mock.calls[0][2]).toEqual(['g1']);
    });

    it('reports not-found without throwing when nothing resolves', async () => {
        vi.mocked(searchMediaByTitle).mockResolvedValue([]);
        const result = await getDetailsTool.execute({ title: 'Nonexistent' }, makeCtx());
        expect(JSON.parse(result.summaryForModel).found).toBe(false);
        expect(result.media).toBeUndefined();
    });
});
