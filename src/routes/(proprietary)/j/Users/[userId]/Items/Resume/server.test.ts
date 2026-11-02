// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * GET /j/UserItems/Resume and the legacy /j/Users/{userId}/Items/Resume (audit
 * gap 7): MediaTypes / IncludeItemTypes / ExcludeItemTypes / ParentId /
 * SearchTerm / paging reach the query. SQL semantics live in
 * jellyfin-browse-g2.queries.integration.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseResumeQuery } from '$lib/server/proprietary/jellyfin-compat/resume-handler';

vi.setConfig({ testTimeout: 30_000 });

const { mockGetResumeItemsPage } = vi.hoisted(() => ({ mockGetResumeItemsPage: vi.fn() }));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (h: unknown) => h,
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) as never }));
vi.mock('$lib/server/config.js', () => ({ config: {}, LUMASTRA_MASTER_KEY: 'k' }));
vi.mock('$lib/server/config', () => ({ config: {}, LUMASTRA_MASTER_KEY: 'k' }));
vi.mock('$lib/server/database/queries/jellyfin-browse.queries', async (orig) => {
    const real =
        await orig<typeof import('$lib/server/database/queries/jellyfin-browse.queries')>();
    return {
        getResumeItemsPage: mockGetResumeItemsPage,
        mapJellyfinMediaTypes: real.mapJellyfinMediaTypes,
        mapJellyfinTypes: real.mapJellyfinTypes,
    };
});
vi.mock('$lib/server/proprietary/jellyfin-compat/access-context', () => ({
    buildJellyfinAccessContext: vi.fn(async () => ({
        boundary: { library: { kind: 'all' }, age: { kind: 'any' } },
        deniedGroupIds: [],
        ageRating: null,
    })),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/content-language', () => ({
    applyJellyfinContentLanguage: vi.fn(async () => {}),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/media-source-enrichment', () => ({
    enrichItemsWithMediaSources: vi.fn(async () => {}),
    dropFilelessPlayables: (items: unknown[]) => items,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/provider-ids-enrichment', () => ({
    enrichItemsWithProviderIds: vi.fn(async () => {}),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/music-artists-enrichment', () => ({
    enrichItemsWithMusicArtists: vi.fn(async () => {}),
}));
vi.mock('$lib/paraglide/messages', async () => {
    const { messagesStub } = await import('$lib/server/__testkit__/paraglide-messages-stub');
    return messagesStub;
});
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

const USER = { username: 'denis', userId: '00000000-0000-0000-0000-0000000000de' };
const MOVIE = {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    title: 'Movie',
    media_type: 'movie',
    runtime_seconds: 6000,
    resume_position_ms: 600_000,
    total_count: '7',
};

async function call(route: 'canonical' | 'legacy', query = ''): Promise<Record<string, unknown>> {
    const mod =
        route === 'canonical'
            ? await import('../../../../UserItems/Resume/+server')
            : await import('./+server');
    const res = await (mod.GET as (e: never) => Promise<Response>)({
        url: new URL(`http://localhost/j/UserItems/Resume${query}`),
        request: { method: 'GET', headers: { get: () => null } },
        locals: { user: USER },
        params: route === 'legacy' ? { userId: USER.userId } : {},
        route: { id: null },
    } as never);
    return (await res.json()) as Record<string, unknown>;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetResumeItemsPage.mockResolvedValue({ rows: [MOVIE], totalCount: 7 });
});

describe('parseResumeQuery', () => {
    const q = (s: string) => parseResumeQuery(new URL(`http://x/UserItems/Resume${s}`));

    it('defaults to movies and episodes', () => {
        expect(q('').filters.mediaTypes).toEqual(['movie', 'episode']);
    });
    it('MediaTypes=Audio is audio only — never a video', () => {
        expect(q('?MediaTypes=Audio').filters.mediaTypes).toEqual(['track']);
    });
    it('MediaTypes=Video', () => {
        expect(q('?MediaTypes=Video').filters.mediaTypes).toEqual(['movie', 'episode']);
    });
    it('IncludeItemTypes and ExcludeItemTypes', () => {
        expect(q('?IncludeItemTypes=Episode').filters.mediaTypes).toEqual(['episode']);
        expect(q('?ExcludeItemTypes=Movie').filters.mediaTypes).toEqual(['episode']);
        expect(q('?MediaTypes=Video&IncludeItemTypes=Audio').filters.mediaTypes).toEqual([]);
    });
    it('ParentId, SearchTerm, paging, EnableTotalRecordCount', () => {
        expect(
            q('?ParentId=lib-1&SearchTerm=dawn&StartIndex=10&Limit=5&EnableTotalRecordCount=false'),
        ).toEqual({
            limit: 5,
            filters: {
                mediaTypes: ['movie', 'episode'],
                parentId: 'lib-1',
                searchTerm: 'dawn',
                startIndex: 10,
            },
            enableTotalRecordCount: false,
        });
    });
    it('the user root folder is no parent', () => {
        expect(q('?ParentId=f27caa37e5142225cceded48f6553502').filters.parentId).toBeNull();
    });
});

describe('GET /UserItems/Resume', () => {
    it('passes the filters and reports the real total and StartIndex', async () => {
        const body = await call('canonical', '?MediaTypes=Video&StartIndex=3&Limit=2');
        expect(mockGetResumeItemsPage).toHaveBeenCalledWith(
            expect.anything(),
            USER.userId,
            2,
            expect.anything(),
            expect.objectContaining({ mediaTypes: ['movie', 'episode'], startIndex: 3 }),
            true,
        );
        expect(body).toMatchObject({ TotalRecordCount: 7, StartIndex: 3 });
        expect((body.Items as { Id: string }[]).map((i) => i.Id)).toEqual([MOVIE.id]);
    });

    it('answers empty without a query when no resumable type is asked for', async () => {
        const body = await call('canonical', '?MediaTypes=Photo');
        expect(body).toEqual({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
        expect(mockGetResumeItemsPage).not.toHaveBeenCalled();
    });

    it('the legacy route is the same handler', async () => {
        expect(await call('legacy', '?MediaTypes=Audio')).toEqual(
            await call('canonical', '?MediaTypes=Audio'),
        );
        expect(mockGetResumeItemsPage.mock.calls[0][4]).toMatchObject({ mediaTypes: ['track'] });
    });
});
