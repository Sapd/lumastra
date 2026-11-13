// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Official jellyfin-web/SDK regressions: real routes, auth middleware, PG and Valkey. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey';
import { truncateTables, TEST_TABLES } from '../integration/helpers/cleanup.js';
import { ensureTestUser } from '../integration/fixtures/user.fixtures.js';
import { getOrCreatePassword } from '$lib/server/proprietary/jellyfin-compat/auth';
import { storeQuickConnectRequest } from '$lib/server/proprietary/jellyfin-compat/quick-connect-store';
import { callAndCheck, jfEvent, mintJfSession, type RouteHandler } from './harness';
import { seedEpisodeExternalSrt, seedMovieEmbeddedSubs, seedMusicAlbum } from './seed';
import { GET as userGet } from '../../src/routes/(proprietary)/j/Users/[userId]/+server';
import { GET as userItemsGet } from '../../src/routes/(proprietary)/j/Users/[userId]/Items/+server';
import { GET as itemGet } from '../../src/routes/(proprietary)/j/Users/[userId]/Items/[itemId]/+server';
import { GET as viewsGet } from '../../src/routes/(proprietary)/j/Users/[userId]/Views/+server';
import { GET as itemsGet } from '../../src/routes/(proprietary)/j/Items/+server';
import { GET as artistsGet } from '../../src/routes/(proprietary)/j/Artists/+server';
import { GET as albumArtistsGet } from '../../src/routes/(proprietary)/j/Artists/AlbumArtists/+server';
import { POST as favoritePost } from '../../src/routes/(proprietary)/j/Users/[userId]/FavoriteItems/[itemId]/+server';
import { POST as playedPost } from '../../src/routes/(proprietary)/j/Users/[userId]/PlayedItems/[itemId]/+server';
import { POST as authPost } from '../../src/routes/(proprietary)/j/Users/AuthenticateByName/+server';
import { POST as quickConnectPost } from '../../src/routes/(proprietary)/j/Users/AuthenticateWithQuickConnect/+server';
import { POST as playlistCreatePost } from '../../src/routes/(proprietary)/j/Playlists/+server';

const USER_ID = '40c8943e-e6fe-4721-9dee-7f9c5029fb4d';
const COMPACT_ID = USER_ID.replaceAll('-', '');
const OTHER_ID = '00000000-0000-4000-8000-00000000beef';
let sql: postgres.Sql;
let token: string;
let username: string;
let movieId: string;
let seriesId: string;

interface Items {
    Items: { Id: string; Type: string; UserData: { IsFavorite: boolean } }[];
    TotalRecordCount: number;
    StartIndex: number;
}

beforeAll(async () => {
    sql = getTestDb();
    if (!(await connectValkey())) throw new Error('Valkey not reachable');
});
afterAll(async () => {
    await disconnectValkey();
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
    await ensureTestUser(sql, USER_ID);
    await ensureTestUser(sql, OTHER_ID);
    await sql`UPDATE users SET is_admin = false, admin_pinned = false WHERE id = ${USER_ID}`;
    [{ username }] = await sql<
        { username: string }[]
    >`SELECT username FROM users WHERE id = ${USER_ID}`;
    token = await mintJfSession(sql, { userId: USER_ID, username });
    movieId = (await seedMovieEmbeddedSubs(sql)).itemId;
    seriesId = (await seedEpisodeExternalSrt(sql)).seriesId;
});

function check(
    name: string,
    schema: string,
    handler: RouteHandler,
    path: string,
    params: Record<string, string> = {},
    method: 'GET' | 'POST' = 'GET',
    legacy = false,
): Promise<unknown> {
    return callAndCheck(
        name,
        schema,
        handler,
        jfEvent({ method, path, params, token }),
        legacy ? { legacySchema: schema } : {},
    );
}

// The shared query sent by jellyfin-web 12.4's favourites tabs.
const WEB_FAVORITES =
    'SortBy=SeriesSortName%2CSortName&SortOrder=Ascending&Filters=IsFavorite&Recursive=true&Fields=PrimaryImageAspectRatio&CollapseBoxSetItems=false&ExcludeLocationTypes=Virtual&EnableTotalRecordCount=false&Limit=20';

describe('F1 — compact compat user IDs', () => {
    it.each(['password', 'quick-connect'] as const)(
        '%s login returns an ID GET /Users/{id} accepts',
        async (mode) => {
            let body: unknown;
            if (mode === 'password') {
                body = await callAndCheck(
                    'web-auth-password',
                    'AuthenticationResult',
                    authPost,
                    jfEvent({
                        method: 'POST',
                        path: '/j/Users/AuthenticateByName',
                        params: {},
                        body: { Username: username, Pw: await getOrCreatePassword(USER_ID) },
                    }),
                );
            } else {
                const secret = crypto.randomUUID().replaceAll('-', '');
                expect(
                    await storeQuickConnectRequest(
                        '831492',
                        secret,
                        JSON.stringify({
                            code: '831492',
                            authenticated: true,
                            userId: USER_ID,
                            username,
                            isAdmin: false,
                            groups: [],
                            displayName: null,
                        }),
                    ),
                ).toBe(true);
                body = await callAndCheck(
                    'web-auth-quick-connect',
                    'AuthenticationResult',
                    quickConnectPost,
                    jfEvent({
                        method: 'POST',
                        path: '/j/Users/AuthenticateWithQuickConnect',
                        params: {},
                        body: { Secret: secret },
                    }),
                );
            }
            const auth = body as { AccessToken: string; User: { Id: string } };
            expect(auth.User.Id).toBe(COMPACT_ID);
            token = auth.AccessToken;
            expect(
                await check(`web-user-${mode}`, 'UserDto', userGet, `/j/Users/${auth.User.Id}`, {
                    userId: auth.User.Id,
                }),
            ).toMatchObject({ Id: COMPACT_ID });
        },
    );

    it.each([USER_ID, COMPACT_ID, COMPACT_ID.toUpperCase()])(
        'accepts user ID %s across legacy routes',
        async (userId) => {
            const params = { userId, itemId: movieId };
            await check('web-user-forms', 'UserDto', userGet, `/j/Users/${userId}`, params);
            await check(
                'web-user-views',
                'BaseItemDtoQueryResult',
                viewsGet,
                `/j/Users/${userId}/Views`,
                params,
                'GET',
                true,
            );
            await check(
                'web-user-items',
                'BaseItemDtoQueryResult',
                userItemsGet,
                `/j/Users/${userId}/Items?Recursive=true`,
                params,
                'GET',
                true,
            );
            await check(
                'web-user-item',
                'BaseItemDto',
                itemGet,
                `/j/Users/${userId}/Items/${movieId}`,
                params,
                'GET',
                true,
            );
            expect(
                await check(
                    'web-user-favorite',
                    'UserItemDataDto',
                    favoritePost,
                    `/j/Users/${userId}/FavoriteItems/${movieId}`,
                    params,
                    'POST',
                    true,
                ),
            ).toMatchObject({ IsFavorite: true });
            expect(
                await check(
                    'web-user-played',
                    'UserItemDataDto',
                    playedPost,
                    `/j/Users/${userId}/PlayedItems/${movieId}`,
                    params,
                    'POST',
                    true,
                ),
            ).toMatchObject({ Played: true });
        },
    );

    it('admin lookup accepts compact target IDs and rejects malformed IDs cleanly', async () => {
        await sql`UPDATE users SET is_admin = true, admin_pinned = true WHERE id = ${OTHER_ID}`;
        const [{ username: adminName }] = await sql<
            { username: string }[]
        >`SELECT username FROM users WHERE id = ${OTHER_ID}`;
        token = await mintJfSession(sql, { userId: OTHER_ID, username: adminName });
        expect(
            await check('web-admin-user', 'UserDto', userGet, `/j/Users/${COMPACT_ID}`, {
                userId: COMPACT_ID,
            }),
        ).toMatchObject({ Id: COMPACT_ID });
        const response = await userGet(
            jfEvent({
                method: 'GET',
                path: '/j/Users/invalid',
                params: { userId: 'invalid' },
                token,
            }) as never,
        );
        expect(response.status).toBe(404);
    });

    it('returns one not-found message for foreign, legacy-provider and invalid IDs', async () => {
        await sql`UPDATE users SET jellyfin_user_id = '11111111111111111111111111111111' WHERE id = ${USER_ID}`;
        for (const userId of [
            OTHER_ID,
            OTHER_ID.replaceAll('-', ''),
            '11111111111111111111111111111111',
            'invalid',
        ]) {
            const response = await userGet(
                jfEvent({
                    method: 'GET',
                    path: `/j/Users/${userId}`,
                    params: { userId },
                    token,
                }) as never,
            );
            expect(response.status).toBe(404);
            expect(await response.json()).toMatchObject({ error: 'User not found' });
        }
    });
});

describe('F2 — favourites apply to every returned type', () => {
    beforeEach(async () => {
        await seedMusicAlbum(sql);
        await check(
            'web-favorite-add',
            'UserItemDataDto',
            favoritePost,
            `/j/Users/${COMPACT_ID}/FavoriteItems/${movieId}`,
            { userId: COMPACT_ID, itemId: movieId },
            'POST',
            true,
        );
    });

    it.each(['Playlist', 'MusicArtist', 'Movie', 'Series', 'MusicAlbum', 'Audio'])(
        'filters %s on the legacy Items route',
        async (type) => {
            const body = (await check(
                `web-favorites-${type}`,
                'BaseItemDtoQueryResult',
                userItemsGet,
                `/j/Users/${COMPACT_ID}/Items?${WEB_FAVORITES}&IncludeItemTypes=${type}`,
                { userId: COMPACT_ID },
                'GET',
                true,
            )) as Items;
            expect(body.Items.map((i) => i.Id)).toEqual(type === 'Movie' ? [movieId] : []);
            expect(body.TotalRecordCount).toBe(body.Items.length);
            expect(body.Items.every((i) => i.UserData.IsFavorite)).toBe(true);
        },
    );

    it.each([
        ['artists', artistsGet],
        ['album-artists', albumArtistsGet],
    ] as const)(
        '%s excludes unfavourited artists and preserves ordinary browsing',
        async (name, handler) => {
            const ordinary = (await check(
                `web-${name}-all`,
                'BaseItemDtoQueryResult',
                handler,
                '/j/Artists?Limit=20',
            )) as Items;
            expect(ordinary.Items).toHaveLength(1);
            for (const filter of [WEB_FAVORITES, 'IsFavorite=true', 'Filters=IsFavoriteOrLikes']) {
                const body = (await check(
                    `web-${name}-favorites`,
                    'BaseItemDtoQueryResult',
                    handler,
                    `/j/Artists?${filter}&userId=${COMPACT_ID}`,
                )) as Items;
                expect(body.Items).toEqual([]);
                expect(body.TotalRecordCount).toBe(0);
            }
            const playlists = (await check(
                'web-playlists-all',
                'BaseItemDtoQueryResult',
                userItemsGet,
                `/j/Users/${COMPACT_ID}/Items?IncludeItemTypes=Playlist`,
                { userId: COMPACT_ID },
                'GET',
                true,
            )) as Items;
            expect(playlists.Items).toHaveLength(1); // Watchlist created by the favourite write.
        },
    );
});

describe('F3 — all requested catalog types', () => {
    it.each([
        ['csv', 'IncludeItemTypes=Movie,Series'],
        [
            'sdk',
            'includeItemTypes=Movie&includeItemTypes=Series&includeItemTypes=Episode&includeItemTypes=MusicAlbum&includeItemTypes=Audio',
        ],
    ])('%s encoding works on both Items routes', async (name, query) => {
        const music = await seedMusicAlbum(sql);
        for (const [route, handler, params, legacy] of [
            ['/j/Items', itemsGet, {}, false],
            [`/j/Users/${COMPACT_ID}/Items`, userItemsGet, { userId: COMPACT_ID }, true],
        ] as const) {
            const body = (await check(
                `web-catalog-${name}-${legacy}`,
                'BaseItemDtoQueryResult',
                handler,
                `${route}?userId=${COMPACT_ID}&limit=100&recursive=true&fields=MediaSources&fields=MediaStreams&fields=Path&${query}`,
                params,
                'GET',
                legacy,
            )) as Items;
            expect(body.Items.map((i) => i.Id)).toContain(movieId);
            expect(body.Items.map((i) => i.Id)).toContain(seriesId);
            if (name === 'sdk') {
                expect(new Set(body.Items.map((i) => i.Type))).toEqual(
                    new Set(['Movie', 'Series', 'Episode', 'MusicAlbum', 'Audio']),
                );
                expect(body.Items.map((i) => i.Id)).toContain(music.albumId);
                expect(body.Items.map((i) => i.Id)).toContain(music.trackId);
            } else {
                expect(body.TotalRecordCount).toBe(2);
            }
        }
    });
});

interface Found {
    Items: { Id: string; Name: string; Type: string }[];
    TotalRecordCount: number;
}

describe('F4 — SearchTerm applies to every requested type', () => {
    async function createPlaylist(label: string, Name: string, Ids: string[]): Promise<string> {
        const body = (await callAndCheck(
            label,
            'PlaylistCreationResult',
            playlistCreatePost,
            jfEvent({
                method: 'POST',
                path: '/j/Playlists',
                token,
                params: {},
                body: { Name, Ids, MediaType: 'Video' },
            }),
        )) as { Id: string };
        return body.Id;
    }

    const find = async (name: string, query: string): Promise<Found> =>
        (await check(name, 'BaseItemDtoQueryResult', itemsGet, `/j/Items?${query}`)) as Found;

    beforeEach(async () => {
        await createPlaylist('f4-playlist-picks', 'Contract Picks', [movieId]);
        await createPlaylist('f4-playlist-weekend', 'Weekend Watchlist', [movieId]);
    });

    it('a web search naming Movie, Series and Playlist returns the matching media and only the matching playlist', async () => {
        const body = await find(
            'f4-web-search',
            'searchTerm=Contract&IncludeItemTypes=Movie&IncludeItemTypes=Series&IncludeItemTypes=Playlist&Recursive=true&Fields=PrimaryImageAspectRatio&Limit=20',
        );
        expect(body.Items.map((i) => i.Id)).toEqual(expect.arrayContaining([movieId, seriesId]));
        expect(body.Items.map((i) => `${i.Type}:${i.Name}`).sort()).toEqual([
            'Movie:Contract Movie',
            'Playlist:Contract Picks',
            'Series:Contract Series',
        ]);
        expect(body.TotalRecordCount).toBe(3);
    });

    it('pages the combined playlist and media list without losing or repeating entries', async () => {
        const seen = new Set<string>();
        for (const start of [0, 1, 2]) {
            const body = await find(
                `f4-web-page-${start}`,
                `searchTerm=Contract&IncludeItemTypes=Movie&IncludeItemTypes=Series&IncludeItemTypes=Playlist&Recursive=true&StartIndex=${start}&Limit=1`,
            );
            expect(body.Items).toHaveLength(1);
            expect(body.TotalRecordCount).toBe(3);
            seen.add(`${body.Items[0].Type}:${body.Items[0].Name}`);
        }
        expect(seen.size).toBe(3);
    });

    it('IncludeItemTypes=Playlist with SearchTerm lists only the playlists whose name matches', async () => {
        const body = await find(
            'f4-playlist-only-search',
            'searchTerm=Contract&IncludeItemTypes=Playlist&Recursive=true&Limit=20',
        );
        expect(body.Items.map((i) => i.Name)).toEqual(['Contract Picks']);
        expect(body.TotalRecordCount).toBe(1);
    });

    it('Filters=IsFavorite with SearchTerm keeps playlists out and filters the media', async () => {
        await check(
            'f4-favorite-add',
            'UserItemDataDto',
            favoritePost,
            `/j/Users/${COMPACT_ID}/FavoriteItems/${movieId}`,
            { userId: COMPACT_ID, itemId: movieId },
            'POST',
            true,
        );
        const body = await find(
            'f4-favorites-search',
            'searchTerm=Contract&IncludeItemTypes=Movie&IncludeItemTypes=Playlist&Filters=IsFavorite&Recursive=true&Limit=20',
        );
        expect(body.Items.map((i) => i.Id)).toEqual([movieId]);
        expect(body.TotalRecordCount).toBe(1);
    });

    it('music types named with SearchTerm are searched like the video types', async () => {
        await seedMusicAlbum(sql);
        const body = await find(
            'f4-music-search',
            'searchTerm=Contract&IncludeItemTypes=MusicAlbum&IncludeItemTypes=MusicArtist&IncludeItemTypes=Audio&Recursive=true&Limit=20',
        );
        const found = body.Items.map((i) => `${i.Type}:${i.Name}`);
        expect(found).toEqual(
            expect.arrayContaining(['MusicAlbum:Contract Album', 'MusicArtist:Contract Artist']),
        );
        expect(found.some((f) => f.startsWith('Movie:') || f.startsWith('Series:'))).toBe(false);
    });

    it('a playlist parent applies SearchTerm to its entries', async () => {
        const [{ id: pilotId }] = await sql<{ id: string }[]>`
            SELECT id FROM media_items WHERE title = 'Pilot' AND media_type = 'episode'`;
        const mixedId = await createPlaylist('f4-playlist-mixed', 'Mixed list', [movieId, pilotId]);
        const body = await find(
            'f4-playlist-parent-search',
            `ParentId=${mixedId}&searchTerm=Contract&Recursive=true&Limit=20`,
        );
        expect(body.Items.map((i) => i.Id)).toEqual([movieId]);
        expect(body.TotalRecordCount).toBe(1);
    });

    it('without SearchTerm, IncludeItemTypes=Playlist still lists every playlist', async () => {
        const body = await find(
            'f4-playlist-all',
            'IncludeItemTypes=Playlist&Recursive=true&Limit=20',
        );
        expect(body.Items.map((i) => i.Name).sort()).toEqual([
            'Contract Picks',
            'Weekend Watchlist',
        ]);
        expect(body.TotalRecordCount).toBe(2);
    });
});
