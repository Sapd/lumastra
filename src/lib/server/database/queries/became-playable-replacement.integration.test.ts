// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for migration 16.216.0 — replacing a file must not
 * re-announce a title.
 *
 * `media.becamePlayable` fires on a has_files transition to true, and the
 * notification kinds built on it say "this is available now"
 * (`request.available` deep-links to the user's request). But a replacement is
 * a DELETE then an INSERT, and `file-delta-ingest` runs every remove in a
 * payload BEFORE any upsert — so swapping one release of a title for another
 * walks has_files true → false → true and the second edge announces a title the
 * user has had for months. That is the reported bug: re-downloading The Witcher
 * produced a fresh "now available" notification.
 *
 * The transition is still the right signal; it just has to remember that the
 * item was playable moments ago. These cases pin the suppression AND the three
 * paths that must keep firing — a gate that silences everything would "fix" the
 * report by breaking the feature.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';

const RUN = Boolean(process.env.TEST_DATABASE_URL || process.env.DATABASE_URL);

describe.runIf(RUN)('16.216.0 — a file replacement does not re-emit media.becamePlayable', () => {
    let sql: postgres.Sql;
    let priorFlag: string | null = null;
    const cleanupIds: string[] = [];
    const cleanupPaths: string[] = [];

    beforeAll(async () => {
        sql = getTestDb();
        try {
            await sql`SELECT files_lost_at FROM media_items LIMIT 0`;
        } catch {
            throw new Error('Migration 16.216.0 missing — run db:test:migrate first');
        }
        const rows = await sql<{ value: string }[]>`
            SELECT value FROM feature_flags WHERE key = 'event_outbox_enabled'
        `;
        priorFlag = rows[0]?.value ?? null;
        await sql`
            INSERT INTO feature_flags (key, value) VALUES ('event_outbox_enabled', 'on')
            ON CONFLICT (key) DO UPDATE SET value = 'on'
        `;
    });

    afterAll(async () => {
        if (priorFlag === null) {
            await sql`DELETE FROM feature_flags WHERE key = 'event_outbox_enabled'`;
        } else {
            await sql`UPDATE feature_flags SET value = ${priorFlag} WHERE key = 'event_outbox_enabled'`;
        }
        await closeTestDb();
    });

    afterEach(async () => {
        if (cleanupPaths.length > 0) {
            await sql`DELETE FROM media_files WHERE file_path = ANY(${cleanupPaths})`;
            cleanupPaths.length = 0;
        }
        if (cleanupIds.length > 0) {
            await sql`DELETE FROM event_outbox WHERE media_item_id = ANY(${cleanupIds}::uuid[])`;
            await sql`DELETE FROM media_items WHERE id = ANY(${cleanupIds}::uuid[])`;
            cleanupIds.length = 0;
        }
    });

    async function playableEvents(mediaId: string): Promise<number> {
        const rows = await sql<{ n: number }[]>`
            SELECT count(*)::int AS n FROM event_outbox
            WHERE media_item_id = ${mediaId}::uuid AND event_name = 'media.becamePlayable'
        `;
        return rows[0].n;
    }

    /** An item with no files yet. Returns its id. */
    async function createItem(hasFiles: boolean): Promise<string> {
        const id = crypto.randomUUID();
        cleanupIds.push(id);
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${id}::uuid, ${'Replacement Repro ' + id.slice(0, 8)}, 'movie', 'active', ${hasFiles})
        `;
        return id;
    }

    async function attachFile(mediaId: string, path: string): Promise<void> {
        cleanupPaths.push(path);
        const [file] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path, file_size_bytes) VALUES (${path}, 100) RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${file.id}, ${mediaId}::uuid, true)
        `;
        await recomputeHasFiles(mediaId);
    }

    async function removeFile(path: string, mediaId: string): Promise<void> {
        await sql`DELETE FROM media_files WHERE file_path = ${path}`;
        await recomputeHasFiles(mediaId);
    }

    /** Mirrors recomputeHasFilesBatch's predicate for a single leaf item. */
    async function recomputeHasFiles(mediaId: string): Promise<void> {
        await sql`
            UPDATE media_items target
               SET has_files = EXISTS (
                   SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = target.id
               )
             WHERE target.id = ${mediaId}::uuid
        `;
    }

    it('emits nothing when a file is swapped for another (remove-then-upsert)', async () => {
        const id = await createItem(false);
        await attachFile(id, `/repro/${id}/old.mkv`);
        expect(await playableEvents(id)).toBe(1); // the original arrival

        await sql`DELETE FROM event_outbox WHERE media_item_id = ${id}::uuid`;

        // The replacement, in the order file-delta-ingest applies it.
        await removeFile(`/repro/${id}/old.mkv`, id);
        await attachFile(id, `/repro/${id}/new.mkv`);

        expect(await playableEvents(id)).toBe(0);
    });

    it('still emits for an item that gains its first file', async () => {
        const id = await createItem(false);
        await attachFile(id, `/repro/${id}/first.mkv`);
        expect(await playableEvents(id)).toBe(1);
    });

    it('still emits for a row INSERTed already playable', async () => {
        const id = await createItem(true);
        expect(await playableEvents(id)).toBe(1);
    });

    /**
     * 16.217.0 widened the window from 6h to 7 days. The 6h size only covered a
     * same-cycle swap; a *arr upgrade drops the old file when the grab is
     * decided and imports the replacement whenever the download finishes, which
     * is routinely days later.
     */
    it('stays quiet for a replacement whose new file lands days later', async () => {
        const id = await createItem(false);
        await attachFile(id, `/repro/${id}/old.mkv`);
        await removeFile(`/repro/${id}/old.mkv`, id);
        await sql`DELETE FROM event_outbox WHERE media_item_id = ${id}::uuid`;

        // Inside the week — the upgrade's download took three days to finish.
        await sql`
            UPDATE media_items SET files_lost_at = now() - interval '3 days'
            WHERE id = ${id}::uuid
        `;
        await attachFile(id, `/repro/${id}/upgraded.mkv`);

        expect(await playableEvents(id)).toBe(0);
    });

    it('still emits when the item was genuinely gone for longer than the grace window', async () => {
        const id = await createItem(false);
        await attachFile(id, `/repro/${id}/old.mkv`);
        await removeFile(`/repro/${id}/old.mkv`, id);
        await sql`DELETE FROM event_outbox WHERE media_item_id = ${id}::uuid`;

        // Past the week: a deliberate re-acquisition, not a replacement.
        await sql`
            UPDATE media_items SET files_lost_at = now() - interval '8 days'
            WHERE id = ${id}::uuid
        `;
        await attachFile(id, `/repro/${id}/reacquired.mkv`);

        expect(await playableEvents(id)).toBe(1);
    });

    it('clears the marker on a suppressed return, so the NEXT real loss starts a fresh window', async () => {
        const id = await createItem(false);
        await attachFile(id, `/repro/${id}/old.mkv`);
        await removeFile(`/repro/${id}/old.mkv`, id);
        await attachFile(id, `/repro/${id}/new.mkv`);

        const rows = await sql<{ files_lost_at: Date | null }[]>`
            SELECT files_lost_at FROM media_items WHERE id = ${id}::uuid
        `;
        expect(rows[0].files_lost_at).toBeNull();
    });
});
