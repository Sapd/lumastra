// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * getJellyfinItemImages against real rows: every source the image route can
 * serve counts (provider paths incl. the neutral artwork block, custom URLs,
 * local artwork files, an AudiobookShelf cover), nothing inherited is reported
 * as the item's own, and the parent chain comes back nearest first.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { getImageDescriptorOwners } from './image-descriptor.queries.js';
import { getJellyfinItemImages } from './jellyfin-item-images.queries.js';
import { upsertLocalArtwork } from './media-artwork.queries.js';

let sql: postgres.Sql;

beforeAll(() => {
    sql = getTestDb();
});
afterAll(async () => {
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, [
        'media_artwork',
        'provider_metadata',
        'external_ids',
        'media_items',
    ]);
});

async function item(
    mediaType: string,
    parentId: string | null = null,
    extra: { custom_poster_url?: string; custom_logo_url?: string; poster_blurhash?: string } = {},
): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, status, parent_id, custom_poster_url, custom_logo_url, poster_blurhash)
        VALUES ('x', ${mediaType}, 'active', ${parentId}, ${extra.custom_poster_url ?? null},
                ${extra.custom_logo_url ?? null}, ${extra.poster_blurhash ?? null})
        RETURNING id`;
    return row.id;
}

async function metadata(
    mediaId: string,
    provider: string,
    data: Record<string, unknown>,
): Promise<void> {
    await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
              VALUES (${mediaId}, ${provider}, ${sql.json(data as postgres.JSONValue)})`;
}

async function artwork(mediaId: string, type: string, file: string): Promise<void> {
    await sql`INSERT INTO media_artwork (media_item_id, artwork_type, source, file_path)
              VALUES (${mediaId}, ${type}, 'local', ${file})`;
}

describe('getJellyfinItemImages', () => {
    it('ignores archived candidates in legacy image availability and revisions', async () => {
        const id = await item('movie');
        await artwork(id, 'poster', '/art/hidden.jpg');
        await sql`UPDATE image_candidates SET suppressed=true,selected=false WHERE media_item_id=${id}`;
        expect((await getJellyfinItemImages(sql, [id])).nodes.get(id)?.poster_src).toBeNull();
    });
    it('reads every own source and walks the parent chain', async () => {
        const series = await item('tv', null, { poster_blurhash: 'LHASH' });
        await metadata(series, 'tmdb', { poster_path: '/p.jpg', backdrop_path: '/b.jpg' });
        await artwork(series, 'logo', '/art/logo.png');
        const season = await item('season', series);
        const episode = await item('episode', season);
        await metadata(episode, 'tvdb', { artwork: { still: 'https://x/still.jpg' } });
        await artwork(episode, 'backdrop', '/frames/ep.jpg');

        const { nodes, chains } = await getJellyfinItemImages(sql, [episode, 'not-a-uuid']);
        expect(chains.get(episode)?.nodeIds).toEqual([episode, season, series]);
        expect(chains.has('not-a-uuid')).toBe(false);

        const s = nodes.get(series)!;
        expect(s.poster_src).toMatch(/^\/p\.jpg#@/);
        expect(s.backdrop_src).toMatch(/^\/b\.jpg#@/);
        expect(s.logo_src).toMatch(/^\/art\/logo\.png@/);
        expect(s.poster_blurhash).toBe('LHASH');

        // Nothing of the series is reported as the season's own.
        const se = nodes.get(season)!;
        expect([se.poster_src, se.backdrop_src, se.logo_src, se.thumb_src]).toEqual([
            null,
            null,
            null,
            null,
        ]);

        const e = nodes.get(episode)!;
        expect(e.still_src).toMatch(/^https:\/\/x\/still\.jpg#@.*\|\/frames\/ep\.jpg@/);
        // The extracted frame is a local "backdrop" row, but not a metadata backdrop.
        expect(e.backdrop_src).toMatch(/^\/frames\/ep\.jpg@/);
        expect(e.backdrop_meta_src).toBeNull();
    });

    it('combines legacy and canonical reads without changing the bounded nodes or revisions', async () => {
        const series = await item('tv', null, {
            custom_poster_url: 'https://images.example/series.jpg',
        });
        const season = await item('season', series);
        const first = await item('episode', season);
        const second = await item('episode', season);
        await metadata(series, 'tmdb', {
            poster_path: '/series.jpg',
            backdrop_path: '/backdrop.jpg',
        });
        await artwork(first, 'backdrop', '/frames/first.jpg');
        const ids = [first, second, first, 'not-a-uuid'];
        const compare = async () => {
            const legacy = await getJellyfinItemImages(sql, ids);
            const owners = await getImageDescriptorOwners(sql, [...legacy.nodes.keys()]);
            const combined = await getJellyfinItemImages(sql, ids, true);
            expect(combined.nodes).toEqual(legacy.nodes);
            expect(combined.chains).toEqual(legacy.chains);
            expect(combined.owners).toEqual(
                new Map(owners.filter((r) => legacy.nodes.has(r.id)).map((r) => [r.id, r])),
            );
            expect(combined.owners?.size).toBe(4);
            return combined;
        };
        const before = await compare();
        await sql`UPDATE provider_metadata SET metadata='{"poster_path":"/changed.jpg"}'::jsonb,
            updated_at=now()+interval '1 second' WHERE media_id=${series}`;
        const after = await compare();
        expect(after.nodes.get(series)?.poster_src).not.toBe(before.nodes.get(series)?.poster_src);
        expect(after.owners?.get(series)?.provider_paths).not.toEqual(
            before.owners?.get(series)?.provider_paths,
        );
        const empty = await getJellyfinItemImages(sql, ['bad-id'], true);
        expect(empty.owners?.size).toBe(0);
    });

    it('custom URLs and an AudiobookShelf cover count as posters / logos', async () => {
        const channel = await item('tvchannel', null, {
            custom_poster_url: 'https://logos/x.png',
            custom_logo_url: 'https://logos/y.png',
        });
        const book = await item('audiobook');
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                  VALUES (${book}, 'audiobookshelf', 'abs-1', 'audiobook', true)`;
        const bare = await item('movie');

        const { nodes } = await getJellyfinItemImages(sql, [channel, book, bare]);
        expect(nodes.get(channel)?.poster_src).toBe('https://logos/x.png');
        expect(nodes.get(channel)?.logo_src).toBe('https://logos/y.png');
        expect(nodes.get(book)?.poster_src).toMatch(/^abs:abs-1:/);
        expect(nodes.get(bare)?.poster_src).toBeNull();
    });

    it('a changed source changes the identity string', async () => {
        const movie = await item('movie');
        await metadata(movie, 'tmdb', { poster_path: '/old.jpg' });
        const before = (await getJellyfinItemImages(sql, [movie])).nodes.get(movie)?.poster_src;
        await sql`UPDATE provider_metadata SET metadata = jsonb_set(metadata, '{poster_path}', '"/new.jpg"')
                  WHERE media_id = ${movie}`;
        const after = (await getJellyfinItemImages(sql, [movie])).nodes.get(movie)?.poster_src;
        expect(before).toMatch(/^\/old\.jpg#/);
        expect(after).toMatch(/^\/new\.jpg#/);
    });

    it('exposes the tmdb / jellyfin ids the route can fetch live with', async () => {
        const movie = await item('movie');
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                  VALUES (${movie}, 'tmdb', '693134', 'movie', true),
                         (${movie}, 'jellyfin', 'abcdef0123456789abcdef0123456789', 'movie', false)`;
        const n = (await getJellyfinItemImages(sql, [movie])).nodes.get(movie)!;
        expect(n.poster_src).toBeNull();
        expect(n.tmdb_id).toBe('693134');
        expect(n.jellyfin_id).toBe('abcdef0123456789abcdef0123456789');
    });

    it('an admin re-upload to the same path changes the source (a new tag)', async () => {
        const movie = await item('movie');
        const write = (): Promise<unknown> =>
            upsertLocalArtwork(sql, {
                mediaItemId: movie,
                artworkType: 'poster',
                filePath: '/meta/movie/poster.jpg',
                sourceTag: 'admin:file',
            });
        await write();
        const before = (await getJellyfinItemImages(sql, [movie])).nodes.get(movie)?.poster_src;
        await new Promise((r) => setTimeout(r, 5));
        await write();
        const after = (await getJellyfinItemImages(sql, [movie])).nodes.get(movie)?.poster_src;
        expect(before).toContain('/meta/movie/poster.jpg@');
        expect(after).not.toBe(before);
    });

    it('a provider refresh that keeps the path text changes the source', async () => {
        // (A preferred-provider switch is folded in the same way, as `#<provider>@`;
        // the test DB only enables providers by config, so it is not exercised here.)
        const movie = await item('movie');
        await metadata(movie, 'tmdb', { poster_path: '/same.jpg' });
        const src = async (): Promise<string | null | undefined> =>
            (await getJellyfinItemImages(sql, [movie])).nodes.get(movie)?.poster_src;
        const first = await src();
        await sql`UPDATE provider_metadata SET updated_at = now() + interval '1 second' WHERE media_id = ${movie}`;
        const refreshed = await src();
        expect(first).toMatch(/^\/same\.jpg#@/);
        expect(refreshed).toMatch(/^\/same\.jpg#@/);
        expect(refreshed).not.toBe(first);
    });
});
