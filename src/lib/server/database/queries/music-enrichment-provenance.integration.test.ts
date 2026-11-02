// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestArtist,
    createTestAlbum,
    insertTestArtist,
    insertTestAlbum,
    createTestTrack,
    insertTestTrack,
} from '../../../../../tests/integration/fixtures/index.js';
import {
    mergeMusicProvenance,
    writableAlbumArtwork,
    clearMusicArtworkProvenance,
    persistAlbumCoverArtFallback,
} from './music-enrichment-provenance.queries.js';
import {
    updateArtistPosterUrls,
    atomicallyWipeArtistEnrichment,
} from './artist-enrichment.queries.js';
import {
    atomicallyWipeAlbumEnrichment,
    getUnenrichedAlbums,
    countUnenrichedAlbums,
} from './album-enrichment.queries.js';
import { lockArtworkOwners } from './media-artwork.queries.js';
import { getAlbumWithTracks } from './music.queries.js';
import { getMusicAttributionConfig } from './metadata-attributions.queries.js';
import { recomputeHasFilesBatch } from './media-files.queries.js';
import { withTx } from '../with-tx.js';

const source = (value: string) => ({
    provider: 'discogs' as const,
    url: 'https://www.discogs.com/release/42',
    value,
});
describe('persisted music provenance and ownership', () => {
    let sql: postgres.Sql;
    let artistId: string;
    let albumId: string;
    beforeAll(() => {
        sql = getTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, ['media_artwork', 'media_items', 'external_ids']);
        const artist = createTestArtist();
        await insertTestArtist(sql, artist);
        artistId = artist.id;
        const album = createTestAlbum(artistId);
        await insertTestAlbum(sql, album);
        albumId = album.id;
    });
    async function snapshot(id: string) {
        const [row] =
            await sql`SELECT custom_metadata, custom_poster_url, custom_backdrop_url FROM media_items WHERE id = ${id}`;
        return row;
    }
    async function sidecar(id: string, tag: string | null) {
        await sql`INSERT INTO media_artwork (media_item_id, artwork_type, source, remote_url, file_path, language) VALUES (${id}, 'poster', 'local', ${tag}, '/music/folder.jpg', '')`;
    }
    it('partial replacement keeps untouched credit, namespace data and unrelated metadata', async () => {
        await sql`UPDATE media_items SET custom_metadata = ${sql.json({ custom: 'kept', artist_enrichment: { biography: 'bio', provenance: { biography: source('bio'), poster: source('old') } } })} WHERE id = ${artistId}`;
        await mergeMusicProvenance(sql, artistId, 'artist_enrichment', ['poster'], {
            poster: source('new'),
        });
        expect((await snapshot(artistId)).custom_metadata).toEqual({
            custom: 'kept',
            artist_enrichment: {
                biography: 'bio',
                provenance: { biography: source('bio'), poster: source('new') },
            },
        });
        await mergeMusicProvenance(sql, artistId, 'artist_enrichment', ['poster'], {});
        expect((await snapshot(artistId)).custom_metadata.artist_enrichment.provenance).toEqual({
            biography: source('bio'),
        });
    });
    it.each([null, 'historical', 42, []])(
        'repairs malformed provenance %s without losing sibling fields',
        async (invalid) => {
            await sql`UPDATE media_items SET custom_metadata = ${sql.json({ custom: 'kept', album_enrichment: { biography: 'kept bio', provenance: invalid } })} WHERE id = ${albumId}`;
            await mergeMusicProvenance(sql, albumId, 'album_enrichment', ['poster'], {
                poster: source('new'),
            });
            expect((await snapshot(albumId)).custom_metadata).toEqual({
                custom: 'kept',
                album_enrichment: { biography: 'kept bio', provenance: { poster: source('new') } },
            });
        },
    );
    it.each([null, 'historical', 42, []])(
        'repairs malformed enrichment namespace %s',
        async (invalid) => {
            await sql`UPDATE media_items SET custom_metadata = ${sql.json({ custom: 'kept', album_enrichment: invalid })} WHERE id = ${albumId}`;
            await mergeMusicProvenance(sql, albumId, 'album_enrichment', ['poster'], {
                poster: source('new'),
            });
            expect((await snapshot(albumId)).custom_metadata).toEqual({
                custom: 'kept',
                album_enrichment: { provenance: { poster: source('new') } },
            });
        },
    );
    it('projects inherited artist credit only when no album artwork takes precedence', async () => {
        await sql`UPDATE media_items SET custom_poster_url = 'artist-photo', custom_metadata = ${sql.json({ artist_enrichment: { provenance: { poster: { ...source('artist-photo'), url: 'https://www.discogs.com/artist/42' } } } })} WHERE id = ${artistId}`;
        expect((await getAlbumWithTracks(sql, albumId))?.album.inherited_poster_credit_url).toBe(
            'https://www.discogs.com/artist/42',
        );
        await sql`UPDATE media_items SET custom_poster_url = 'curated-photo' WHERE id = ${artistId}`;
        expect(
            (await getAlbumWithTracks(sql, albumId))?.album.inherited_poster_credit_url,
        ).toBeNull();
        await sql`UPDATE media_items SET custom_poster_url = 'artist-photo' WHERE id = ${artistId}`;
        await sidecar(albumId, 'admin:file');
        expect(
            (await getAlbumWithTracks(sql, albumId))?.album.inherited_poster_credit_url,
        ).toBeNull();
        await sql`DELETE FROM media_artwork WHERE media_item_id = ${albumId}`;
        await sql`UPDATE media_items SET custom_poster_url = 'album-cover' WHERE id = ${albumId}`;
        expect(
            (await getAlbumWithTracks(sql, albumId))?.album.inherited_poster_credit_url,
        ).toBeNull();
    });
    it.each([null, 'historical', 42, []])(
        'omits malformed retained-provider provenance %s',
        async (invalid) => {
            await sql`UPDATE media_items SET custom_metadata = ${sql.json({ album_enrichment: { provenance: invalid } })} WHERE id = ${albumId}`;
            expect((await getMusicAttributionConfig(sql)).retainedProviders).toEqual([]);
        },
    );
    it('retains provider presence without credentials or active source-chain configuration', async () => {
        await mergeMusicProvenance(sql, albumId, 'album_enrichment', ['poster'], {
            poster: source('poster'),
        });
        expect((await getMusicAttributionConfig(sql)).retainedProviders).toContain('discogs');
    });
    it.each(['absent', 'plugin', 'historical', 'admin', 'sidecar'])(
        'checks album %s ownership',
        async (kind) => {
            if (kind !== 'absent')
                await sql`UPDATE media_items SET custom_poster_url = 'old', custom_metadata = ${sql.json(kind === 'plugin' ? { album_enrichment: { provenance: { poster: source('old') } } } : {})} WHERE id = ${albumId}`;
            if (kind === 'plugin' || kind === 'admin' || kind === 'sidecar')
                await sidecar(
                    albumId,
                    kind === 'plugin' ? 'album-enrichment' : kind === 'admin' ? 'admin:file' : null,
                );
            expect((await writableAlbumArtwork(sql, albumId)).poster).toBe(
                kind === 'absent' || kind === 'plugin',
            );
        },
    );
    it.each(['absent', 'plugin', 'historical', 'admin', 'sidecar'])(
        'writes only artist %s ownership',
        async (kind) => {
            if (kind === 'plugin' || kind === 'historical')
                await sql`UPDATE media_items SET custom_poster_url = 'old', custom_metadata = ${sql.json(kind === 'plugin' ? { artist_enrichment: { provenance: { poster: source('old') } } } : {})} WHERE id = ${artistId}`;
            if (kind === 'admin' || kind === 'sidecar')
                await sidecar(artistId, kind === 'admin' ? 'admin:file' : null);
            const writable = kind === 'absent' || kind === 'plugin';
            expect((await updateArtistPosterUrls(sql, artistId, 'new', null)).poster).toBe(
                writable,
            );
            expect((await snapshot(artistId)).custom_poster_url).toBe(
                writable ? 'new' : kind === 'historical' ? 'old' : null,
            );
        },
    );
    it('clears artwork and wipes plugin provenance without removing unrelated metadata', async () => {
        await sql`UPDATE media_items SET custom_metadata = ${sql.json({ custom: 'kept', artist_enrichment: { provenance: { poster: source('old'), biography: source('bio') } }, album_enrichment: { provenance: { poster: source('old') } } })}, processing_state = '{"artist-enrichment":{"version":5}}' WHERE id = ${artistId}`;
        await clearMusicArtworkProvenance(sql, artistId, 'poster');
        const meta = (await snapshot(artistId)).custom_metadata;
        expect(meta.artist_enrichment.provenance).toEqual({ biography: source('bio') });
        expect(meta.album_enrichment.provenance).toEqual({});
        await atomicallyWipeArtistEnrichment(sql, [artistId], 'artist_enrichment');
        expect((await snapshot(artistId)).custom_metadata.custom).toBe('kept');
        expect((await snapshot(artistId)).custom_metadata.artist_enrichment).toBeUndefined();
        await sql`UPDATE media_items SET custom_metadata = ${sql.json({ custom: 'kept', album_enrichment: { provenance: { poster: source('old') } } })}, custom_poster_url = 'old' WHERE id = ${albumId}`;
        await atomicallyWipeAlbumEnrichment(sql, [albumId]);
        expect((await snapshot(albumId)).custom_metadata).toEqual({ custom: 'kept' });
    });
    it('rolls back CAA URL if provenance persistence fails', async () => {
        await withTx(sql, async (tx) => {
            await tx`ALTER TABLE media_items ADD CONSTRAINT test_provenance_failure CHECK (NOT (custom_metadata ? 'album_enrichment'))`;
            await expect(
                persistAlbumCoverArtFallback(
                    tx,
                    albumId,
                    'https://coverartarchive.org/release/test/front',
                ),
            ).rejects.toThrow();
            const [row] = await tx`SELECT custom_poster_url FROM media_items WHERE id = ${albumId}`;
            expect(row.custom_poster_url).toBeNull();
            await tx`ALTER TABLE media_items DROP CONSTRAINT test_provenance_failure`;
        });
        expect((await snapshot(albumId)).custom_poster_url).toBeNull();
        expect((await writableAlbumArtwork(sql, albumId)).poster).toBe(true);
    });
    it('rechecks concurrent admin ownership under lock before CAA mutation', async () => {
        let release!: () => void;
        let locked!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const acquired = new Promise<void>((resolve) => {
            locked = resolve;
        });
        const admin = withTx(sql, async (tx) => {
            await lockArtworkOwners(tx, [albumId]);
            locked();
            await held;
            await tx`UPDATE media_items SET custom_poster_url = 'admin' WHERE id = ${albumId}`;
        });
        await acquired;
        const plugin = persistAlbumCoverArtFallback(sql, albumId, 'caa');
        release();
        await Promise.all([admin, plugin]);
        expect((await snapshot(albumId)).custom_poster_url).toBe('admin');
        expect((await snapshot(albumId)).custom_metadata.album_enrichment).toBeUndefined();
    });
    it('drain selects old no-match rows on version bump and excludes current no-match rows', async () => {
        await insertTestTrack(sql, createTestTrack(albumId, 1));
        await recomputeHasFilesBatch(sql, [albumId]);
        await sql`UPDATE media_items SET processing_state = '{"album-enrichment":{"version":1,"status":"no-match"}}' WHERE id = ${albumId}`;
        expect((await getUnenrichedAlbums(sql, 2, 10)).map((row) => row.id)).toContain(albumId);
        expect(await countUnenrichedAlbums(sql, 2)).toBe(1);
        await sql`UPDATE media_items SET processing_state = '{"album-enrichment":{"version":2,"status":"no-match"}}' WHERE id = ${albumId}`;
        expect(await getUnenrichedAlbums(sql, 2, 10)).toEqual([]);
        expect(await countUnenrichedAlbums(sql, 2)).toBe(0);
    });
});
