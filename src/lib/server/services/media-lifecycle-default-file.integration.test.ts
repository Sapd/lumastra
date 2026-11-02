// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for MediaLifecycleService.afterDefaultFileChanged (bug #8).
 *
 * Verifies that when a higher-quality file replaces the default, the old
 * default file's per-file artifacts are deleted and content-bound stages
 * are reset to pending.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { MediaLifecycleService } from './media-lifecycle.service.js';
import { TaskRegistry, setTestRegistry } from '$lib/server/tasks/registry.js';
import { findRowsByItem } from '$lib/server/database/queries/stage-state.queries.js';
import type { AnyTaskDefinition, CoversStagesDeclaration } from '@sapd/lumastra-plugin-sdk';

// ---------------------------------------------------------------------------
// Orchestrator mock — must be declared before any import that loads it.
// ---------------------------------------------------------------------------
const startRunMock = vi.fn().mockResolvedValue({ deduped: false });
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: {
        startRun: (...args: unknown[]) => startRunMock(...args),
    },
}));

// ---------------------------------------------------------------------------
// Trickplay-storage mock — we don't exercise actual disk deletion here.
// ---------------------------------------------------------------------------
const deleteTrickplayMock = vi.fn().mockResolvedValue(undefined);
vi.mock('./trickplay-storage.service.js', () => ({
    deleteTrickplay: (...args: unknown[]) => deleteTrickplayMock(...args),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mkTask(
    id: string,
    coversStages: ReadonlyArray<CoversStagesDeclaration>,
): AnyTaskDefinition {
    return defineTask({
        id,
        name: id,
        version: '1.0.0',
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        processingVersion: 1,
        inputSchema: z.object({}),
        identityFor: () => id,
        manualOnly: true,
        coversStages,
        execute: async () => ({ success: true as const }),
    });
}

async function insertMediaItem(sql: postgres.Sql): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, media_type, title)
        VALUES (${id}::uuid, 'movie', ${'dfc-test-' + id.slice(0, 6)})
    `;
    return id;
}

async function insertMediaFile(sql: postgres.Sql, filePath: string): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_files (id, file_path)
        VALUES (${id}::uuid, ${filePath})
    `;
    return id;
}

async function linkFileToItem(
    sql: postgres.Sql,
    fileId: string,
    mediaItemId: string,
    isDefault: boolean,
): Promise<void> {
    await sql`
        INSERT INTO media_file_items (file_id, media_item_id, is_default)
        VALUES (${fileId}::uuid, ${mediaItemId}::uuid, ${isDefault})
    `;
}

/**
 * Simulate the post-promotion state: demote oldFileId, promote newFileId.
 * Both UPDATEs run in a single transaction so the DEFERRABLE INITIALLY DEFERRED
 * constraint trigger fires only at commit, after both rows are consistent.
 */
async function flipDefault(
    sql: postgres.Sql,
    mediaItemId: string,
    oldFileId: string,
    newFileId: string,
): Promise<void> {
    await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`
            UPDATE media_file_items
            SET is_default = FALSE
            WHERE media_item_id = ${mediaItemId}::uuid AND file_id = ${oldFileId}::uuid
        `;
        await tx`
            UPDATE media_file_items
            SET is_default = TRUE
            WHERE media_item_id = ${mediaItemId}::uuid AND file_id = ${newFileId}::uuid
        `;
    });
}

async function insertMediaStream(
    sql: postgres.Sql,
    fileId: string,
    height: number,
): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_streams (id, file_id, stream_index, stream_type, codec, height)
        VALUES (${id}::uuid, ${fileId}::uuid, 0, 'video', 'h264', ${height})
    `;
    return id;
}

async function insertTrickplayParams(
    sql: postgres.Sql,
    mediaItemId: string,
    fileId: string,
): Promise<void> {
    await sql`
        INSERT INTO trickplay_params
            (media_item_id, file_id, width, height, interval_ms,
             tile_width, tile_height, thumbnail_count, bandwidth, source)
        VALUES
            (${mediaItemId}::uuid, ${fileId}::uuid, 320, 18, 10000,
             5, 5, 25, 50000, 'local')
    `;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MediaLifecycleService.afterDefaultFileChanged', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        startRunMock.mockClear();
        deleteTrickplayMock.mockClear();
        await sql`TRUNCATE media_item_stage_state CASCADE`;
        await sql`
            DELETE FROM media_file_items
            WHERE media_item_id IN (
                SELECT id FROM media_items WHERE title LIKE 'dfc-test-%'
            )
        `;
        await sql`
            DELETE FROM media_streams ms
            WHERE ms.file_id IN (
                SELECT mf.id FROM media_files mf
                WHERE mf.file_path LIKE '/test/dfc/%'
            )
        `;
        await sql`
            DELETE FROM trickplay_params
            WHERE media_item_id IN (
                SELECT id FROM media_items WHERE title LIKE 'dfc-test-%'
            )
        `;
        await sql`DELETE FROM media_files WHERE file_path LIKE '/test/dfc/%'`;
        await sql`DELETE FROM media_items WHERE title LIKE 'dfc-test-%'`;
        setTestRegistry(new TaskRegistry());
    });

    it('deletes media_streams for the old default file', async () => {
        const mediaItemId = await insertMediaItem(sql);
        const oldFileId = await insertMediaFile(sql, '/test/dfc/movie-1080p.mkv');
        const newFileId = await insertMediaFile(sql, '/test/dfc/movie-4k.mkv');

        // oldFile was the original default; newFile was promoted to default
        await linkFileToItem(sql, oldFileId, mediaItemId, true);
        await linkFileToItem(sql, newFileId, mediaItemId, false);
        await flipDefault(sql, mediaItemId, oldFileId, newFileId);

        const streamId = await insertMediaStream(sql, oldFileId, 1080);

        await MediaLifecycleService.afterDefaultFileChanged(sql, mediaItemId, oldFileId, newFileId);

        const remaining = await sql<{ id: string }[]>`
            SELECT id FROM media_streams WHERE id = ${streamId}::uuid
        `;
        expect(remaining).toHaveLength(0);
    });

    it('deletes trickplay_params for the media item linked to the old file', async () => {
        const mediaItemId = await insertMediaItem(sql);
        const oldFileId = await insertMediaFile(sql, '/test/dfc/movie-1080p.mkv');
        const newFileId = await insertMediaFile(sql, '/test/dfc/movie-4k.mkv');

        await linkFileToItem(sql, oldFileId, mediaItemId, true);
        await linkFileToItem(sql, newFileId, mediaItemId, false);
        await flipDefault(sql, mediaItemId, oldFileId, newFileId);

        await insertTrickplayParams(sql, mediaItemId, oldFileId);

        await MediaLifecycleService.afterDefaultFileChanged(sql, mediaItemId, oldFileId, newFileId);

        const remaining = await sql<{ media_item_id: string }[]>`
            SELECT media_item_id FROM trickplay_params
            WHERE media_item_id = ${mediaItemId}::uuid
        `;
        expect(remaining).toHaveLength(0);
    });

    it('calls deleteTrickplay for on-disk sprites of the old file', async () => {
        const mediaItemId = await insertMediaItem(sql);
        const oldFileId = await insertMediaFile(sql, '/test/dfc/movie-1080p.mkv');
        const newFileId = await insertMediaFile(sql, '/test/dfc/movie-4k.mkv');

        await linkFileToItem(sql, oldFileId, mediaItemId, true);
        await linkFileToItem(sql, newFileId, mediaItemId, false);
        await flipDefault(sql, mediaItemId, oldFileId, newFileId);

        await MediaLifecycleService.afterDefaultFileChanged(sql, mediaItemId, oldFileId, newFileId);

        expect(deleteTrickplayMock).toHaveBeenCalledWith(oldFileId, '/test/dfc/movie-1080p.mkv');
    });

    it('flips file-content-invalidated stage rows to pending', async () => {
        const reg = new TaskRegistry();
        reg.registerTask(
            mkTask('trickplay-params-sync', [
                {
                    id: 'trickplay-params-sync',
                    appliesTo: ['movie'] as const,
                    invalidatedBy: [
                        'file.attached',
                        'file.detached',
                        'file.contentChanged',
                        'file.defaultChanged',
                    ] as const,
                },
            ]),
        );
        setTestRegistry(reg);

        const mediaItemId = await insertMediaItem(sql);
        const oldFileId = await insertMediaFile(sql, '/test/dfc/movie-1080p.mkv');
        const newFileId = await insertMediaFile(sql, '/test/dfc/movie-4k.mkv');

        await linkFileToItem(sql, oldFileId, mediaItemId, true);
        await linkFileToItem(sql, newFileId, mediaItemId, false);
        await flipDefault(sql, mediaItemId, oldFileId, newFileId);

        await MediaLifecycleService.afterCreated(mediaItemId, 'dfc-test');
        await sql`
            UPDATE media_item_stage_state
            SET status = 'completed'
            WHERE media_item_id = ${mediaItemId}::uuid
              AND stage_id = 'trickplay-params-sync'
        `;

        await MediaLifecycleService.afterDefaultFileChanged(sql, mediaItemId, oldFileId, newFileId);

        const rows = await findRowsByItem(sql, mediaItemId);
        const row = rows.find((r) => r.stage_id === 'trickplay-params-sync');
        expect(row?.status).toBe('pending');
    });

    it('does not affect media_streams for the new default file', async () => {
        const mediaItemId = await insertMediaItem(sql);
        const oldFileId = await insertMediaFile(sql, '/test/dfc/movie-1080p.mkv');
        const newFileId = await insertMediaFile(sql, '/test/dfc/movie-4k.mkv');

        await linkFileToItem(sql, oldFileId, mediaItemId, true);
        await linkFileToItem(sql, newFileId, mediaItemId, false);
        await flipDefault(sql, mediaItemId, oldFileId, newFileId);

        // Stream on the NEW file only — must survive cleanup of the old file
        const newStreamId = await insertMediaStream(sql, newFileId, 2160);

        await MediaLifecycleService.afterDefaultFileChanged(sql, mediaItemId, oldFileId, newFileId);

        const remaining = await sql<{ id: string }[]>`
            SELECT id FROM media_streams WHERE id = ${newStreamId}::uuid
        `;
        expect(remaining).toHaveLength(1);
    });

    it('is safe when old file has no artifacts (no-op)', async () => {
        const mediaItemId = await insertMediaItem(sql);
        const oldFileId = await insertMediaFile(sql, '/test/dfc/movie-1080p.mkv');
        const newFileId = await insertMediaFile(sql, '/test/dfc/movie-4k.mkv');

        await linkFileToItem(sql, oldFileId, mediaItemId, true);
        await linkFileToItem(sql, newFileId, mediaItemId, false);
        await flipDefault(sql, mediaItemId, oldFileId, newFileId);

        // No streams or trickplay rows inserted — should complete without error
        await expect(
            MediaLifecycleService.afterDefaultFileChanged(sql, mediaItemId, oldFileId, newFileId),
        ).resolves.not.toThrow();
    });
});
