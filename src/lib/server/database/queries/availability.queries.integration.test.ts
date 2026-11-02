// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Availability Query Module
 *
 * Tests isAvailableExpr, canRequestExpr, isAvailable, batchGetAvailability, and getAvailability.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    isAvailableExpr,
    canRequestExpr,
    isAvailable,
    batchGetAvailability,
    getAvailability,
} from './availability.queries.js';

describe('Availability Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    describe('isAvailable', () => {
        it('returns true when media has_files = true', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;

            const result = await isAvailable(sql, item.id);
            expect(result).toBe(true);
        });

        it('returns false when media has_files = false', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await isAvailable(sql, item.id);
            expect(result).toBe(false);
        });

        it('returns false for non-existent media', async () => {
            const result = await isAvailable(sql, '00000000-0000-0000-0000-000000000000');
            expect(result).toBe(false);
        });
    });

    describe('batchGetAvailability', () => {
        it('returns map with true for available items', async () => {
            const item1 = createTestMediaItem({ media_type: 'movie' });
            const item2 = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, item1);
            await insertTestMediaItem(sql, item2);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item1.id}::uuid`;

            const result = await batchGetAvailability(sql, [item1.id, item2.id]);
            expect(result.get(item1.id)).toBe(true);
            expect(result.get(item2.id)).toBe(false);
        });

        it('returns empty map for empty input', async () => {
            const result = await batchGetAvailability(sql, []);
            expect(result.size).toBe(0);
        });

        it('returns false for invalid UUIDs', async () => {
            const result = await batchGetAvailability(sql, ['not-a-uuid', '12345']);
            expect(result.get('not-a-uuid')).toBe(false);
            expect(result.get('12345')).toBe(false);
        });
    });

    describe('getAvailability', () => {
        it('returns is_available and jellyfin_id', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${item.id}::uuid, 'jellyfin', 'jf123', 'movie', false)
            `;

            const result = await getAvailability(sql, item.id);
            expect(result.is_available).toBe(true);
            expect(result).not.toHaveProperty('jellyfin_id');
        });

        it('returns defaults for non-existent media', async () => {
            const result = await getAvailability(sql, '00000000-0000-0000-0000-000000000000');
            expect(result.is_available).toBe(false);
        });
    });

    describe('isAvailableExpr', () => {
        it.each(['availability_item', 'availability_target'])(
            'keeps custom references correlated when the outer alias is %s',
            async (alias) => {
                const available = createTestMediaItem({ media_type: 'tv', has_files: true });
                const unavailable = createTestMediaItem({ media_type: 'tv', has_files: false });
                await insertTestMediaItem(sql, available);
                await insertTestMediaItem(sql, unavailable);
                const mediaId = sql`${sql(alias + '.id')}`;

                const rows = await sql`
                    SELECT ${sql(alias + '.id')} AS id,
                        ${isAvailableExpr(sql, mediaId)} AS available,
                        ${canRequestExpr(sql, mediaId)} AS can_request
                    FROM media_items ${sql(alias)}
                    ORDER BY ${sql(alias + '.has_files')} DESC
                `;
                expect(rows).toEqual([
                    { id: available.id, available: true, can_request: false },
                    { id: unavailable.id, available: false, can_request: true },
                ]);
            },
        );

        it('uses the canonical flag even when an unavailable row has a direct file link', async () => {
            const item = createTestMediaItem({ media_type: 'movie', has_files: false });
            await insertTestMediaItem(sql, item);
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path)
                VALUES (${fileId}::uuid, ${`/test/canonical/${item.id}.mkv`})
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${item.id}::uuid)
            `;
            const rows = await sql`
                SELECT ${isAvailableExpr(sql, sql`mi.id`)} AS available,
                    ${canRequestExpr(sql, sql`mi.id`)} AS can_request
                FROM media_items mi WHERE mi.id = ${item.id}::uuid
            `;
            expect(rows[0]).toEqual({ available: false, can_request: true });
        });

        it.each([
            { mediaType: 'movie', hasFiles: true },
            { mediaType: 'movie', hasFiles: false },
            { mediaType: 'tv', hasFiles: true },
            { mediaType: 'tv', hasFiles: false },
        ] as const)(
            'agrees with the default branch for $mediaType with has_files=$hasFiles',
            async ({ mediaType, hasFiles }) => {
                const item = createTestMediaItem({
                    media_type: mediaType,
                    has_files: hasFiles,
                });
                await insertTestMediaItem(sql, item);
                // An unrelated available row catches accidental shadowing of mi.
                await insertTestMediaItem(
                    sql,
                    createTestMediaItem({ media_type: 'movie', has_files: true }),
                );

                if (mediaType === 'tv' && hasFiles) {
                    const season = createTestMediaItem({
                        media_type: 'season',
                        parent_id: item.id,
                    });
                    const episode = createTestMediaItem({
                        media_type: 'episode',
                        parent_id: season.id,
                    });
                    await insertTestMediaItem(sql, season);
                    await insertTestMediaItem(sql, episode);
                    const fileId = crypto.randomUUID();
                    await sql`
                        INSERT INTO media_files (id, file_path)
                        VALUES (${fileId}::uuid, ${`/test/episodes/${episode.id}.mkv`})
                    `;
                    await sql`
                        INSERT INTO media_file_items (file_id, media_item_id)
                        VALUES (${fileId}::uuid, ${episode.id}::uuid)
                    `;
                }

                const directLinks = await sql`
                    SELECT file_id FROM media_file_items
                    WHERE media_item_id = ${item.id}::uuid
                `;
                expect(directLinks).toHaveLength(0);

                const rows = await sql`
                    SELECT
                        ${isAvailableExpr(sql)} AS default_available,
                        ${isAvailableExpr(sql, sql`mi.id`)} AS custom_available,
                        ${canRequestExpr(sql)} AS default_can_request,
                        ${canRequestExpr(sql, sql`mi.id`)} AS custom_can_request
                    FROM media_items mi
                    WHERE mi.id = ${item.id}::uuid
                `;
                expect(rows[0]).toEqual({
                    default_available: hasFiles,
                    custom_available: hasFiles,
                    default_can_request: !hasFiles,
                    custom_can_request: !hasFiles,
                });
            },
        );

        it.each(['00000000-0000-0000-0000-000000000000', null])(
            'returns false and allows requests for missing custom ID %s',
            async (mediaId) => {
                await insertTestMediaItem(
                    sql,
                    createTestMediaItem({ media_type: 'tv', has_files: true }),
                );
                const rows = await sql`
                    SELECT
                        ${isAvailableExpr(sql, sql`input.media_id`)} AS available,
                        ${canRequestExpr(sql, sql`input.media_id`)} AS can_request
                    FROM (SELECT ${mediaId}::uuid AS media_id) input
                `;
                expect(rows[0]).toEqual({ available: false, can_request: true });
            },
        );

        it('produces a valid SQL fragment', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`UPDATE media_items SET has_files = true WHERE id = ${item.id}::uuid`;

            const fragment = isAvailableExpr(sql);
            const rows = await sql`
                SELECT ${fragment} AS available FROM media_items mi WHERE mi.id = ${item.id}::uuid
            `;
            expect(rows[0].available).toBe(true);
        });
    });

    describe('canRequestExpr', () => {
        it('produces a valid negated SQL fragment', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            // has_files defaults to false

            const fragment = canRequestExpr(sql);
            const rows = await sql`
                SELECT ${fragment} AS can_request FROM media_items mi WHERE mi.id = ${item.id}::uuid
            `;
            expect(rows[0].can_request).toBe(true);
        });
    });
});
