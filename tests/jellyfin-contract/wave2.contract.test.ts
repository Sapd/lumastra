// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.
/**
 * Cloud-parity brief 09 against the jellyfin-sdk-kotlin contract: AdjacentTo,
 * the /Items list filters, Fields= / EnableImages / EnableUserData /
 * EnableTotalRecordCount shaping, and /Artists/AlbumArtists. Shaping must never
 * remove a field the SDK requires.
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
import { GET as itemsGet } from '../../src/routes/(proprietary)/j/Items/+server';
import { GET as episodesGet } from '../../src/routes/(proprietary)/j/Shows/[seriesId]/Episodes/+server';
import { GET as nextUpGet } from '../../src/routes/(proprietary)/j/Shows/NextUp/+server';
import { GET as latestGet } from '../../src/routes/(proprietary)/j/Items/Latest/+server';
import { GET as albumArtistsGet } from '../../src/routes/(proprietary)/j/Artists/AlbumArtists/+server';
import { GET as artistsGet } from '../../src/routes/(proprietary)/j/Artists/+server';

const USER_ID = '00000000-0000-4000-8000-00000000c0de';
let sql: postgres.Sql;
let token: string;
let movie: { itemId: string };
let episode: { itemId: string; seriesId: string; seasonId: string };

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
    episode = await seedEpisodeExternalSrt(sql);
    movie = await seedMovieEmbeddedSubs(sql);
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

type ItemsBody = { Items: Record<string, unknown>[]; TotalRecordCount: number };

describe('/j brief-09 contract', () => {
    it('Shows/{id}/Episodes?AdjacentTo=', async () => {
        const body = (await get(
            'episodes-adjacent',
            'BaseItemDtoQueryResult',
            episodesGet,
            `/j/Shows/${episode.seriesId}/Episodes?AdjacentTo=${episode.itemId}&Fields=Overview,MediaSources`,
            { seriesId: episode.seriesId },
        )) as ItemsBody;
        expect(body.Items.map((i) => i.Id)).toEqual([episode.itemId]);
        expect(body.TotalRecordCount).toBe(1);
    });

    it('Items with the brief-09 list filters', async () => {
        await seedProviderMetadata(sql, movie.itemId, {
            content_rating: 'PG-13',
            keywords: ['heist'],
            poster_path: '/p.jpg',
        });
        const body = (await get(
            'items-wave2-filters',
            'BaseItemDtoQueryResult',
            itemsGet,
            `/j/Items?Recursive=true&IncludeItemTypes=Movie&Tags=heist&OfficialRatings=PG-13&ImageTypes=Primary&NameLessThan=z&ExcludeItemIds=${episode.itemId}&CollapseBoxSetItems=true&MaxOfficialRating=R`,
        )) as ItemsBody;
        expect(body.Items.map((i) => i.Id)).toEqual([movie.itemId]);
    });

    it('Items shaped by Fields / EnableImages / EnableUserData / EnableTotalRecordCount', async () => {
        const body = (await get(
            'items-shaped',
            'BaseItemDtoQueryResult',
            itemsGet,
            '/j/Items?Recursive=true&IncludeItemTypes=Movie,Episode&Limit=1&Fields=PrimaryImageAspectRatio&EnableImages=false&EnableUserData=false&EnableTotalRecordCount=false',
        )) as ItemsBody;
        expect(body.Items).toHaveLength(1);
        expect(body.TotalRecordCount).toBe(1);
        const item = body.Items[0];
        // Fields only gates what wave 2 added; fields sent before stay.
        expect(item).not.toHaveProperty('CanDelete');
        expect(item).toHaveProperty('DateCreated');
        expect(item).not.toHaveProperty('UserData');
        expect(item.ImageTags).toEqual({});
        expect(item).toHaveProperty('PrimaryImageAspectRatio');
        expect(item).toHaveProperty('MediaSources');
    });

    it('NextUp and Latest with Fields', async () => {
        await get(
            'nextup-fields',
            'BaseItemDtoQueryResult',
            nextUpGet,
            '/j/Shows/NextUp?Fields=PrimaryImageAspectRatio,DateCreated&EnableImageTypes=Primary,Backdrop,Thumb&ImageTypeLimit=1',
        );
        await get(
            'latest-fields',
            'List<BaseItemDto>',
            latestGet,
            '/j/Items/Latest?Fields=PrimaryImageAspectRatio&ImageTypeLimit=1&EnableImageTypes=Primary',
        );
    });

    it('Artists/AlbumArtists lists the album artists like Artists', async () => {
        const music = await seedMusicAlbum(sql);
        const albumArtists = (await get(
            'album-artists',
            'BaseItemDtoQueryResult',
            albumArtistsGet,
            '/j/Artists/AlbumArtists?Fields=PrimaryImageAspectRatio,SortName&StartIndex=0&Limit=50',
        )) as ItemsBody;
        expect(albumArtists.Items.map((i) => i.Id)).toEqual([music.artistId]);
        expect(albumArtists.Items[0].Type).toBe('MusicArtist');
        const artists = (await get(
            'artists-fields',
            'BaseItemDtoQueryResult',
            artistsGet,
            '/j/Artists?Fields=Overview',
        )) as ItemsBody;
        expect(artists.Items.map((i) => i.Id)).toEqual([music.artistId]);
    });
});

describe('/j brief-09 root views', () => {
    it('ExcludeItemIds drops a view; HasParentalRating=true keeps the views listing', async () => {
        const groups = [
            '00000000-0000-4000-8000-0000000b0901',
            '00000000-0000-4000-8000-0000000b0902',
        ];
        for (const [i, id] of groups.entries()) {
            await sql`INSERT INTO library_groups (id, name) VALUES (${id}::uuid, ${`Wave2 ${i}`})
                      ON CONFLICT (id) DO NOTHING`;
            await sql`INSERT INTO library_paths (path, media_type, library_group_id)
                      VALUES (${`/wave2/lib${i}`}, 'movie', ${id}::uuid)`;
        }
        await sql`UPDATE media_files SET library_group_id = ${groups[0]}::uuid
                  WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${movie.itemId}::uuid)`;
        try {
            const views = (await get(
                'items-root-views-has-rating',
                'BaseItemDtoQueryResult',
                itemsGet,
                '/j/Items?HasParentalRating=true',
            )) as ItemsBody;
            expect(views.Items.length).toBeGreaterThan(0);
            expect(views.Items.every((i) => i.Type === 'CollectionFolder')).toBe(true);
            const excluded = (await get(
                'items-root-views-excluded',
                'BaseItemDtoQueryResult',
                itemsGet,
                `/j/Items?ExcludeItemIds=${views.Items[0].Id as string}`,
            )) as ItemsBody;
            expect(excluded.Items.map((i) => i.Id)).not.toContain(views.Items[0].Id);
            expect(excluded.Items).toHaveLength(views.Items.length - 1);
        } finally {
            await sql`DELETE FROM library_paths WHERE library_group_id = ANY(${groups}::uuid[])`;
            await sql`UPDATE media_files SET library_group_id = NULL WHERE library_group_id = ANY(${groups}::uuid[])`;
            await sql`DELETE FROM library_groups WHERE id = ANY(${groups}::uuid[])`;
        }
    });
});
