// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for MediaDeletionService.hardDelete cascade mode.
 *
 * Seeds a music subtree (artist → album → 2 tracks, each track file-backed,
 * one track carrying a user rating and an embedding) against the real
 * `lumastra_tests` database and verifies:
 *   - countDescendants() reports the recursive descendant count
 *   - cascade delete removes the whole subtree with NO orphans
 *     (no parent_id=NULL tracks, no dangling media_files / media_file_items /
 *     media_embeddings) and recomputes has_files on the surviving artist
 *   - the default (non-cascade) path still deletes a leaf
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { MediaDeletionService, CascadeLimitExceededError } from './media-deletion.service.js';
import { MediaLifecycleService } from './media-lifecycle.service.js';
import { upsertJob } from '$lib/server/database/queries/transcode-jobs.queries.js';
import { toUserId } from '$lib/shared/user-id.js';

const TITLE_PREFIX = 'cascade-del-test-';

describe('MediaDeletionService.hardDelete cascade', () => {
    let sql: postgres.Sql;

    let artistId: string;
    let albumId: string;
    let track1Id: string;
    let track2Id: string;
    let track1FileId: string;
    let track2FileId: string;
    let userId: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    async function insertItem(
        mediaType: string,
        parentId: string | null,
        hasFiles: boolean,
    ): Promise<string> {
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, media_type, title, parent_id, has_files)
            VALUES (
                ${id}::uuid,
                ${mediaType},
                ${TITLE_PREFIX + id.slice(0, 8)},
                ${parentId},
                ${hasFiles}
            )
        `;
        return id;
    }

    async function attachFile(mediaItemId: string): Promise<string> {
        const [f] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path)
            VALUES (${TITLE_PREFIX + mediaItemId.slice(0, 8) + '.flac'})
            RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${f.id}::uuid, ${mediaItemId}::uuid)
        `;
        return f.id;
    }

    beforeEach(async () => {
        // Clean up any leftovers from a previous run (FK CASCADEs handle
        // junction rows / ratings / embeddings).
        await sql`DELETE FROM media_files WHERE file_path LIKE ${TITLE_PREFIX + '%'}`;
        await sql`DELETE FROM media_items WHERE title LIKE ${TITLE_PREFIX + '%'}`;
        await sql`DELETE FROM users WHERE username LIKE ${TITLE_PREFIX + '%'}`;

        // Seed: artist → album → 2 tracks, each track file-backed.
        artistId = await insertItem('artist', null, true);
        albumId = await insertItem('album', artistId, true);
        track1Id = await insertItem('track', albumId, true);
        track2Id = await insertItem('track', albumId, true);
        track1FileId = await attachFile(track1Id);
        track2FileId = await attachFile(track2Id);

        // A user rating on track1 (user_ratings FKs user_profiles → users).
        userId = crypto.randomUUID();
        await sql`
            INSERT INTO users (id, username)
            VALUES (${userId}::uuid, ${TITLE_PREFIX + userId.slice(0, 8)})
        `;
        await sql`INSERT INTO user_profiles (user_id) VALUES (${userId}::uuid)`;
        await sql`
            INSERT INTO user_ratings (user_id, media_id, rating)
            VALUES (${userId}::uuid, ${track1Id}::uuid, 8)
        `;

        // An embedding on track1.
        const vectorString = `[${Array(1024).fill(0).join(',')}]`;
        await sql`
            INSERT INTO media_embeddings (media_id, source, embedding)
            VALUES (${track1Id}::uuid, 'library', ${vectorString}::vector)
        `;
    });

    it('non-cascade delete of a parent with children is guarded — count is available', async () => {
        const n = await MediaDeletionService.countDescendants(sql, albumId);
        expect(n).toBe(2);
    });

    it('countDescendants counts the whole subtree recursively (artist → album → tracks)', async () => {
        const n = await MediaDeletionService.countDescendants(sql, artistId);
        expect(n).toBe(3); // album + 2 tracks
    });

    it('cascade deletes the whole subtree, leaves the artist, recomputes has_files, no orphans', async () => {
        const res = await MediaDeletionService.hardDelete(sql, albumId, { cascade: true });
        expect(res.deleted).toBe(true);
        expect(res.deletedCount).toBe(3); // album + 2 tracks

        const remaining = await sql`
            SELECT id FROM media_items WHERE id = ANY(${[albumId, track1Id, track2Id]}::uuid[])
        `;
        expect(remaining).toHaveLength(0);

        const artist = await sql<{ id: string; has_files: boolean }[]>`
            SELECT id, has_files FROM media_items WHERE id = ${artistId}::uuid
        `;
        expect(artist).toHaveLength(1);
        expect(artist[0].has_files).toBe(false);

        // no orphans
        const orphanFiles = await sql`
            SELECT 1 FROM media_file_items
            WHERE media_item_id = ANY(${[albumId, track1Id, track2Id]}::uuid[])
        `;
        expect(orphanFiles).toHaveLength(0);
        const orphanEmb = await sql`
            SELECT 1 FROM media_embeddings WHERE media_id = ANY(${[track1Id, track2Id]}::uuid[])
        `;
        expect(orphanEmb).toHaveLength(0);
        const nulledParents = await sql`
            SELECT 1 FROM media_items WHERE parent_id = ${albumId}::uuid
        `;
        expect(nulledParents).toHaveLength(0); // no parent_id=NULL orphan tracks left behind
        const files = await sql`
            SELECT 1 FROM media_files WHERE id = ANY(${[track1FileId, track2FileId]}::uuid[])
        `;
        expect(files).toHaveLength(0); // orphaned media_files removed

        const ratings = await sql`
            SELECT 1 FROM user_ratings WHERE media_id = ${track1Id}::uuid
        `;
        expect(ratings).toHaveLength(0);
    });

    it('cascade=false (default) still deletes a leaf with no children', async () => {
        const res = await MediaDeletionService.hardDelete(sql, track1Id);
        expect(res.deleted).toBe(true);
        expect(res.deletedCount).toBe(1);

        const remaining = await sql`SELECT id FROM media_items WHERE id = ${track1Id}::uuid`;
        expect(remaining).toHaveLength(0);
        // Siblings and parents untouched
        const rest = await sql`
            SELECT id FROM media_items WHERE id = ANY(${[artistId, albumId, track2Id]}::uuid[])
        `;
        expect(rest).toHaveLength(3);
    });

    // A /j transcode row has no play_sessions row (and no FK since mig
    // 16.282.0), and stores the item id as the client sent it — dashless.
    it("removes the deleted item's transcode rows, whatever spelling the item id was stored in", async () => {
        const sid = crypto.randomUUID().replace(/-/g, '');
        const now = new Date();
        await upsertJob(sql, {
            play_session_id: sid,
            job_id: `job-${sid.slice(0, 8)}`,
            item_id: track1Id.replace(/-/g, ''),
            user_id: toUserId(userId),
            device_id: 'jellyfin-compat',
            config: { itemId: track1Id.replace(/-/g, '') },
            output_dir: '/tmp/' + sid,
            status: 'stopped',
            mode: 'full',
            segment_offset: 0,
            segments_ready: 0,
            master_playlist_ready: false,
            pod_name: 'pod-a',
            ffmpeg_pid: null,
            created_at: now,
            last_accessed_at: now,
            last_progress_at: now,
            transcode_decision: null,
            can_restore: true,
            ensure_play_session: false,
        });

        await MediaDeletionService.hardDelete(sql, track1Id);

        const rows = await sql`SELECT 1 FROM active_transcode_jobs WHERE play_session_id = ${sid}`;
        expect(rows).toHaveLength(0);
    });

    it('returns deleted=false for a nonexistent id', async () => {
        const res = await MediaDeletionService.hardDelete(sql, crypto.randomUUID(), {
            cascade: true,
        });
        expect(res.deleted).toBe(false);
        expect(res.deletedCount).toBe(0);
    });

    // ---- E3 (#5): cascade cap enforced in-tx ------------------------------

    it('cascade cap enforced in-tx: throws CascadeLimitExceededError, nothing deleted', async () => {
        // album has 2 children (track1, track2) → 2 descendants > maxDescendants=1.
        await expect(
            MediaDeletionService.hardDelete(sql, albumId, {
                cascade: true,
                maxDescendants: 1,
            }),
        ).rejects.toThrow(CascadeLimitExceededError);

        // The throw rolls back the transaction — nothing was deleted.
        const rows = await sql`
            SELECT id FROM media_items WHERE id = ANY(${[albumId, track1Id, track2Id]}::uuid[])
        `;
        expect(rows).toHaveLength(3);
        // childCount surfaced for the endpoint mapping.
        await MediaDeletionService.hardDelete(sql, albumId, {
            cascade: true,
            maxDescendants: 1,
        }).catch((err) => {
            expect(err).toBeInstanceOf(CascadeLimitExceededError);
            expect((err as CascadeLimitExceededError).childCount).toBe(2);
        });
    });

    it('cascade cap NOT tripped when descendants == maxDescendants', async () => {
        const res = await MediaDeletionService.hardDelete(sql, albumId, {
            cascade: true,
            maxDescendants: 2,
        });
        expect(res.deleted).toBe(true);
        expect(res.deletedCount).toBe(3);
    });

    // ---- E3 (#6): guardFileBacked skips a row that regained a file ---------

    it('guardFileBacked: hardDelete skips a row that regained a file', async () => {
        // A status='deleted' orphan row that then had a file re-attached
        // (concurrent reclaim mid-retention-loop).
        const id = await insertItem('track', null, false);
        await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${id}::uuid`;
        const fileId = await attachFile(id);

        const res = await MediaDeletionService.hardDelete(sql, id, { guardFileBacked: true });
        expect(res.deleted).toBe(false);
        expect(res.deletedCount).toBe(0);

        // Row + link intact — the concurrent reclaim's work is preserved.
        const row = await sql`SELECT id FROM media_items WHERE id = ${id}::uuid`;
        expect(row).toHaveLength(1);
        const link = await sql`SELECT 1 FROM media_file_items WHERE media_item_id = ${id}::uuid`;
        expect(link).toHaveLength(1);
        const file = await sql`SELECT 1 FROM media_files WHERE id = ${fileId}::uuid`;
        expect(file).toHaveLength(1);
    });

    it('guardFileBacked: still deletes a genuinely file-less row', async () => {
        const id = await insertItem('track', null, false);
        await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${id}::uuid`;

        const res = await MediaDeletionService.hardDelete(sql, id, { guardFileBacked: true });
        expect(res.deleted).toBe(true);
        expect(res.deletedCount).toBe(1);
        const row = await sql`SELECT id FROM media_items WHERE id = ${id}::uuid`;
        expect(row).toHaveLength(0);
    });

    it('hard-deleting an artist drops its id from other tracks, locked ones included', async () => {
        const creditOnly = await insertItem('artist', null, false); // no children
        const other = crypto.randomUUID();
        const credit = async (locked: boolean, ids: string[]): Promise<string> => {
            const id = await insertItem('track', null, false);
            await sql`
                UPDATE media_items
                SET metadata_locked = ${locked},
                    custom_metadata = ${sql.json({ additional_artist_ids: ids })}
                WHERE id = ${id}::uuid
            `;
            return id;
        };
        const open = await credit(false, [other, creditOnly]);
        const locked = await credit(true, [creditOnly, other]);

        const res = await MediaDeletionService.hardDelete(sql, creditOnly);
        expect(res.deleted).toBe(true);

        for (const [id, expected] of [
            [open, [other]],
            [locked, [other]],
        ] as const) {
            const [row] = await sql<{ ids: string[] }[]>`
                SELECT ARRAY(SELECT jsonb_array_elements_text(custom_metadata->'additional_artist_ids')) AS ids
                FROM media_items WHERE id = ${id}::uuid
            `;
            expect(row.ids).toEqual(expected);
        }
    });

    // ---- E3 (#7): afterDeletedBatch keyed on the explicit root -------------

    it('afterDeletedBatch emits keyed on the explicit root, not RETURNING order', async () => {
        const rootId = crypto.randomUUID();
        // Root deliberately NOT first — mimics the unordered RETURNING id set.
        const ids = [crypto.randomUUID(), rootId, crypto.randomUUID()];

        const emitSubjects: unknown[] = [];
        const fakeSql = Object.assign(
            (strings: TemplateStringsArray, ...values: unknown[]) => {
                if (strings.join(' ').includes('emit_pipeline_event')) {
                    emitSubjects.push(values[1]);
                }
                return Promise.resolve([] as unknown[]);
            },
            { json: (v: unknown) => v },
        ) as unknown as postgres.Sql;

        await MediaLifecycleService.afterDeletedBatch(ids, rootId, fakeSql);

        expect(emitSubjects).toHaveLength(1);
        expect(emitSubjects[0]).toBe(rootId);
    });
});
