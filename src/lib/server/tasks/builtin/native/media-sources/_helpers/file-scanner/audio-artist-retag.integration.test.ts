// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { mockLogger } from '@sapd/lumastra-plugin-sdk-testing';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getTestDb } from '../../../../../../../../../tests/integration/setup/test-database.js';
import {
    TEST_TABLES,
    truncateTables,
} from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import type { LibraryPathRow } from '../../../../../../database/queries/library-paths.queries.js';
import { processAudioFile } from './audio-processor.js';
import { ID3_UTF8, textFrameBody, writeId3Mp3 } from './id3-mp3-fixture.test-helpers.js';
import type { FileScannerContext } from './shared.js';
import { hashFileHead } from '../../../../../../utils/file-hash.js';
import { repairTrackArtistCreditsFrozen as repairExistingTrackArtistCredits } from '../../../../../../database/migrations/_frozen/16.394.0-track-artist-credit-repair.js';

describe('real audio-file artist retag reconciliation', () => {
    let sql: postgres.Sql;
    let root: string;
    let libraryPath: LibraryPathRow;
    let context: FileScannerContext;

    beforeAll(async () => {
        sql = getTestDb();
        context = { sql, logger: mockLogger() } as unknown as FileScannerContext;
        // Failure injection for one test, armed per track by a row, not by DDL.
        // Installed once, with a lock timeout so it cannot queue behind another
        // suite's transaction on the shared slot database.
        await sql.begin(async (tx) => {
            await tx`SET LOCAL lock_timeout = '10s'`;
            await tx`CREATE TABLE IF NOT EXISTS test_reconcile_fail (track_id uuid)`;
            await tx`DELETE FROM test_reconcile_fail`;
            await tx`INSERT INTO test_reconcile_fail VALUES (NULL)`;
            await tx`
                CREATE OR REPLACE FUNCTION test_reconcile_fail() RETURNS trigger LANGUAGE plpgsql AS $$
                BEGIN
                    -- Only a write that CHANGES the credit fails: the scanner's own
                    -- tag update, which carries the credit along, must succeed.
                    IF NEW.custom_metadata ? 'track_artist_credits'
                       AND (NEW.custom_metadata->'track_artist_credits')
                           IS DISTINCT FROM (OLD.custom_metadata->'track_artist_credits')
                       AND EXISTS (SELECT 1 FROM test_reconcile_fail WHERE track_id = NEW.id) THEN
                        RAISE EXCEPTION 'reconcile down';
                    END IF;
                    RETURN NEW;
                END $$`;
            await tx`DROP TRIGGER IF EXISTS test_reconcile_fail ON media_items`;
            await tx`CREATE TRIGGER test_reconcile_fail BEFORE UPDATE ON media_items
                FOR EACH ROW WHEN (NEW.media_type = 'track') EXECUTE FUNCTION test_reconcile_fail()`;
        });
        return async () => {
            // Best effort: never wait on a lock at teardown.
            await sql
                .begin(async (tx) => {
                    await tx`SET LOCAL lock_timeout = '5s'`;
                    await tx`DROP TRIGGER IF EXISTS test_reconcile_fail ON media_items`;
                    await tx`DROP FUNCTION IF EXISTS test_reconcile_fail()`;
                    await tx`DROP TABLE IF EXISTS test_reconcile_fail`;
                })
                .catch(() => undefined);
        };
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        root = await mkdtemp(join(tmpdir(), 'lumastra-credit-retag-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${`credit-retag-${randomUUID()}`}) RETURNING id
        `;
        const [lp] = await sql<LibraryPathRow[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'music', ${group.id}, true) RETURNING *
        `;
        libraryPath = lp;
        return async () => {
            await rm(root, { recursive: true, force: true });
            await truncateTables(sql, TEST_TABLES.media);
            await sql`DELETE FROM library_paths WHERE id = ${lp.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group.id}`;
        };
    });

    async function writeArtist(filePath: string, name: string) {
        await writeId3Mp3(filePath, 4, [
            { id: 'TIT2', body: textFrameBody(ID3_UTF8, ['Evening Song']) },
            { id: 'TALB', body: textFrameBody(ID3_UTF8, ['Evening Album']) },
            { id: 'TPE1', body: textFrameBody(ID3_UTF8, [name]) },
            { id: 'TPE2', body: textFrameBody(ID3_UTF8, ['Album Curator']) },
        ]);
    }

    it('reconciles a deleted legacy track when its file returns after the repair migration', async () => {
        const filePath = join(root, 'restored-song.mp3');
        await writeArtist(filePath, 'cascada');
        const artistId = randomUUID();
        const trackId = randomUUID();
        const contentHash = await hashFileHead(filePath);
        await sql`
            INSERT INTO media_items (id, title, media_type)
            VALUES (${artistId}::uuid, 'Cascada', 'artist')
        `;
        await sql`
            INSERT INTO media_items
                (id, title, media_type, status, is_dismissed, dismissed_at, dismissed_content_hash, custom_metadata)
            VALUES (${trackId}::uuid, 'Restored Song', 'track', 'deleted', true, NOW(), ${contentHash},
                ${sql.json({ artist: 'cascada', operator_note: 'Keep the original track identity' })})
        `;
        expect((await repairExistingTrackArtistCredits(sql)).scanned).toBe(0);

        expect(await processAudioFile(sql, filePath, libraryPath, context)).toBe('updated');
        const [track] = await sql<
            {
                id: string;
                status: string;
                is_dismissed: boolean;
                custom_metadata: Record<string, unknown>;
            }[]
        >`SELECT id, status, is_dismissed, custom_metadata FROM media_items WHERE id = ${trackId}::uuid`;
        expect(track).toMatchObject({
            id: trackId,
            status: 'active',
            is_dismissed: false,
            custom_metadata: {
                artist: 'cascada',
                operator_note: 'Keep the original track identity',
                raw_artist_tags: { source: 'stored_metadata', artist: 'cascada' },
                track_artist_credits: [{ id: artistId, credited_name: 'cascada' }],
                file_artist_ids: [artistId],
            },
        });
        const [link] = await sql<{ media_item_id: string }[]>`
            SELECT link.media_item_id FROM media_files file
            JOIN media_file_items link ON link.file_id = file.id WHERE file.file_path = ${filePath}
        `;
        expect(link.media_item_id).toBe(trackId);
    });

    it('rescans changed ARTIST bytes without replacing non-file metadata or remixer ownership', async () => {
        const filePath = join(root, 'evening-song.mp3');
        await writeArtist(filePath, 'Old Lantern');
        expect(await processAudioFile(sql, filePath, libraryPath, context)).toBe('added');
        const [before] = await sql<
            { id: string; parent_id: string; custom_metadata: Record<string, unknown> }[]
        >`
            SELECT track.id, track.parent_id, track.custom_metadata
            FROM media_files file
            JOIN media_file_items link ON link.file_id = file.id
            JOIN media_items track ON track.id = link.media_item_id
            WHERE file.file_path = ${filePath}
        `;
        const oldIds = before.custom_metadata.file_artist_ids as string[];
        expect(oldIds).toHaveLength(1);
        const remixerId = randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (${remixerId}::uuid, 'Independent Remixer', 'artist', 'active')
        `;
        const extraMetadata = {
            operator_note: 'Preserve the hand-entered annotation',
            local_artwork: { poster: 'operator-cover.jpg' },
            lyrics: { source: 'manual', text: 'Fixture text' },
            remixer_artist_ids: [remixerId],
            additional_artist_ids: [
                ...(before.custom_metadata.additional_artist_ids as string[]),
                remixerId,
            ],
        };
        await sql`
            UPDATE media_items
            SET custom_metadata = custom_metadata || ${sql.json(extraMetadata)},
                custom_poster_url = '/fixtures/operator-cover.jpg'
            WHERE id = ${before.id}::uuid
        `;

        await writeArtist(filePath, 'New and Different Lantern');
        const later = new Date(Date.now() + 60_000);
        await utimes(filePath, later, later);
        expect(await processAudioFile(sql, filePath, libraryPath, context)).toBe('updated');
        const [after] = await sql<
            {
                id: string;
                parent_id: string;
                custom_metadata: Record<string, unknown>;
                custom_poster_url: string;
            }[]
        >`
            SELECT id, parent_id, custom_metadata, custom_poster_url FROM media_items WHERE id = ${before.id}::uuid
        `;
        expect(after.id).toBe(before.id);
        expect(after.parent_id).toBe(before.parent_id);
        expect(after.custom_poster_url).toBe('/fixtures/operator-cover.jpg');
        expect(after.custom_metadata).toMatchObject({
            artist: 'New and Different Lantern',
            raw_artist_tags: { source: 'file', artist: 'New and Different Lantern' },
            operator_note: extraMetadata.operator_note,
            local_artwork: extraMetadata.local_artwork,
            lyrics: extraMetadata.lyrics,
            remixer_artist_ids: [remixerId],
        });
        const credits = after.custom_metadata.track_artist_credits as Array<{
            id: string;
            credited_name: string;
        }>;
        expect(credits).toHaveLength(1);
        expect(credits[0].credited_name).toBe('New and Different Lantern');
        expect(credits[0].id).not.toBe(oldIds[0]);
        expect(after.custom_metadata.additional_artist_ids).not.toContain(oldIds[0]);
        expect(after.custom_metadata.additional_artist_ids).toContain(remixerId);
        expect(after.custom_metadata.file_artist_ids).toEqual([credits[0].id]);
        const [performer] = await sql<
            { title: string }[]
        >`SELECT title FROM media_items WHERE id = ${credits[0].id}::uuid`;
        expect(performer.title).toBe('New and Different Lantern');
    }, 60_000);

    it('drops the stale canonical credit on a retag when the reconcile fails, so reads use the new tags', async () => {
        const filePath = join(root, 'failing-reconcile.mp3');
        await writeArtist(filePath, 'First Spelling');
        expect(await processAudioFile(sql, filePath, libraryPath, context)).toBe('added');
        const [{ id }] = await sql<{ id: string }[]>`
            SELECT link.media_item_id AS id FROM media_files file
            JOIN media_file_items link ON link.file_id = file.id
            WHERE file.file_path = ${filePath}
        `;
        // Every canonical-credit write on this track now fails; the rescan's
        // own tag write does not carry one. Toggled by data, not DDL: a DROP
        // TRIGGER here would queue behind the scan's background transaction.
        await sql`UPDATE test_reconcile_fail SET track_id = ${id}::uuid`;
        try {
            await writeArtist(filePath, 'Second Spelling');
            const later = new Date(Date.now() + 60_000);
            await utimes(filePath, later, later);
            expect(await processAudioFile(sql, filePath, libraryPath, context)).toBe('updated');
        } finally {
            await sql`UPDATE test_reconcile_fail SET track_id = NULL`;
        }
        const [after] = await sql<{ custom_metadata: Record<string, unknown> }[]>`
            SELECT custom_metadata FROM media_items WHERE id = ${id}::uuid
        `;
        expect(after.custom_metadata.artist).toBe('Second Spelling');
        expect(after.custom_metadata.track_artist_credits).toBeUndefined();
        expect(after.custom_metadata.artist_credit_source).toBeUndefined();

        // The next scan retries and restores the canonical credit.
        expect(await processAudioFile(sql, filePath, libraryPath, context)).not.toBe('error');
        const [healed] = await sql<{ custom_metadata: Record<string, unknown> }[]>`
            SELECT custom_metadata FROM media_items WHERE id = ${id}::uuid
        `;
        expect(healed.custom_metadata.track_artist_credits).toMatchObject([
            { credited_name: 'Second Spelling' },
        ]);
    }, 60_000);

    async function writeArtists(filePath: string, names: string[]) {
        await writeId3Mp3(filePath, 4, [
            { id: 'TIT2', body: textFrameBody(ID3_UTF8, ['Evening Song']) },
            { id: 'TALB', body: textFrameBody(ID3_UTF8, ['Evening Album']) },
            { id: 'TPE1', body: textFrameBody(ID3_UTF8, names) },
            { id: 'TPE2', body: textFrameBody(ID3_UTF8, ['Album Curator']) },
        ]);
    }
    async function trackFor(filePath: string): Promise<string> {
        const [{ id }] = await sql<{ id: string }[]>`
            SELECT link.media_item_id AS id FROM media_files file
            JOIN media_file_items link ON link.file_id = file.id
            WHERE file.file_path = ${filePath}
        `;
        return id;
    }
    async function metaOf(id: string): Promise<Record<string, unknown>> {
        const [row] = await sql<{ custom_metadata: Record<string, unknown> }[]>`
            SELECT custom_metadata FROM media_items WHERE id = ${id}::uuid
        `;
        return row.custom_metadata;
    }
    async function touch(filePath: string): Promise<void> {
        const later = new Date(Date.now() + 120_000);
        await utimes(filePath, later, later);
    }

    it('keeps the canonical credit on a changed-bytes rescan whose artist tags did not change', async () => {
        const filePath = join(root, 'same-tags.mp3');
        await writeArtist(filePath, 'Steady Spelling');
        expect(await processAudioFile(sql, filePath, libraryPath, context)).toBe('added');
        const id = await trackFor(filePath);
        const before = await metaOf(id);
        expect(before.track_artist_credits).toBeDefined();
        // A failing reconcile proves the rescan itself kept the credit.
        await sql`UPDATE test_reconcile_fail SET track_id = ${id}::uuid`;
        try {
            // New bytes (album tag), same artist evidence.
            await writeId3Mp3(filePath, 4, [
                { id: 'TIT2', body: textFrameBody(ID3_UTF8, ['Evening Song']) },
                { id: 'TALB', body: textFrameBody(ID3_UTF8, ['Evening Album (Remaster)']) },
                { id: 'TPE1', body: textFrameBody(ID3_UTF8, ['Steady Spelling']) },
                { id: 'TPE2', body: textFrameBody(ID3_UTF8, ['Album Curator']) },
            ]);
            await touch(filePath);
            expect(await processAudioFile(sql, filePath, libraryPath, context)).toBe('updated');
        } finally {
            await sql`UPDATE test_reconcile_fail SET track_id = NULL`;
        }
        const after = await metaOf(id);
        expect(after.track_artist_credits).toEqual(before.track_artist_credits);
        expect(after.artist_credit_source).toEqual(before.artist_credit_source);
    }, 60_000);

    it('keeps the established identity of an unchanged name when the retag adds another', async () => {
        const filePath = join(root, 'parked-identity.mp3');
        await writeArtists(filePath, ['Keeper Act']);
        expect(await processAudioFile(sql, filePath, libraryPath, context)).toBe('added');
        const id = await trackFor(filePath);
        const [{ id: keeperId }] = (await metaOf(id)).track_artist_credits as { id: string }[];
        // An operator renames the artist; its old name no longer resolves by title.
        await sql`UPDATE media_items SET title = 'Keeper Act (Renamed)' WHERE id = ${keeperId}::uuid`;
        await writeArtists(filePath, ['Keeper Act', 'Newcomer Act']);
        await touch(filePath);
        expect(await processAudioFile(sql, filePath, libraryPath, context)).toBe('updated');
        const after = await metaOf(id);
        const credits = after.track_artist_credits as { id: string; credited_name: string }[];
        expect(credits.map((c) => c.credited_name)).toEqual(['Keeper Act', 'Newcomer Act']);
        expect(credits[0].id).toBe(keeperId);
        expect(after.artist_credit_previous).toBeUndefined();
    }, 60_000);
});
