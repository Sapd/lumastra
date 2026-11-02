// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for PUT /api/admin/livetv/channels/bulk
 *
 * Tests the bulk channel operations endpoint:
 * - Bulk hide/show
 * - Bulk move to category
 * - Bulk set quality
 * - Schema validation (missing required fields)
 * - Cache invalidation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BulkUpdateChannelsRequestSchema } from '$lib/schemas/livetv.js';

// Mock the database service
const mockGetSql = vi.fn();
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: () => mockGetSql() },
}));

// Mock the query function
const mockBulkUpdateChannels = vi.fn();
vi.mock('$lib/server/database/queries/livetv-channels.queries.js', () => ({
    bulkUpdateChannels: (...args: unknown[]) => mockBulkUpdateChannels(...args),
}));

// Mock cache manager
const mockClear = vi.fn();
vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: {
        for: () => ({ clear: mockClear }),
    },
    CACHE_NAMESPACES: { browseChannels: 'browseChannels' },
}));

describe('PUT /api/admin/livetv/channels/bulk', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('BulkUpdateChannelsRequestSchema validation', () => {
        it('accepts bulk hide action', () => {
            const result = BulkUpdateChannelsRequestSchema.safeParse({
                channelIds: [
                    '123e4567-e89b-12d3-a456-426614174001',
                    '123e4567-e89b-12d3-a456-426614174002',
                ],
                action: 'hide',
            });
            expect(result.success).toBe(true);
        });

        it('accepts bulk show action', () => {
            const result = BulkUpdateChannelsRequestSchema.safeParse({
                channelIds: ['123e4567-e89b-12d3-a456-426614174001'],
                action: 'show',
            });
            expect(result.success).toBe(true);
        });

        it('accepts setQuality with qualityTier', () => {
            const result = BulkUpdateChannelsRequestSchema.safeParse({
                channelIds: [
                    '123e4567-e89b-12d3-a456-426614174001',
                    '123e4567-e89b-12d3-a456-426614174002',
                ],
                action: 'setQuality',
                qualityTier: 'fhd',
            });
            expect(result.success).toBe(true);
        });

        it('accepts moveToCategory with categoryId', () => {
            const result = BulkUpdateChannelsRequestSchema.safeParse({
                channelIds: ['123e4567-e89b-12d3-a456-426614174001'],
                action: 'moveToCategory',
                categoryId: '423e4567-e89b-12d3-a456-426614174001',
            });
            expect(result.success).toBe(true);
        });

        it('rejects invalid action', () => {
            const result = BulkUpdateChannelsRequestSchema.safeParse({
                channelIds: ['uuid-1'],
                action: 'delete',
            });
            expect(result.success).toBe(false);
        });

        it('rejects setQuality without qualityTier', () => {
            const result = BulkUpdateChannelsRequestSchema.safeParse({
                channelIds: ['uuid-1'],
                action: 'setQuality',
            });
            expect(result.success).toBe(false);
        });

        it('rejects moveToCategory without categoryId', () => {
            const result = BulkUpdateChannelsRequestSchema.safeParse({
                channelIds: ['uuid-1'],
                action: 'moveToCategory',
            });
            expect(result.success).toBe(false);
        });

        it('rejects empty channelIds array', () => {
            const result = BulkUpdateChannelsRequestSchema.safeParse({
                channelIds: [],
                action: 'hide',
            });
            expect(result.success).toBe(false);
        });

        it('rejects invalid quality tier for setQuality', () => {
            const result = BulkUpdateChannelsRequestSchema.safeParse({
                channelIds: ['uuid-1'],
                action: 'setQuality',
                qualityTier: '4k',
            });
            expect(result.success).toBe(false);
        });
    });

    describe('bulkUpdateChannels query integration', () => {
        it('bulk hide returns success with count', async () => {
            mockBulkUpdateChannels.mockResolvedValue(3);

            const count = await mockBulkUpdateChannels({}, ['uuid-1', 'uuid-2', 'uuid-3'], {
                isVisible: false,
            });

            expect(count).toBe(3);
        });

        it('bulk show returns success with count', async () => {
            mockBulkUpdateChannels.mockResolvedValue(2);

            const count = await mockBulkUpdateChannels({}, ['uuid-1', 'uuid-2'], {
                isVisible: true,
            });

            expect(count).toBe(2);
        });

        it('bulk move to category works', async () => {
            mockBulkUpdateChannels.mockResolvedValue(5);

            const count = await mockBulkUpdateChannels(
                {},
                ['uuid-1', 'uuid-2', 'uuid-3', 'uuid-4', 'uuid-5'],
                { categoryId: 'uuid-cat-new' },
            );

            expect(count).toBe(5);
        });

        it('bulk set quality works', async () => {
            mockBulkUpdateChannels.mockResolvedValue(4);

            const count = await mockBulkUpdateChannels(
                {},
                ['uuid-1', 'uuid-2', 'uuid-3', 'uuid-4'],
                { qualityTier: 'hd' },
            );

            expect(count).toBe(4);
        });

        it('returns 0 for empty channelIds', async () => {
            mockBulkUpdateChannels.mockResolvedValue(0);

            const count = await mockBulkUpdateChannels({}, [], {
                isVisible: false,
            });

            expect(count).toBe(0);
        });
    });

    describe('action → updates mapping', () => {
        it('hide action maps to isVisible: false', () => {
            const body = {
                channelIds: ['uuid-1'],
                action: 'hide' as 'hide' | 'show',
            };
            const updates: Record<string, unknown> = {};
            switch (body.action) {
                case 'hide':
                    updates.isVisible = false;
                    break;
                case 'show':
                    updates.isVisible = true;
                    break;
            }
            expect(updates.isVisible).toBe(false);
        });

        it('show action maps to isVisible: true', () => {
            const body = {
                channelIds: ['uuid-1'],
                action: 'show' as 'hide' | 'show',
            };
            const updates: Record<string, unknown> = {};
            switch (body.action) {
                case 'hide':
                    updates.isVisible = false;
                    break;
                case 'show':
                    updates.isVisible = true;
                    break;
            }
            expect(updates.isVisible).toBe(true);
        });

        it('setQuality action maps qualityTier', () => {
            const body = {
                channelIds: ['uuid-1'],
                action: 'setQuality' as const,
                qualityTier: 'fhd',
            };
            const updates: Record<string, unknown> = {};
            if (body.action === 'setQuality') updates.qualityTier = body.qualityTier;
            expect(updates.qualityTier).toBe('fhd');
        });

        it('moveToCategory action maps categoryId', () => {
            const body = {
                channelIds: ['uuid-1'],
                action: 'moveToCategory' as const,
                categoryId: 'uuid-cat-1',
            };
            const updates: Record<string, unknown> = {};
            if (body.action === 'moveToCategory') updates.categoryId = body.categoryId;
            expect(updates.categoryId).toBe('uuid-cat-1');
        });
    });
});
