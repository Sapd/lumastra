// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for livetv-setup query module
 */

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';

import {
    getChannelsForSetup,
    bulkUpdateChannelVisibility,
    bulkUpdateChannelSortOrder,
    getSetupSummary,
} from './livetv-setup.queries.js';

// =============================================================================
// Mock helpers
// =============================================================================

function createMockSql(defaultReturn: unknown[] = []) {
    const calls: unknown[][] = [];

    const mockSql = vi.fn((...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(defaultReturn);
    }) as unknown as postgres.Sql;

    (mockSql as unknown as Record<string, unknown>).array = vi.fn((arr: unknown[]) => arr);

    return { sql: mockSql, calls };
}

// =============================================================================
// getChannelsForSetup
// =============================================================================

describe('getChannelsForSetup', () => {
    it('calls sql with the provided sourceId', async () => {
        const { sql, calls } = createMockSql([]);

        await getChannelsForSetup(sql, 'uuid-source-1');

        expect(calls).toHaveLength(1);
        const args = calls[0] as unknown[];
        expect(args).toContain('uuid-source-1');
    });

    it('returns the rows from sql', async () => {
        const fakeRows = [
            {
                id: 'uuid-ch-1',
                title: 'KWF',
                quality_tier: 'fhd',
                is_visible: true,
                sort_order: 0,
                country_code: 'de',
                category_name: 'News',
                backup_group_id: null,
                epg_channel_id: 'kwf.de',
            },
        ];
        const { sql } = createMockSql(fakeRows);

        const result = await getChannelsForSetup(sql, 'uuid-source-1');

        expect(result).toEqual(fakeRows);
    });

    it('returns an empty array when no channels exist', async () => {
        const { sql } = createMockSql([]);

        const result = await getChannelsForSetup(sql, 'uuid-source-empty');

        expect(result).toEqual([]);
    });
});

// =============================================================================
// bulkUpdateChannelVisibility
// =============================================================================

describe('bulkUpdateChannelVisibility', () => {
    it('calls sql once with id and visible arrays', async () => {
        const { sql, calls } = createMockSql([]);

        await bulkUpdateChannelVisibility(sql, [
            { id: 'uuid-ch-1', isVisible: true },
            { id: 'uuid-ch-2', isVisible: false },
        ]);

        expect(calls).toHaveLength(1);
    });

    it('skips the query when updates array is empty', async () => {
        const { sql, calls } = createMockSql([]);

        await bulkUpdateChannelVisibility(sql, []);

        expect(calls).toHaveLength(0);
    });

    it('passes the correct values to sql.array', async () => {
        const arrayCalls: unknown[][] = [];
        const mockSql = vi.fn(() => Promise.resolve([])) as unknown as postgres.Sql;
        (mockSql as unknown as Record<string, unknown>).array = vi.fn((arr: unknown[]) => {
            arrayCalls.push(arr);
            return arr;
        });

        await bulkUpdateChannelVisibility(mockSql as postgres.Sql, [
            { id: 'uuid-ch-1', isVisible: true },
            { id: 'uuid-ch-2', isVisible: false },
        ]);

        expect(arrayCalls[0]).toEqual(['uuid-ch-1', 'uuid-ch-2']);
        expect(arrayCalls[1]).toEqual([true, false]);
    });
});

// =============================================================================
// bulkUpdateChannelSortOrder
// =============================================================================

describe('bulkUpdateChannelSortOrder', () => {
    it('calls sql once with id and sort_order arrays', async () => {
        const { sql, calls } = createMockSql([]);

        await bulkUpdateChannelSortOrder(sql, [
            { id: 'uuid-ch-1', sortOrder: 0 },
            { id: 'uuid-ch-2', sortOrder: 100000 },
        ]);

        expect(calls).toHaveLength(1);
    });

    it('skips the query when updates array is empty', async () => {
        const { sql, calls } = createMockSql([]);

        await bulkUpdateChannelSortOrder(sql, []);

        expect(calls).toHaveLength(0);
    });

    it('passes the correct sort order values to sql.array', async () => {
        const arrayCalls: unknown[][] = [];
        const mockSql = vi.fn(() => Promise.resolve([])) as unknown as postgres.Sql;
        (mockSql as unknown as Record<string, unknown>).array = vi.fn((arr: unknown[]) => {
            arrayCalls.push(arr);
            return arr;
        });

        await bulkUpdateChannelSortOrder(mockSql as postgres.Sql, [
            { id: 'uuid-ch-1', sortOrder: 5 },
            { id: 'uuid-ch-2', sortOrder: 200000 },
        ]);

        expect(arrayCalls[0]).toEqual(['uuid-ch-1', 'uuid-ch-2']);
        expect(arrayCalls[1]).toEqual([5, 200000]);
    });
});

// =============================================================================
// getSetupSummary
// =============================================================================

describe('getSetupSummary', () => {
    it('executes four queries (summary, categories, regions, lineup filter), each for the source', async () => {
        const { sql, calls } = createMockSql([]);

        await getSetupSummary(sql, 'uuid-source-1');

        expect(calls).toHaveLength(4);
        for (const call of calls) expect(call.slice(1)).toContain('uuid-source-1');
    });

    it('returns default summary when no rows are returned', async () => {
        const { sql } = createMockSql([]);

        const result = await getSetupSummary(sql, 'uuid-source-empty');

        expect(result.summary).toEqual({
            total_channels: 0,
            visible_channels: 0,
            quality_uhd: 0,
            quality_fhd: 0,
            quality_hd: 0,
            quality_sd: 0,
            quality_unknown: 0,
            regional_variant_count: 0,
            untagged_channels: 0,
        });
        expect(result.categories).toEqual([]);
        expect(result.detectedRegions).toEqual([]);
        expect(result.regions).toEqual([]);
        expect(result.lineupFilter).toBeNull();
    });

    it('maps region rows to sorted detectedRegions and passes the counts through', async () => {
        const regionRows = [
            { code: 'de', channel_count: 40 },
            { code: 'at', channel_count: 10 },
        ];
        let callIndex = 0;
        const mockSql = vi.fn(() => {
            callIndex++;
            if (callIndex === 3) return Promise.resolve(regionRows);
            return Promise.resolve([]);
        }) as unknown as postgres.Sql;
        (mockSql as unknown as Record<string, unknown>).array = vi.fn((arr: unknown[]) => arr);

        const result = await getSetupSummary(mockSql, 'uuid-source-1');

        expect(result.detectedRegions).toEqual(['at', 'de']);
        expect(result.regions).toEqual(regionRows);
    });

    it('returns the stored lineup filter from the fourth query', async () => {
        const filter = { countries: ['de', 'uk'], includeUntagged: true };
        let callIndex = 0;
        const mockSql = vi.fn(() => {
            callIndex++;
            if (callIndex === 4) return Promise.resolve([{ lineup_filter: filter }]);
            return Promise.resolve([]);
        }) as unknown as postgres.Sql;
        (mockSql as unknown as Record<string, unknown>).array = vi.fn((arr: unknown[]) => arr);

        const result = await getSetupSummary(mockSql, 'uuid-source-1');

        expect(result.lineupFilter).toEqual(filter);
    });

    it('maps category rows correctly', async () => {
        let callIndex = 0;
        const mockSql = vi.fn(() => {
            callIndex++;
            if (callIndex === 2) {
                return Promise.resolve([
                    { name: 'News', channel_count: 10 },
                    { name: 'Sports', channel_count: 5 },
                ]);
            }
            return Promise.resolve([]);
        }) as unknown as postgres.Sql;
        (mockSql as unknown as Record<string, unknown>).array = vi.fn((arr: unknown[]) => arr);

        const result = await getSetupSummary(mockSql, 'uuid-source-1');

        expect(result.categories).toEqual([
            { name: 'News', channel_count: 10 },
            { name: 'Sports', channel_count: 5 },
        ]);
    });
});
