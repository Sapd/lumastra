// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock CatalogService
const mockGetOrCreateMinimal = vi.fn().mockResolvedValue({ id: 'test-uuid-123', isNew: false });

vi.mock('$lib/server/services/catalog.service.js', () => ({
    CatalogService: class {
        getOrCreateMinimal = mockGetOrCreateMinimal;
    },
}));

vi.mock('../utils/provider-config.js', () => ({
    getPrimaryExternalIdProvider: vi.fn().mockReturnValue('tmdb'),
}));

import { resolveExternalIdsToMediaId } from './media-resolution.js';

describe('resolveExternalIdsToMediaId', () => {
    const mockSql = {} as Parameters<typeof resolveExternalIdsToMediaId>[0];

    beforeEach(() => {
        mockGetOrCreateMinimal.mockResolvedValue({
            id: 'test-uuid-123',
            isNew: false,
        });
    });

    it('resolves TMDB ID directly', async () => {
        const result = await resolveExternalIdsToMediaId(mockSql, { tmdb: '12345' }, 'movie');
        expect(result).toBe('test-uuid-123');
        expect(mockGetOrCreateMinimal).toHaveBeenCalledWith('12345', 'tmdb', 'movie', undefined);
    });

    it('falls back to IMDB if no TMDB', async () => {
        const result = await resolveExternalIdsToMediaId(mockSql, { imdb: 'tt0137523' }, 'movie');
        expect(result).toBe('test-uuid-123');
        expect(mockGetOrCreateMinimal).toHaveBeenCalledWith(
            'tt0137523',
            'imdb',
            'movie',
            undefined,
        );
    });

    it('uses first available provider in priority order (tvdb)', async () => {
        mockGetOrCreateMinimal.mockResolvedValue({
            id: 'uuid-456',
            isNew: false,
        });

        const result = await resolveExternalIdsToMediaId(mockSql, { tvdb: '78901' }, 'tv');
        expect(result).toBe('uuid-456');
        expect(mockGetOrCreateMinimal).toHaveBeenCalledWith('78901', 'tvdb', 'tv', undefined);
    });

    it('returns null if externalIds is empty', async () => {
        const result = await resolveExternalIdsToMediaId(mockSql, {}, 'movie');
        expect(result).toBeNull();
    });

    it('returns null if externalIds is undefined', async () => {
        const result = await resolveExternalIdsToMediaId(mockSql, undefined, 'movie');
        expect(result).toBeNull();
    });

    it('passes title to getOrCreateMinimal when provided', async () => {
        await resolveExternalIdsToMediaId(mockSql, { tmdb: '550' }, 'movie', 'Quiet Orbit');
        expect(mockGetOrCreateMinimal).toHaveBeenCalledWith('550', 'tmdb', 'movie', 'Quiet Orbit');
    });

    it('uses internal UUID directly without DB lookup', async () => {
        const uuid = '550e8400-e29b-41d4-a716-446655440000';
        mockGetOrCreateMinimal.mockClear();
        const result = await resolveExternalIdsToMediaId(mockSql, { internal: uuid }, 'movie');
        expect(result).toBe(uuid);
        // CatalogService.getOrCreateMinimal should NOT have been called
        expect(mockGetOrCreateMinimal).not.toHaveBeenCalled();
    });

    it('prefers internal UUID over TMDB when both present', async () => {
        const uuid = '550e8400-e29b-41d4-a716-446655440000';
        mockGetOrCreateMinimal.mockClear();
        const result = await resolveExternalIdsToMediaId(
            mockSql,
            { internal: uuid, tmdb: '550' },
            'movie',
        );
        expect(result).toBe(uuid);
        expect(mockGetOrCreateMinimal).not.toHaveBeenCalled();
    });
});
