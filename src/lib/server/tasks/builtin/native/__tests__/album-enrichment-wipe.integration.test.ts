// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * album-enrichment wipe integration tests.
 *
 * Tests `atomicallyWipeAlbumEnrichment` from the queries module against a
 * real PostgreSQL test database.
 *
 * Setup for each test:
 *   - An album (the target) with:
 *       • A `media_artwork` row: source='local', remote_url='album-enrichment'
 *       • custom_poster_url pointing at the plugin's proxy endpoint
 *       • An `external_ids` row: provider='musicbrainz_release', source='album-enrichment'
 *       • An `external_ids` row: provider='musicbrainz_releasegroup', source='album-enrichment'
 *       • processing_state containing 'album-enrichment' namespace key
 *   - A second album (the bystander) with:
 *       • A `media_artwork` row: source='local', remote_url='admin:file' (user-uploaded)
 *   - An `external_ids` row for the target album:
 *       provider='musicbrainz_artist', source='nfo' (should NOT be wiped)
 *       (different provider to avoid unique constraint on media_id+provider+media_type)
 *
 * Assertions after calling atomicallyWipeAlbumEnrichment([albumId]):
 *   ✓ Plugin's media_artwork row deleted.
 *   ✓ Bystander's media_artwork row (admin:file) preserved.
 *   ✓ custom_poster_url on target album nulled.
 *   ✓ Plugin's external_ids rows deleted.
 *   ✓ nfo-sourced external_ids row preserved.
 *   ✓ processing_state 'album-enrichment' key dropped.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../../tests/integration/helpers/cleanup.js';
import {
    insertTestArtist,
    insertTestAlbum,
    createTestArtist,
    createTestAlbum,
} from '../../../../../../../tests/integration/fixtures/index.js';
import { atomicallyWipeAlbumEnrichment } from '../../../../database/queries/album-enrichment.queries.js';

// ─── Test table set ───────────────────────────────────────────────────────────

const WIPE_TEST_TABLES = [
    'media_file_items',
    'media_files',
    'media_items',
    'external_ids',
] as const;

// media_artwork depends on media_items — must be included but listed first
// because TRUNCATE CASCADE handles FKs; ordering doesn't matter with CASCADE
// but we include it so media_artwork rows don't survive between tests.
const ALL_WIPE_TABLES = ['media_artwork', ...WIPE_TEST_TABLES] as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function insertMediaArtwork(
    sql: postgres.Sql,
    params: {
        mediaItemId: string;
        artworkType: 'poster' | 'backdrop';
        source: string;
        remoteUrl: string | null;
        filePath: string | null;
    },
): Promise<string> {
    const [row] = await sql<[{ id: string }]>`
        INSERT INTO media_artwork (media_item_id, artwork_type, source, remote_url, file_path, language)
        VALUES (
            ${params.mediaItemId}::uuid,
            ${params.artworkType},
            ${params.source},
            ${params.remoteUrl},
            ${params.filePath},
            ''
        )
        RETURNING id
    `;
    return row.id;
}

async function insertExternalId(
    sql: postgres.Sql,
    params: {
        mediaId: string;
        provider: string;
        externalId: string;
        mediaType: string;
        source: string | null;
    },
): Promise<void> {
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, source)
        VALUES (
            ${params.mediaId}::uuid,
            ${params.provider},
            ${params.externalId},
            ${params.mediaType},
            ${params.source}
        )
    `;
}

async function setCustomPosterUrl(
    sql: postgres.Sql,
    albumId: string,
    url: string | null,
): Promise<void> {
    await sql`
        UPDATE media_items
        SET custom_poster_url = ${url}
        WHERE id = ${albumId}::uuid
    `;
}

async function setProcessingState(
    sql: postgres.Sql,
    albumId: string,
    state: Record<string, unknown>,
): Promise<void> {
    await sql`
        UPDATE media_items
        SET processing_state = ${sql.json(state as Record<string, never>)}
        WHERE id = ${albumId}::uuid
    `;
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('atomicallyWipeAlbumEnrichment (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ALL_WIPE_TABLES);
    });

    // ── Core wipe behaviour ───────────────────────────────────────────────────

    it('deletes plugin-authored artwork row and preserves user-uploaded row', async () => {
        const artist = createTestArtist({ title: 'Test Artist Wipe' });
        await insertTestArtist(sql, artist);

        const album = createTestAlbum(artist.id, { title: 'Target Album' });
        await insertTestAlbum(sql, album);

        const bystander = createTestAlbum(artist.id, {
            title: 'Bystander Album',
        });
        await insertTestAlbum(sql, bystander);

        // Plugin-authored artwork on target
        await insertMediaArtwork(sql, {
            mediaItemId: album.id,
            artworkType: 'poster',
            source: 'local',
            remoteUrl: 'album-enrichment',
            filePath: '/data/.metadata/album-id/poster.jpg',
        });

        // User-uploaded artwork on bystander
        await insertMediaArtwork(sql, {
            mediaItemId: bystander.id,
            artworkType: 'poster',
            source: 'local',
            remoteUrl: 'admin:file',
            filePath: '/uploads/bystander/poster.jpg',
        });

        await atomicallyWipeAlbumEnrichment(sql as never, [album.id]);

        // Plugin row gone
        const targetRows = await sql<{ id: string }[]>`
            SELECT id FROM media_artwork
            WHERE media_item_id = ${album.id}::uuid
        `;
        expect(targetRows).toHaveLength(0);

        // Bystander row preserved
        const bystanderRows = await sql<{ id: string }[]>`
            SELECT id FROM media_artwork
            WHERE media_item_id = ${bystander.id}::uuid
        `;
        expect(bystanderRows).toHaveLength(1);
    });

    it('nulls custom_poster_url when it points at the plugin proxy endpoint', async () => {
        const artist = createTestArtist({ title: 'Test Artist URL' });
        await insertTestArtist(sql, artist);

        const album = createTestAlbum(artist.id, { title: 'URL Test Album' });
        await insertTestAlbum(sql, album);

        const proxyUrl = `/api/image/custom/${album.id}/poster`;
        await setCustomPosterUrl(sql, album.id, proxyUrl);

        await insertMediaArtwork(sql, {
            mediaItemId: album.id,
            artworkType: 'poster',
            source: 'local',
            remoteUrl: 'album-enrichment',
            filePath: '/data/.metadata/album-id/poster.jpg',
        });

        await atomicallyWipeAlbumEnrichment(sql as never, [album.id]);

        const [row] = await sql<[{ custom_poster_url: string | null }]>`
            SELECT custom_poster_url FROM media_items WHERE id = ${album.id}::uuid
        `;
        expect(row.custom_poster_url).toBeNull();
    });

    it('preserves custom_poster_url when it does NOT point at the plugin proxy endpoint', async () => {
        const artist = createTestArtist({ title: 'Test Artist ExtURL' });
        await insertTestArtist(sql, artist);

        const album = createTestAlbum(artist.id, {
            title: 'External URL Album',
        });
        await insertTestAlbum(sql, album);

        // A URL from a different source (e.g., TMDB) — must not be cleared
        await setCustomPosterUrl(sql, album.id, 'https://image.tmdb.org/t/p/w500/abc.jpg');

        await insertMediaArtwork(sql, {
            mediaItemId: album.id,
            artworkType: 'poster',
            source: 'local',
            remoteUrl: 'album-enrichment',
            filePath: '/data/.metadata/album-id/poster.jpg',
        });

        await atomicallyWipeAlbumEnrichment(sql as never, [album.id]);

        const [row] = await sql<[{ custom_poster_url: string | null }]>`
            SELECT custom_poster_url FROM media_items WHERE id = ${album.id}::uuid
        `;
        // Non-plugin URL is preserved
        expect(row.custom_poster_url).toBe('https://image.tmdb.org/t/p/w500/abc.jpg');
    });

    it('deletes plugin-authored external_ids and preserves external_ids from other sources', async () => {
        const artist = createTestArtist({ title: 'Test Artist EIDs' });
        await insertTestArtist(sql, artist);

        const album = createTestAlbum(artist.id, { title: 'MBID Album' });
        await insertTestAlbum(sql, album);

        // Plugin-authored release MBID
        await insertExternalId(sql, {
            mediaId: album.id,
            provider: 'musicbrainz_release',
            externalId: 'aaaaaaaa-0001-0001-0001-000000000001',
            mediaType: 'album',
            source: 'album-enrichment',
        });

        // Plugin-authored release-group MBID
        await insertExternalId(sql, {
            mediaId: album.id,
            provider: 'musicbrainz_releasegroup',
            externalId: 'bbbbbbbb-0002-0002-0002-000000000002',
            mediaType: 'album',
            source: 'album-enrichment',
        });

        // NFO-sourced artist MBID — different provider so it coexists with the
        // plugin-authored release MBID (unique constraint is on media_id + provider
        // + media_type; using a distinct provider avoids the collision).
        await insertExternalId(sql, {
            mediaId: album.id,
            provider: 'musicbrainz_artist',
            externalId: 'cccccccc-0003-0003-0003-000000000003',
            mediaType: 'album',
            source: 'nfo',
        });

        await atomicallyWipeAlbumEnrichment(sql as never, [album.id]);

        const remaining = await sql<
            { provider: string; source: string | null; external_id: string }[]
        >`
            SELECT provider, source, external_id FROM external_ids
            WHERE media_id = ${album.id}::uuid
            ORDER BY provider
        `;

        // Only the nfo-sourced musicbrainz_artist row should remain; both plugin
        // rows (musicbrainz_release + musicbrainz_releasegroup) were wiped.
        expect(remaining).toHaveLength(1);
        expect(remaining[0].source).toBe('nfo');
        expect(remaining[0].external_id).toBe('cccccccc-0003-0003-0003-000000000003');
    });

    it('drops the album-enrichment key from processing_state', async () => {
        const artist = createTestArtist({ title: 'Test Artist PS' });
        await insertTestArtist(sql, artist);

        const album = createTestAlbum(artist.id, {
            title: 'Processing State Album',
        });
        await insertTestAlbum(sql, album);

        await setProcessingState(sql, album.id, {
            'album-enrichment': {
                version: 1,
                status: 'success',
                processedAt: '2026-04-25T00:00:00Z',
            },
            'other-plugin': {
                version: 2,
                status: 'success',
            },
        });

        await atomicallyWipeAlbumEnrichment(sql as never, [album.id]);

        const [row] = await sql<[{ processing_state: Record<string, unknown> | null }]>`
            SELECT processing_state FROM media_items WHERE id = ${album.id}::uuid
        `;

        const ps = row.processing_state ?? {};
        // album-enrichment key dropped
        expect(ps['album-enrichment']).toBeUndefined();
        // Other plugin keys preserved
        expect(ps['other-plugin']).toBeDefined();
    });

    // ── Atomicity: wipe does not touch a different album's rows ───────────────

    it('only wipes the specified albumId — sibling album rows untouched', async () => {
        const artist = createTestArtist({ title: 'Test Artist Sibling' });
        await insertTestArtist(sql, artist);

        const target = createTestAlbum(artist.id, { title: 'Target' });
        const sibling = createTestAlbum(artist.id, { title: 'Sibling' });
        await insertTestAlbum(sql, target);
        await insertTestAlbum(sql, sibling);

        // Both have plugin-authored artwork
        await insertMediaArtwork(sql, {
            mediaItemId: target.id,
            artworkType: 'poster',
            source: 'local',
            remoteUrl: 'album-enrichment',
            filePath: '/data/.metadata/target/poster.jpg',
        });
        await insertMediaArtwork(sql, {
            mediaItemId: sibling.id,
            artworkType: 'poster',
            source: 'local',
            remoteUrl: 'album-enrichment',
            filePath: '/data/.metadata/sibling/poster.jpg',
        });

        // Only wipe target
        await atomicallyWipeAlbumEnrichment(sql as never, [target.id]);

        // Target's artwork gone
        const targetArt = await sql<{ id: string }[]>`
            SELECT id FROM media_artwork WHERE media_item_id = ${target.id}::uuid
        `;
        expect(targetArt).toHaveLength(0);

        // Sibling's artwork intact
        const siblingArt = await sql<{ id: string }[]>`
            SELECT id FROM media_artwork WHERE media_item_id = ${sibling.id}::uuid
        `;
        expect(siblingArt).toHaveLength(1);
    });

    // ── Empty batch is a no-op ────────────────────────────────────────────────

    it('is a no-op when albumIds list is empty', async () => {
        const artist = createTestArtist({ title: 'Test Artist NoOp' });
        await insertTestArtist(sql, artist);

        const album = createTestAlbum(artist.id, { title: 'NoOp Album' });
        await insertTestAlbum(sql, album);

        await insertMediaArtwork(sql, {
            mediaItemId: album.id,
            artworkType: 'poster',
            source: 'local',
            remoteUrl: 'album-enrichment',
            filePath: '/data/.metadata/album/poster.jpg',
        });

        // Passing empty array
        await atomicallyWipeAlbumEnrichment(sql as never, []);

        // Row still present
        const rows = await sql<{ id: string }[]>`
            SELECT id FROM media_artwork WHERE media_item_id = ${album.id}::uuid
        `;
        expect(rows).toHaveLength(1);
    });

    // ── Backdrop artwork is also wiped ────────────────────────────────────────

    it('wipes backdrop artwork rows in addition to poster', async () => {
        const artist = createTestArtist({ title: 'Test Artist Backdrop' });
        await insertTestArtist(sql, artist);

        const album = createTestAlbum(artist.id, { title: 'Backdrop Album' });
        await insertTestAlbum(sql, album);

        await insertMediaArtwork(sql, {
            mediaItemId: album.id,
            artworkType: 'poster',
            source: 'local',
            remoteUrl: 'album-enrichment',
            filePath: '/data/.metadata/album/poster.jpg',
        });
        await insertMediaArtwork(sql, {
            mediaItemId: album.id,
            artworkType: 'backdrop',
            source: 'local',
            remoteUrl: 'album-enrichment',
            filePath: '/data/.metadata/album/backdrop.jpg',
        });

        await atomicallyWipeAlbumEnrichment(sql as never, [album.id]);

        const remaining = await sql<{ artwork_type: string }[]>`
            SELECT artwork_type FROM media_artwork WHERE media_item_id = ${album.id}::uuid
        `;
        expect(remaining).toHaveLength(0);
    });
});
