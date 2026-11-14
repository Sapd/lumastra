// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Route-level integration tests for the /j music endpoints: Instant Mix (all
// eight routes), Albums/Artists Similar, Artists/{name}, MusicGenres/{name},
// Lyrics and the by-name image routes.
//
// withJellyfinAuth is stubbed (the contract suite runs the real one) so each
// test can pick its caller: an age-restricted one (maxAgeRating 12) who must
// never see the 18-rated "Rated" artist's music, and — on the library-group
// axis — callers outside the `vip` user group, who must never see anything in
// the restricted "VIP" library group ("Hidden Artist" / "Dark Artist"). The
// `vip` caller sees it, so every denial is checked against a caller who does
// get the row.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { ensureTestUser } from '../../../../tests/integration/fixtures/user.fixtures.js';
import {
    createTestAlbum,
    createTestArtist,
    createTestTrack,
    insertTestAlbum,
    insertTestArtist,
    insertTestTrack,
} from '../../../../tests/integration/fixtures/music.fixtures.js';
import { GET as itemsMix } from '../../../routes/(modules)/j/Items/[itemId]/InstantMix/+server';
import { GET as songsMix } from '../../../routes/(modules)/j/Songs/[itemId]/InstantMix/+server';
import { GET as albumsMix } from '../../../routes/(modules)/j/Albums/[itemId]/InstantMix/+server';
import { GET as artistsMix } from '../../../routes/(modules)/j/Artists/[name]/InstantMix/+server';
import { GET as artistsMixQuery } from '../../../routes/(modules)/j/Artists/InstantMix/+server';
import { GET as playlistsMix } from '../../../routes/(modules)/j/Playlists/[playlistId]/InstantMix/+server';
import { GET as genreNameMix } from '../../../routes/(modules)/j/MusicGenres/[name]/InstantMix/+server';
import { GET as genreIdMix } from '../../../routes/(modules)/j/MusicGenres/InstantMix/+server';
import { GET as albumsSimilar } from '../../../routes/(modules)/j/Albums/[itemId]/Similar/+server';
import { GET as artistsSimilar } from '../../../routes/(modules)/j/Artists/[name]/Similar/+server';
import { GET as artistByName } from '../../../routes/(modules)/j/Artists/[name]/+server';
import { GET as musicGenre } from '../../../routes/(modules)/j/MusicGenres/[name]/+server';
import * as lyricsRoute from '../../../routes/(modules)/j/Audio/[itemId]/Lyrics/+server';
import { GET as artistImage } from '../../../routes/(modules)/j/Artists/[name]/Images/[imageType]/[imageIndex]/+server';
import { GET as genreImage } from '../../../routes/(modules)/j/MusicGenres/[name]/Images/[imageType]/[imageIndex]/+server';
import { invalidateLibraryGroupPermissionsCache } from '$lib/server/cache/library-group-permissions-cache.js';
import { clearMusicGenreCache, musicGenreId } from './music-genres';
import { playlistIdToUuid } from './playlist-id';

vi.setConfig({ testTimeout: 30_000 });

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('./middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

vi.mock('$lib/server/database', async (importOriginal) => {
    const mod = await importOriginal<typeof import('$lib/server/database')>();
    const { getTestDb: getSql } =
        await import('../../../../tests/integration/setup/test-database.js');
    return { ...mod, getDb: () => getSql() };
});

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

const ADULT_ID = '00000000-0000-4000-8000-0000000a0001';
const KID_ID = '00000000-0000-4000-8000-0000000a0002';
const OTHER_ID = '00000000-0000-4000-8000-0000000a0003';
const VIP_ID = '00000000-0000-4000-8000-0000000a0004';
/** Library group only the `vip` user group may see. */
const VIP_GROUP = '00000000-0000-4000-8000-0000000a0f01';

/** adult/kid are outside `vip`, so the VIP library group is denied to them. */
type Caller = 'adult' | 'kid' | 'admin' | 'vip';

function user(caller: Caller): Record<string, unknown> {
    const kid = caller === 'kid';
    return {
        username: caller,
        userId: toUserId(kid ? KID_ID : caller === 'vip' ? VIP_ID : ADULT_ID),
        groups: caller === 'vip' ? 'vip' : '',
        userGroups: caller === 'vip' ? ['vip'] : [],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        isAdmin: caller === 'admin',
        maxAgeRating: kid ? 12 : null,
        isAgeRestricted: kid,
        isModerator: false,
        liveTvPriority: 'normal',
    };
}

function event(
    path: string,
    params: Record<string, string>,
    caller: Caller = 'adult',
    init: RequestInit = {},
): RequestEvent {
    const url = new URL(`http://localhost${path}`);
    return {
        url,
        request: new Request(url, init),
        // withJellyfinAuth is stubbed: set the /j principal it would build.
        locals: {
            user: user(caller),
            principal: { kind: 'jellyfin_compat', username: caller, isAdmin: caller === 'admin' },
            jfToken: 'session-token',
        },
        params,
        route: { id: null },
        cookies: {} as never,
        fetch,
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: () => undefined,
    } as unknown as RequestEvent;
}

type Handler = (e: RequestEvent) => Promise<Response>;

async function call(
    handler: unknown,
    path: string,
    params: Record<string, string>,
    caller: Caller = 'adult',
    init: RequestInit = {},
): Promise<Response> {
    return (handler as Handler)(event(path, params, caller, init));
}

interface ItemsBody {
    Items: Array<{ Id: string; Type: string; Name: string; ImageTags?: Record<string, string> }>;
    TotalRecordCount: number;
    StartIndex: number;
}

async function items(res: Response): Promise<ItemsBody> {
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()) as ItemsBody;
}

const ids = (body: ItemsBody): string[] => body.Items.map((i) => i.Id);

/** Unit vector along `axis`, nudged towards `toward` by `amount`. */
function vec(axis: number, toward = 0, amount = 0): string {
    const v = new Array<number>(1024).fill(0);
    v[axis] = 1;
    if (amount) v[toward] += amount;
    return `[${v.join(',')}]`;
}

interface Library {
    artistA: string;
    albumA: string;
    a1: string;
    a2: string;
    artistB: string;
    albumB: string;
    b1: string;
    b2: string;
    artistC: string;
    albumC: string;
    c1: string;
    artistD: string;
    albumD: string;
    d1: string;
    /** In the VIP library group: h1 is the nearest neighbour of a1 (Synthwave). */
    artistH: string;
    albumH: string;
    h1: string;
    /** In the VIP library group, the only Darkwave track. */
    k1: string;
    movie: string;
}

async function seedArtist(
    sql: postgres.Sql,
    name: string,
    genre: string,
    trackCount: number,
    ageRating: number,
): Promise<{ artistId: string; albumId: string; trackIds: string[] }> {
    const artist = createTestArtist({ title: name });
    const album = createTestAlbum(artist.id, { title: `${name} Album` });
    await insertTestArtist(sql, artist);
    await insertTestAlbum(sql, album);
    const trackIds: string[] = [];
    for (let i = 1; i <= trackCount; i++) {
        const track = createTestTrack(album.id, i, {
            title: `${name} Song ${i}`,
            custom_metadata: { genre, artist: name, album: album.title, track_number: i },
        });
        await insertTestTrack(sql, track);
        trackIds.push(track.id);
    }
    const all = [artist.id, album.id, ...trackIds];
    await sql`UPDATE media_items SET status = 'active', has_files = true, age_rating = ${ageRating}
              WHERE id = ANY(${all}::uuid[])`;
    return { artistId: artist.id, albumId: album.id, trackIds };
}

async function seedLibrary(sql: postgres.Sql): Promise<Library> {
    const a = await seedArtist(sql, 'Mix Artist', 'Synthwave', 2, 6);
    const b = await seedArtist(sql, 'Other Artist', 'Synthwave', 2, 6);
    const c = await seedArtist(sql, 'Rated Artist', 'Synthwave', 1, 18);
    const d = await seedArtist(sql, 'Jazz Artist', 'Jazz', 1, 6);
    const embed = async (id: string, v: string): Promise<void> => {
        await sql`INSERT INTO media_embeddings (media_id, embedding, source)
                  VALUES (${id}::uuid, ${v}::vector, 'music')`;
    };
    // a1/a2 sit on axis 0. c1 is the nearest neighbour, then b1; b2 is far away.
    await embed(a.trackIds[0], vec(0));
    await embed(a.trackIds[1], vec(0, 2, 0.01));
    await embed(c.trackIds[0], vec(0, 1, 0.05));
    await embed(b.trackIds[0], vec(0, 1, 0.3));
    await embed(b.trackIds[1], vec(7));

    // The VIP library group: denied to everyone outside the `vip` user group.
    const h = await seedArtist(sql, 'Hidden Artist', 'Synthwave', 1, 6);
    const k = await seedArtist(sql, 'Dark Artist', 'Darkwave', 1, 6);
    await embed(h.trackIds[0], vec(0, 2, 0.02));
    await embed(k.trackIds[0], vec(0, 1, 0.1));
    const vipItems = [h.artistId, h.albumId, ...h.trackIds, k.artistId, k.albumId, ...k.trackIds];
    await sql`INSERT INTO library_groups (id, name) VALUES (${VIP_GROUP}::uuid, 'VIP music')`;
    await sql`INSERT INTO library_group_permissions (library_group_id, allowed_groups)
              VALUES (${VIP_GROUP}::uuid, ${['vip']})`;
    await sql`UPDATE media_items SET library_group_id = ${VIP_GROUP}::uuid
              WHERE id = ANY(${vipItems}::uuid[])`;
    await sql`UPDATE media_files mf SET library_group_id = ${VIP_GROUP}::uuid
              FROM media_file_items mfi
              WHERE mfi.file_id = mf.id AND mfi.media_item_id = ANY(${vipItems}::uuid[])`;
    invalidateLibraryGroupPermissionsCache();

    const [movie] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, status, has_files, age_rating)
        VALUES ('Some Movie', 'movie', 'active', true, 6) RETURNING id`;
    return {
        artistA: a.artistId,
        albumA: a.albumId,
        a1: a.trackIds[0],
        a2: a.trackIds[1],
        artistB: b.artistId,
        albumB: b.albumId,
        b1: b.trackIds[0],
        b2: b.trackIds[1],
        artistC: c.artistId,
        albumC: c.albumId,
        c1: c.trackIds[0],
        artistD: d.artistId,
        albumD: d.albumId,
        d1: d.trackIds[0],
        artistH: h.artistId,
        albumH: h.albumId,
        h1: h.trackIds[0],
        k1: k.trackIds[0],
        movie: movie.id,
    };
}

describe.skipIf(!RUN)('/j music endpoints (integration)', () => {
    let sql: postgres.Sql;
    let lib: Library;

    beforeAll(async () => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, 'playlist_items', 'playlists']);
        await sql`DELETE FROM library_group_permissions WHERE library_group_id = ${VIP_GROUP}::uuid`;
        await sql`DELETE FROM library_groups WHERE id = ${VIP_GROUP}::uuid`;
        for (const id of [ADULT_ID, KID_ID, OTHER_ID, VIP_ID]) await ensureTestUser(sql, id);
        clearMusicGenreCache();
        lib = await seedLibrary(sql);
    });

    afterAll(async () => {
        await sql`DELETE FROM library_group_permissions WHERE library_group_id = ${VIP_GROUP}::uuid`;
        await sql`DELETE FROM library_groups WHERE id = ${VIP_GROUP}::uuid`;
        invalidateLibraryGroupPermissionsCache();
        await closeTestDb();
    });

    describe('InstantMix', () => {
        it('song mix starts with the song, then its nearest neighbours', async () => {
            const body = await items(
                await call(songsMix, `/j/Songs/${lib.a1}/InstantMix`, { itemId: lib.a1 }),
            );
            expect(body.Items[0].Id).toBe(lib.a1);
            const order = ids(body);
            expect(order.indexOf(lib.c1)).toBeLessThan(order.indexOf(lib.b1));
            expect(body.Items.every((i) => i.Type === 'Audio')).toBe(true);
            expect(body.TotalRecordCount).toBe(body.Items.length);
            expect(body.StartIndex).toBe(0);
        });

        it('Limit cuts the page but TotalRecordCount stays the pool size', async () => {
            const full = await items(
                await call(songsMix, `/j/Songs/${lib.a1}/InstantMix`, { itemId: lib.a1 }),
            );
            const page = await items(
                await call(songsMix, `/j/Songs/${lib.a1}/InstantMix?limit=2`, { itemId: lib.a1 }),
            );
            expect(page.Items).toHaveLength(2);
            expect(page.TotalRecordCount).toBe(full.TotalRecordCount);
            expect(ids(page)).toEqual(ids(full).slice(0, 2));
        });

        it('never hands an age-restricted user a track above their rating', async () => {
            const body = await items(
                await call(songsMix, `/j/Songs/${lib.a1}/InstantMix`, { itemId: lib.a1 }, 'kid'),
            );
            expect(ids(body)).toContain(lib.b1);
            expect(ids(body)).not.toContain(lib.c1);
        });

        it('404s a seed the caller cannot see, an unknown id and a junk id', async () => {
            expect(
                (await call(songsMix, `/j/Songs/${lib.c1}/InstantMix`, { itemId: lib.c1 }, 'kid'))
                    .status,
            ).toBe(404);
            const unknown = '99999999-9999-4999-8999-999999999999';
            expect(
                (await call(itemsMix, `/j/Items/${unknown}/InstantMix`, { itemId: unknown }))
                    .status,
            ).toBe(404);
            expect(
                (await call(itemsMix, `/j/Items/nope/InstantMix`, { itemId: 'nope' })).status,
            ).toBe(404);
        });

        it('dispatches on the item type, whatever the route says', async () => {
            const albumMix = await items(
                await call(itemsMix, `/j/Items/${lib.albumA}/InstantMix`, { itemId: lib.albumA }),
            );
            expect(ids(albumMix)).toEqual(expect.arrayContaining([lib.a1, lib.a2, lib.b1]));

            // A song id on the Albums route is still a song mix.
            const songOnAlbums = await items(
                await call(albumsMix, `/j/Albums/${lib.a2}/InstantMix`, { itemId: lib.a2 }),
            );
            expect(songOnAlbums.Items[0].Id).toBe(lib.a2);

            const artistMix = await items(
                await call(artistsMix, `/j/Artists/${lib.artistA}/InstantMix`, {
                    name: lib.artistA,
                }),
            );
            expect(ids(artistMix)).toEqual(expect.arrayContaining([lib.a1, lib.a2]));

            const legacy = await items(
                await call(artistsMixQuery, `/j/Artists/InstantMix?id=${lib.artistA}`, {}),
            );
            expect(ids(legacy).sort()).toEqual(ids(artistMix).sort());
        });

        it('a non-music item yields an empty mix, not an error', async () => {
            const body = await items(
                await call(itemsMix, `/j/Items/${lib.movie}/InstantMix`, { itemId: lib.movie }),
            );
            expect(body).toEqual({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
        });

        it('genre mixes by name and by Id hold only that genre', async () => {
            const synth = await items(
                await call(genreNameMix, `/j/MusicGenres/synthwave/InstantMix`, {
                    name: 'synthwave',
                }),
            );
            expect(ids(synth).sort()).toEqual([lib.a1, lib.a2, lib.b1, lib.b2, lib.c1].sort());

            const jazz = await items(
                await call(genreIdMix, `/j/MusicGenres/InstantMix?id=${musicGenreId('Jazz')}`, {}),
            );
            expect(ids(jazz)).toEqual([lib.d1]);

            expect(
                (
                    await call(genreNameMix, `/j/MusicGenres/Polka/InstantMix`, {
                        name: 'Polka',
                    })
                ).status,
            ).toBe(404);
            expect((await call(genreIdMix, `/j/MusicGenres/InstantMix`, {})).status).toBe(422);
        });

        it('playlist mix is gated by playlist role', async () => {
            const [pl] = await sql<{ id: number }[]>`
                INSERT INTO playlists (user_id, name, playlist_type, visibility)
                VALUES (${OTHER_ID}::uuid, 'Private mix', 'music', 'private') RETURNING id`;
            await sql`INSERT INTO playlist_items (playlist_id, title, position, media_id)
                      VALUES (${pl.id}, 'b2', 0, ${lib.b2}::uuid)`;
            const uuid = playlistIdToUuid(pl.id);
            expect(
                (await call(playlistsMix, `/j/Playlists/${uuid}/InstantMix`, { playlistId: uuid }))
                    .status,
            ).toBe(404);

            await sql`UPDATE playlists SET user_id = ${ADULT_ID}::uuid WHERE id = ${pl.id}`;
            const body = await items(
                await call(playlistsMix, `/j/Playlists/${uuid}/InstantMix`, { playlistId: uuid }),
            );
            expect(ids(body)).toContain(lib.b2);
        });

        it('EnableImages=false and EnableUserData=false trim the DTOs', async () => {
            const res = await call(
                songsMix,
                `/j/Songs/${lib.a1}/InstantMix?EnableImages=false&EnableUserData=false`,
                { itemId: lib.a1 },
            );
            const body = (await res.json()) as {
                Items: Array<{ ImageTags: object; UserData?: object }>;
            };
            expect(body.Items[0].ImageTags).toEqual({});
            expect(body.Items[0].UserData).toBeUndefined();
        });
    });

    describe('Similar', () => {
        it('albums: genre-overlap fallback, excludeArtistIds, access', async () => {
            const adult = await items(
                await call(albumsSimilar, `/j/Albums/${lib.albumA}/Similar`, {
                    itemId: lib.albumA,
                }),
            );
            expect(ids(adult).sort()).toEqual([lib.albumB, lib.albumC].sort());
            expect(adult.Items.every((i) => i.Type === 'MusicAlbum')).toBe(true);

            const excluded = await items(
                await call(
                    albumsSimilar,
                    `/j/Albums/${lib.albumA}/Similar?excludeArtistIds=${lib.artistB}`,
                    { itemId: lib.albumA },
                ),
            );
            expect(ids(excluded)).toEqual([lib.albumC]);

            const kid = await items(
                await call(
                    albumsSimilar,
                    `/j/Albums/${lib.albumA}/Similar`,
                    { itemId: lib.albumA },
                    'kid',
                ),
            );
            expect(ids(kid)).toEqual([lib.albumB]);
        });

        it('artists: genre overlap; Limit; non-music empty; unknown 404', async () => {
            const body = await items(
                await call(artistsSimilar, `/j/Artists/${lib.artistA}/Similar?limit=1`, {
                    name: lib.artistA,
                }),
            );
            expect(body.Items).toHaveLength(1);
            expect([lib.artistB, lib.artistC]).toContain(body.Items[0].Id);
            expect(body.Items[0].Type).toBe('MusicArtist');

            const movie = await items(
                await call(albumsSimilar, `/j/Albums/${lib.movie}/Similar`, {
                    itemId: lib.movie,
                }),
            );
            expect(movie.Items).toEqual([]);
            expect(
                (await call(albumsSimilar, `/j/Albums/xyz/Similar`, { itemId: 'xyz' })).status,
            ).toBe(404);
            expect(
                (
                    await call(
                        artistsSimilar,
                        `/j/Artists/${lib.artistC}/Similar`,
                        { name: lib.artistC },
                        'kid',
                    )
                ).status,
            ).toBe(404);
        });
    });

    describe('by name', () => {
        it('Artists/{name} matches case-insensitively and hides what the caller cannot see', async () => {
            const res = await call(artistByName, `/j/Artists/mix%20artist`, {
                name: 'mix artist',
            });
            expect(res.status).toBe(200);
            const dto = (await res.json()) as { Id: string; Type: string; Name: string };
            expect(dto).toMatchObject({ Id: lib.artistA, Type: 'MusicArtist', Name: 'Mix Artist' });

            expect((await call(artistByName, `/j/Artists/Nobody`, { name: 'Nobody' })).status).toBe(
                404,
            );
            expect(
                (await call(artistByName, `/j/Artists/Rated`, { name: 'Rated Artist' }, 'kid'))
                    .status,
            ).toBe(404);
        });

        it('MusicGenres/{name} returns a MusicGenre counted over visible tracks', async () => {
            const adult = (await (
                await call(musicGenre, `/j/MusicGenres/Synthwave`, { name: 'Synthwave' })
            ).json()) as { Type: string; Id: string; ChildCount: number; Name: string };
            expect(adult).toMatchObject({
                Type: 'MusicGenre',
                Id: musicGenreId('Synthwave'),
                ChildCount: 5,
            });
            const kid = (await (
                await call(musicGenre, `/j/MusicGenres/Synthwave`, { name: 'synthwave' }, 'kid')
            ).json()) as { ChildCount: number };
            expect(kid.ChildCount).toBe(4);
            expect((await call(musicGenre, `/j/MusicGenres/Polka`, { name: 'Polka' })).status).toBe(
                404,
            );
        });

        it('by-name images: 404 when there is no image, 422 on a junk index', async () => {
            const params = { name: 'Mix Artist', imageType: 'Primary', imageIndex: '0' };
            expect(
                (await call(artistImage, `/j/Artists/Mix%20Artist/Images/Primary/0`, params))
                    .status,
            ).toBe(404);
            expect(
                (
                    await call(artistImage, `/j/Artists/Mix%20Artist/Images/Primary/x`, {
                        ...params,
                        imageIndex: 'x',
                    })
                ).status,
            ).toBe(422);
            expect(
                (
                    await call(artistImage, `/j/Artists/Nobody/Images/Primary/0`, {
                        ...params,
                        name: 'Nobody',
                    })
                ).status,
            ).toBe(404);
        });
    });

    describe('Lyrics', () => {
        const lrc = '[ar:Mix Artist]\n[00:01.00]First line\n[00:02.50]Second line';

        async function setLyrics(trackId: string, lyrics: object): Promise<void> {
            await sql`UPDATE media_items
                      SET custom_metadata = custom_metadata || ${sql.json({ lyrics } as never)}
                      WHERE id = ${trackId}::uuid`;
        }

        it('serves synced lyrics as ticks, plain as unsynced, none as 404', async () => {
            await setLyrics(lib.a1, { synced: lrc, plain: null, source: 'test' });
            await setLyrics(lib.a2, { synced: null, plain: 'Just words', source: 'test' });
            const synced = (await (
                await (lyricsRoute.GET as unknown as Handler)(
                    event(`/j/Audio/${lib.a1}/Lyrics`, { itemId: lib.a1 }),
                )
            ).json()) as { Metadata: { IsSynced: boolean }; Lyrics: object[] };
            expect(synced.Metadata.IsSynced).toBe(true);
            expect(synced.Lyrics).toEqual([
                { Text: 'First line', Start: 10_000_000 },
                { Text: 'Second line', Start: 25_000_000 },
            ]);
            const plain = (await (
                await (lyricsRoute.GET as unknown as Handler)(
                    event(`/j/Audio/${lib.a2}/Lyrics`, { itemId: lib.a2 }),
                )
            ).json()) as { Lyrics: object[] };
            expect(plain.Lyrics).toEqual([{ Text: 'Just words' }]);
            expect(
                (
                    await (lyricsRoute.GET as unknown as Handler)(
                        event(`/j/Audio/${lib.b1}/Lyrics`, { itemId: lib.b1 }),
                    )
                ).status,
            ).toBe(404);
        });

        it('404s a track the caller cannot see', async () => {
            await setLyrics(lib.c1, { synced: lrc, plain: null, source: 'test' });
            const res = await (lyricsRoute.GET as unknown as Handler)(
                event(`/j/Audio/${lib.c1}/Lyrics`, { itemId: lib.c1 }, 'kid'),
            );
            expect(res.status).toBe(404);
        });

        it('upload and delete need lyric management (admin)', async () => {
            const post = (caller: Caller, query = '?fileName=song.lrc'): Promise<Response> =>
                (lyricsRoute.POST as unknown as Handler)(
                    event(`/j/Audio/${lib.b1}/Lyrics${query}`, { itemId: lib.b1 }, caller, {
                        method: 'POST',
                        body: lrc,
                    }),
                );
            expect((await post('adult')).status).toBe(403);
            expect((await post('admin', '')).status).toBe(422);

            const uploaded = await post('admin');
            expect(uploaded.status).toBe(200);
            expect(((await uploaded.json()) as { Lyrics: object[] }).Lyrics).toHaveLength(2);

            const del = (caller: Caller): Promise<Response> =>
                (lyricsRoute.DELETE as unknown as Handler)(
                    event(`/j/Audio/${lib.b1}/Lyrics`, { itemId: lib.b1 }, caller, {
                        method: 'DELETE',
                    }),
                );
            expect((await del('adult')).status).toBe(403);
            expect((await del('admin')).status).toBe(204);
            expect(
                (
                    await (lyricsRoute.GET as unknown as Handler)(
                        event(`/j/Audio/${lib.b1}/Lyrics`, { itemId: lib.b1 }),
                    )
                ).status,
            ).toBe(404);
            expect((await del('admin')).status).toBe(404);
        });
    });

    describe('library-group denial (VIP library, caller outside the vip group)', () => {
        const lyrics = { synced: '[00:01.00]Hidden line', plain: null, source: 'test' };

        it('song and genre mixes never include a denied track', async () => {
            const vip = await items(
                await call(songsMix, `/j/Songs/${lib.a1}/InstantMix`, { itemId: lib.a1 }, 'vip'),
            );
            expect(ids(vip)).toContain(lib.h1);
            const adult = await items(
                await call(songsMix, `/j/Songs/${lib.a1}/InstantMix`, { itemId: lib.a1 }),
            );
            expect(ids(adult)).not.toContain(lib.h1);
            expect(ids(adult)).not.toContain(lib.k1);
            expect(ids(adult)).toContain(lib.b1);

            const vipGenre = await items(
                await call(
                    genreNameMix,
                    `/j/MusicGenres/synthwave/InstantMix`,
                    { name: 'synthwave' },
                    'vip',
                ),
            );
            expect(ids(vipGenre)).toContain(lib.h1);
            const genre = await items(
                await call(genreNameMix, `/j/MusicGenres/synthwave/InstantMix`, {
                    name: 'synthwave',
                }),
            );
            expect(ids(genre)).not.toContain(lib.h1);
        });

        it('a seed in a denied library is a 404 for every mix and Similar route', async () => {
            expect(
                (await call(songsMix, `/j/Songs/${lib.h1}/InstantMix`, { itemId: lib.h1 }, 'vip'))
                    .status,
            ).toBe(200);
            expect(
                (await call(songsMix, `/j/Songs/${lib.h1}/InstantMix`, { itemId: lib.h1 })).status,
            ).toBe(404);
            expect(
                (
                    await call(albumsMix, `/j/Albums/${lib.albumH}/InstantMix`, {
                        itemId: lib.albumH,
                    })
                ).status,
            ).toBe(404);
            expect(
                (
                    await call(artistsMix, `/j/Artists/${lib.artistH}/InstantMix`, {
                        name: lib.artistH,
                    })
                ).status,
            ).toBe(404);
            expect(
                (
                    await call(albumsSimilar, `/j/Albums/${lib.albumH}/Similar`, {
                        itemId: lib.albumH,
                    })
                ).status,
            ).toBe(404);
            expect(
                (
                    await call(artistsSimilar, `/j/Artists/${lib.artistH}/Similar`, {
                        name: lib.artistH,
                    })
                ).status,
            ).toBe(404);
        });

        it('Similar never ranks a denied album or artist', async () => {
            const vip = await items(
                await call(
                    albumsSimilar,
                    `/j/Albums/${lib.albumA}/Similar`,
                    { itemId: lib.albumA },
                    'vip',
                ),
            );
            expect(ids(vip)).toContain(lib.albumH);
            const adult = await items(
                await call(albumsSimilar, `/j/Albums/${lib.albumA}/Similar`, {
                    itemId: lib.albumA,
                }),
            );
            expect(ids(adult)).not.toContain(lib.albumH);

            const vipArtists = await items(
                await call(
                    artistsSimilar,
                    `/j/Artists/${lib.artistA}/Similar`,
                    { name: lib.artistA },
                    'vip',
                ),
            );
            expect(ids(vipArtists)).toContain(lib.artistH);
            const artists = await items(
                await call(artistsSimilar, `/j/Artists/${lib.artistA}/Similar`, {
                    name: lib.artistA,
                }),
            );
            expect(ids(artists)).not.toContain(lib.artistH);
        });

        it('Artists/{name} and MusicGenres/{name} 404 what only a denied library holds', async () => {
            expect(
                (
                    await call(
                        artistByName,
                        `/j/Artists/Hidden%20Artist`,
                        { name: 'Hidden Artist' },
                        'vip',
                    )
                ).status,
            ).toBe(200);
            expect(
                (await call(artistByName, `/j/Artists/Hidden%20Artist`, { name: 'Hidden Artist' }))
                    .status,
            ).toBe(404);

            expect(
                (await call(musicGenre, `/j/MusicGenres/Darkwave`, { name: 'Darkwave' }, 'vip'))
                    .status,
            ).toBe(200);
            expect(
                (await call(musicGenre, `/j/MusicGenres/Darkwave`, { name: 'Darkwave' })).status,
            ).toBe(404);
            // By Id too, and the genre mix.
            const darkId = musicGenreId('Darkwave');
            expect(
                (await call(musicGenre, `/j/MusicGenres/${darkId}`, { name: darkId })).status,
            ).toBe(404);
            expect(
                (
                    await call(genreNameMix, `/j/MusicGenres/Darkwave/InstantMix`, {
                        name: 'Darkwave',
                    })
                ).status,
            ).toBe(404);

            // Counts cover only visible tracks: the VIP Synthwave track counts for vip only.
            const vipSynth = (await (
                await call(musicGenre, `/j/MusicGenres/Synthwave`, { name: 'Synthwave' }, 'vip')
            ).json()) as { ChildCount: number };
            const synth = (await (
                await call(musicGenre, `/j/MusicGenres/Synthwave`, { name: 'Synthwave' })
            ).json()) as { ChildCount: number };
            expect(vipSynth.ChildCount).toBe(6);
            expect(synth.ChildCount).toBe(5);
        });

        it('the genre image route 404s a genre only a denied library holds', async () => {
            const params = { name: 'Darkwave', imageType: 'Primary', imageIndex: '0' };
            const res = await call(genreImage, `/j/MusicGenres/Darkwave/Images/Primary/0`, params);
            expect(res.status).toBe(404);
        });

        it('Lyrics of a denied track are a 404', async () => {
            await sql`UPDATE media_items
                      SET custom_metadata = custom_metadata || ${sql.json({ lyrics } as never)}
                      WHERE id = ${lib.h1}::uuid`;
            const get = (caller: Caller): Promise<Response> =>
                (lyricsRoute.GET as unknown as Handler)(
                    event(`/j/Audio/${lib.h1}/Lyrics`, { itemId: lib.h1 }, caller),
                );
            expect((await get('vip')).status).toBe(200);
            expect((await get('adult')).status).toBe(404);
        });
    });

    describe('Minor fixes', () => {
        it('MusicGenres/{name} tags the Primary image when a visible album cover exists', async () => {
            await sql`UPDATE media_items SET custom_poster_url = '/covers/a.jpg' WHERE id = ${lib.albumA}::uuid`;
            const dto = (await (
                await call(musicGenre, `/j/MusicGenres/Synthwave`, { name: 'Synthwave' })
            ).json()) as { ImageTags: Record<string, string> };
            expect(dto.ImageTags.Primary).toEqual(expect.any(String));

            const jazz = (await (
                await call(musicGenre, `/j/MusicGenres/Jazz`, { name: 'Jazz' })
            ).json()) as { ImageTags: Record<string, string> };
            expect(jazz.ImageTags).toEqual({});
        });

        it('Lyrics POST with no lyric lines stores nothing and keeps the old lyrics', async () => {
            await sql`UPDATE media_items
                      SET custom_metadata = custom_metadata || ${sql.json({ lyrics: { synced: null, plain: 'Kept words', source: 'test' } } as never)}
                      WHERE id = ${lib.b1}::uuid`;
            const res = await (lyricsRoute.POST as unknown as Handler)(
                event(`/j/Audio/${lib.b1}/Lyrics?fileName=bad.lrc`, { itemId: lib.b1 }, 'admin', {
                    method: 'POST',
                    body: 'no timestamps here',
                }),
            );
            expect(res.status).toBe(422);
            const kept = (await (
                await (lyricsRoute.GET as unknown as Handler)(
                    event(`/j/Audio/${lib.b1}/Lyrics`, { itemId: lib.b1 }),
                )
            ).json()) as { Lyrics: object[] };
            expect(kept.Lyrics).toEqual([{ Text: 'Kept words' }]);
        });
    });
});
