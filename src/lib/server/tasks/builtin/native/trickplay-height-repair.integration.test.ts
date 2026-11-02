// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../tests/integration/helpers/cleanup.js';
import { createAndInsertTestMovie } from '../../../../../../tests/integration/fixtures/index.js';
import { upsertTrickplayParams } from '../../../database/queries/trickplay-params.queries.js';
import { repairTrickplayHeights } from './trickplay-height-repair.js';

describe('repairTrickplayHeights', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, [
            'trickplay_params',
            ...TEST_TABLES.mediaFiles,
            ...TEST_TABLES.media,
        ]);
    });

    async function movieWithParams(heightMeasured?: boolean) {
        const { id: mediaId } = await createAndInsertTestMovie(sql, { withFileItem: true });
        const [{ file_id: fileId }] = await sql<{ file_id: string }[]>`
            SELECT file_id FROM media_file_items WHERE media_item_id = ${mediaId}::uuid LIMIT 1
        `;
        await upsertTrickplayParams(sql, mediaId, fileId, [
            {
                width: 320,
                height: 180,
                heightMeasured,
                intervalMs: 10000,
                tileWidth: 10,
                tileHeight: 10,
                thumbnailCount: 130,
                bandwidth: 320,
                source: 'jellyfin-disk',
            },
        ]);
        const [{ updated_at }] = await sql<{ updated_at: Date }[]>`
            SELECT updated_at FROM trickplay_params WHERE media_item_id = ${mediaId}::uuid
        `;
        return { mediaId, fileId, updatedAt: updated_at };
    }

    async function row(mediaId: string) {
        const [r] = await sql<{ height: number; height_measured: boolean; updated_at: Date }[]>`
            SELECT height, height_measured, updated_at FROM trickplay_params
             WHERE media_item_id = ${mediaId}::uuid
        `;
        return r;
    }

    it('stores the measured height once and bumps the sheet revision only on change', async () => {
        const fourThree = await movieWithParams();
        const sixteenNine = await movieWithParams();
        const unreadable = await movieWithParams();
        const alreadyMeasured = await movieWithParams(true);
        await sql`SELECT pg_sleep(0.01)`;

        const heights = new Map([
            [fourThree.fileId, 240],
            [sixteenNine.fileId, 180],
            [alreadyMeasured.fileId, 999],
        ]);
        const seen: string[] = [];
        const result = await repairTrickplayHeights(
            sql,
            { budgetMs: 60_000 },
            {
                measure: async (r) => {
                    seen.push(r.file_id);
                    return heights.get(r.file_id) ?? null;
                },
            },
        );

        expect(result).toEqual({ measured: 2, changed: 1, unmeasurable: 1 });
        expect(seen).not.toContain(alreadyMeasured.fileId);

        const a = await row(fourThree.mediaId);
        expect(a).toMatchObject({ height: 240, height_measured: true });
        expect(a.updated_at.getTime()).toBeGreaterThan(fourThree.updatedAt.getTime());

        const b = await row(sixteenNine.mediaId);
        expect(b).toMatchObject({ height: 180, height_measured: true });
        expect(b.updated_at.getTime()).toBe(sixteenNine.updatedAt.getTime());

        expect(await row(unreadable.mediaId)).toMatchObject({
            height: 180,
            height_measured: false,
        });

        // The next run only retries the row it could not measure.
        seen.length = 0;
        await repairTrickplayHeights(
            sql,
            { budgetMs: 60_000 },
            {
                measure: async (r) => {
                    seen.push(r.file_id);
                    return null;
                },
            },
        );
        expect(seen).toEqual([unreadable.fileId]);
    });
});
