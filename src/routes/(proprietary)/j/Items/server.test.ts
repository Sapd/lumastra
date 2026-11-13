// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /j/Items and the legacy GET /j/Users/{userId}/Items run ONE
 * implementation (items-handler.ts). These tests pin that both routes read the
 * same query the same way, and that the legacy route kept / gained the
 * behaviours it used to lack (root views, playlists, ArtistIds, scan limit).
 * SQL semantics live in jellyfin-browse-g1.queries.integration.test.ts.
 */

import type { RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const {
    mockBrowseMediaItems,
    mockBuildAccessContext,
    mockBuildLibraryViews,
    mockSearchMedia,
    mockGetOwnedPlaylists,
    mockGetSharedPlaylists,
    mockGetPlaylistItems,
    mockGetPlaylistWatchProgress,
    mockGetUserRole,
} = vi.hoisted(() => ({
    mockBrowseMediaItems: vi.fn(),
    mockBuildAccessContext: vi.fn(),
    mockBuildLibraryViews: vi.fn(),
    mockSearchMedia: vi.fn(),
    mockGetOwnedPlaylists: vi.fn(),
    mockGetSharedPlaylists: vi.fn(),
    mockGetPlaylistItems: vi.fn(),
    mockGetPlaylistWatchProgress: vi.fn(),
    mockGetUserRole: vi.fn(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) as never }));
vi.mock('$lib/server/config.js', () => ({
    config: { TMDB_LANGUAGE: 'en-US', METADATA_ADDITIONAL_LANGUAGES: [] },
    LUMASTRA_MASTER_KEY: 'test-key',
}));
vi.mock('$lib/server/config', () => ({
    config: { TMDB_LANGUAGE: 'en-US', METADATA_ADDITIONAL_LANGUAGES: [] },
    LUMASTRA_MASTER_KEY: 'test-key',
}));
vi.mock('$lib/server/database/queries/jellyfin-browse.queries', () => ({
    browseMediaItems: mockBrowseMediaItems,
    mapJellyfinMediaTypes: (m: string) =>
        m
            .split(',')
            .flatMap((t) =>
                t.trim().toLowerCase() === 'video'
                    ? ['movie', 'episode']
                    : t.trim().toLowerCase() === 'audio'
                      ? ['track']
                      : [],
            ),
    mapJellyfinTypes: (types: string) =>
        types
            .split(',')
            .map((t) => t.trim())
            .map(
                (t) =>
                    ({ Movie: 'movie', Series: 'tv', Episode: 'episode', Season: 'season' })[t] ??
                    t.toLowerCase(),
            ),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/access-context', () => ({
    buildJellyfinAccessContext: mockBuildAccessContext,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/folder-user-data', () => ({
    applyFolderUserData: vi.fn(async () => {}),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/library-views-utils', () => ({
    buildLibraryViews: mockBuildLibraryViews,
}));
vi.mock('$lib/server/database/queries/search.queries', () => ({ searchMedia: mockSearchMedia }));
vi.mock('$lib/server/database/queries/playlists.queries', () => ({
    getOwnedPlaylists: mockGetOwnedPlaylists,
    getSharedPlaylists: mockGetSharedPlaylists,
    getPlaylistItems: mockGetPlaylistItems,
    getPlaylistWatchProgress: mockGetPlaylistWatchProgress,
}));
vi.mock('$lib/server/utils/playlist-utils', () => ({ getUserRole: mockGetUserRole }));
vi.mock('$lib/server/proprietary/jellyfin-compat/content-language', () => ({
    applyJellyfinContentLanguage: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/media-source-enrichment', () => ({
    enrichItemsWithMediaSources: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/provider-ids-enrichment', () => ({
    enrichItemsWithProviderIds: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/music-artists-enrichment', () => ({
    enrichItemsWithMusicArtists: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/paraglide/messages', async () => {
    const { messagesStub } = await import('$lib/server/__testkit__/paraglide-messages-stub');
    return messagesStub;
});
vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

const USER = {
    username: 'denis',
    userId: '00000000-0000-0000-0000-0000000000de',
    isAdmin: false,
};
const BOUNDARY = { library: { kind: 'all' }, age: { kind: 'any' } };
const MOVIE_ROW = {
    id: 'aaaaaaaa-0000-0000-0000-000000000001',
    title: 'A Movie',
    media_type: 'movie',
    year: 2020,
};

type Route = 'items' | 'legacy';

function event(route: Route, query: string): never {
    const path = route === 'items' ? '/j/Items' : `/j/Users/${USER.userId}/Items`;
    return {
        url: new URL(`http://localhost${path}${query}`),
        request: { method: 'GET', headers: { get: () => null } },
        locals: { user: USER },
        params: route === 'items' ? {} : { userId: USER.userId },
        route: { id: null },
    } as never;
}

async function call(route: Route, query = ''): Promise<{ status: number; body: unknown }> {
    const mod =
        route === 'items'
            ? await import('./+server')
            : await import('../Users/[userId]/Items/+server');
    const res = await (mod.GET as (e: never) => Promise<Response>)(event(route, query));
    return { status: res.status, body: await res.json() };
}

/** The options object browseMediaItems received on its last call. */
function lastBrowse(): Record<string, unknown> {
    return mockBrowseMediaItems.mock.calls.at(-1)?.[1] as Record<string, unknown>;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockBuildAccessContext.mockResolvedValue({
        boundary: BOUNDARY,
        deniedGroupIds: [],
        ageRating: null,
    });
    mockBrowseMediaItems.mockResolvedValue({ rows: [MOVIE_ROW], totalCount: 1 });
    mockBuildLibraryViews.mockResolvedValue([{ Id: 'view-1', Name: 'Movies' }]);
    mockGetOwnedPlaylists.mockResolvedValue([{ id: 7, name: 'Mine', item_count: 2 }]);
    mockGetSharedPlaylists.mockResolvedValue([]);
    mockGetPlaylistWatchProgress.mockResolvedValue([]);
    mockGetPlaylistItems.mockResolvedValue([{ media_id: MOVIE_ROW.id, title: 'A Movie' }]);
    mockGetUserRole.mockResolvedValue({ role: 'owner' });
    mockSearchMedia.mockResolvedValue([{ internal_id: MOVIE_ROW.id }]);
});

describe('/Items and /Users/{userId}/Items share one implementation', () => {
    const QUERY =
        '?ParentId=11111111-1111-1111-1111-111111111111&IncludeItemTypes=Movie&SortBy=DateCreated,SortName&SortOrder=Descending&StartIndex=20&Limit=10&Genres=Drama&Years=2020,2021&NameStartsWith=A&Filters=IsUnplayed';

    it('passes the identical browse options and returns the identical body', async () => {
        const a = await call('items', QUERY);
        const itemsOptions = lastBrowse();
        const b = await call('legacy', QUERY);
        const legacyOptions = lastBrowse();

        expect(legacyOptions).toEqual(itemsOptions);
        expect(b).toEqual(a);
        expect(itemsOptions).toMatchObject({
            mediaTypes: ['movie'],
            sortBy: 'DateCreated,SortName',
            sortOrder: 'Descending',
            startIndex: 20,
            limit: 10,
            genres: ['Drama'],
            years: [2020, 2021],
            nameStartsWith: 'A',
            isPlayed: false,
            access: BOUNDARY,
        });
    });

    it.each<Route>(['items', 'legacy'])(
        '%s: a bare request returns the library views',
        async (r) => {
            const { body } = await call(r);
            expect(mockBuildLibraryViews).toHaveBeenCalledTimes(1);
            expect(mockBrowseMediaItems).not.toHaveBeenCalled();
            expect(body).toMatchObject({ Items: [{ Id: 'view-1' }], TotalRecordCount: 1 });
        },
    );

    it.each<Route>(['items', 'legacy'])(
        '%s: IncludeItemTypes=Playlist lists playlists',
        async (r) => {
            const { body } = await call(r, '?IncludeItemTypes=Playlist');
            expect(mockGetOwnedPlaylists).toHaveBeenCalledTimes(1);
            expect(body).toMatchObject({
                Items: [
                    { Type: 'Playlist', Name: 'Mine', Id: '00000000-0000-4000-8000-000000000007' },
                ],
                TotalRecordCount: 1,
            });
        },
    );

    it.each<Route>(['items', 'legacy'])('%s: ParentId=<playlist> lists its items', async (r) => {
        const { body } = await call(r, '?ParentId=00000000-0000-4000-8000-000000000007');
        expect(mockGetUserRole).toHaveBeenCalledWith(expect.anything(), 7, USER.username);
        expect(lastBrowse()).toMatchObject({ idList: [MOVIE_ROW.id] });
        expect(body).toMatchObject({ Items: [{ Id: MOVIE_ROW.id }], TotalRecordCount: 1 });
    });

    it.each<Route>(['items', 'legacy'])(
        '%s: a playlist the user cannot see is a 404',
        async (r) => {
            mockGetUserRole.mockResolvedValue({ role: null });
            const { status } = await call(r, '?ParentId=00000000-0000-4000-8000-000000000007');
            expect(status).toBe(404);
            expect(mockGetPlaylistItems).not.toHaveBeenCalled();
        },
    );

    it.each<Route>(['items', 'legacy'])('%s: ArtistIds reaches the query', async (r) => {
        await call(r, '?IncludeItemTypes=MusicAlbum&ArtistIds=a1,a2&Recursive=true');
        expect(lastBrowse()).toMatchObject({ artistIds: ['a1', 'a2'] });
    });

    it.each<Route>(['items', 'legacy'])(
        '%s: Recursive without Limit pages up to the scan cap',
        async (r) => {
            await call(r, '?Recursive=true&IncludeItemTypes=Movie');
            expect(lastBrowse()).toMatchObject({ limit: 10000 });
            await call(r, '?IncludeItemTypes=Movie&Limit=5000');
            expect(lastBrowse()).toMatchObject({ limit: 100 });
        },
    );

    it.each<Route>(['items', 'legacy'])(
        '%s: a season folder without SortBy is served in episode order',
        async (r) => {
            await call(r, '?ParentId=22222222-2222-2222-2222-222222222222');
            expect(lastBrowse()).toMatchObject({ forceEpisodeOrder: true });
            await call(r, '?ParentId=22222222-2222-2222-2222-222222222222&SortBy=SortName');
            expect(lastBrowse()).toMatchObject({ forceEpisodeOrder: false });
        },
    );

    it('an untyped search covers episodes only on the legacy route (unchanged)', async () => {
        await call('items', '?SearchTerm=foo');
        expect(mockSearchMedia.mock.calls.at(-1)?.[3]).toMatchObject({
            mediaTypes: ['movie', 'tv', 'music'],
        });
        await call('legacy', '?SearchTerm=foo');
        expect(mockSearchMedia.mock.calls.at(-1)?.[3]).toMatchObject({
            mediaTypes: ['movie', 'tv', 'episode', 'music'],
        });
    });
});

describe('/Items filter parameters reach the query', () => {
    it.each<Route>(['items', 'legacy'])(
        '%s: booleans, exclusions, media types, genre ids, recursion',
        async (r) => {
            await call(
                r,
                '?ParentId=33333333-3333-3333-3333-333333333333&Recursive=true&isFavorite=true&isPlayed=false&ExcludeItemTypes=Series,Season&MediaTypes=Video&GenreIds=abc,def&Genres=Action|Science Fiction',
            );
            expect(lastBrowse()).toMatchObject({
                isFavorite: true,
                isPlayed: false,
                isResumable: false,
                isFolder: null,
                excludeMediaTypes: ['tv', 'season'],
                playableMediaTypes: ['movie', 'episode'],
                genreIds: ['abc', 'def'],
                genres: ['Action', 'Science Fiction'],
                recursive: true,
                parentId: '33333333-3333-3333-3333-333333333333',
            });
        },
    );

    it('Filters=IsResumable,IsNotFolder', async () => {
        await call('items', '?Filters=IsResumable,IsNotFolder&Recursive=true');
        expect(lastBrowse()).toMatchObject({ isResumable: true, isFolder: false });
    });

    it('Filters=IsFavoriteOrLikes means the favourites', async () => {
        await call('items', '?Filters=IsFavoriteOrLikes&IncludeItemTypes=Movie');
        expect(lastBrowse()).toMatchObject({ isFavorite: true });
    });

    it('Filters override the isPlayed boolean, like ApplyFilters', async () => {
        await call('items', '?isPlayed=true&Filters=IsUnplayed&IncludeItemTypes=Movie');
        expect(lastBrowse()).toMatchObject({ isPlayed: false });
    });

    it('isFavorite=false is a real filter (not ignored) and leaves the root views', async () => {
        await call('items', '?isFavorite=false');
        expect(mockBuildLibraryViews).not.toHaveBeenCalled();
        expect(lastBrowse()).toMatchObject({ isFavorite: false });
    });

    it('contradictory Filters are a client error like Jellyfin (422 in our taxonomy)', async () => {
        const { status } = await call('items', '?Filters=IsPlayed,IsUnplayed');
        expect(status).toBe(422);
        expect(mockBrowseMediaItems).not.toHaveBeenCalled();
    });
});

describe('/Items SearchTerm', () => {
    it.each<Route>(['items', 'legacy'])(
        '%s: filters and ParentId apply to the ranked ids; the total is the filtered total',
        async (r) => {
            mockSearchMedia.mockResolvedValue([
                { internal_id: 'id-1' },
                { internal_id: 'id-2' },
                { internal_id: 'id-1' },
            ]);
            mockBrowseMediaItems.mockResolvedValue({ rows: [MOVIE_ROW], totalCount: 37 });

            const { body } = await call(
                r,
                '?SearchTerm=star&ParentId=44444444-4444-4444-4444-444444444444&IncludeItemTypes=Movie,Episode&isPlayed=false&Years=1977&StartIndex=10&Limit=5',
            );

            expect(mockSearchMedia.mock.calls.at(-1)?.[3]).toMatchObject({
                limit: 500,
                offset: 0,
                mediaTypes: ['movie', 'episode'],
            });
            expect(lastBrowse()).toMatchObject({
                idList: ['id-1', 'id-2'],
                orderByIdList: true,
                parentId: '44444444-4444-4444-4444-444444444444',
                mediaTypes: ['movie', 'episode'],
                isPlayed: false,
                years: [1977],
                startIndex: 10,
                limit: 5,
            });
            expect(body).toMatchObject({ TotalRecordCount: 37, StartIndex: 10 });
        },
    );

    it('a search for only unsearchable types is empty without touching the index', async () => {
        const { body } = await call('items', '?SearchTerm=x&IncludeItemTypes=Person');
        expect(mockSearchMedia).not.toHaveBeenCalled();
        expect(body).toMatchObject({ Items: [], TotalRecordCount: 0 });
    });
});

describe('/Items ParentId=<user root folder>', () => {
    it('is the root (library views), with or without dashes', async () => {
        const { USER_ROOT_FOLDER_ID } =
            await import('$lib/server/proprietary/jellyfin-compat/constants');
        await call('items', `?ParentId=${USER_ROOT_FOLDER_ID}`);
        expect(mockBuildLibraryViews).toHaveBeenCalledTimes(1);
        const dashed = USER_ROOT_FOLDER_ID.replace(
            /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
            '$1-$2-$3-$4-$5',
        ).toUpperCase();
        await call('legacy', `?ParentId=${dashed}&IncludeItemTypes=Movie&Recursive=true`);
        expect(lastBrowse()).toMatchObject({ parentId: null, mediaTypes: ['movie'] });
    });
});
