// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import {
    createTestArtist,
    createTestAlbum,
    createTestTrack,
    insertTestArtist,
    insertTestAlbum,
    insertTestTrack,
} from '../../../../../../../tests/integration/fixtures/index.js';
import { linkRemixerArtists } from '../media-sources/_helpers/file-scanner/audio-processor.js';
import type { FileScannerContext } from '../media-sources/_helpers/file-scanner/shared.js';

const silentLogger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
};
// linkRemixerArtists only reads context.logger — same structural-subset
// pattern drainBacklog documents in builtin/CLAUDE.md.
const context = { logger: silentLogger } as unknown as FileScannerContext;

describe('linkRemixerArtists (match-only scan pass)', () => {
    let sql: postgres.Sql;
    let remixerId: string;
    let trackId: string;
    let unknownRemixTrackId: string;

    beforeAll(async () => {
        sql = getTestDb();
        await sql`TRUNCATE TABLE media_embeddings, media_file_items, media_files, watch_history, media_items CASCADE`;

        const remixer = createTestArtist({ title: 'Ekoglow' });
        await insertTestArtist(sql, remixer);
        remixerId = remixer.id;

        const performer = createTestArtist({ title: 'Refresh' });
        await insertTestArtist(sql, performer);

        const album = createTestAlbum(performer.id, { title: 'Harbortime' });
        await insertTestAlbum(sql, album);

        const remixTrack = createTestTrack(album.id, 1, {
            title: 'Harbortime (Ekoglow Remix)',
        });
        await insertTestTrack(sql, remixTrack);
        trackId = remixTrack.id;

        const unknownRemix = createTestTrack(album.id, 2, {
            title: 'Harbortime (Nobody Known Remix)',
        });
        await insertTestTrack(sql, unknownRemix);
        unknownRemixTrackId = unknownRemix.id;
    });

    afterAll(async () => {
        await closeTestDb();
    });

    async function additionalIds(id: string): Promise<string[]> {
        const [row] = await sql<{ ids: unknown }[]>`
            SELECT COALESCE(custom_metadata->'additional_artist_ids', '[]'::jsonb) AS ids
            FROM media_items WHERE id = ${id}::uuid
        `;
        return Array.isArray(row?.ids) ? (row.ids as string[]) : [];
    }

    it('links a known remixer into additional_artist_ids', async () => {
        const updated = await linkRemixerArtists(sql, context);
        expect(updated).toBeGreaterThanOrEqual(1);
        expect(await additionalIds(trackId)).toContain(remixerId);
    });

    it('never creates an artist for an unknown remixer (match-only)', async () => {
        expect(await additionalIds(unknownRemixTrackId)).toEqual([]);
        const [row] = await sql<{ n: number }[]>`
            SELECT COUNT(*)::int AS n FROM media_items
            WHERE media_type = 'artist' AND LOWER(title) LIKE '%nobody known%'
        `;
        expect(row.n).toBe(0);
    });

    it('is idempotent — second run appends nothing', async () => {
        const before = await additionalIds(trackId);
        await linkRemixerArtists(sql, context);
        expect(await additionalIds(trackId)).toEqual(before);
    });

    it('surfaces the remix on the remixer artist page path (decision 3)', async () => {
        // Same containment predicate the artist-page track query uses.
        const rows = await sql<{ id: string }[]>`
            SELECT id FROM media_items
            WHERE media_type = 'track'
              AND custom_metadata->'additional_artist_ids' @> ${sql.json([remixerId])}
        `;
        expect(rows.map((r) => r.id)).toContain(trackId);
    });

    it('remixer ids survive an ensureTrackArtistLinks rescan (interplay)', async () => {
        // Simulate the tag-derived multi-artist path running AFTER the remixer
        // pass: ensureTrackArtistLinks appends starting from existing ids, so
        // the remixer id must not be dropped.
        const { ensureTrackArtistLinks } =
            await import('../media-sources/_helpers/file-scanner/audio-processor.js');
        await sql`
            UPDATE media_items
            SET custom_metadata = COALESCE(custom_metadata, '{}'::jsonb)
                || ${sql.json({ artist: 'Refresh, Second Performer' } as unknown as Record<string, never>)}
            WHERE id = ${trackId}::uuid
        `;
        await ensureTrackArtistLinks(sql, trackId, context, null);
        expect(await additionalIds(trackId)).toContain(remixerId);
    });

    it('does not lock or rewrite a track it has nothing to change on (every track, every scan)', async () => {
        // A scanned track carries empty remixer arrays. The pass used to select
        // every such track (`custom_metadata ? 'title_remixer_artist_ids'`) and
        // take a row lock + no-op UPDATE on each, in one transaction, after
        // every library scan: the whole music library locked for the pass.
        const performer = createTestArtist({ title: 'Plain Performer' });
        await insertTestArtist(sql, performer);
        const album = createTestAlbum(performer.id, { title: 'Plain Album' });
        await insertTestAlbum(sql, album);
        const plain = createTestTrack(album.id, 1, { title: 'Plain Song' });
        await insertTestTrack(sql, plain);
        await sql`
            UPDATE media_items
            SET custom_metadata = COALESCE(custom_metadata, '{}'::jsonb) || ${sql.json({
                title_remixer_artist_ids: [],
                independent_remixer_artist_ids: [],
                remixer_artist_ids: [],
                additional_artist_ids: [],
            } as unknown as Record<string, never>)}
            WHERE id = ${plain.id}::uuid
        `;

        // Another writer holds the track's row lock for the duration.
        const holder = await sql.reserve();
        try {
            await holder`BEGIN`;
            await holder`SELECT 1 FROM media_items WHERE id = ${plain.id}::uuid FOR UPDATE`;
            const outcome = await Promise.race([
                linkRemixerArtists(sql, context).then(() => 'finished' as const),
                new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 3_000)),
            ]);
            expect(outcome).toBe('finished');
        } finally {
            await holder`ROLLBACK`;
            holder.release();
        }
    }, 20_000);

    it('still repairs a plain track whose performer ids are missing from additional_artist_ids', async () => {
        const performer = createTestArtist({ title: 'Repair Performer' });
        await insertTestArtist(sql, performer);
        const album = createTestAlbum(performer.id, { title: 'Repair Album' });
        await insertTestAlbum(sql, album);
        const track = createTestTrack(album.id, 1, { title: 'Repair Song' });
        await insertTestTrack(sql, track);
        await sql`
            UPDATE media_items
            SET custom_metadata = COALESCE(custom_metadata, '{}'::jsonb) || ${sql.json({
                title_remixer_artist_ids: [],
                independent_remixer_artist_ids: [],
                remixer_artist_ids: [],
                additional_artist_ids: [],
                file_artist_ids: [performer.id],
            } as unknown as Record<string, never>)}
            WHERE id = ${track.id}::uuid
        `;
        await linkRemixerArtists(sql, context);
        expect(await additionalIds(track.id)).toEqual([performer.id]);
    });
});
