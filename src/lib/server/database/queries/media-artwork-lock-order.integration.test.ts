// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Artwork writers must lock the owning media_items row BEFORE media_artwork
 * rows. Prod 2026-09-22..23: 4 deadlocks between invalidateFileProbeData
 * (media_items, then DELETE local artwork) and deleteArtworkById (DELETE the
 * artwork row, then clear custom_poster_url).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    attachFileToItem,
    invalidateFileProbeData,
    upsertMediaFile,
} from './media-files.queries.js';
import { deleteArtworkById, upsertLocalArtwork } from './media-artwork.queries.js';

describe('artwork lock order', () => {
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

    it('file invalidation racing artwork deletion never deadlocks', async () => {
        const items: { id: string; fileId: string }[] = [];
        for (let i = 0; i < 12; i++) {
            const [row] = await sql<{ id: string }[]>`
                INSERT INTO media_items (media_type, title, status, has_files)
                VALUES ('movie', 'Fixture', 'active', true) RETURNING id`;
            const { id: fileId } = await upsertMediaFile(sql, {
                filePath: `/fixtures/artwork-lock-${i}.mkv`,
            });
            await attachFileToItem(sql, fileId, row.id);
            items.push({ id: row.id, fileId });
        }

        const errors: string[] = [];
        for (let round = 0; round < 6; round++) {
            const artworkIds: string[] = [];
            for (const it of items) {
                for (const type of ['poster', 'backdrop'] as const) {
                    await upsertLocalArtwork(sql, {
                        mediaItemId: it.id,
                        artworkType: type,
                        filePath: `/data/art/${it.id}-${type}-${round}.jpg`,
                    });
                }
                const [a] = await sql<{ id: string }[]>`
                    SELECT id FROM media_artwork
                    WHERE media_item_id = ${it.id} AND artwork_type = 'poster' AND source = 'local'`;
                artworkIds.push(a.id);
            }
            await Promise.all(
                items.flatMap((it, i) => [
                    invalidateFileProbeData(sql, it.fileId).catch((e: unknown) =>
                        errors.push(String(e)),
                    ),
                    deleteArtworkById(sql, artworkIds[i]).catch((e: unknown) =>
                        errors.push(String(e)),
                    ),
                ]),
            );
        }

        expect(errors).toEqual([]);
    });
});
