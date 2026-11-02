// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * GET /j/Shows/NextUp reads Jellyfin's paging and scoping parameters
 * (TvShowsController.GetNextUp) and reports the real total. Query semantics:
 * jellyfin-browse-g1.queries.integration.test.ts.
 */

import type { RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseNextUpQuery } from '$lib/server/proprietary/jellyfin-compat/next-up-query';

vi.setConfig({ testTimeout: 30_000 });

const { mockPage, mockAccess } = vi.hoisted(() => ({
    mockPage: vi.fn(),
    mockAccess: vi.fn(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) as never }));
vi.mock('$lib/server/config.js', () => ({
    config: { NEXT_UP_MAX_AGE_DAYS: 60, TMDB_LANGUAGE: 'en-US', METADATA_ADDITIONAL_LANGUAGES: [] },
    LUMASTRA_MASTER_KEY: 'test-key',
}));
vi.mock('$lib/server/config', () => ({
    config: { NEXT_UP_MAX_AGE_DAYS: 60, TMDB_LANGUAGE: 'en-US', METADATA_ADDITIONAL_LANGUAGES: [] },
    LUMASTRA_MASTER_KEY: 'test-key',
}));
vi.mock('$lib/server/database/queries/jellyfin-browse.queries', () => ({
    getNextUpEpisodesPage: mockPage,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/access-context', () => ({
    buildJellyfinAccessContext: mockAccess,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/content-language', () => ({
    applyJellyfinContentLanguage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/media-source-enrichment', () => ({
    // Every episode gains a source except the one titled "Fileless".
    enrichItemsWithMediaSources: vi.fn(
        async (_sql: unknown, items: Array<{ Name: string; MediaSources?: unknown[] }>) => {
            for (const i of items) if (i.Name !== 'Fileless') i.MediaSources = [{}];
        },
    ),
    dropFilelessPlayables: (items: Array<{ MediaSources?: unknown[] }>) =>
        items.filter((i) => (i.MediaSources?.length ?? 0) > 0),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/provider-ids-enrichment', () => ({
    enrichItemsWithProviderIds: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/paraglide/messages', async () => {
    const { messagesStub } = await import('$lib/server/__testkit__/paraglide-messages-stub');
    return messagesStub;
});
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const USER = { username: 'denis', userId: '00000000-0000-0000-0000-0000000000de' };
const LIB = '55555555-5555-5555-5555-555555555555';

function episode(id: number, title = `Ep ${id}`): Record<string, unknown> {
    return {
        id: `eeeeeeee-0000-0000-0000-${String(id).padStart(12, '0')}`,
        title,
        media_type: 'episode',
        season_number: 1,
        episode_number: id,
    };
}

async function call(query: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const { GET } = await import('./+server');
    const res = await (GET as (e: never) => Promise<Response>)({
        url: new URL(`http://localhost/j/Shows/NextUp${query}`),
        request: { method: 'GET', headers: { get: () => null } },
        locals: { user: USER },
        params: {},
        route: { id: null },
    } as never);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.mockResolvedValue({ boundary: { library: { kind: 'all' }, age: { kind: 'any' } } });
    mockPage.mockResolvedValue({ rows: [episode(3), episode(4)], totalCount: 9 });
});

describe('GET /j/Shows/NextUp', () => {
    it('pages with StartIndex and reports the real total', async () => {
        const { body } = await call('?StartIndex=4&Limit=2');
        const [, limit, , seriesId, maxAgeDays, page] = mockPage.mock.calls[0].slice(1);
        expect(limit).toBe(2);
        expect(seriesId).toBeNull();
        expect(maxAgeDays).toBe(60);
        expect(page).toMatchObject({ startIndex: 4 });
        expect(body).toMatchObject({ StartIndex: 4, TotalRecordCount: 9 });
        expect((body.Items as unknown[]).length).toBe(2);
    });

    it('passes ParentId, enableRewatching, enableResumable and nextUpDateCutoff', async () => {
        await call(
            `?ParentId=${LIB}&enableRewatching=false&enableResumable=false&nextUpDateCutoff=2026-09-01T00:00:00Z`,
        );
        expect(mockPage.mock.calls[0][6]).toMatchObject({
            parentId: LIB,
            requireUnwatchedNext: true,
            excludeResumable: true,
            minLastWatchedAt: new Date('2026-09-01T00:00:00Z'),
        });
    });

    it('a malformed SeriesId is an empty answer, not every series', async () => {
        const { body } = await call('?SeriesId=not-a-series&StartIndex=3');
        expect(mockPage).not.toHaveBeenCalled();
        expect(body).toEqual({ Items: [], TotalRecordCount: 0, StartIndex: 3 });
    });

    it('SeriesId still scopes to one series', async () => {
        await call(`?SeriesId=${LIB}`);
        expect(mockPage.mock.calls[0][4]).toBe(LIB);
    });

    it('a dropped fileless episode leaves the total too', async () => {
        mockPage.mockResolvedValue({ rows: [episode(1), episode(2, 'Fileless')], totalCount: 5 });
        const { body } = await call('');
        expect((body.Items as unknown[]).length).toBe(1);
        expect(body.TotalRecordCount).toBe(4);
    });
});

describe('parseNextUpQuery', () => {
    const parse = (q: string) => parseNextUpQuery(new URL(`http://localhost/j/Shows/NextUp${q}`));

    it('defaults: first page of 20, follows re-watches, resumable included, no cutoff', () => {
        expect(parse('')).toEqual({
            limit: 20,
            startIndex: 0,
            seriesId: null,
            malformedSeriesId: false,
            parentId: null,
            requireUnwatchedNext: false,
            excludeResumable: false,
            minLastWatchedAt: null,
        });
    });

    it('enableRewatching=true keeps following re-watches', () => {
        expect(parse('?enableRewatching=true').requireUnwatchedNext).toBe(false);
    });

    it('ignores DateTime.MinValue and garbage cutoffs, malformed ids and clamps Limit', () => {
        const q = parse(
            '?nextUpDateCutoff=0001-01-01T00:00:00&ParentId=not-an-id&SeriesId=1&Limit=5000&StartIndex=-3',
        );
        expect(q.minLastWatchedAt).toBeNull();
        expect(q.parentId).toBeNull();
        expect(q.seriesId).toBeNull();
        expect(q.malformedSeriesId).toBe(true);
        expect(q.limit).toBe(100);
        expect(q.startIndex).toBe(0);
        expect(parse('?nextUpDateCutoff=yesterday').minLastWatchedAt).toBeNull();
    });

    it('accepts Jellyfin-style dashless ids', () => {
        expect(parse('?ParentId=55555555555555555555555555555555').parentId).toBe(
            '55555555555555555555555555555555',
        );
    });
});
