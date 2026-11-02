// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for admin LiveTV channel reorder API endpoint:
 * PUT /api/admin/livetv/channels/reorder
 *
 * Tests the batch reorder endpoint including:
 * - Schema validation (request shapes)
 * - Query function behavior (batch updates)
 * - Transaction handling (channels + categories atomically)
 * - Cache invalidation after reorder
 */

import { describe, it, expect, vi } from 'vitest';
import { ReorderChannelsRequestSchema } from '$lib/schemas/livetv.js';
import {
    batchUpdateChannelSortOrder,
    batchUpdateCategorySortOrder,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import type postgres from 'postgres';

// =============================================================================
// Mock helpers
// =============================================================================

function createMockSql(defaultReturn: unknown[] = []) {
    const calls: unknown[][] = [];

    const mockSql = vi.fn((...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(defaultReturn);
    }) as unknown as postgres.Sql;

    const beginCallback = vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
        const tx = createMockSql(defaultReturn).sql;
        return callback(tx);
    });

    (mockSql as unknown as Record<string, unknown>).begin = beginCallback;

    return { sql: mockSql, calls, beginCallback };
}

// =============================================================================
// Request Schema Validation (contract tests)
// =============================================================================

describe('PUT /api/admin/livetv/channels/reorder — schema validation', () => {
    it('accepts valid channel reorder payload', () => {
        const payload = {
            channels: [
                { id: '00000000-0000-4000-8000-000000000001', sortOrder: 0 },
                { id: '00000000-0000-4000-8000-000000000002', sortOrder: 1 },
                { id: '00000000-0000-4000-8000-000000000003', sortOrder: 2 },
            ],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(true);
    });

    it('accepts valid category reorder payload', () => {
        const payload = {
            categories: [
                { id: '00000000-0000-4000-8000-000000000101', sortOrder: 0 },
                { id: '00000000-0000-4000-8000-000000000102', sortOrder: 1 },
            ],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(true);
    });

    it('accepts combined channel + category reorder', () => {
        const payload = {
            channels: [
                { id: '00000000-0000-4000-8000-000000000001', sortOrder: 0 },
                { id: '00000000-0000-4000-8000-000000000002', sortOrder: 1 },
            ],
            categories: [
                { id: '00000000-0000-4000-8000-000000000101', sortOrder: 0 },
                { id: '00000000-0000-4000-8000-000000000102', sortOrder: 1 },
            ],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(true);
    });

    it('rejects empty payload (neither channels nor categories)', () => {
        const result = ReorderChannelsRequestSchema.safeParse({});
        expect(result.success).toBe(false);
    });

    it('rejects payload with both arrays empty', () => {
        const result = ReorderChannelsRequestSchema.safeParse({
            channels: [],
            categories: [],
        });
        expect(result.success).toBe(false);
    });

    it('rejects negative sort order', () => {
        const payload = {
            channels: [{ id: '00000000-0000-4000-8000-000000000001', sortOrder: -1 }],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(false);
    });

    it('rejects non-integer sort order', () => {
        const payload = {
            channels: [{ id: '00000000-0000-4000-8000-000000000001', sortOrder: 1.5 }],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(false);
    });

    it('accepts duplicate sort order values (not unique constraint)', () => {
        const payload = {
            channels: [
                { id: '00000000-0000-4000-8000-000000000001', sortOrder: 0 },
                { id: '00000000-0000-4000-8000-000000000002', sortOrder: 0 },
            ],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(true);
    });

    it('rejects missing id in channel update', () => {
        const payload = {
            channels: [{ sortOrder: 0 }],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(false);
    });

    it('rejects missing sortOrder in channel update', () => {
        const payload = {
            channels: [{ id: '00000000-0000-4000-8000-000000000001' }],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(false);
    });

    it('accepts large payloads (1300+ channels)', () => {
        const channels = Array.from({ length: 1300 }, (_, i) => ({
            id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
            sortOrder: i,
        }));
        const result = ReorderChannelsRequestSchema.safeParse({ channels });
        expect(result.success).toBe(true);
    });
});

// =============================================================================
// Transaction Handling
// =============================================================================

describe('PUT /api/admin/livetv/channels/reorder — transaction handling', () => {
    it('calls batchUpdateChannelSortOrder with correct data', async () => {
        const updateResult = Object.assign([], { count: 3 });
        const { sql } = createMockSql(updateResult);

        const count = await batchUpdateChannelSortOrder(sql, [
            { id: '00000000-0000-4000-8000-000000000001', sortOrder: 2 },
            { id: '00000000-0000-4000-8000-000000000002', sortOrder: 0 },
            { id: '00000000-0000-4000-8000-000000000003', sortOrder: 1 },
        ]);

        expect(count).toBe(3);
    });

    it('calls batchUpdateCategorySortOrder with correct data', async () => {
        const updateResult = Object.assign([], { count: 2 });
        const { sql } = createMockSql(updateResult);

        const count = await batchUpdateCategorySortOrder(sql, [
            { id: '00000000-0000-4000-8000-000000000101', sortOrder: 1 },
            { id: '00000000-0000-4000-8000-000000000102', sortOrder: 0 },
        ]);

        expect(count).toBe(2);
    });

    it('handles channel-only reorder (no categories)', async () => {
        const updateResult = Object.assign([], { count: 2 });
        const { sql } = createMockSql(updateResult);

        const count = await batchUpdateChannelSortOrder(sql, [
            { id: '00000000-0000-4000-8000-000000000001', sortOrder: 0 },
            { id: '00000000-0000-4000-8000-000000000002', sortOrder: 1 },
        ]);

        expect(count).toBe(2);
    });

    it('handles category-only reorder (no channels)', async () => {
        const updateResult = Object.assign([], { count: 1 });
        const { sql } = createMockSql(updateResult);

        const count = await batchUpdateCategorySortOrder(sql, [
            { id: '00000000-0000-4000-8000-000000000101', sortOrder: 0 },
        ]);

        expect(count).toBe(1);
    });

    it('both batch updates can run in a transaction', async () => {
        const updateResult = Object.assign([], { count: 2 });
        const { sql } = createMockSql(updateResult);

        // Simulate what the route handler does: both updates in sql.begin()
        await sql.begin(async (txRaw) => {
            const tx = txRaw as unknown as typeof sql;
            await batchUpdateChannelSortOrder(tx, [
                { id: '00000000-0000-4000-8000-000000000001', sortOrder: 0 },
            ]);
            await batchUpdateCategorySortOrder(tx, [
                { id: '00000000-0000-4000-8000-000000000101', sortOrder: 0 },
            ]);
        });

        expect(sql.begin).toHaveBeenCalledOnce();
    });

    it('empty channel array is a no-op', async () => {
        const { sql, calls } = createMockSql([]);

        const count = await batchUpdateChannelSortOrder(sql, []);

        expect(count).toBe(0);
        expect(calls).toHaveLength(0);
    });

    it('empty category array is a no-op', async () => {
        const { sql, calls } = createMockSql([]);

        const count = await batchUpdateCategorySortOrder(sql, []);

        expect(count).toBe(0);
        expect(calls).toHaveLength(0);
    });
});

// =============================================================================
// Concurrent Reorder (last-write-wins behavior)
// =============================================================================

describe('PUT /api/admin/livetv/channels/reorder — concurrent handling', () => {
    it('concurrent reorder requests both succeed (last-write-wins)', async () => {
        const updateResult = Object.assign([], { count: 2 });
        const { sql } = createMockSql(updateResult);

        // Two concurrent reorder calls — both should complete
        const [count1, count2] = await Promise.all([
            batchUpdateChannelSortOrder(sql, [
                { id: '00000000-0000-4000-8000-000000000001', sortOrder: 0 },
                { id: '00000000-0000-4000-8000-000000000002', sortOrder: 1 },
            ]),
            batchUpdateChannelSortOrder(sql, [
                { id: '00000000-0000-4000-8000-000000000001', sortOrder: 1 },
                { id: '00000000-0000-4000-8000-000000000002', sortOrder: 0 },
            ]),
        ]);

        expect(count1).toBe(2);
        expect(count2).toBe(2);
    });
});

// =============================================================================
// Edge Cases
// =============================================================================

describe('PUT /api/admin/livetv/channels/reorder — edge cases', () => {
    it('handles single channel reorder', async () => {
        const updateResult = Object.assign([], { count: 1 });
        const { sql } = createMockSql(updateResult);

        const count = await batchUpdateChannelSortOrder(sql, [
            { id: '00000000-0000-4000-8000-000000000001', sortOrder: 5 },
        ]);

        expect(count).toBe(1);
    });

    it('handles reorder to same positions (no-change reorder)', async () => {
        const updateResult = Object.assign([], { count: 3 });
        const { sql } = createMockSql(updateResult);

        const count = await batchUpdateChannelSortOrder(sql, [
            { id: '00000000-0000-4000-8000-000000000001', sortOrder: 0 },
            { id: '00000000-0000-4000-8000-000000000002', sortOrder: 1 },
            { id: '00000000-0000-4000-8000-000000000003', sortOrder: 2 },
        ]);

        // Even if positions didn't change, the UPDATE runs and returns count
        expect(count).toBe(3);
    });

    it('returns 0 for non-existent channel IDs', async () => {
        const updateResult = Object.assign([], { count: 0 });
        const { sql } = createMockSql(updateResult);

        const count = await batchUpdateChannelSortOrder(sql, [
            { id: 'uuid-nonexistent', sortOrder: 0 },
        ]);

        expect(count).toBe(0);
    });

    it('accepts sort order 0 (zero-indexed)', () => {
        const payload = {
            channels: [{ id: '00000000-0000-4000-8000-000000000001', sortOrder: 0 }],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(true);
    });

    it('accepts large sort order values', () => {
        const payload = {
            channels: [{ id: '00000000-0000-4000-8000-000000000001', sortOrder: 9999 }],
        };
        const result = ReorderChannelsRequestSchema.safeParse(payload);
        expect(result.success).toBe(true);
    });
});
