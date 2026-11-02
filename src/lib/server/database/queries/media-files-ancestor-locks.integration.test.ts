// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Ancestor-chain writers must lock episode/season/series rows in ONE order.
 * Prod 2026-09-22..23: 20 `deadlock detected` between propagateHasFiles,
 * touchLibraryAddedAt and recomputeHasFilesBatch running inside concurrent
 * scanner transactions for siblings of one series.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    attachFileToItem,
    recomputeHasFilesBatch,
    touchLibraryAddedAt,
} from './media-files.queries.js';

describe('ancestor-chain lock order', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    async function item(mediaType: string, parentId: string | null): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files, parent_id)
            VALUES (${mediaType}, 'Fixture', 'active', false, ${parentId}) RETURNING id`;
        return row.id;
    }

    async function file(n: number): Promise<string> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path) VALUES (${`/fixtures/lock-order-${n}.mkv`}) RETURNING id`;
        return row.id;
    }

    it('concurrent sibling attaches + recomputes never deadlock', async () => {
        const seriesId = await item('tv', null);
        const seasons = [await item('season', seriesId), await item('season', seriesId)];
        const episodes: string[] = [];
        for (let i = 0; i < 24; i++) episodes.push(await item('episode', seasons[i % 2]));
        const files = await Promise.all(episodes.map((_, i) => file(i)));
        // Reclaim candidates make attach write processing_state. Without a
        // completed old default, the snapshot UPDATE is a no-op and cannot
        // expose an item-before-ancestor lock inversion.
        for (const [i, episode] of episodes.entries()) {
            const oldFile = await file(100 + i);
            await sql`UPDATE media_files SET file_hash_head = ${'a'.repeat(64)} WHERE id = ${oldFile}`;
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${oldFile}, ${episode}, true)`;
            await sql`INSERT INTO media_item_stage_state (media_item_id, stage_id, status, processing_version)
                VALUES (${episode}, 'trickplay-generation', 'completed', 1)`;
        }

        const errors: unknown[] = [];
        await Promise.all(
            episodes.map((ep, i) =>
                sql
                    .begin(async (tx) => {
                        const t = tx as unknown as postgres.Sql;
                        if (i % 3 === 0) {
                            await recomputeHasFilesBatch(t, [
                                ep,
                                episodes[(i + 1) % episodes.length],
                            ]);
                            await touchLibraryAddedAt(t, ep, true);
                        } else {
                            // The file-rematch reclaim path: attach + touch in one tx.
                            await attachFileToItem(t, files[i], ep);
                            await touchLibraryAddedAt(t, ep, true);
                        }
                    })
                    .catch((err: unknown) => errors.push(err)),
            ),
        );

        expect(errors.map((e) => String(e))).toEqual([]);
        const [s] = await sql<{ has_files: boolean }[]>`
            SELECT has_files FROM media_items WHERE id = ${seriesId}`;
        expect(s.has_files).toBe(true);
    });
});
