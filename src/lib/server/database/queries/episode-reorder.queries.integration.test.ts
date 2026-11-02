// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Episode Reorder Query Module
 *
 * Tests verifyEpisodesBelongToSeries and reorderEpisodes against a real
 * PostgreSQL test database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';

import { verifyEpisodesBelongToSeries, reorderEpisodes } from './episode-reorder.queries.js';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Episode Reorder Queries', () => {
    let sql: postgres.Sql;
    let seriesId: string;
    let seasonId: string;
    let episodeIds: string[];

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);

        seriesId = crypto.randomUUID();
        seasonId = crypto.randomUUID();
        episodeIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];

        // Insert series
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (${seriesId}::uuid, ${'Test Series'}, 'tv', 'active')
        `;

        // Insert season
        await sql`
            INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
            VALUES (${seasonId}::uuid, ${'Season 1'}, 'season', ${seriesId}::uuid, 1, 'active')
        `;

        // Insert episodes under season
        for (let i = 0; i < episodeIds.length; i++) {
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
                VALUES (
                    ${episodeIds[i]}::uuid,
                    ${`Episode ${i + 1}`},
                    'episode',
                    ${seasonId}::uuid,
                    1,
                    ${i + 1},
                    'active'
                )
            `;
        }
    });

    // ========================================================================
    // verifyEpisodesBelongToSeries
    // ========================================================================

    describe('verifyEpisodesBelongToSeries', () => {
        it('returns all episode ids that belong to the series', async () => {
            const valid = await verifyEpisodesBelongToSeries(sql, seriesId, episodeIds);
            expect(valid.size).toBe(3);
            for (const id of episodeIds) {
                expect(valid.has(id)).toBe(true);
            }
        });

        it('excludes episode ids that do not belong to the series', async () => {
            const otherEpisodeId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${otherEpisodeId}::uuid, ${'Orphan Episode'}, 'episode', 'active')
            `;

            const valid = await verifyEpisodesBelongToSeries(sql, seriesId, [
                ...episodeIds,
                otherEpisodeId,
            ]);
            expect(valid.size).toBe(3);
            expect(valid.has(otherEpisodeId)).toBe(false);
        });

        it('returns empty set for non-existent series', async () => {
            const valid = await verifyEpisodesBelongToSeries(sql, crypto.randomUUID(), episodeIds);
            expect(valid.size).toBe(0);
        });

        it('returns empty set for empty episodeIds', async () => {
            const valid = await verifyEpisodesBelongToSeries(sql, seriesId, []);
            expect(valid.size).toBe(0);
        });

        it('excludes episodes that belong to a different series', async () => {
            const otherSeriesId = crypto.randomUUID();
            const otherSeasonId = crypto.randomUUID();
            const otherEpisodeId = crypto.randomUUID();

            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${otherSeriesId}::uuid, ${'Other Series'}, 'tv', 'active')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, status)
                VALUES (${otherSeasonId}::uuid, ${'Season 1'}, 'season', ${otherSeriesId}::uuid, 1, 'active')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
                VALUES (${otherEpisodeId}::uuid, ${'Other Ep'}, 'episode', ${otherSeasonId}::uuid, 1, 1, 'active')
            `;

            const valid = await verifyEpisodesBelongToSeries(sql, seriesId, [
                ...episodeIds,
                otherEpisodeId,
            ]);
            expect(valid.size).toBe(3);
            expect(valid.has(otherEpisodeId)).toBe(false);
        });
    });

    // ========================================================================
    // reorderEpisodes
    // ========================================================================

    describe('reorderEpisodes', () => {
        it('updates episode_number for a batch of episodes', async () => {
            await reorderEpisodes(sql, [
                { id: episodeIds[0], episodeNumber: 3 },
                { id: episodeIds[1], episodeNumber: 1 },
                { id: episodeIds[2], episodeNumber: 2 },
            ]);

            const rows = await sql<{ id: string; episode_number: number }[]>`
                SELECT id, episode_number FROM media_items
                WHERE id = ANY(${episodeIds}::uuid[])
                ORDER BY episode_number
            `;

            expect(rows[0].episode_number).toBe(1);
            expect(rows[0].id).toBe(episodeIds[1]);
            expect(rows[1].episode_number).toBe(2);
            expect(rows[1].id).toBe(episodeIds[2]);
            expect(rows[2].episode_number).toBe(3);
            expect(rows[2].id).toBe(episodeIds[0]);
        });

        it('updates updated_at timestamp', async () => {
            // Bracket with the DATABASE clock, not the test process's: updated_at
            // is stamped by Postgres, and a DB in a VM/container (podman on macOS)
            // or on another host runs a few ms off the local clock.
            const dbNow = async (): Promise<Date> =>
                (await sql<{ now: Date }[]>`SELECT clock_timestamp() AS now`)[0].now;
            const before = await dbNow();
            await reorderEpisodes(sql, [{ id: episodeIds[0], episodeNumber: 99 }]);
            const after = await dbNow();

            const [row] = await sql<{ updated_at: Date }[]>`
                SELECT updated_at FROM media_items WHERE id = ${episodeIds[0]}::uuid
            `;
            expect(row.updated_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
            expect(row.updated_at.getTime()).toBeLessThanOrEqual(after.getTime());
        });

        it('does nothing for empty batch', async () => {
            await expect(reorderEpisodes(sql, [])).resolves.toBeUndefined();
        });
    });
});
