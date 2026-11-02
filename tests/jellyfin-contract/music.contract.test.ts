// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.
/**
 * Contract suite: the /j music endpoints (Instant Mix, Similar, artist and genre
 * by name, lyrics) through the real route handlers and the real withJellyfinAuth,
 * over real PG + Valkey. Each JSON body is checked against the jellyfin-sdk-kotlin
 * contract digest and written to out/ for the JVM decode step.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { truncateTables, TEST_TABLES } from '../integration/helpers/cleanup.js';
import { ensureTestUser } from '../integration/fixtures/user.fixtures.js';
import { callAndCheck, jfEvent, mintJfSession, type RouteHandler } from './harness';
import { seedMusicAlbum } from './seed';
import { playlistIdToUuid } from '$lib/server/proprietary/jellyfin-compat/playlist-id';
import { musicGenreId } from '$lib/server/proprietary/jellyfin-compat/music-genres';
import { GET as itemsMixGet } from '../../src/routes/(proprietary)/j/Items/[itemId]/InstantMix/+server';
import { GET as songsMixGet } from '../../src/routes/(proprietary)/j/Songs/[itemId]/InstantMix/+server';
import { GET as albumsMixGet } from '../../src/routes/(proprietary)/j/Albums/[itemId]/InstantMix/+server';
import { GET as artistsMixGet } from '../../src/routes/(proprietary)/j/Artists/[name]/InstantMix/+server';
import { GET as artistsMixQueryGet } from '../../src/routes/(proprietary)/j/Artists/InstantMix/+server';
import { GET as playlistsMixGet } from '../../src/routes/(proprietary)/j/Playlists/[playlistId]/InstantMix/+server';
import { GET as genreNameMixGet } from '../../src/routes/(proprietary)/j/MusicGenres/[name]/InstantMix/+server';
import { GET as genreIdMixGet } from '../../src/routes/(proprietary)/j/MusicGenres/InstantMix/+server';
import { GET as albumsSimilarGet } from '../../src/routes/(proprietary)/j/Albums/[itemId]/Similar/+server';
import { GET as artistsSimilarGet } from '../../src/routes/(proprietary)/j/Artists/[name]/Similar/+server';
import { GET as artistByNameGet } from '../../src/routes/(proprietary)/j/Artists/[name]/+server';
import { GET as musicGenreGet } from '../../src/routes/(proprietary)/j/MusicGenres/[name]/+server';
import { GET as lyricsGet } from '../../src/routes/(proprietary)/j/Audio/[itemId]/Lyrics/+server';

const USER_ID = '00000000-0000-4000-8000-00000000c1de';
const GENRE = 'Contract Pop';
let sql: postgres.Sql;
let token: string;

beforeAll(async () => {
    sql = getTestDb();
    if (!(await connectValkey())) throw new Error('Valkey not reachable (CACHE_URL)');
});
afterAll(async () => {
    await disconnectValkey();
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, [...TEST_TABLES.media, ...TEST_TABLES.userData]);
    await ensureTestUser(sql, USER_ID);
    const [{ username }] = await sql<
        { username: string }[]
    >`SELECT username FROM users WHERE id = ${USER_ID}`;
    token = await mintJfSession(sql, { userId: USER_ID, username });
});

function get(
    name: string,
    kotlinClass: string,
    handler: RouteHandler,
    path: string,
    params: Record<string, string>,
): Promise<unknown> {
    return callAndCheck(
        name,
        kotlinClass,
        handler,
        jfEvent({ method: 'GET', path, token, params }),
    );
}

interface QueryResult {
    Items: Array<{ Id: string; Type: string; MediaSources?: unknown[] }>;
    TotalRecordCount: number;
}

/** Two albums by two artists sharing a genre, with embeddings and a playlist. */
async function seedMusic(): Promise<{
    artistId: string;
    albumId: string;
    trackId: string;
    otherArtistId: string;
    otherAlbumId: string;
    playlistUuid: string;
}> {
    const first = await seedMusicAlbum(sql);
    const { createAndInsertTestMusicHierarchy } =
        await import('../integration/fixtures/music.fixtures.js');
    const other = await createAndInsertTestMusicHierarchy(sql, {
        artistTitle: 'Contract Other Artist',
        albumTitle: 'Contract Other Album',
        trackCount: 2,
    });
    const trackIds = (
        await sql<{ id: string }[]>`
            SELECT id FROM media_items
            WHERE media_type = 'track' AND parent_id IN (${first.albumId}, ${other.albumId})`
    ).map((r) => r.id);
    await sql`UPDATE media_items SET status = 'active', has_files = true
              WHERE id IN (${other.artistId}, ${other.albumId}) OR id = ANY(${trackIds}::uuid[])`;
    await sql`UPDATE media_items
              SET custom_metadata = custom_metadata || ${sql.json({ genre: GENRE })}
              WHERE id = ANY(${trackIds}::uuid[])`;
    for (const [i, id] of trackIds.entries()) {
        const v = new Array<number>(1024).fill(0);
        v[0] = 1;
        v[1 + i] = 0.1;
        await sql`INSERT INTO media_embeddings (media_id, embedding, source)
                  VALUES (${id}::uuid, ${`[${v.join(',')}]`}::vector, 'music')`;
    }
    await sql`UPDATE media_items
              SET custom_metadata = custom_metadata || ${sql.json({
                  lyrics: {
                      synced: '[ar:Contract Artist]\n[00:01.00]Line one\n[00:02.00]Line two',
                      plain: null,
                      source: 'contract',
                  },
              })}
              WHERE id = ${first.trackId}`;
    const [pl] = await sql<{ id: number }[]>`
        INSERT INTO playlists (user_id, name, playlist_type, visibility)
        VALUES (${USER_ID}::uuid, 'Contract Playlist', 'music', 'private') RETURNING id`;
    await sql`INSERT INTO playlist_items (playlist_id, title, position, media_id)
              VALUES (${pl.id}, 'Contract Track', 0, ${first.trackId}::uuid)`;
    return {
        artistId: first.artistId,
        albumId: first.albumId,
        trackId: first.trackId,
        otherArtistId: other.artistId,
        otherAlbumId: other.albumId,
        playlistUuid: playlistIdToUuid(pl.id),
    };
}

describe('music endpoints contract', () => {
    it('Instant Mix answers BaseItemDtoQueryResult on every route', async () => {
        const m = await seedMusic();
        const song = (await get(
            'instant-mix-song',
            'BaseItemDtoQueryResult',
            songsMixGet,
            `/j/Songs/${m.trackId}/InstantMix?UserId=${USER_ID}&Limit=50&Fields=MediaSources`,
            { itemId: m.trackId },
        )) as QueryResult;
        expect(song.Items[0].Id).toBe(m.trackId);
        expect(song.Items.length).toBeGreaterThan(1);
        expect(song.Items[0].MediaSources?.length).toBeGreaterThan(0);

        await get(
            'instant-mix-item',
            'BaseItemDtoQueryResult',
            itemsMixGet,
            `/j/Items/${m.albumId}/InstantMix`,
            { itemId: m.albumId },
        );
        await get(
            'instant-mix-album',
            'BaseItemDtoQueryResult',
            albumsMixGet,
            `/j/Albums/${m.albumId}/InstantMix?limit=3`,
            { itemId: m.albumId },
        );
        await get(
            'instant-mix-artist',
            'BaseItemDtoQueryResult',
            artistsMixGet,
            `/j/Artists/${m.artistId}/InstantMix`,
            { name: m.artistId },
        );
        await get(
            'instant-mix-artist-query',
            'BaseItemDtoQueryResult',
            artistsMixQueryGet,
            `/j/Artists/InstantMix?id=${m.artistId}`,
            {},
        );
        const playlist = (await get(
            'instant-mix-playlist',
            'BaseItemDtoQueryResult',
            playlistsMixGet,
            `/j/Playlists/${m.playlistUuid}/InstantMix`,
            { playlistId: m.playlistUuid },
        )) as QueryResult;
        expect(playlist.Items.map((i) => i.Id)).toContain(m.trackId);
        const genre = (await get(
            'instant-mix-genre-name',
            'BaseItemDtoQueryResult',
            genreNameMixGet,
            `/j/MusicGenres/${encodeURIComponent(GENRE)}/InstantMix`,
            { name: GENRE },
        )) as QueryResult;
        expect(genre.TotalRecordCount).toBe(4);
        await get(
            'instant-mix-genre-id',
            'BaseItemDtoQueryResult',
            genreIdMixGet,
            `/j/MusicGenres/InstantMix?id=${musicGenreId(GENRE)}`,
            {},
        );
    });

    it('Similar answers albums for an album and artists for an artist', async () => {
        const m = await seedMusic();
        const albums = (await get(
            'similar-albums',
            'BaseItemDtoQueryResult',
            albumsSimilarGet,
            `/j/Albums/${m.albumId}/Similar?limit=12`,
            { itemId: m.albumId },
        )) as QueryResult;
        expect(albums.Items.map((i) => [i.Id, i.Type])).toEqual([[m.otherAlbumId, 'MusicAlbum']]);
        const artists = (await get(
            'similar-artists',
            'BaseItemDtoQueryResult',
            artistsSimilarGet,
            `/j/Artists/${m.artistId}/Similar`,
            { name: m.artistId },
        )) as QueryResult;
        expect(artists.Items.map((i) => [i.Id, i.Type])).toEqual([
            [m.otherArtistId, 'MusicArtist'],
        ]);
    });

    it('artist and music genre by name answer BaseItemDto', async () => {
        const m = await seedMusic();
        const artist = (await get(
            'artist-by-name',
            'BaseItemDto',
            artistByNameGet,
            `/j/Artists/Contract%20Artist`,
            { name: 'Contract Artist' },
        )) as { Id: string; Type: string };
        expect(artist).toMatchObject({ Id: m.artistId, Type: 'MusicArtist' });
        const genre = (await get(
            'music-genre-by-name',
            'BaseItemDto',
            musicGenreGet,
            `/j/MusicGenres/${encodeURIComponent(GENRE)}`,
            { name: GENRE },
        )) as { Type: string; Name: string };
        expect(genre).toMatchObject({ Type: 'MusicGenre', Name: GENRE });
    });

    it('lyrics answer LyricDto', async () => {
        const m = await seedMusic();
        const lyrics = (await get(
            'audio-lyrics',
            'LyricDto',
            lyricsGet,
            `/j/Audio/${m.trackId}/Lyrics`,
            { itemId: m.trackId },
        )) as { Metadata: { IsSynced: boolean }; Lyrics: Array<{ Start: number }> };
        expect(lyrics.Metadata.IsSynced).toBe(true);
        expect(lyrics.Lyrics.map((l) => l.Start)).toEqual([10_000_000, 20_000_000]);
    });
});
