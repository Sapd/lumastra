// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for `findAdoptableOrphanTrack`'s disc-number matching
 * against a real database.
 *
 * The disc term reads `custom_metadata->>'disc_number'`, a freeform jsonb key
 * that `PUT /api/admin/media/bulk-metadata` merges arbitrary admin-supplied
 * values into verbatim. A bare `::int` there raised
 * `invalid input syntax for type integer` and failed the whole statement — and
 * because this runs inside the scanner's new-track path, that fails the file's
 * scan outright rather than degrading one comparison.
 *
 * These cases pin BOTH halves: the crash is gone, AND the matching semantics
 * for the values the scanner actually writes are unchanged.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import { findAdoptableOrphanTrack } from './audio-processor.js';

const TITLE = 'Adoptable Track';

describe('findAdoptableOrphanTrack — disc_number matching (integration)', () => {
    let sql: postgres.Sql;
    let albumId: string;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['media_file_items', 'media_files', 'media_items']);

        const artistId = crypto.randomUUID();
        albumId = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, created_at, updated_at)
            VALUES (${artistId}::uuid, 'Orphan Test Artist', 'artist', NOW(), NOW())
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, created_at, updated_at)
            VALUES (${albumId}::uuid, 'Orphan Test Album', 'album', ${artistId}::uuid, NOW(), NOW())
        `;
    });

    /**
     * Inserts a file-less (therefore adoptable) track with the given metadata.
     *
     * Passed through `sql.json`, NOT a pre-stringified literal cast with
     * `::jsonb` — postgres.js double-encodes an already-stringified value, which
     * stores a jsonb STRING SCALAR whose `->>'disc_number'` is silently NULL.
     * That makes every case below pass or fail for the wrong reason.
     */
    async function insertOrphanTrack(customMetadata: Record<string, unknown>, sortOrder = 1) {
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (
                id, title, media_type, parent_id, sort_order, custom_metadata, created_at, updated_at
            )
            VALUES (
                ${id}::uuid, ${TITLE}, 'track', ${albumId}::uuid, ${sortOrder},
                ${sql.json(customMetadata as never)}, NOW(), NOW()
            )
        `;
        return id;
    }

    /** Guards the fixture itself: a wrongly-encoded seed would make these tests lie. */
    async function readStoredDiscNumber(trackId: string): Promise<string | null> {
        const [row] = await sql<{ disc: string | null }[]>`
            SELECT custom_metadata ->> 'disc_number' AS disc
            FROM media_items WHERE id = ${trackId}::uuid
        `;
        return row.disc;
    }

    it('does not throw when an orphan carries a non-numeric disc_number', async () => {
        const poisoned = await insertOrphanTrack({ disc_number: '1/2' });

        // The seed really is the shape under test — a jsonb string, not a
        // double-encoded scalar that would read as NULL and prove nothing.
        expect(await readStoredDiscNumber(poisoned)).toBe('1/2');

        // The assertion that matters is that this RESOLVES at all — the bare
        // `::int` raised PostgresError here, aborting the file's scan.
        const result = await findAdoptableOrphanTrack(sql, {
            albumId,
            title: TITLE,
            trackNumber: 1,
            discNumber: 1,
        });

        // A garbage tag is not disc 1, so it is not adopted. It is skipped, not fatal.
        expect(result).toBeNull();
    });

    it('does not let a poisoned orphan hide a genuinely matching one', async () => {
        // Ordering matters: the poisoned row is scanned alongside the real match.
        // Under the bare cast this whole statement raised rather than returning
        // the row that was sitting right there.
        await insertOrphanTrack({ disc_number: '1/2' });
        const real = await insertOrphanTrack({ disc_number: 1 });

        const result = await findAdoptableOrphanTrack(sql, {
            albumId,
            title: TITLE,
            trackNumber: 1,
            discNumber: 1,
        });

        expect(result).toBe(real);
    });

    it('still adopts an orphan whose disc_number is a JSON number', async () => {
        const orphan = await insertOrphanTrack({ disc_number: 2 });
        expect(await readStoredDiscNumber(orphan)).toBe('2');

        const result = await findAdoptableOrphanTrack(sql, {
            albumId,
            title: TITLE,
            trackNumber: 1,
            discNumber: 2,
        });

        expect(result).toBe(orphan);
    });

    it('still adopts an orphan with no disc_number when the incoming file has none', async () => {
        const orphan = await insertOrphanTrack({});

        const result = await findAdoptableOrphanTrack(sql, {
            albumId,
            title: TITLE,
            trackNumber: 1,
            discNumber: null,
        });

        expect(result).toBe(orphan);
    });

    it('does not adopt across a disc-number mismatch', async () => {
        await insertOrphanTrack({ disc_number: 2 });

        const result = await findAdoptableOrphanTrack(sql, {
            albumId,
            title: TITLE,
            trackNumber: 1,
            discNumber: 1,
        });

        expect(result).toBeNull();
    });

    it('does not treat a garbage tag as "absent" for an untagged incoming file', async () => {
        // The reason this site uses a text comparison rather than the
        // `jsonb_typeof(...) = 'number'` guard the ORDER BY sites use: that guard
        // maps garbage to NULL, and under `IS NOT DISTINCT FROM` NULL is a
        // MATCHABLE value — an untagged incoming file would silently adopt this
        // "1/2"-tagged orphan. NULL-as-unknown is right for sorting, wrong for
        // equality.
        await insertOrphanTrack({ disc_number: '1/2' });

        const result = await findAdoptableOrphanTrack(sql, {
            albumId,
            title: TITLE,
            trackNumber: 1,
            discNumber: null,
        });

        expect(result).toBeNull();
    });

    it('does not adopt a track that already has a file', async () => {
        const trackId = await insertOrphanTrack({ disc_number: 1 });
        const fileId = crypto.randomUUID();
        await sql`
            INSERT INTO media_files (id, file_path, created_at, updated_at)
            VALUES (${fileId}::uuid, ${`/test/music/${trackId}.mp3`}, NOW(), NOW())
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order)
            VALUES (${fileId}::uuid, ${trackId}::uuid, true, 0)
        `;

        const result = await findAdoptableOrphanTrack(sql, {
            albumId,
            title: TITLE,
            trackNumber: 1,
            discNumber: 1,
        });

        expect(result).toBeNull();
    });
});
