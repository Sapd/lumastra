// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for ProviderResolutionService
 *
 * Tests resolution of external IDs (IMDB, TVDB, etc.) to TMDB IDs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { providerResolutionService } from './provider-resolution.service';
import type { ExternalIds } from '$lib/types/api-common';

const mockIsAvailable = vi.fn();
const mockResolveImdbToTmdb = vi.fn();
const mockResolveTvdbToTmdb = vi.fn();
const mockGetExternalIdFor = vi.fn();

vi.mock('../providers/implementations/tmdb/index.js', () => ({
    tmdbApi: {
        isAvailable: () => mockIsAvailable(),
        resolveImdbToTmdb: (...args: unknown[]) => mockResolveImdbToTmdb(...args),
        resolveTvdbToTmdb: (...args: unknown[]) => mockResolveTvdbToTmdb(...args),
    },
}));

vi.mock('$lib/utils/external-ids.js', () => ({
    getExternalIdFor: (...args: unknown[]) => mockGetExternalIdFor(...args),
}));

describe('ProviderResolutionService', () => {
    beforeEach(() => {
        mockIsAvailable.mockReset();
        mockResolveImdbToTmdb.mockReset();
        mockResolveTvdbToTmdb.mockReset();
        mockGetExternalIdFor.mockReset();

        mockIsAvailable.mockReturnValue(true);
        mockGetExternalIdFor.mockImplementation((ids: unknown, provider: unknown) => {
            if (ids && typeof ids === 'object' && !Array.isArray(ids)) {
                return (ids as Record<string, string | undefined>)[String(provider)];
            }
            return undefined;
        });
    });

    describe('resolveToTmdb', () => {
        it('returns TMDB passthrough when TMDB ID is present', async () => {
            const externalIds: ExternalIds = { tmdb: '550' };

            const result = await providerResolutionService.resolveToTmdb(externalIds, 'movie');

            expect(result).toEqual({
                success: true,
                tmdbId: 550,
                resolvedFrom: 'tmdb',
            });
        });

        it('resolves IMDB to TMDB ID', async () => {
            mockResolveImdbToTmdb.mockResolvedValue(456);
            const externalIds: ExternalIds = { imdb: 'tt0111161' };

            const result = await providerResolutionService.resolveToTmdb(externalIds, 'movie');

            expect(result).toEqual({
                success: true,
                tmdbId: 456,
                resolvedFrom: 'imdb',
            });
            expect(mockResolveImdbToTmdb).toHaveBeenCalledWith('tt0111161', 'movie');
        });

        it('resolves TVDB to TMDB ID for TV media type', async () => {
            mockResolveTvdbToTmdb.mockResolvedValue(789);
            const externalIds: ExternalIds = { tvdb: '81189' };

            const result = await providerResolutionService.resolveToTmdb(externalIds, 'tv');

            expect(result).toEqual({
                success: true,
                tmdbId: 789,
                resolvedFrom: 'tvdb',
            });
            expect(mockResolveTvdbToTmdb).toHaveBeenCalledWith('81189');
        });

        it('returns not_found for TVDB with movie media type', async () => {
            const externalIds: ExternalIds = { tvdb: '81189' };

            const result = await providerResolutionService.resolveToTmdb(externalIds, 'movie');

            expect(result.success).toBe(false);
            expect(result).toMatchObject({
                error: 'No resolvable external IDs found',
                reason: 'not_found',
            });
        });

        it('returns api_unavailable when TMDB API is not available', async () => {
            mockIsAvailable.mockReturnValue(false);

            const result = await providerResolutionService.resolveToTmdb({ tmdb: '123' }, 'movie');

            expect(result).toEqual({
                success: false,
                error: 'TMDB API is not configured or unavailable',
                reason: 'api_unavailable',
            });
        });

        it('returns no_valid_ids when externalIds is undefined', async () => {
            const result = await providerResolutionService.resolveToTmdb(undefined, 'movie');

            expect(result).toEqual({
                success: false,
                error: 'No external IDs provided',
                reason: 'no_valid_ids',
            });
        });

        it('continues to next provider when IMDB format is invalid', async () => {
            mockResolveTvdbToTmdb.mockResolvedValue(789);
            const externalIds: ExternalIds = {
                imdb: 'invalid',
                tvdb: '81189',
            };

            const result = await providerResolutionService.resolveToTmdb(externalIds, 'tv');

            expect(result).toEqual({
                success: true,
                tmdbId: 789,
                resolvedFrom: 'tvdb',
            });
            expect(mockResolveImdbToTmdb).not.toHaveBeenCalled();
        });

        it('returns api_error when IMDB resolution throws', async () => {
            mockResolveImdbToTmdb.mockRejectedValue(new Error('Network error'));
            const externalIds: ExternalIds = { imdb: 'tt0111161' };

            const result = await providerResolutionService.resolveToTmdb(externalIds, 'movie');

            expect(result.success).toBe(false);
            expect(result).toMatchObject({
                error: 'Failed to resolve IMDB ID: Network error',
                reason: 'api_error',
            });
        });

        it('returns api_error when TVDB resolution throws', async () => {
            mockResolveTvdbToTmdb.mockRejectedValue(new Error('Timeout'));
            const externalIds: ExternalIds = { tvdb: '81189' };

            const result = await providerResolutionService.resolveToTmdb(externalIds, 'tv');

            expect(result.success).toBe(false);
            expect(result).toMatchObject({
                error: 'Failed to resolve TVDB ID: Timeout',
                reason: 'api_error',
            });
        });

        it('returns unsupported_provider when only unsupported IDs are present', async () => {
            const externalIds: ExternalIds = {
                mal: '123',
                trakt: '456',
            };

            const result = await providerResolutionService.resolveToTmdb(externalIds, 'movie');

            expect(result.success).toBe(false);
            expect(result).toMatchObject({
                error: 'Cannot resolve MAL, Trakt IDs to TMDB',
                reason: 'unsupported_provider',
            });
        });

        it('returns not_found when no valid IDs are present', async () => {
            const externalIds: ExternalIds = {};

            const result = await providerResolutionService.resolveToTmdb(externalIds, 'movie');

            expect(result.success).toBe(false);
            expect(result).toMatchObject({
                error: 'No resolvable external IDs found',
                reason: 'not_found',
            });
        });

        it('continues to next provider when TMDB ID parsing returns NaN', async () => {
            mockResolveImdbToTmdb.mockResolvedValue(456);
            const externalIds: ExternalIds = {
                tmdb: 'abc',
                imdb: 'tt0111161',
            };

            const result = await providerResolutionService.resolveToTmdb(externalIds, 'movie');

            expect(result).toEqual({
                success: true,
                tmdbId: 456,
                resolvedFrom: 'imdb',
            });
        });
    });

    describe('canResolve', () => {
        it('returns true when TMDB ID is present', () => {
            expect(providerResolutionService.canResolve({ tmdb: '123' }, 'movie')).toBe(true);
            expect(providerResolutionService.canResolve({ tmdb: '123' }, 'tv')).toBe(true);
        });

        it('returns true when IMDB ID is present', () => {
            expect(providerResolutionService.canResolve({ imdb: 'tt0111161' }, 'movie')).toBe(true);
            expect(providerResolutionService.canResolve({ imdb: 'tt0111161' }, 'tv')).toBe(true);
        });

        it('returns true for TVDB with series media type', () => {
            expect(providerResolutionService.canResolve({ tvdb: '81189' }, 'tv')).toBe(true);
        });

        it('returns false for TVDB with movie media type', () => {
            expect(providerResolutionService.canResolve({ tvdb: '81189' }, 'movie')).toBe(false);
        });

        it('returns false when no IDs are provided', () => {
            expect(providerResolutionService.canResolve(undefined, 'movie')).toBe(false);
            expect(providerResolutionService.canResolve({}, 'tv')).toBe(false);
        });
    });

    describe('getTmdbIdDirect', () => {
        it('returns number for valid TMDB ID', () => {
            expect(providerResolutionService.getTmdbIdDirect({ tmdb: '550' })).toBe(550);
        });

        it('returns undefined when no TMDB ID is present', () => {
            expect(
                providerResolutionService.getTmdbIdDirect({
                    imdb: 'tt0111161',
                }),
            ).toBeUndefined();
        });

        it('returns undefined when TMDB ID is not a number', () => {
            expect(providerResolutionService.getTmdbIdDirect({ tmdb: 'abc' })).toBeUndefined();
        });
    });
});
