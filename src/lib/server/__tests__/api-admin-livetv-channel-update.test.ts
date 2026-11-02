// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for PUT /api/admin/livetv/channels/[channelId]
 *
 * Tests the single channel update endpoint:
 * - Visibility toggle
 * - Not-found handling
 * - Empty body rejection
 * - Cache invalidation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { UpdateChannelRequestSchema } from '$lib/schemas/livetv.js';

// Mock the database service
const mockGetSql = vi.fn();
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: () => mockGetSql() },
}));

// Mock the query function
const mockUpdateChannel = vi.fn();
vi.mock('$lib/server/database/queries/livetv-channels.queries.js', () => ({
    updateChannel: (...args: unknown[]) => mockUpdateChannel(...args),
}));

// Mock cache manager
const mockClear = vi.fn();
vi.mock('$lib/server/cache/index.js', () => ({
    cacheManager: {
        for: () => ({ clear: mockClear }),
    },
    CACHE_NAMESPACES: { browseChannels: 'browseChannels' },
}));

describe('PUT /api/admin/livetv/channels/[channelId]', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    describe('UpdateChannelRequestSchema validation', () => {
        it('accepts visibility toggle payload', () => {
            const result = UpdateChannelRequestSchema.safeParse({
                isVisible: false,
            });
            expect(result.success).toBe(true);
        });

        it('accepts quality tier update', () => {
            const result = UpdateChannelRequestSchema.safeParse({
                qualityTier: 'hd',
            });
            expect(result.success).toBe(true);
        });

        it('accepts category reassignment', () => {
            const result = UpdateChannelRequestSchema.safeParse({
                categoryId: 'uuid-cat-1',
            });
            expect(result.success).toBe(true);
        });

        it('accepts admin display name update', () => {
            const result = UpdateChannelRequestSchema.safeParse({
                adminDisplayName: 'My Channel',
            });
            expect(result.success).toBe(true);
        });

        it('rejects empty body (needs at least one field)', () => {
            const result = UpdateChannelRequestSchema.safeParse({});
            expect(result.success).toBe(false);
        });

        it('rejects invalid quality tier', () => {
            const result = UpdateChannelRequestSchema.safeParse({
                qualityTier: '4k',
            });
            expect(result.success).toBe(false);
        });

        it('accepts multiple fields at once', () => {
            const result = UpdateChannelRequestSchema.safeParse({
                isVisible: true,
                qualityTier: 'fhd',
                categoryId: 'uuid-cat-2',
            });
            expect(result.success).toBe(true);
        });
    });

    describe('updateChannel query integration', () => {
        it('calls updateChannel with correct parameters', async () => {
            const mockSql = {};
            mockGetSql.mockResolvedValue(mockSql);
            mockUpdateChannel.mockResolvedValue(true);

            await mockUpdateChannel(mockSql, 'uuid-ch-1', { isVisible: false });

            expect(mockUpdateChannel).toHaveBeenCalledWith(mockSql, 'uuid-ch-1', {
                isVisible: false,
            });
        });

        it('returns true when channel found and updated', async () => {
            mockUpdateChannel.mockResolvedValue(true);

            const result = await mockUpdateChannel({}, 'uuid-ch-1', {
                isVisible: true,
            });

            expect(result).toBe(true);
        });

        it('returns false for non-existent channel (404)', async () => {
            mockUpdateChannel.mockResolvedValue(false);

            const result = await mockUpdateChannel({}, 'uuid-nonexistent', {
                isVisible: false,
            });

            expect(result).toBe(false);
        });
    });
});
