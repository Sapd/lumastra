// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for findPlaybackDurationMs (media-items.queries.ts).
 *
 * Pins the probe-first precedence (a linked file's duration beats the metadata
 * runtime), the episode share of a file used by several active episodes, and
 * the null result when neither source exists.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';
import type { MediaType } from '../../../../../tests/integration/fixtures/index.js';
import { findPlaybackDurationMs, findPlaybackDurationsMs } from './media-items.queries.js';

const createdItems: string[] = [];
const createdFiles: string[] = [];

async function insertItem(mediaType: MediaType): Promise<string> {
    const id = randomUUID();
    createdItems.push(id);
    await insertTestMediaItem(getTestDb(), createTestMediaItem({ id, media_type: mediaType }));
    return id;
}

async function insertFile(durationSeconds: number, itemIds: string[]): Promise<string> {
    const sql = getTestDb();
    const fileId = randomUUID();
    createdFiles.push(fileId);
    await sql`
        INSERT INTO media_files (id, file_path, duration_seconds, created_at, updated_at)
        VALUES (${fileId}::uuid, ${`/test/duration/${fileId}.mkv`}, ${durationSeconds}, NOW(), NOW())
    `;
    for (const itemId of itemIds) {
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${fileId}::uuid, ${itemId}::uuid)
        `;
    }
    return fileId;
}

afterEach(async () => {
    const sql = getTestDb();
    for (const fileId of createdFiles) {
        await sql`DELETE FROM media_file_items WHERE file_id = ${fileId}::uuid`;
        await sql`DELETE FROM media_files WHERE id = ${fileId}::uuid`;
    }
    for (const itemId of createdItems) {
        await sql`DELETE FROM media_items WHERE id = ${itemId}::uuid`;
    }
    createdFiles.length = 0;
    createdItems.length = 0;
});

describe('findPlaybackDurationMs', () => {
    it('returns the probed duration of the linked file in whole milliseconds, ahead of the metadata runtime', async () => {
        const movie = await insertItem('movie');
        // A different metadata runtime must lose to the probe, or the precedence is untested.
        await getTestDb()`UPDATE media_items SET runtime_seconds = 600 WHERE id = ${movie}::uuid`;
        await insertFile(634.567, [movie]);
        expect(await findPlaybackDurationMs(getTestDb(), movie)).toBe(634567);
    });

    it('falls back to the metadata runtime when no file is linked', async () => {
        const movie = await insertItem('movie');
        await getTestDb()`UPDATE media_items SET runtime_seconds = 600 WHERE id = ${movie}::uuid`;
        expect(await findPlaybackDurationMs(getTestDb(), movie)).toBe(600000);
    });

    it('gives an episode its share of a file that two active episodes share', async () => {
        const first = await insertItem('episode');
        const second = await insertItem('episode');
        await insertFile(3600, [first, second]);
        expect(await findPlaybackDurationMs(getTestDb(), first)).toBe(1800000);
    });

    it('returns null when neither a linked file nor a runtime is known', async () => {
        const movie = await insertItem('movie');
        expect(await findPlaybackDurationMs(getTestDb(), movie)).toBeNull();
    });

    it('prefers the episode segment window on its link over the even file share', async () => {
        const first = await insertItem('episode');
        const second = await insertItem('episode');
        const fileId = await insertFile(145.092, [first, second]);
        // Deliberately unequal windows: the even share (72546 each) must lose.
        await getTestDb()`
            UPDATE media_file_items SET start_offset_ms = 0, end_offset_ms = 70000, offset_source = 'chapter'
            WHERE file_id = ${fileId}::uuid AND media_item_id = ${first}::uuid
        `;
        await getTestDb()`
            UPDATE media_file_items SET start_offset_ms = 70000, end_offset_ms = 145092, offset_source = 'chapter'
            WHERE file_id = ${fileId}::uuid AND media_item_id = ${second}::uuid
        `;
        expect(await findPlaybackDurationMs(getTestDb(), first)).toBe(70000);
        expect(await findPlaybackDurationMs(getTestDb(), second)).toBe(75092);
    });
});

describe('findPlaybackDurationsMs', () => {
    it('agrees with findPlaybackDurationMs for every id, and leaves out ids with no value', async () => {
        const first = await insertItem('episode');
        const second = await insertItem('episode');
        const single = await insertItem('episode');
        const noFile = await insertItem('episode');
        const sql = getTestDb();
        await sql`UPDATE media_items SET runtime_seconds = 73 WHERE id IN (${first}::uuid, ${second}::uuid, ${noFile}::uuid)`;
        await sql`UPDATE media_items SET runtime_seconds = 145 WHERE id = ${single}::uuid`;
        const combined = await insertFile(145.092, [first, second]);
        await sql`
            UPDATE media_file_items SET start_offset_ms = 0, end_offset_ms = 72546, offset_source = 'runtime-split'
            WHERE file_id = ${combined}::uuid AND media_item_id = ${first}::uuid
        `;
        await sql`
            UPDATE media_file_items SET start_offset_ms = 72546, end_offset_ms = 145092, offset_source = 'runtime-split'
            WHERE file_id = ${combined}::uuid AND media_item_id = ${second}::uuid
        `;
        await insertFile(145.092, [single]);

        const map = await findPlaybackDurationsMs(sql, [first, second, single, noFile]);

        expect(map.get(first)).toBe(72546);
        expect(map.get(second)).toBe(72546);
        expect(map.get(single)).toBe(145092);
        expect(map.get(noFile)).toBe(73000);
        for (const id of [first, second, single, noFile]) {
            expect(map.get(id)).toBe((await findPlaybackDurationMs(sql, id)) ?? undefined);
        }
    });

    it('omits an item that has neither a file nor a runtime', async () => {
        const unknown = await insertItem('episode');
        const map = await findPlaybackDurationsMs(getTestDb(), [unknown]);
        expect(map.has(unknown)).toBe(false);
    });

    it('returns an empty map without querying for an empty id list', async () => {
        expect((await findPlaybackDurationsMs(getTestDb(), [])).size).toBe(0);
    });
});
