// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    type MediaType,
} from '../../../../../tests/integration/fixtures/media.fixtures.js';
import { upsertLocalArtwork } from '$lib/server/database/queries/media-artwork.queries.js';
import {
    registerImageCandidate,
    selectImageCandidate,
} from '$lib/server/database/queries/image-candidates.queries.js';
import { getImageDescriptorOwners } from '$lib/server/database/queries/image-descriptor.queries.js';
import { resolveImageSet, resolveImageSets } from './index.js';
import type { ImageSetRole } from '$lib/schemas/api-image-descriptor.js';

let sql: postgres.Sql;
let ids: Record<string, string>;
async function artwork(
    name: string,
    role: 'poster' | 'backdrop' | 'logo' | 'thumb',
): Promise<void> {
    await upsertLocalArtwork(sql, {
        mediaItemId: ids[name],
        artworkType: role,
        filePath: `/absent/${name}-${role}.jpg`,
    });
}
describe('database image descriptors', () => {
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, 'image_candidates']);
        ids = {};
        for (const [name, media_type, parent] of [
            ['movie', 'movie'],
            ['series', 'tv'],
            ['season', 'season', 'series'],
            ['episode', 'episode', 'season'],
            ['artist', 'artist'],
            ['album', 'album', 'artist'],
            ['track', 'track', 'album'],
            ['book', 'audiobook'],
        ] as [string, MediaType, string?][]) {
            const row = createTestMediaItem({
                media_type,
                parent_id: parent ? ids[parent] : null,
                title: `Descriptor ${name}`,
            });
            await insertTestMediaItem(sql, row);
            ids[name] = row.id;
        }
    });
    const selfRows: [string, ImageSetRole, 'poster' | 'backdrop' | 'logo' | 'thumb'][] = [
        ...['movie', 'series', 'season', 'episode'].flatMap(
            (name): [string, ImageSetRole, 'poster' | 'backdrop' | 'logo' | 'thumb'][] =>
                (['poster', 'backdrop', 'logo', 'thumb'] as const).map((role) => [
                    name,
                    role,
                    role,
                ]),
        ),
        ['track', 'primary', 'poster'],
        ['album', 'primary', 'poster'],
        ['artist', 'primary', 'poster'],
        ['artist', 'backdrop', 'backdrop'],
        ['artist', 'logo', 'logo'],
        ['book', 'primary', 'poster'],
    ];
    it.each(selfRows)('%s offers its own %s', async (name, role, slot) => {
        await artwork(name, slot);
        const set = await resolveImageSet(sql, 'v1', ids[name]);
        expect(set[role]?.source).toBe('self');
        expect(set[role]?.href).toContain(`/media/${ids[name]}/images/${slot}?`);
        expect(set[role]?.revision).toMatch(/^[0-9a-f]{12}$/);
    });
    it.each(['poster', 'backdrop', 'logo'] as const)(
        'season and episode inherit %s from the nearest eligible ancestor',
        async (role) => {
            await artwork('series', role);
            const sets = await resolveImageSets(
                sql,
                'v1',
                Object.values(ids).map((id) => ({ id })),
            );
            expect(sets.get(ids.season)?.[role]?.source).toBe('series');
            expect(sets.get(ids.episode)?.[role]).toEqual(sets.get(ids.season)?.[role]);
            expect(sets.get(ids.episode)?.[role]?.revision).toBe(
                sets.get(ids.series)?.[role]?.revision,
            );
            await artwork('season', role);
            expect((await resolveImageSet(sql, 'v1', ids.episode))[role]?.source).toBe('season');
            await artwork('episode', role);
            expect((await resolveImageSet(sql, 'v1', ids.episode))[role]?.source).toBe('self');
        },
    );
    it('episode thumb uses still, frame, series backdrop in order, never series poster or season thumb', async () => {
        await artwork('series', 'poster');
        await artwork('season', 'thumb');
        expect((await resolveImageSet(sql, 'v1', ids.episode)).thumb).toBeUndefined();
        await artwork('series', 'backdrop');
        const inherited = (await resolveImageSet(sql, 'v1', ids.episode)).thumb;
        expect(inherited?.source).toBe('series');
        expect(inherited?.href).toContain(`/media/${ids.series}/images/backdrop?`);
        expect((await resolveImageSet(sql, 'v1', ids.season)).backdrop?.source).toBe('series');
        expect(
            (await resolveImageSet(sql, 'v1', ids.episode, undefined, { inherit: 'none' })).thumb,
        ).toBeUndefined();
        await artwork('episode', 'backdrop');
        expect((await resolveImageSet(sql, 'v1', ids.episode)).thumb?.href).toContain(
            `/media/${ids.episode}/images/backdrop?`,
        );
        await artwork('episode', 'thumb');
        expect((await resolveImageSet(sql, 'v1', ids.episode)).thumb?.href).toContain(
            `/media/${ids.episode}/images/thumb?`,
        );
    });
    it('season thumbs are self only and track covers stop at the album', async () => {
        await artwork('series', 'thumb');
        await artwork('artist', 'poster');
        await sql`UPDATE media_items SET custom_poster_url = 'https://example.com/artist' WHERE id = ${ids.artist}`;
        expect(await resolveImageSet(sql, 'v1', ids.season)).toEqual({});
        expect(await resolveImageSet(sql, 'v1', ids.track)).toEqual({});
        expect((await resolveImageSet(sql, 'v1', ids.album)).primary?.source).toBe('artist');
        await artwork('album', 'poster');
        expect((await resolveImageSet(sql, 'v1', ids.track)).primary?.source).toBe('album');
        expect(await resolveImageSet(sql, 'v1', ids.track, undefined, { inherit: 'none' })).toEqual(
            {},
        );
        await artwork('track', 'poster');
        expect((await resolveImageSet(sql, 'v1', ids.track)).primary?.source).toBe('self');
    });
    it('resolves album artwork in batch without persisting an artist fallback and updates v for a real cover', async () => {
        expect(await resolveImageSet(sql, 'v1', ids.album)).toEqual({});
        await artwork('artist', 'poster');
        const sets = await resolveImageSets(sql, 'v1', [{ id: ids.album }, { id: ids.artist }]);
        const fallback = sets.get(ids.album)?.primary;
        expect(fallback).toEqual({ ...sets.get(ids.artist)?.primary, source: 'artist' });
        expect(fallback?.href).toContain(`/media/${ids.artist}/images/poster?`);
        expect(fallback?.variants?.thumb).toContain(`&v=${fallback?.revision}`);
        expect(await resolveImageSet(sql, 'v1', ids.album, undefined, { inherit: 'none' })).toEqual(
            {},
        );
        const [album] =
            await sql`SELECT custom_poster_url FROM media_items WHERE id = ${ids.album}`;
        expect(album.custom_poster_url).toBeNull();
        expect(
            await sql`SELECT id FROM media_artwork WHERE media_item_id = ${ids.album}`,
        ).toHaveLength(0);
        await artwork('album', 'poster');
        const own = (await resolveImageSet(sql, 'v1', ids.album)).primary;
        expect(own?.source).toBe('self');
        expect(own?.href).toContain(`/media/${ids.album}/images/poster?`);
        expect(own?.revision).not.toBe(fallback?.revision);
        expect(own?.variants?.thumb).not.toBe(fallback?.variants?.thumb);
    });
    it('keeps album selection ahead of artist candidates and reports the inherited provider', async () => {
        const artistCandidate = await registerImageCandidate(sql, {
            mediaItemId: ids.artist,
            role: 'poster',
            provider: 'discogs',
            providerRef: 'https://i.discogs.com/artist.jpg',
            width: 700,
            height: 700,
        });
        const fallback = (await resolveImageSet(sql, 'v1', ids.album)).primary;
        expect(fallback).toMatchObject({
            source: 'artist',
            provider: 'discogs',
            width: 700,
            height: 700,
        });
        expect(fallback?.href).toContain(`/media/${ids.artist}/images/poster?`);
        expect(await resolveImageSet(sql, 'v1', ids.track)).toEqual({});
        const albumCandidate = await registerImageCandidate(sql, {
            mediaItemId: ids.album,
            role: 'poster',
            provider: 'deezer',
            providerRef: 'https://cdn-images.dzcdn.net/album.jpg',
        });
        await selectImageCandidate(sql, ids.album, albumCandidate!, true, true);
        const selected = (await resolveImageSet(sql, 'v1', ids.album)).primary;
        expect(selected).toMatchObject({ source: 'self', provider: 'deezer' });
        expect(selected?.href).toContain(`/media/${ids.album}/images/poster?`);
        expect(selected?.revision).not.toBe(fallback?.revision);
        await sql`DELETE FROM image_candidates WHERE id = ${albumCandidate}`;
        expect((await resolveImageSet(sql, 'v1', ids.album)).primary?.source).toBe('artist');
        await sql`UPDATE media_items SET is_various_artists = true WHERE id = ${ids.artist}`;
        expect(await resolveImageSet(sql, 'v1', ids.album)).toEqual({});
        expect(
            await sql`SELECT id FROM image_candidates WHERE media_item_id = ${ids.album}`,
        ).toHaveLength(0);
        expect(
            await sql`SELECT id FROM image_candidates WHERE id = ${artistCandidate}`,
        ).toHaveLength(1);
    });
    it('never substitutes a Various Artists picture, even with a custom or local image', async () => {
        await sql`UPDATE media_items SET is_various_artists = true, title = 'VA localized label',
            custom_poster_url = 'https://example.com/va.jpg' WHERE id = ${ids.artist}`;
        await artwork('artist', 'poster');
        expect(await resolveImageSet(sql, 'v1', ids.album)).toEqual({});
        expect(
            (await getImageDescriptorOwners(sql, [ids.album])).find((row) => row.id === ids.artist)
                ?.is_various_artists,
        ).toBe(true);
        await artwork('album', 'poster');
        expect((await resolveImageSet(sql, 'v1', ids.album)).primary?.source).toBe('self');
    });
    it('reads neutral and legacy provider paths, paired custom columns, owner blurhash and local updated_at', async () => {
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
            VALUES (${ids.series}, 'aggregated', ${sql.json({ artwork: { poster: '/poster', backdrop: '/bg' }, logo_path: '/logo', still_path: '/still' })}, NOW())`;
        await sql`UPDATE media_items SET poster_blurhash = 'series-poster', backdrop_blurhash = 'series-backdrop' WHERE id = ${ids.series}`;
        await sql`UPDATE media_items SET custom_logo_url = 'https://example.com/logo', custom_backdrop_url = 'https://example.com/bg', custom_thumb_url = 'https://example.com/still', custom_poster_url = 'https://example.com/poster' WHERE id = ${ids.movie}`;
        const sets = await resolveImageSets(sql, 'internal', [
            { id: ids.series },
            { id: ids.movie },
            { id: ids.episode },
        ]);
        expect(Object.keys(sets.get(ids.movie) ?? {})).toEqual([
            'poster',
            'backdrop',
            'logo',
            'thumb',
        ]);
        expect(Object.keys(sets.get(ids.series) ?? {})).toEqual([
            'poster',
            'backdrop',
            'logo',
            'thumb',
        ]);
        expect(sets.get(ids.episode)?.poster?.placeholder).toEqual({ blurhash: 'series-poster' });
        expect(sets.get(ids.episode)?.backdrop?.placeholder).toEqual({
            blurhash: 'series-backdrop',
        });
        await artwork('album', 'poster');
        await sql`UPDATE media_items SET poster_blurhash = 'album-cover' WHERE id = ${ids.album}`;
        expect((await resolveImageSet(sql, 'v1', ids.track)).primary?.placeholder).toEqual({
            blurhash: 'album-cover',
        });
        const first = (await resolveImageSet(sql, 'v1', ids.album)).primary?.revision;
        await sql`UPDATE image_candidates SET updated_at = updated_at + INTERVAL '1 second' WHERE media_item_id = ${ids.album}`;
        expect((await resolveImageSet(sql, 'v1', ids.album)).primary?.revision).not.toBe(first);
        const owners = await getImageDescriptorOwners(sql, [ids.episode, ids.track]);
        expect(new Set(owners.map((row) => row.id))).toEqual(
            new Set([ids.episode, ids.season, ids.series, ids.track, ids.album, ids.artist]),
        );
        expect(await getImageDescriptorOwners(sql, ['not-a-uuid'])).toEqual([]);
    });
    it('uses configured candidate priority and refreshes changed provider references', async () => {
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at) VALUES
            (${ids.movie}, 'aggregated', ${sql.json({ poster_path: '/aggregated' })}, NOW()),
            (${ids.movie}, 'tmdb', ${sql.json({ poster_path: '/tmdb' })}, NOW())`;
        await sql`INSERT INTO provider_capabilities (provider, enabled) VALUES ('tmdb', true) ON CONFLICT (provider) DO UPDATE SET enabled = true`;
        const first = (await resolveImageSet(sql, 'v1', ids.movie)).poster?.revision;
        await sql`UPDATE media_items SET preferred_provider = 'tmdb' WHERE id = ${ids.movie}`;
        expect((await getImageDescriptorOwners(sql, [ids.movie]))[0].provider_paths.poster).toBe(
            '/tmdb',
        );
        const second = (await resolveImageSet(sql, 'v1', ids.movie)).poster?.revision;
        expect(second).toBe(first);
        await sql`UPDATE provider_metadata SET metadata = ${sql.json({ poster_path: '/changed' })} WHERE media_id = ${ids.movie} AND provider = 'tmdb'`;
        const third = (await resolveImageSet(sql, 'v1', ids.movie)).poster?.revision;
        expect(third).not.toBe(second);
        await sql`UPDATE media_items SET custom_poster_url = 'https://example.com/new' WHERE id = ${ids.movie}`;
        expect((await resolveImageSet(sql, 'v1', ids.movie)).poster?.revision).toBe(third);
    });
});
