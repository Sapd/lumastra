// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.
/**
 * Contract suite: filter menus, genres and search hints (cloud-parity brief 12)
 * through the real route handlers and the real withJellyfinAuth, over real
 * PG + Valkey. Each JSON body is checked against the jellyfin-sdk-kotlin
 * contract digest and written to out/ for the JVM decode step.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { truncateTables, TEST_TABLES } from '../integration/helpers/cleanup.js';
import { ensureTestUser } from '../integration/fixtures/user.fixtures.js';
import { callAndCheck, jfEvent, mintJfSession, type RouteHandler } from './harness';
import {
    seedEpisodeExternalSrt,
    seedMovieEmbeddedSubs,
    seedMusicAlbum,
    seedProviderMetadata,
} from './seed';
import { clearVideoGenreCache } from '$lib/server/proprietary/jellyfin-compat/genres';
import { clearMusicGenreCache } from '$lib/server/proprietary/jellyfin-compat/music-genres';
import { GET as filtersGet } from '../../src/routes/(proprietary)/j/Items/Filters/+server';
import { GET as filters2Get } from '../../src/routes/(proprietary)/j/Items/Filters2/+server';
import { GET as genresGet } from '../../src/routes/(proprietary)/j/Genres/+server';
import { GET as genreGet } from '../../src/routes/(proprietary)/j/Genres/[genreName]/+server';
import { GET as musicGenresGet } from '../../src/routes/(proprietary)/j/MusicGenres/+server';
import { GET as hintsGet } from '../../src/routes/(proprietary)/j/Search/Hints/+server';

const USER_ID = '00000000-0000-4000-8000-00000000f12e';
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
    clearVideoGenreCache();
    clearMusicGenreCache();
    await ensureTestUser(sql, USER_ID);
    const [{ username }] = await sql<
        { username: string }[]
    >`SELECT username FROM users WHERE id = ${USER_ID}`;
    token = await mintJfSession(sql, { userId: USER_ID, username });

    const movie = await seedMovieEmbeddedSubs(sql);
    await seedProviderMetadata(sql, movie.itemId, {
        genres: [
            { id: 18, name: 'Drama' },
            { id: 28, name: 'Action' },
        ],
        content_rating: 'PG-13',
    });
    const episode = await seedEpisodeExternalSrt(sql);
    await seedProviderMetadata(sql, episode.seriesId, {
        genres: [{ id: 16, name: 'Animation' }],
        content_rating: 'TV-14',
    });
    const music = await seedMusicAlbum(sql);
    await sql`UPDATE media_items SET custom_metadata = custom_metadata || ${sql.json({ genre: 'Contract Jazz' })}
              WHERE parent_id = ${music.albumId}`;
});

function get(
    name: string,
    kotlinClass: string,
    handler: RouteHandler,
    path: string,
    params: Record<string, string> = {},
): Promise<unknown> {
    return callAndCheck(
        name,
        kotlinClass,
        handler,
        jfEvent({ method: 'GET', path, token, params }),
    );
}

describe('/j filters, genres and search contract', () => {
    it('Items/Filters', async () => {
        const body = (await get(
            'items-filters',
            'QueryFiltersLegacy',
            filtersGet,
            '/j/Items/Filters',
        )) as { Genres: string[]; OfficialRatings: string[]; Years: number[] };
        expect(body.Genres).toEqual(['Action', 'Animation', 'Drama']);
        expect(body.OfficialRatings).toEqual(['PG-13', 'TV-14']);
        // 2020: the movie and the episode; the music fixture brings its own year.
        expect(body.Years).toContain(2020);
    });

    it('Items/Filters2', async () => {
        const body = (await get(
            'items-filters2',
            'QueryFilters',
            filters2Get,
            '/j/Items/Filters2?IncludeItemTypes=Movie,Series&Recursive=true',
        )) as { Genres: { Name: string }[] };
        expect(body.Genres.map((g) => g.Name)).toEqual(['Action', 'Animation', 'Drama']);
    });

    it('Items/Filters2 — music', async () => {
        const body = (await get(
            'items-filters2-music',
            'QueryFilters',
            filters2Get,
            '/j/Items/Filters2?IncludeItemTypes=MusicAlbum',
        )) as { Genres: { Name: string }[] };
        expect(body.Genres.map((g) => g.Name)).toEqual(['Contract Jazz']);
    });

    it('Genres', async () => {
        const body = (await get(
            'genres',
            'BaseItemDtoQueryResult',
            genresGet,
            '/j/Genres?Fields=ItemCounts&SortBy=SortName&SortOrder=Ascending&Limit=10',
        )) as { Items: { Name: string; ChildCount: number }[]; TotalRecordCount: number };
        expect(body.Items.map((g) => g.Name)).toEqual(['Action', 'Animation', 'Drama']);
        expect(body.TotalRecordCount).toBe(3);
    });

    it('Genres/{genreName}', async () => {
        const body = (await get('genre', 'BaseItemDto', genreGet, '/j/Genres/Drama', {
            genreName: 'Drama',
        })) as { Type: string; MovieCount: number };
        expect(body).toMatchObject({ Type: 'Genre', MovieCount: 1 });
    });

    it('MusicGenres', async () => {
        const body = (await get(
            'music-genres',
            'BaseItemDtoQueryResult',
            musicGenresGet,
            '/j/MusicGenres?StartIndex=0&Limit=20&SortBy=SortName',
        )) as { Items: { Name: string; SongCount: number }[] };
        expect(body.Items).toEqual([
            expect.objectContaining({ Name: 'Contract Jazz', SongCount: 2 }),
        ]);
    });

    it('Search/Hints — episode, series, movie and music', async () => {
        const body = (await get(
            'search-hints',
            'SearchHintResult',
            hintsGet,
            '/j/Search/Hints?SearchTerm=contract&Limit=20',
        )) as { SearchHints: { Type: string }[]; TotalRecordCount: number };
        expect(body.SearchHints.map((h) => h.Type)).toEqual(
            expect.arrayContaining(['Movie', 'Series', 'MusicAlbum', 'MusicArtist', 'Audio']),
        );
        expect(body.TotalRecordCount).toBe(body.SearchHints.length);

        const episode = (await get(
            'search-hints-episode',
            'SearchHintResult',
            hintsGet,
            '/j/Search/Hints?SearchTerm=pilot&IncludeItemTypes=Episode',
        )) as { SearchHints: { Type: string; Series: string }[] };
        expect(episode.SearchHints).toEqual([
            expect.objectContaining({ Type: 'Episode', Series: 'Contract Series' }),
        ]);
    });

    it('Search/Hints — genres', async () => {
        const body = (await get(
            'search-hints-genres',
            'SearchHintResult',
            hintsGet,
            '/j/Search/Hints?SearchTerm=jazz&IncludeMedia=false',
        )) as { SearchHints: { Type: string; Name: string }[] };
        expect(body.SearchHints).toEqual([
            expect.objectContaining({ Type: 'MusicGenre', Name: 'Contract Jazz' }),
        ]);
    });
});
