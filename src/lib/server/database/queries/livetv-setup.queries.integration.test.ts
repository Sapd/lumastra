// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for LiveTV Setup Query Module
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';

import {
    getChannelsForSetup,
    bulkUpdateChannelVisibility,
    bulkUpdateChannelSortOrder,
    getSetupSummary,
    saveSourceLineupFilter,
    getSourceLineupFilter,
} from './livetv-setup.queries.js';

async function insertSource(sql: postgres.Sql, id: string, name = 'Test Source'): Promise<void> {
    await sql`
        INSERT INTO livetv_sources (id, name, source_type, max_streams)
        VALUES (${id}::uuid, ${name}, 'm3u', 2)
    `;
}

async function insertCategory(sql: postgres.Sql, id: string, name: string): Promise<void> {
    await sql`
        INSERT INTO livetv_categories (id, name, sort_order, is_visible)
        VALUES (${id}::uuid, ${name}, 0, true)
    `;
}

async function insertChannel(
    sql: postgres.Sql,
    opts: {
        id: string;
        name: string;
        sourceId: string;
        sortOrder?: number;
        isVisible?: boolean;
        categoryId?: string;
        countryCode?: string;
        qualityTier?: string;
    },
): Promise<void> {
    await sql`
        INSERT INTO media_items (id, title, media_type, status)
        VALUES (${opts.id}::uuid, ${opts.name}, 'tvchannel', 'active')
    `;
    await sql`
        INSERT INTO livetv_channels (
            id, m3u_url, source_id, sort_order, is_visible,
            category_id, country_code, quality_tier
        )
        VALUES (
            ${opts.id}::uuid,
            'http://stream.test',
            ${opts.sourceId}::uuid,
            ${opts.sortOrder ?? 0},
            ${opts.isVisible ?? true},
            ${opts.categoryId ? sql`${opts.categoryId}::uuid` : sql`NULL`},
            ${opts.countryCode ?? null},
            ${opts.qualityTier ?? null}
        )
    `;
}

describe('LiveTV Setup Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE livetv_channels, livetv_categories, livetv_sources, media_items RESTART IDENTITY CASCADE',
        );
    });

    // ========================================================================
    // getChannelsForSetup
    // ========================================================================

    describe('getChannelsForSetup', () => {
        it('returns channels for a source ordered by sort_order, title', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const ch1 = crypto.randomUUID();
            const ch2 = crypto.randomUUID();
            await insertChannel(sql, {
                id: ch1,
                name: 'Beta',
                sourceId,
                sortOrder: 2,
            });
            await insertChannel(sql, {
                id: ch2,
                name: 'Alpha',
                sourceId,
                sortOrder: 1,
            });

            const rows = await getChannelsForSetup(sql, sourceId);
            expect(rows).toHaveLength(2);
            expect(rows[0].title).toBe('Alpha');
            expect(rows[1].title).toBe('Beta');
        });

        it('returns empty array for unknown source', async () => {
            const rows = await getChannelsForSetup(sql, '00000000-0000-0000-0000-000000000000');
            expect(rows).toEqual([]);
        });
    });

    // ========================================================================
    // bulkUpdateChannelVisibility
    // ========================================================================

    describe('bulkUpdateChannelVisibility', () => {
        it('updates visibility for multiple channels', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const ch1 = crypto.randomUUID();
            const ch2 = crypto.randomUUID();
            await insertChannel(sql, {
                id: ch1,
                name: 'Ch1',
                sourceId,
                isVisible: true,
            });
            await insertChannel(sql, {
                id: ch2,
                name: 'Ch2',
                sourceId,
                isVisible: true,
            });

            await bulkUpdateChannelVisibility(sql, [
                { id: ch1, isVisible: false },
                { id: ch2, isVisible: false },
            ]);

            const rows = await getChannelsForSetup(sql, sourceId);
            expect(rows.every((r) => !r.is_visible)).toBe(true);
        });

        it('is a no-op for empty updates', async () => {
            await expect(bulkUpdateChannelVisibility(sql, [])).resolves.toBeUndefined();
        });
    });

    // ========================================================================
    // bulkUpdateChannelSortOrder
    // ========================================================================

    describe('bulkUpdateChannelSortOrder', () => {
        it('updates sort_order for multiple channels', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const ch1 = crypto.randomUUID();
            const ch2 = crypto.randomUUID();
            await insertChannel(sql, {
                id: ch1,
                name: 'Ch1',
                sourceId,
                sortOrder: 0,
            });
            await insertChannel(sql, {
                id: ch2,
                name: 'Ch2',
                sourceId,
                sortOrder: 0,
            });

            await bulkUpdateChannelSortOrder(sql, [
                { id: ch1, sortOrder: 10 },
                { id: ch2, sortOrder: 5 },
            ]);

            const rows = await getChannelsForSetup(sql, sourceId);
            expect(rows[0].id).toBe(ch2);
            expect(rows[1].id).toBe(ch1);
        });
    });

    // ========================================================================
    // getSetupSummary
    // ========================================================================

    describe('getSetupSummary', () => {
        it('returns zeroed summary when no channels', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const result = await getSetupSummary(sql, sourceId);
            expect(result.summary.total_channels).toBe(0);
            expect(result.summary.visible_channels).toBe(0);
            expect(result.categories).toEqual([]);
        });

        it('aggregates quality tiers and categories', async () => {
            const sourceId = crypto.randomUUID();
            const catId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            await insertCategory(sql, catId, 'Sports');
            await insertChannel(sql, {
                id: crypto.randomUUID(),
                name: 'UHD Channel',
                sourceId,
                qualityTier: 'uhd',
                isVisible: true,
                categoryId: catId,
            });
            await insertChannel(sql, {
                id: crypto.randomUUID(),
                name: 'HD Channel',
                sourceId,
                qualityTier: 'hd',
                isVisible: false,
            });

            const result = await getSetupSummary(sql, sourceId);
            expect(result.summary.total_channels).toBe(2);
            expect(result.summary.visible_channels).toBe(1);
            expect(result.summary.quality_uhd).toBe(1);
            expect(result.summary.quality_hd).toBe(1);
            expect(result.categories).toHaveLength(2); // Sports + Uncategorized
        });

        it('detects regional variants', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            await insertChannel(sql, {
                id: crypto.randomUUID(),
                name: 'News',
                sourceId,
                countryCode: 'de',
            });
            await insertChannel(sql, {
                id: crypto.randomUUID(),
                name: 'News',
                sourceId,
                countryCode: 'at',
            });

            const result = await getSetupSummary(sql, sourceId);
            expect(result.summary.regional_variant_count).toBeGreaterThanOrEqual(0);
            expect(result.detectedRegions).toContain('at');
            expect(result.detectedRegions).toContain('de');
        });

        it('counts channels per region and untagged channels', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            const add = (name: string, countryCode?: string) =>
                insertChannel(sql, { id: crypto.randomUUID(), name, sourceId, countryCode });
            await add('US: VDD', 'us');
            await add('US: KVL', 'us');
            await add('RO: Pro TV', 'ro');
            await add('24/7 • Seabright');
            await add('✦ 24x7 Cartoons');
            await add('7/24 | PARADE MÜZİK 1', 'tr');
            await add('Orb 24/7 News');
            await add('Max der Maurer S2 E5');

            const result = await getSetupSummary(sql, sourceId);
            expect(result.regions.map((r) => [r.code, Number(r.channel_count)])).toEqual([
                ['us', 2],
                ['ro', 1],
                ['tr', 1],
            ]);
            expect(Number(result.summary.untagged_channels)).toBe(4);
            expect(result.lineupFilter).toBeNull();
        });
    });

    describe('lineup filter', () => {
        it('stores and reads back a source filter (migration 16.304.0)', async () => {
            const sourceId = crypto.randomUUID();
            await insertSource(sql, sourceId);
            expect(await getSourceLineupFilter(sql, sourceId)).toBeNull();

            const filter = {
                countries: ['de', 'at', 'uk', 'us'],
                includeUntagged: true,
                hideLoopChannels: true,
                hiddenCategories: ['ADULT XXX'],
                channelOrder: 'traditional',
                preferHighQuality: true,
            };
            await saveSourceLineupFilter(sql, sourceId, filter);

            expect(await getSourceLineupFilter(sql, sourceId)).toEqual(filter);
            expect((await getSetupSummary(sql, sourceId)).lineupFilter).toEqual(filter);
        });
    });
});
