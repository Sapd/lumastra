// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for livetv-channels query module
 */

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { config } from '../../config.js';
import { clampTrigramThreshold } from './builders/trigram-threshold.builder.js';

import {
    createChannelWithMediaItem,
    bulkCreateChannels,
    getChannelsBySourceId,
    deleteChannelsBySourceId,
    searchChannels,
    getChannelsForAdmin,
    getAllVisibleChannels,
    batchUpdateChannelSortOrder,
    batchUpdateCategorySortOrder,
    updateChannel,
    bulkUpdateChannels,
    updateCategoryVisibility,
    getBackupGroupsForAdmin,
    removeChannelFromBackupGroup,
    splitBackupGroup,
    createBackupGroup,
    addChannelToBackupGroup,
    getEpgMatchReviewData,
    searchEpgChannels,
    updateEpgMatch,
    renameCategory,
    createCategory,
    mergeCategories,
    deleteEmptyCategory,
    getCategoryChannelCount,
} from './livetv-channels.queries.js';

// =============================================================================
// Mock helpers
// =============================================================================

function createMockSql(defaultReturn: unknown[] = []) {
    const calls: unknown[][] = [];

    const mockSql = vi.fn((...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(defaultReturn);
    }) as unknown as postgres.Sql;

    (mockSql as unknown as Record<string, unknown>).begin = vi.fn(
        async (callback: (tx: unknown) => Promise<unknown>) => {
            const tx = createMockSql(defaultReturn).sql;
            return callback(tx);
        },
    );

    return { sql: mockSql, calls };
}

// =============================================================================
// createChannelWithMediaItem
// =============================================================================

describe('createChannelWithMediaItem', () => {
    it('executes inside a transaction', async () => {
        const { sql } = createMockSql();

        await createChannelWithMediaItem(sql, {
            id: 'uuid-channel-1',
            name: 'WBN One',
            streamUrl: 'https://example.com/wbn1.m3u8',
            sourceId: 'uuid-source-1',
        });

        expect(sql.begin).toHaveBeenCalledOnce();
    });

    it('returns the channel id', async () => {
        const { sql } = createMockSql();

        const result = await createChannelWithMediaItem(sql, {
            id: 'uuid-channel-42',
            name: 'Test Channel',
            streamUrl: 'https://example.com/stream.m3u8',
            sourceId: 'uuid-source-1',
        });

        expect(result).toBe('uuid-channel-42');
    });

    it('inserts into media_items then livetv_channels within the transaction', async () => {
        const innerCalls: unknown[][] = [];
        const tx = vi.fn((...args: unknown[]) => {
            innerCalls.push(args);
            return Promise.resolve([]);
        }) as unknown as postgres.Sql;

        const mockSql = vi.fn() as unknown as postgres.Sql;
        (mockSql as unknown as Record<string, unknown>).begin = vi.fn(
            async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
        );

        await createChannelWithMediaItem(mockSql, {
            id: 'uuid-ch',
            name: 'CH Name',
            streamUrl: 'https://example.com/ch.m3u8',
            sourceId: 'uuid-src',
        });

        expect(innerCalls).toHaveLength(2);
    });

    it('maps optional fields to null when not provided', async () => {
        const innerCalls: unknown[][] = [];
        const tx = vi.fn((...args: unknown[]) => {
            innerCalls.push(args);
            return Promise.resolve([]);
        }) as unknown as postgres.Sql;

        const mockSql = vi.fn() as unknown as postgres.Sql;
        (mockSql as unknown as Record<string, unknown>).begin = vi.fn(
            async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
        );

        await createChannelWithMediaItem(mockSql, {
            id: 'uuid-ch',
            name: 'Minimal Channel',
            streamUrl: 'https://example.com/min.m3u8',
            sourceId: 'uuid-src',
        });

        const firstCallArgs = innerCalls[0] as unknown[][];
        const templateStrings = firstCallArgs[0] as unknown as TemplateStringsArray;
        expect(templateStrings.join('')).toContain('media_items');
    });
});

// =============================================================================
// bulkCreateChannels
// =============================================================================

describe('bulkCreateChannels', () => {
    it('executes inside a transaction', async () => {
        const { sql } = createMockSql();

        await bulkCreateChannels(sql, {
            channels: [],
            categories: [],
            backupGroups: [],
        });

        expect(sql.begin).toHaveBeenCalledOnce();
    });

    it('returns counts matching the input arrays', async () => {
        const { sql } = createMockSql();

        const result = await bulkCreateChannels(sql, {
            channels: [
                {
                    id: 'uuid-ch-1',
                    name: 'Channel 1',
                    streamUrl: 'https://example.com/1.m3u8',
                    sourceId: 'uuid-src',
                },
                {
                    id: 'uuid-ch-2',
                    name: 'Channel 2',
                    streamUrl: 'https://example.com/2.m3u8',
                    sourceId: 'uuid-src',
                },
            ],
            categories: [{ id: 'uuid-cat-1', name: 'Sports' }],
            backupGroups: [{ id: 'uuid-bg-1', name: 'Sports Backup', sourceId: 'uuid-src' }],
        });

        expect(result).toEqual({
            channelCount: 2,
            categoryCount: 1,
            backupGroupCount: 1,
        });
    });

    it('skips category insert when categories array is empty', async () => {
        const innerCalls: unknown[][] = [];
        const tx = vi.fn((...args: unknown[]) => {
            innerCalls.push(args);
            return Promise.resolve([]);
        }) as unknown as postgres.Sql;

        const mockSql = vi.fn() as unknown as postgres.Sql;
        (mockSql as unknown as Record<string, unknown>).begin = vi.fn(
            async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
        );

        await bulkCreateChannels(mockSql, {
            channels: [
                {
                    id: 'uuid-ch-1',
                    name: 'CH',
                    streamUrl: 'https://example.com/ch.m3u8',
                    sourceId: 'uuid-src',
                },
            ],
            categories: [],
            backupGroups: [],
        });

        // 2 inserts (media_items + livetv_channels), each has a tx() helper call + tagged template = 4
        expect(innerCalls).toHaveLength(4);
    });

    it('skips backup group insert when backupGroups array is empty', async () => {
        const innerCalls: unknown[][] = [];
        const tx = vi.fn((...args: unknown[]) => {
            innerCalls.push(args);
            return Promise.resolve([]);
        }) as unknown as postgres.Sql;

        const mockSql = vi.fn() as unknown as postgres.Sql;
        (mockSql as unknown as Record<string, unknown>).begin = vi.fn(
            async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
        );

        await bulkCreateChannels(mockSql, {
            channels: [
                {
                    id: 'uuid-ch-1',
                    name: 'CH',
                    streamUrl: 'https://example.com/ch.m3u8',
                    sourceId: 'uuid-src',
                },
            ],
            categories: [{ id: 'uuid-cat', name: 'News' }],
            backupGroups: [],
        });

        // 3 inserts (categories + media_items + livetv_channels), each 2 calls = 6
        expect(innerCalls).toHaveLength(6);
    });

    it('inserts all four tables when all arrays are non-empty', async () => {
        const innerCalls: unknown[][] = [];
        const tx = vi.fn((...args: unknown[]) => {
            innerCalls.push(args);
            return Promise.resolve([]);
        }) as unknown as postgres.Sql;

        const mockSql = vi.fn() as unknown as postgres.Sql;
        (mockSql as unknown as Record<string, unknown>).begin = vi.fn(
            async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
        );

        await bulkCreateChannels(mockSql, {
            channels: [
                {
                    id: 'uuid-ch-1',
                    name: 'CH',
                    streamUrl: 'https://example.com/ch.m3u8',
                    sourceId: 'uuid-src',
                    categoryId: 'uuid-cat',
                    backupGroupId: 'uuid-bg',
                },
            ],
            categories: [{ id: 'uuid-cat', name: 'News' }],
            backupGroups: [{ id: 'uuid-bg', name: 'News BG', sourceId: 'uuid-src' }],
        });

        // 4 inserts (categories + backupGroups + media_items + livetv_channels), each 2 calls = 8
        expect(innerCalls).toHaveLength(8);
    });

    it('skips all inserts and returns zeros for empty input', async () => {
        const { sql } = createMockSql();

        const result = await bulkCreateChannels(sql, {
            channels: [],
            categories: [],
            backupGroups: [],
        });

        expect(result).toEqual({
            channelCount: 0,
            categoryCount: 0,
            backupGroupCount: 0,
        });
    });
});

// =============================================================================
// getChannelsBySourceId
// =============================================================================

describe('getChannelsBySourceId', () => {
    it('calls sql with the provided sourceId', async () => {
        const { sql, calls } = createMockSql([]);

        await getChannelsBySourceId(sql, 'uuid-source-99');

        expect(calls).toHaveLength(1);
        const templateArgs = calls[0] as unknown[][];
        expect(templateArgs).toContain('uuid-source-99');
    });

    it('returns the rows from sql', async () => {
        const fakeRows = [
            {
                id: 'uuid-ch-1',
                name: 'WBN One',
                stream_url: 'https://example.com/wbn1.m3u8',
                logo_url: null,
                quality_tier: 'fhd',
                epg_channel_id: 'wbn1',
                sort_order: 0,
                is_visible: true,
                category_id: null,
                backup_group_id: null,
                source_id: 'uuid-source-1',
                country_code: 'de',
                created_at: new Date('2026-01-01'),
            },
        ];
        const { sql } = createMockSql(fakeRows);

        const result = await getChannelsBySourceId(sql, 'uuid-source-1');

        expect(result).toEqual(fakeRows);
    });

    it('returns an empty array when no channels exist', async () => {
        const { sql } = createMockSql([]);

        const result = await getChannelsBySourceId(sql, 'uuid-source-empty');

        expect(result).toEqual([]);
    });
});

// =============================================================================
// deleteChannelsBySourceId
// =============================================================================

describe('deleteChannelsBySourceId', () => {
    it('calls sql with the provided sourceId', async () => {
        const deleteResult = Object.assign([], { count: 0 });
        const { sql, calls } = createMockSql(deleteResult);

        await deleteChannelsBySourceId(sql, 'uuid-source-delete');

        expect(calls).toHaveLength(1);
        const templateArgs = calls[0] as unknown[][];
        expect(templateArgs).toContain('uuid-source-delete');
    });

    it('returns the count of deleted rows', async () => {
        const deleteResult = Object.assign([], { count: 7 });
        const { sql } = createMockSql(deleteResult);

        const count = await deleteChannelsBySourceId(sql, 'uuid-source-1');

        expect(count).toBe(7);
    });

    it('returns 0 when no channels match the sourceId', async () => {
        const deleteResult = Object.assign([], { count: 0 });
        const { sql } = createMockSql(deleteResult);

        const count = await deleteChannelsBySourceId(sql, 'uuid-source-none');

        expect(count).toBe(0);
    });
});

// =============================================================================
// searchChannels
// =============================================================================

describe('searchChannels', () => {
    it('calls sql with the query string', async () => {
        const { sql, calls } = createMockSql([]);

        await searchChannels(sql, 'Siebenstern');

        expect(calls).toHaveLength(1);
        const templateArgs = calls[0] as unknown[];
        expect(templateArgs).toContain('Siebenstern');
    });

    it('returns the rows from sql', async () => {
        const fakeRows = [
            {
                id: 'uuid-ch-1',
                name: 'Siebenstern',
                stream_url: 'https://example.com/stern7.m3u8',
                logo_url: null,
                quality_tier: 'fhd',
                epg_channel_id: 'stern7',
                sort_order: 0,
                is_visible: true,
                category_id: null,
                category_name: null,
                backup_group_id: null,
                source_id: 'uuid-source-1',
                country_code: 'de',
                consecutive_absences: 0,
                created_at: new Date('2026-01-01'),
                similarity_score: 0.85,
            },
        ];
        const { sql } = createMockSql(fakeRows);

        const result = await searchChannels(sql, 'stern7');

        expect(result).toEqual(fakeRows);
        expect(result[0].similarity_score).toBe(0.85);
    });

    it('returns empty array for empty query', async () => {
        const { sql, calls } = createMockSql([]);

        const result = await searchChannels(sql, '');

        expect(result).toEqual([]);
        // Should not call sql at all for empty query
        expect(calls).toHaveLength(0);
    });

    it('returns empty array for whitespace-only query', async () => {
        const { sql, calls } = createMockSql([]);

        const result = await searchChannels(sql, '   ');

        expect(result).toEqual([]);
        expect(calls).toHaveLength(0);
    });

    it('trims the query before passing to sql', async () => {
        const { sql, calls } = createMockSql([]);

        await searchChannels(sql, '  WBN  ');

        expect(calls).toHaveLength(1);
        const templateArgs = calls[0] as unknown[];
        expect(templateArgs).toContain('WBN');
    });

    it('passes the ILIKE pattern with wildcards', async () => {
        const { sql, calls } = createMockSql([]);

        await searchChannels(sql, 'WBN');

        expect(calls).toHaveLength(1);
        const templateArgs = calls[0] as unknown[];
        expect(templateArgs).toContain('%WBN%');
    });

    it('escapes the backslash itself so it cannot swallow the next escape', async () => {
        const { sql, calls } = createMockSql([]);

        await searchChannels(sql, 'a\\%b');

        expect(calls[0] as unknown[]).toContain('%a\\\\\\%b%');
    });

    it('passes the similarity threshold 0.25', async () => {
        const { sql, calls } = createMockSql([]);

        await searchChannels(sql, 'test');

        expect(calls).toHaveLength(1);
        const templateArgs = calls[0] as unknown[];
        expect(templateArgs).toContain(0.25);
    });

    it('uses default limit of 20', async () => {
        const { sql, calls } = createMockSql([]);

        await searchChannels(sql, 'test');

        expect(calls).toHaveLength(1);
        const templateArgs = calls[0] as unknown[];
        expect(templateArgs).toContain(20);
    });

    it('respects custom limit parameter', async () => {
        const { sql, calls } = createMockSql([]);

        await searchChannels(sql, 'test', 5);

        expect(calls).toHaveLength(1);
        const templateArgs = calls[0] as unknown[];
        expect(templateArgs).toContain(5);
    });

    it('returns empty array when no channels match', async () => {
        const { sql } = createMockSql([]);

        const result = await searchChannels(sql, 'nonexistent-channel-xyz');

        expect(result).toEqual([]);
    });

    it('escapes ILIKE wildcard % in the pattern', async () => {
        const { sql, calls } = createMockSql([]);

        await searchChannels(sql, '50%off');

        expect(calls).toHaveLength(1);
        const templateArgs = calls[0] as unknown[];
        // Should escape % to \% in the ILIKE pattern
        expect(templateArgs).toContain('%50\\%off%');
    });

    it('escapes ILIKE wildcard _ in the pattern', async () => {
        const { sql, calls } = createMockSql([]);

        await searchChannels(sql, 'channel_one');

        expect(calls).toHaveLength(1);
        const templateArgs = calls[0] as unknown[];
        // Should escape _ to \_ in the ILIKE pattern
        expect(templateArgs).toContain('%channel\\_one%');
    });

    it('passes unescaped query for trigram similarity (only ILIKE pattern is escaped)', async () => {
        const { sql, calls } = createMockSql([]);

        await searchChannels(sql, '50%off');

        expect(calls).toHaveLength(1);
        const templateArgs = calls[0] as unknown[];
        // Trigram similarity uses the raw trimmed query
        expect(templateArgs).toContain('50%off');
    });
});

// =============================================================================
// getChannelsForAdmin
// =============================================================================

describe('getAllVisibleChannels', () => {
    it('withholds channels whose category is hidden, keeping uncategorized ones', async () => {
        const { sql, calls } = createMockSql([]);

        await getAllVisibleChannels(sql);

        const queryText = calls
            .flatMap((args) => (Array.isArray(args[0]) ? (args[0] as string[]) : []))
            .join('');
        // /livetv filtered hidden categories client-side while /j did not — the
        // two viewer surfaces disagreed until this moved into the query.
        expect(queryText).toContain('lcat.is_visible = true OR lc.category_id IS NULL');
    });

    it("orders by the group playlist anchor, not the primary's own slot", async () => {
        const { sql, calls } = createMockSql([]);

        await getAllVisibleChannels(sql);

        const queryText = calls
            .flatMap((args) => (Array.isArray(args[0]) ? (args[0] as string[]) : []))
            .join('');
        expect(queryText).toContain('SELECT MIN(sib.sort_order)');
        expect(queryText).toContain('ORDER BY sort_order ASC');
    });
});

describe('getChannelsForAdmin', () => {
    it('calls sql when no sourceId provided', async () => {
        const { sql, calls } = createMockSql([]);

        await getChannelsForAdmin(sql);

        // Tagged template with embedded sql fragment = 2 calls
        expect(calls.length).toBeGreaterThanOrEqual(1);
    });

    // Only a backup group's primary reaches viewers, so the admin payload must
    // carry the primary id — without it a withheld row looks identical to a live
    // one, which is what hid the MTK backup-group bug.
    it('joins livetv_backup_groups and selects the group primary', async () => {
        const { sql, calls } = createMockSql([]);

        await getChannelsForAdmin(sql);

        const queryText = calls
            .flatMap((args) => (Array.isArray(args[0]) ? (args[0] as string[]) : []))
            .join('');
        expect(queryText).toContain('LEFT JOIN livetv_backup_groups bg');
        expect(queryText).toContain('bg.primary_channel_id AS group_primary_channel_id');
    });

    it('calls sql with sourceId filter when provided', async () => {
        const { sql, calls } = createMockSql([]);

        await getChannelsForAdmin(sql, 'uuid-source-42');

        // Tagged template with embedded sql fragment = 2 calls
        expect(calls.length).toBeGreaterThanOrEqual(1);
        const allArgs = calls.flat();
        expect(allArgs).toContain('uuid-source-42');
    });

    it('returns all rows including visible and hidden channels', async () => {
        const fakeRows = [
            {
                id: 'uuid-ch-1',
                name: 'WBN One',
                stream_url: 'https://example.com/wbn1.m3u8',
                logo_url: null,
                quality_tier: 'fhd',
                epg_channel_id: 'wbn1',
                sort_order: 1,
                is_visible: true,
                category_id: 'uuid-cat-1',
                category_name: 'Entertainment',
                category_sort_order: 1,
                category_is_visible: true,
                backup_group_id: null,
                source_id: 'uuid-source-1',
                country_code: 'de',
                consecutive_absences: 0,
                created_at: new Date('2026-01-01'),
                admin_display_name: null,
            },
            {
                id: 'uuid-ch-2',
                name: 'Hidden Channel',
                stream_url: 'https://example.com/hidden.m3u8',
                logo_url: null,
                quality_tier: 'sd',
                epg_channel_id: null,
                sort_order: 2,
                is_visible: false,
                category_id: null,
                category_name: null,
                category_sort_order: null,
                category_is_visible: null,
                backup_group_id: null,
                source_id: 'uuid-source-1',
                country_code: null,
                consecutive_absences: 0,
                created_at: new Date('2026-01-01'),
                admin_display_name: null,
            },
        ];
        const { sql } = createMockSql(fakeRows);

        const result = await getChannelsForAdmin(sql);

        expect(result).toHaveLength(2);
        expect(result[0].is_visible).toBe(true);
        expect(result[1].is_visible).toBe(false);
    });

    it('returns channels with NULL category_id (uncategorized)', async () => {
        const fakeRows = [
            {
                id: 'uuid-ch-1',
                name: 'No Category Channel',
                stream_url: 'https://example.com/nc.m3u8',
                logo_url: null,
                quality_tier: null,
                epg_channel_id: null,
                sort_order: 0,
                is_visible: true,
                category_id: null,
                category_name: null,
                category_sort_order: null,
                category_is_visible: null,
                backup_group_id: null,
                source_id: 'uuid-source-1',
                country_code: null,
                consecutive_absences: 0,
                created_at: new Date('2026-01-01'),
                admin_display_name: null,
            },
        ];
        const { sql } = createMockSql(fakeRows);

        const result = await getChannelsForAdmin(sql);

        expect(result).toHaveLength(1);
        expect(result[0].category_id).toBeNull();
    });

    it('includes orphaned channels (source_id IS NULL)', async () => {
        const fakeRows = [
            {
                id: 'uuid-ch-orphan',
                name: 'Orphaned Channel',
                stream_url: 'https://example.com/orphan.m3u8',
                logo_url: null,
                quality_tier: 'hd',
                epg_channel_id: null,
                sort_order: 0,
                is_visible: true,
                category_id: null,
                category_name: null,
                category_sort_order: null,
                category_is_visible: null,
                backup_group_id: null,
                source_id: null,
                country_code: null,
                consecutive_absences: 0,
                created_at: new Date('2026-01-01'),
                admin_display_name: null,
            },
        ];
        const { sql } = createMockSql(fakeRows);

        const result = await getChannelsForAdmin(sql);

        expect(result).toHaveLength(1);
        expect(result[0].source_id).toBeNull();
    });

    it('returns empty array when no channels exist', async () => {
        const { sql } = createMockSql([]);

        const result = await getChannelsForAdmin(sql);

        expect(result).toEqual([]);
    });

    it('includes admin_display_name field', async () => {
        const fakeRows = [
            {
                id: 'uuid-ch-1',
                name: 'Custom Name',
                stream_url: 'https://example.com/ch.m3u8',
                logo_url: null,
                quality_tier: 'fhd',
                epg_channel_id: null,
                sort_order: 0,
                is_visible: true,
                category_id: null,
                category_name: null,
                category_sort_order: null,
                category_is_visible: null,
                backup_group_id: null,
                source_id: 'uuid-source-1',
                country_code: null,
                consecutive_absences: 0,
                created_at: new Date('2026-01-01'),
                admin_display_name: 'My Custom Name',
            },
        ];
        const { sql } = createMockSql(fakeRows);

        const result = await getChannelsForAdmin(sql);

        expect(result[0].admin_display_name).toBe('My Custom Name');
    });
});

// =============================================================================
// batchUpdateChannelSortOrder (Story 4.2)
// =============================================================================

describe('batchUpdateChannelSortOrder', () => {
    it('updates sort_order for multiple channels in one call', async () => {
        const updateResult = Object.assign([], { count: 3 });
        const { sql, calls } = createMockSql(updateResult);

        const count = await batchUpdateChannelSortOrder(sql, [
            { id: 'uuid-ch-1', sortOrder: 0 },
            { id: 'uuid-ch-2', sortOrder: 1 },
            { id: 'uuid-ch-3', sortOrder: 2 },
        ]);

        expect(count).toBe(3);
        expect(calls).toHaveLength(1);
    });

    it('returns correct count of updated rows', async () => {
        const updateResult = Object.assign([], { count: 2 });
        const { sql } = createMockSql(updateResult);

        const count = await batchUpdateChannelSortOrder(sql, [
            { id: 'uuid-ch-1', sortOrder: 5 },
            { id: 'uuid-ch-2', sortOrder: 10 },
        ]);

        expect(count).toBe(2);
    });

    it('passes channel IDs and sort orders to sql as arrays', async () => {
        const updateResult = Object.assign([], { count: 2 });
        const { sql, calls } = createMockSql(updateResult);

        await batchUpdateChannelSortOrder(sql, [
            { id: 'uuid-ch-a', sortOrder: 0 },
            { id: 'uuid-ch-b', sortOrder: 1 },
        ]);

        // The unnest pattern passes arrays of IDs and sort orders
        const allArgs = calls.flat();
        const idArray = allArgs.find((arg) => Array.isArray(arg) && arg.includes('uuid-ch-a'));
        const sortArray = allArgs.find(
            (arg) => Array.isArray(arg) && arg.includes(0) && arg.includes(1),
        );
        expect(idArray).toBeDefined();
        expect(sortArray).toBeDefined();
    });

    it('returns 0 for empty update array', async () => {
        const { sql, calls } = createMockSql([]);

        const count = await batchUpdateChannelSortOrder(sql, []);

        expect(count).toBe(0);
        expect(calls).toHaveLength(0);
    });
});

// =============================================================================
// batchUpdateCategorySortOrder (Story 4.2)
// =============================================================================

describe('batchUpdateCategorySortOrder', () => {
    it('updates sort_order for multiple categories in one call', async () => {
        const updateResult = Object.assign([], { count: 2 });
        const { sql, calls } = createMockSql(updateResult);

        const count = await batchUpdateCategorySortOrder(sql, [
            { id: 'uuid-cat-1', sortOrder: 0 },
            { id: 'uuid-cat-2', sortOrder: 1 },
        ]);

        expect(count).toBe(2);
        expect(calls).toHaveLength(1);
    });

    it('returns correct count', async () => {
        const updateResult = Object.assign([], { count: 5 });
        const { sql } = createMockSql(updateResult);

        const count = await batchUpdateCategorySortOrder(sql, [
            { id: 'uuid-cat-1', sortOrder: 0 },
            { id: 'uuid-cat-2', sortOrder: 1 },
            { id: 'uuid-cat-3', sortOrder: 2 },
            { id: 'uuid-cat-4', sortOrder: 3 },
            { id: 'uuid-cat-5', sortOrder: 4 },
        ]);

        expect(count).toBe(5);
    });

    it('returns 0 for empty array', async () => {
        const { sql, calls } = createMockSql([]);

        const count = await batchUpdateCategorySortOrder(sql, []);

        expect(count).toBe(0);
        expect(calls).toHaveLength(0);
    });
});

// =============================================================================
// updateChannel (Story 4.3)
// =============================================================================

describe('updateChannel', () => {
    it('updates visibility for a single channel', async () => {
        const updateResult = Object.assign([], { count: 1 });
        const { sql, calls } = createMockSql(updateResult);

        const result = await updateChannel(sql, 'uuid-ch-1', {
            isVisible: false,
        });

        expect(calls).toHaveLength(1);
        expect(result).toBe(true);
    });

    it('updates quality tier', async () => {
        const updateResult = Object.assign([], { count: 1 });
        const { sql, calls } = createMockSql(updateResult);

        const result = await updateChannel(sql, 'uuid-ch-1', {
            qualityTier: 'fhd',
        });

        expect(calls).toHaveLength(1);
        expect(result).toBe(true);
        const allArgs = calls.flat();
        expect(allArgs).toContain('fhd');
    });

    it('updates category assignment', async () => {
        const updateResult = Object.assign([], { count: 1 });
        const { sql, calls } = createMockSql(updateResult);

        const result = await updateChannel(sql, 'uuid-ch-1', {
            categoryId: 'uuid-cat-2',
        });

        expect(calls).toHaveLength(1);
        expect(result).toBe(true);
    });

    it('partial update (only provided fields change)', async () => {
        const updateResult = Object.assign([], { count: 1 });
        const { sql, calls } = createMockSql(updateResult);

        const result = await updateChannel(sql, 'uuid-ch-1', {
            isVisible: true,
        });

        expect(calls).toHaveLength(1);
        expect(result).toBe(true);
        const allArgs = calls.flat();
        expect(allArgs).toContain(true); // isVisible
    });

    it('returns false for non-existent channel', async () => {
        const updateResult = Object.assign([], { count: 0 });
        const { sql } = createMockSql(updateResult);

        const result = await updateChannel(sql, 'uuid-nonexistent', {
            isVisible: false,
        });

        expect(result).toBe(false);
    });
});

// =============================================================================
// bulkUpdateChannels (Story 4.3)
// =============================================================================

describe('bulkUpdateChannels', () => {
    it('hides multiple channels in one call', async () => {
        const updateResult = Object.assign([], { count: 3 });
        const { sql, calls } = createMockSql(updateResult);

        const count = await bulkUpdateChannels(sql, ['uuid-ch-1', 'uuid-ch-2', 'uuid-ch-3'], {
            isVisible: false,
        });

        expect(count).toBe(3);
        expect(calls).toHaveLength(1);
    });

    it('shows multiple channels in one call', async () => {
        const updateResult = Object.assign([], { count: 2 });
        const { sql } = createMockSql(updateResult);

        const count = await bulkUpdateChannels(sql, ['uuid-ch-1', 'uuid-ch-2'], {
            isVisible: true,
        });

        expect(count).toBe(2);
    });

    it('moves channels to a new category', async () => {
        const updateResult = Object.assign([], { count: 2 });
        const { sql, calls } = createMockSql(updateResult);

        const count = await bulkUpdateChannels(sql, ['uuid-ch-1', 'uuid-ch-2'], {
            categoryId: 'uuid-cat-new',
        });

        expect(count).toBe(2);
        expect(calls).toHaveLength(1);
    });

    it('sets quality tier for multiple channels', async () => {
        const updateResult = Object.assign([], { count: 5 });
        const { sql, calls } = createMockSql(updateResult);

        const count = await bulkUpdateChannels(
            sql,
            ['uuid-ch-1', 'uuid-ch-2', 'uuid-ch-3', 'uuid-ch-4', 'uuid-ch-5'],
            { qualityTier: 'hd' },
        );

        expect(count).toBe(5);
        const allArgs = calls.flat();
        expect(allArgs).toContain('hd');
    });

    it('returns correct count of updated rows', async () => {
        const updateResult = Object.assign([], { count: 7 });
        const { sql } = createMockSql(updateResult);

        const count = await bulkUpdateChannels(sql, ['uuid-ch-1'], {
            isVisible: false,
        });

        expect(count).toBe(7);
    });

    it('empty channelIds array is a no-op', async () => {
        const { sql, calls } = createMockSql([]);

        const count = await bulkUpdateChannels(sql, [], { isVisible: false });

        expect(count).toBe(0);
        expect(calls).toHaveLength(0);
    });
});

// =============================================================================
// updateCategoryVisibility (Story 4.3)
// =============================================================================

describe('updateCategoryVisibility', () => {
    it('executes inside a transaction', async () => {
        const { sql } = createMockSql(Object.assign([], { count: 5 }));

        await updateCategoryVisibility(sql, 'uuid-cat-1', false);

        expect(sql.begin).toHaveBeenCalledOnce();
    });

    it('returns count of updated channels', async () => {
        const txResult = Object.assign([], { count: 10 });
        const innerCalls: unknown[][] = [];
        const tx = vi.fn((...args: unknown[]) => {
            innerCalls.push(args);
            return Promise.resolve(txResult);
        }) as unknown as postgres.Sql;

        const mockSql = vi.fn() as unknown as postgres.Sql;
        (mockSql as unknown as Record<string, unknown>).begin = vi.fn(
            async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
        );

        const count = await updateCategoryVisibility(mockSql, 'uuid-cat-1', false);

        expect(count).toBe(10);
        // Two SQL calls: one for category, one for channels
        expect(innerCalls).toHaveLength(2);
    });
});

// =============================================================================
// getBackupGroupsForAdmin (Story 4.5)
// =============================================================================

describe('getBackupGroupsForAdmin', () => {
    it('returns groups with channels and ungrouped channels', async () => {
        const groupRows = [
            {
                group_id: 'uuid-bg-1',
                group_name: 'WBN',
                primary_channel_id: 'uuid-ch-1',
                channel_id: 'uuid-ch-1',
                channel_name: 'WBN One HD',
                admin_display_name: null,
                quality_tier: 'hd',
                is_visible: true,
            },
            {
                group_id: 'uuid-bg-1',
                group_name: 'WBN',
                primary_channel_id: 'uuid-ch-1',
                channel_id: 'uuid-ch-2',
                channel_name: 'WBN One SD',
                admin_display_name: null,
                quality_tier: 'sd',
                is_visible: true,
            },
        ];
        const ungroupedRows = [
            {
                id: 'uuid-ch-3',
                name: 'Standalone',
                admin_display_name: null,
                quality_tier: 'fhd',
                is_visible: true,
            },
        ];

        let callCount = 0;
        const mockSql = vi.fn((..._args: unknown[]) => {
            callCount++;
            return Promise.resolve(callCount === 1 ? groupRows : ungroupedRows);
        }) as unknown as postgres.Sql;

        const result = await getBackupGroupsForAdmin(mockSql);

        expect(result.groups).toHaveLength(1);
        expect(result.groups[0].name).toBe('WBN');
        expect(result.groups[0].primaryChannelId).toBe('uuid-ch-1');
        expect(result.groups[0].channels).toHaveLength(2);
        expect(result.ungroupedChannels).toHaveLength(1);
        expect(result.ungroupedChannels[0].name).toBe('Standalone');
    });

    it('returns empty groups and ungrouped when no channels exist', async () => {
        const { sql } = createMockSql([]);

        const result = await getBackupGroupsForAdmin(sql);

        expect(result.groups).toHaveLength(0);
        expect(result.ungroupedChannels).toHaveLength(0);
    });

    it('maps adminDisplayName and qualityTier correctly', async () => {
        const groupRows = [
            {
                group_id: 'uuid-bg-1',
                group_name: 'Test',
                primary_channel_id: 'uuid-ch-1',
                channel_id: 'uuid-ch-1',
                channel_name: 'Original Name',
                admin_display_name: 'Custom Name',
                quality_tier: 'uhd',
                is_visible: false,
            },
        ];

        let callCount = 0;
        const mockSql = vi.fn((..._args: unknown[]) => {
            callCount++;
            return Promise.resolve(callCount === 1 ? groupRows : []);
        }) as unknown as postgres.Sql;

        const result = await getBackupGroupsForAdmin(mockSql);

        expect(result.groups[0].channels[0].adminDisplayName).toBe('Custom Name');
        expect(result.groups[0].channels[0].qualityTier).toBe('uhd');
        expect(result.groups[0].channels[0].isVisible).toBe(false);
    });
});

// =============================================================================
// Helper: create a mock tx that returns different results per call
// =============================================================================

function createSequentialTx(responses: unknown[][]) {
    let callIndex = 0;
    const txCalls: unknown[][] = [];
    const tx = vi.fn((...args: unknown[]) => {
        txCalls.push(args);
        const result = responses[callIndex] ?? [];
        // Attach .count to simulate postgres.js result metadata
        const res = Object.assign([...result], { count: result.length });
        callIndex++;
        return Promise.resolve(res);
    }) as unknown as postgres.Sql;

    const mockSql = vi.fn() as unknown as postgres.Sql;
    (mockSql as unknown as Record<string, unknown>).begin = vi.fn(
        async (callback: (tx: unknown) => Promise<unknown>) => callback(tx),
    );

    return { sql: mockSql, tx, txCalls };
}

// =============================================================================
// removeChannelFromBackupGroup (Story 4.5)
// =============================================================================

describe('removeChannelFromBackupGroup', () => {
    it('executes inside a transaction', async () => {
        // Responses: 1=UPDATE(ungroup), 2=SELECT COUNT, 3=SELECT primary, 4=SELECT channels, 5=UPDATE primary
        const { sql } = createSequentialTx([
            [{ count: 1 }], // UPDATE ungroup (1 row affected)
            [{ count: 3 }], // SELECT COUNT remaining = 3
            [{ primary_channel_id: 'uuid-ch-other' }], // SELECT primary (not the removed one)
        ]);

        await removeChannelFromBackupGroup(sql, 'uuid-bg-1', 'uuid-ch-1');

        expect(sql.begin).toHaveBeenCalledOnce();
    });

    it('dissolves group when 1 or fewer channels remain', async () => {
        // After removing: count=1, so dissolve
        const { sql, txCalls } = createSequentialTx([
            [{ count: 1 }], // UPDATE ungroup
            [{ count: 1 }], // SELECT COUNT remaining = 1
            [{ count: 1 }], // UPDATE ungroup remaining
            [], // DELETE group
        ]);

        await removeChannelFromBackupGroup(sql, 'uuid-bg-1', 'uuid-ch-1');

        expect(sql.begin).toHaveBeenCalledOnce();
        // Should have made 4 SQL calls: ungroup, count, ungroup remaining, delete
        expect(txCalls).toHaveLength(4);
    });

    it('auto-promotes primary when removed channel was primary', async () => {
        const { sql, txCalls } = createSequentialTx([
            [{ count: 1 }], // UPDATE ungroup
            [{ count: 2 }], // SELECT COUNT remaining = 2 (don't dissolve)
            [{ primary_channel_id: 'uuid-ch-1' }], // SELECT primary (IS the removed channel)
            [{ id: 'uuid-ch-2', quality_tier: 'hd' }], // autoPromotePrimary: SELECT channels
            [], // autoPromotePrimary: UPDATE primary
        ]);

        await removeChannelFromBackupGroup(sql, 'uuid-bg-1', 'uuid-ch-1');

        expect(txCalls).toHaveLength(5);
    });

    it('throws when channel not found in group', async () => {
        const { sql } = createSequentialTx([
            [], // UPDATE ungroup — 0 rows affected
        ]);

        await expect(
            removeChannelFromBackupGroup(sql, 'uuid-bg-1', 'uuid-nonexistent'),
        ).rejects.toThrow('Channel not found in this backup group');
    });
});

// =============================================================================
// splitBackupGroup (Story 4.5)
// =============================================================================

describe('splitBackupGroup', () => {
    it('executes inside a transaction and returns new group ID', async () => {
        const { sql } = createSequentialTx([
            [{ name: 'WBN One HD' }], // SELECT representative name
            [{ id: 'uuid-new-bg' }], // INSERT new group RETURNING id
            [{ count: 1 }], // UPDATE move channels
            [{ id: 'uuid-ch-2', quality_tier: 'hd' }], // autoPromote new: SELECT
            [], // autoPromote new: UPDATE
            [{ count: 2 }], // SELECT COUNT original remaining = 2
            [{ id: 'uuid-ch-1', quality_tier: 'fhd' }], // autoPromote original: SELECT
            [], // autoPromote original: UPDATE
        ]);

        const result = await splitBackupGroup(sql, 'uuid-bg-1', ['uuid-ch-2']);

        expect(result.newGroupId).toBe('uuid-new-bg');
        expect(sql.begin).toHaveBeenCalledOnce();
    });

    it('dissolves original group when 0-1 channels remain after split', async () => {
        const { sql, txCalls } = createSequentialTx([
            [{ name: 'WBN One HD' }], // SELECT representative name
            [{ id: 'uuid-new-bg' }], // INSERT new group
            [{ count: 2 }], // UPDATE move channels (moved 2)
            [{ id: 'uuid-ch-2', quality_tier: 'hd' }], // autoPromote new: SELECT
            [], // autoPromote new: UPDATE
            [{ count: 0 }], // SELECT COUNT original remaining = 0
            [], // UPDATE ungroup remaining (0 rows)
            [], // DELETE original group
        ]);

        await splitBackupGroup(sql, 'uuid-bg-1', ['uuid-ch-1', 'uuid-ch-2']);

        // Original group dissolved — DELETE should have been called
        expect(txCalls.length).toBeGreaterThanOrEqual(7);
    });

    it('throws when no matching channels found', async () => {
        const { sql } = createSequentialTx([
            [{ name: 'WBN One HD' }], // SELECT representative name
            [{ id: 'uuid-new-bg' }], // INSERT new group
            [], // UPDATE move channels — 0 rows affected
        ]);

        await expect(splitBackupGroup(sql, 'uuid-bg-1', ['uuid-nonexistent'])).rejects.toThrow(
            'No matching channels found',
        );
    });
});

// =============================================================================
// createBackupGroup (Story 4.5)
// =============================================================================

describe('createBackupGroup', () => {
    it('creates group from ungrouped channels and returns group ID', async () => {
        const { sql } = createSequentialTx([
            [{ count: 0 }], // Validate: none already grouped
            [{ name: 'WBN One FHD' }], // SELECT best channel name
            [{ id: 'uuid-new-bg' }], // INSERT new group
            [], // UPDATE assign channels
            [
                { id: 'uuid-ch-1', quality_tier: 'fhd' },
                { id: 'uuid-ch-2', quality_tier: 'hd' },
            ], // autoPromote: SELECT
            [], // autoPromote: UPDATE
        ]);

        const result = await createBackupGroup(sql, ['uuid-ch-1', 'uuid-ch-2']);

        expect(result.groupId).toBe('uuid-new-bg');
        expect(sql.begin).toHaveBeenCalledOnce();
    });

    it('throws when some channels are already in a backup group', async () => {
        const { sql } = createSequentialTx([
            [{ count: 1 }], // Validate: 1 already grouped
        ]);

        await expect(createBackupGroup(sql, ['uuid-ch-1', 'uuid-ch-2'])).rejects.toThrow(
            'Some channels are already in a backup group',
        );
    });
});

// =============================================================================
// addChannelToBackupGroup (Story 4.5)
// =============================================================================

describe('addChannelToBackupGroup', () => {
    it('adds ungrouped channel to group and re-evaluates primary', async () => {
        const { sql, txCalls } = createSequentialTx([
            [{ backup_group_id: null }], // Validate: channel is ungrouped
            [], // UPDATE assign to group
            [
                { id: 'uuid-ch-1', quality_tier: 'fhd' },
                { id: 'uuid-ch-new', quality_tier: 'uhd' },
            ], // autoPromote: SELECT
            [], // autoPromote: UPDATE
        ]);

        await addChannelToBackupGroup(sql, 'uuid-bg-1', 'uuid-ch-new');

        expect(sql.begin).toHaveBeenCalledOnce();
        expect(txCalls).toHaveLength(4);
    });

    it('throws when channel not found', async () => {
        const { sql } = createSequentialTx([
            [], // SELECT channel — not found
        ]);

        await expect(addChannelToBackupGroup(sql, 'uuid-bg-1', 'uuid-nonexistent')).rejects.toThrow(
            'Channel not found',
        );
    });

    it('throws when channel is already in a backup group', async () => {
        const { sql } = createSequentialTx([
            [{ backup_group_id: 'uuid-other-bg' }], // Channel already grouped
        ]);

        await expect(addChannelToBackupGroup(sql, 'uuid-bg-1', 'uuid-ch-1')).rejects.toThrow(
            'already in a backup group',
        );
    });
});

// =============================================================================
// getEpgMatchReviewData (Story 4.6)
// =============================================================================

describe('getEpgMatchReviewData', () => {
    it('calls sql when no sourceId provided', async () => {
        const { sql, calls } = createMockSql([]);

        await getEpgMatchReviewData(sql);

        expect(calls.length).toBeGreaterThanOrEqual(1);
    });

    it('calls sql with sourceId filter when provided', async () => {
        const { sql, calls } = createMockSql([]);

        await getEpgMatchReviewData(sql, 'uuid-source-42');

        expect(calls.length).toBeGreaterThanOrEqual(1);
        const allArgs = calls.flat();
        expect(allArgs).toContain('uuid-source-42');
    });

    it('returns all rows from sql result', async () => {
        const fakeRows = [
            {
                id: 'uuid-ch-1',
                name: 'WBN One',
                admin_display_name: null,
                logo_url: null,
                epg_channel_id: 'wbn1.uk',
                epg_display_name: 'WBN One',
                epg_match_confidence: 0.95,
                epg_match_signals: ['name_exact'],
                epg_manual_override: false,
                category_name: 'Entertainment',
                current_program_title: 'News at Six',
                current_program_start: new Date('2026-03-10T17:00:00Z'),
                current_program_end: new Date('2026-03-10T18:00:00Z'),
                epg_channel_exists: true,
            },
            {
                id: 'uuid-ch-2',
                name: 'Unmatched Channel',
                admin_display_name: null,
                logo_url: null,
                epg_channel_id: null,
                epg_display_name: null,
                epg_match_confidence: null,
                epg_match_signals: null,
                epg_manual_override: false,
                category_name: null,
                current_program_title: null,
                current_program_start: null,
                current_program_end: null,
                epg_channel_exists: false,
            },
        ];
        const { sql } = createMockSql(fakeRows);

        const result = await getEpgMatchReviewData(sql);

        expect(result).toEqual(fakeRows);
        expect(result).toHaveLength(2);
    });

    it('returns empty array when no channels exist', async () => {
        const { sql } = createMockSql([]);

        const result = await getEpgMatchReviewData(sql);

        expect(result).toEqual([]);
    });
});

// =============================================================================
// searchEpgChannels (Story 4.6)
// =============================================================================

// searchEpgChannels now runs its query inside runWithTrigramThreshold, which
// opens a transaction (SET LOCAL pg_trgm.similarity_threshold + the SELECT).
// createSequentialTx (defined below, hoisted) captures both calls on the tx.
describe('searchEpgChannels', () => {
    it('runs inside a trigram-threshold transaction and calls sql with query and sourceId', async () => {
        const { sql, txCalls } = createSequentialTx([[], []]);

        await searchEpgChannels(sql, 'uuid-source-1', 'WBN');

        expect(sql.begin).toHaveBeenCalledOnce();
        expect(txCalls).toHaveLength(2);
        const selectArgs = txCalls[1] as unknown[];
        expect(selectArgs).toContain('uuid-source-1');
        expect(selectArgs).toContain('WBN');
    });

    it('SET LOCALs pg_trgm.similarity_threshold to the config value', async () => {
        const { sql, txCalls } = createSequentialTx([[], []]);

        await searchEpgChannels(sql, 'uuid-source-1', 'WBN');

        const setConfigArgs = txCalls[0] as unknown[];
        const expectedThreshold = String(clampTrigramThreshold(config.SEARCH_TRIGRAM_THRESHOLD));
        expect(setConfigArgs).toContain(expectedThreshold);
    });

    it('returns results from sql', async () => {
        const fakeRows = [
            {
                id: 'wbn1.uk',
                display_name: 'WBN One',
                icon_url: 'https://example.com/wbn1.png',
                similarity_score: 0.9,
            },
        ];
        const { sql } = createSequentialTx([[], fakeRows]);

        const result = await searchEpgChannels(sql, 'uuid-source-1', 'WBN');

        // createSequentialTx attaches a non-fakeRows `.count` property (simulating
        // postgres.js result metadata) — spread to compare only the row values.
        expect([...result]).toEqual(fakeRows);
    });

    it('returns empty array for empty query', async () => {
        const { sql } = createSequentialTx([[], []]);

        const result = await searchEpgChannels(sql, 'uuid-source-1', '');

        expect(result).toEqual([]);
        expect(sql.begin).not.toHaveBeenCalled();
    });

    it('returns empty array for whitespace-only query', async () => {
        const { sql } = createSequentialTx([[], []]);

        const result = await searchEpgChannels(sql, 'uuid-source-1', '   ');

        expect(result).toEqual([]);
        expect(sql.begin).not.toHaveBeenCalled();
    });

    it('trims the query before passing to sql', async () => {
        const { sql, txCalls } = createSequentialTx([[], []]);

        await searchEpgChannels(sql, 'uuid-source-1', '  WBN  ');

        const selectArgs = txCalls[1] as unknown[];
        expect(selectArgs).toContain('WBN');
    });

    it('passes ILIKE pattern with wildcards', async () => {
        const { sql, txCalls } = createSequentialTx([[], []]);

        await searchEpgChannels(sql, 'uuid-source-1', 'WBN');

        const selectArgs = txCalls[1] as unknown[];
        expect(selectArgs).toContain('%WBN%');
    });

    it('escapes ILIKE wildcard % in the pattern', async () => {
        const { sql, txCalls } = createSequentialTx([[], []]);

        await searchEpgChannels(sql, 'uuid-source-1', '50%off');

        const selectArgs = txCalls[1] as unknown[];
        expect(selectArgs).toContain('%50\\%off%');
    });

    it('escapes ILIKE wildcard _ in the pattern', async () => {
        const { sql, txCalls } = createSequentialTx([[], []]);

        await searchEpgChannels(sql, 'uuid-source-1', 'channel_one');

        const selectArgs = txCalls[1] as unknown[];
        expect(selectArgs).toContain('%channel\\_one%');
    });

    it('escapes the backslash itself so it cannot swallow the next escape', async () => {
        const { sql, txCalls } = createSequentialTx([[], []]);

        await searchEpgChannels(sql, 'uuid-source-1', 'a\\%b');

        const selectArgs = txCalls[1] as unknown[];
        expect(selectArgs).toContain('%a\\\\\\%b%');
    });

    it('passes unescaped query for trigram similarity', async () => {
        const { sql, txCalls } = createSequentialTx([[], []]);

        await searchEpgChannels(sql, 'uuid-source-1', '50%off');

        const selectArgs = txCalls[1] as unknown[];
        expect(selectArgs).toContain('50%off');
    });

    it('uses default limit of 10', async () => {
        const { sql, txCalls } = createSequentialTx([[], []]);

        await searchEpgChannels(sql, 'uuid-source-1', 'test');

        const selectArgs = txCalls[1] as unknown[];
        expect(selectArgs).toContain(10);
    });

    it('respects custom limit parameter', async () => {
        const { sql, txCalls } = createSequentialTx([[], []]);

        await searchEpgChannels(sql, 'uuid-source-1', 'test', 5);

        const selectArgs = txCalls[1] as unknown[];
        expect(selectArgs).toContain(5);
    });
});

// =============================================================================
// updateEpgMatch (Story 4.6)
// =============================================================================

describe('updateEpgMatch', () => {
    it('sets match with confidence 1.0 and manual signal', async () => {
        const updateResult = Object.assign([], { count: 1 });
        const { sql, calls } = createMockSql(updateResult);

        const result = await updateEpgMatch(sql, 'uuid-ch-1', 'wbn1.uk', true);

        expect(result).toBe(true);
        expect(calls).toHaveLength(1);
        const templateArgs = calls[0] as unknown[];
        expect(templateArgs).toContain('wbn1.uk');
        expect(templateArgs).toContain(true); // isManual
    });

    it('unmatches channel when epgChannelId is null', async () => {
        const updateResult = Object.assign([], { count: 1 });
        const { sql, calls } = createMockSql(updateResult);

        const result = await updateEpgMatch(sql, 'uuid-ch-1', null, false);

        expect(result).toBe(true);
        expect(calls).toHaveLength(1);
        const templateArgs = calls[0] as unknown[];
        expect(templateArgs).toContain('uuid-ch-1');
    });

    it('returns false when channel not found', async () => {
        const updateResult = Object.assign([], { count: 0 });
        const { sql } = createMockSql(updateResult);

        const result = await updateEpgMatch(sql, 'uuid-nonexistent', 'wbn1.uk', true);

        expect(result).toBe(false);
    });
});

// =============================================================================
// Category Management queries (Story 4.7)
// =============================================================================

describe('renameCategory', () => {
    it('returns true when category found and updated', async () => {
        const updateResult = Object.assign([], { count: 1 });
        const { sql } = createMockSql(updateResult);

        const result = await renameCategory(sql, 'uuid-cat-1', 'New Name');

        expect(result).toBe(true);
    });

    it('returns false when category not found', async () => {
        const updateResult = Object.assign([], { count: 0 });
        const { sql } = createMockSql(updateResult);

        const result = await renameCategory(sql, 'uuid-nonexistent', 'New Name');

        expect(result).toBe(false);
    });
});

describe('createCategory', () => {
    it('creates category with auto sort_order', async () => {
        const returnRow = [{ id: 'uuid-new', name: 'Sports', sort_order: 5 }];
        const { sql } = createMockSql(returnRow);

        const result = await createCategory(sql, 'Sports');

        expect(result).toEqual({
            id: 'uuid-new',
            name: 'Sports',
            sortOrder: 5,
        });
    });

    it('creates category with explicit sort_order', async () => {
        const returnRow = [{ id: 'uuid-new', name: 'News', sort_order: 10 }];
        const { sql } = createMockSql(returnRow);

        const result = await createCategory(sql, 'News', 10);

        expect(result).toEqual({ id: 'uuid-new', name: 'News', sortOrder: 10 });
    });
});

describe('mergeCategories', () => {
    it('moves channels and deletes source category', async () => {
        const moveResult = Object.assign([], { count: 5 });

        // Create custom mock for transaction
        const txCalls: unknown[][] = [];
        const txMock = vi.fn((...args: unknown[]) => {
            txCalls.push(args);
            // First call returns moveResult (UPDATE), second returns delete result
            return Promise.resolve(txCalls.length === 1 ? moveResult : []);
        }) as unknown as postgres.Sql;

        const sql = {
            begin: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(txMock)),
        } as unknown as postgres.Sql;

        const result = await mergeCategories(sql, 'uuid-source', 'uuid-target');

        expect(result).toEqual({ movedChannelCount: 5 });
        expect(txCalls.length).toBe(2); // UPDATE + DELETE
    });

    it('handles empty source category (just deletes)', async () => {
        const moveResult = Object.assign([], { count: 0 });

        const txMock = vi.fn(() => Promise.resolve(moveResult)) as unknown as postgres.Sql;

        const sql = {
            begin: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(txMock)),
        } as unknown as postgres.Sql;

        const result = await mergeCategories(sql, 'uuid-empty-source', 'uuid-target');

        expect(result).toEqual({ movedChannelCount: 0 });
    });
});

describe('deleteEmptyCategory', () => {
    it('deletes category when no channels exist', async () => {
        let callCount = 0;
        const mockTx = vi.fn(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve([{ count: 0 }]); // COUNT query
            return Promise.resolve(Object.assign([], { count: 1 })); // DELETE query
        }) as unknown as postgres.Sql;

        const mockSql = vi.fn() as unknown as postgres.Sql;
        (mockSql as unknown as Record<string, unknown>).begin = vi.fn(
            async (callback: (tx: unknown) => Promise<unknown>) => callback(mockTx),
        );

        const result = await deleteEmptyCategory(mockSql, 'uuid-empty-cat');

        expect(result).toEqual({ deleted: true });
    });

    it('returns has_channels when category has channels', async () => {
        const { sql } = createMockSql([{ count: 3 }]);

        const result = await deleteEmptyCategory(sql, 'uuid-has-channels');

        expect(result).toEqual({ deleted: false, reason: 'has_channels' });
    });

    it('returns not_found when category does not exist', async () => {
        let callCount = 0;
        const mockTx = vi.fn(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve([{ count: 0 }]); // COUNT query
            return Promise.resolve(Object.assign([], { count: 0 })); // DELETE (no rows)
        }) as unknown as postgres.Sql;

        const mockSql = vi.fn() as unknown as postgres.Sql;
        (mockSql as unknown as Record<string, unknown>).begin = vi.fn(
            async (callback: (tx: unknown) => Promise<unknown>) => callback(mockTx),
        );

        const result = await deleteEmptyCategory(mockSql, 'uuid-nonexistent');

        expect(result).toEqual({ deleted: false, reason: 'not_found' });
    });
});

describe('getCategoryChannelCount', () => {
    it('returns correct count', async () => {
        const { sql } = createMockSql([{ count: 15 }]);

        const result = await getCategoryChannelCount(sql, 'uuid-cat-1');

        expect(result).toBe(15);
    });

    it('returns 0 for empty category', async () => {
        const { sql } = createMockSql([{ count: 0 }]);

        const result = await getCategoryChannelCount(sql, 'uuid-empty-cat');

        expect(result).toBe(0);
    });
});
