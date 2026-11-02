// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Media External Groupings Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/index.js';
import { toUserId } from '$lib/shared/user-id.js';

import {
    getEffectiveMapping,
    countWatchedByGrouping,
    upsertGroupings,
    deleteStaleGroupings,
    getSeriesGroupingState,
    upsertSeriesGroupingState,
    countEnrichmentBacklog,
    wipeEnrichmentRows,
} from './media-external-groupings.queries.js';

describe('Media External Groupings Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            ...TEST_TABLES.media,
            'media_external_groupings',
            'series_grouping_state',
            'user_media_state',
            'media_item_stage_state',
        ]);
    });

    // ========================================================================
    // getEffectiveMapping
    // ========================================================================

    describe('getEffectiveMapping', () => {
        it('returns null when no mapping exists', async () => {
            const result = await getEffectiveMapping(
                sql,
                '00000000-0000-0000-0000-000000000000',
                'mal',
            );
            expect(result).toBeNull();
        });

        it('returns group_external_id for a mapping', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);
            await sql`
                INSERT INTO media_external_groupings
                    (media_id, provider, group_external_id, source)
                VALUES (${item.id}::uuid, 'mal', '12345', 'sync')
            `;

            const result = await getEffectiveMapping(sql, item.id, 'mal');
            expect(result).toBe('12345');
        });
    });

    // ========================================================================
    // upsertGroupings
    // ========================================================================

    describe('upsertGroupings', () => {
        it('inserts new grouping rows', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);

            await upsertGroupings(sql, [
                {
                    mediaId: item.id,
                    provider: 'mal',
                    groupExternalId: '999',
                    source: 'sync',
                },
            ]);

            const mapping = await getEffectiveMapping(sql, item.id, 'mal');
            expect(mapping).toBe('999');
        });

        it('updates group_external_id on conflict', async () => {
            const item = createTestMediaItem({ media_type: 'episode' });
            await insertTestMediaItem(sql, item);

            await upsertGroupings(sql, [
                {
                    mediaId: item.id,
                    provider: 'mal',
                    groupExternalId: '111',
                    source: 'sync',
                },
            ]);
            await upsertGroupings(sql, [
                {
                    mediaId: item.id,
                    provider: 'mal',
                    groupExternalId: '222',
                    source: 'sync',
                },
            ]);

            const mapping = await getEffectiveMapping(sql, item.id, 'mal');
            expect(mapping).toBe('222');
        });

        it('is a no-op for empty array', async () => {
            await expect(upsertGroupings(sql, [])).resolves.toBeUndefined();
        });
    });

    // ========================================================================
    // countWatchedByGrouping
    // ========================================================================

    describe('countWatchedByGrouping', () => {
        it('returns 0 when nothing watched', async () => {
            // Use a valid UUID with no matching rows
            const count = await countWatchedByGrouping(
                sql,
                toUserId('00000000-0000-0000-0000-000000000099'),
                'mal',
                '123',
            );
            expect(count).toBe(0);
        });

        it('counts watched episodes mapped to the grouping', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const ep = createTestMediaItem({
                media_type: 'episode',
                id: crypto.randomUUID(),
            });
            await insertTestMediaItem(sql, ep);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${ep.id}::uuid`;

            await sql`
                INSERT INTO media_external_groupings
                    (media_id, provider, group_external_id, source)
                VALUES (${ep.id}::uuid, 'mal', 'group-1', 'sync')
            `;
            await sql`
                INSERT INTO user_media_state
                    (user_id, media_id, is_watched, last_event_source)
                VALUES (${userId}, ${ep.id}::uuid, true, 'test')
            `;

            const count = await countWatchedByGrouping(sql, userId, 'mal', 'group-1');
            expect(count).toBe(1);
        });
    });

    // ========================================================================
    // deleteStaleGroupings
    // ========================================================================

    describe('deleteStaleGroupings', () => {
        it('returns 0 and does nothing for empty keepMediaIds', async () => {
            const deleted = await deleteStaleGroupings(sql, crypto.randomUUID(), 'mal', 'sync', []);
            expect(deleted).toBe(0);
        });

        it('deletes groupings not in keep list', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            const ep1 = createTestMediaItem({
                media_type: 'episode',
                id: crypto.randomUUID(),
            });
            const ep2 = createTestMediaItem({
                media_type: 'episode',
                id: crypto.randomUUID(),
            });
            await insertTestMediaItem(sql, ep1);
            await insertTestMediaItem(sql, ep2);
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${ep1.id}::uuid`;
            await sql`UPDATE media_items SET parent_id = ${series.id}::uuid WHERE id = ${ep2.id}::uuid`;

            await sql`
                INSERT INTO media_external_groupings (media_id, provider, group_external_id, source)
                VALUES
                    (${ep1.id}::uuid, 'mal', 'g1', 'sync'),
                    (${ep2.id}::uuid, 'mal', 'g2', 'sync')
            `;

            const deleted = await deleteStaleGroupings(sql, series.id, 'mal', 'sync', [ep1.id]);
            expect(deleted).toBe(1);

            const remaining = await sql`
                SELECT media_id FROM media_external_groupings WHERE provider = 'mal'
            `;
            expect(remaining).toHaveLength(1);
            expect(remaining[0].media_id).toBe(ep1.id);
        });
    });

    // ========================================================================
    // getSeriesGroupingState / upsertSeriesGroupingState
    // ========================================================================

    describe('series grouping state', () => {
        it('returns null when no state exists', async () => {
            const state = await getSeriesGroupingState(sql, crypto.randomUUID(), 'mal', 'sync');
            expect(state).toBeNull();
        });

        it('upserts and retrieves state', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            await upsertSeriesGroupingState(sql, {
                seriesId: series.id,
                provider: 'mal',
                source: 'sync',
                lastEnrichedAt: new Date(),
                chainSignature: 'sig-1',
                flattenedEpisodeCount: 10,
                enrichedEpisodeCount: 10,
            });

            const state = await getSeriesGroupingState(sql, series.id, 'mal', 'sync');
            expect(state).not.toBeNull();
            expect(state!.chainSignature).toBe('sig-1');
            expect(state!.flattenedEpisodeCount).toBe(10);
        });
    });

    // ========================================================================
    // countEnrichmentBacklog
    // ========================================================================

    describe('countEnrichmentBacklog', () => {
        it('returns zero counts when no eligible series', async () => {
            const backlog = await countEnrichmentBacklog(sql, 'mal', 'sync');
            expect(backlog.analyzed).toBe(0);
            expect(backlog.remaining).toBe(0);
            expect(backlog.ineligible).toBe(0);
        });
    });

    // ========================================================================
    // wipeEnrichmentRows
    // ========================================================================

    describe('wipeEnrichmentRows', () => {
        it('deletes groupings and state for provider+source', async () => {
            const series = createTestMediaItem({ media_type: 'tv' });
            await insertTestMediaItem(sql, series);
            await sql`
                INSERT INTO media_external_groupings (media_id, provider, group_external_id, source)
                VALUES (${series.id}::uuid, 'mal', 'g1', 'sync')
            `;
            await sql`
                INSERT INTO series_grouping_state (series_id, provider, source, chain_signature, flattened_episode_count, enriched_episode_count)
                VALUES (${series.id}::uuid, 'mal', 'sync', 'sig', 1, 1)
            `;

            await wipeEnrichmentRows(sql, 'mal', 'sync');

            const groupings = await sql`
                SELECT 1 FROM media_external_groupings WHERE provider = 'mal' AND source = 'sync'
            `;
            const states = await sql`
                SELECT 1 FROM series_grouping_state WHERE provider = 'mal' AND source = 'sync'
            `;
            expect(groupings).toHaveLength(0);
            expect(states).toHaveLength(0);
        });
    });
});
