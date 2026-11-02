// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for AvailabilityService
 *
 * Tests multi-provider availability logic with mocked providers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    AvailabilityService,
    type JellyfinAvailabilityItem,
    type AvailabilityInfo,
} from './availability.service';
import type { SonarrSeries } from '../sonarr.js';

const mockResolveToTmdb = vi.fn();
const mockGetDb = vi.fn();
const mockGetGenreId = vi.fn();

vi.mock('./provider-resolution.service.js', () => ({
    providerResolutionService: {
        resolveToTmdb: (...args: unknown[]) => mockResolveToTmdb(...args),
    },
}));

vi.mock('../database/connection.js', () => ({
    getDb: () => mockGetDb(),
}));

vi.mock('./genre.service.js', () => ({
    GenreService: {
        getGenreId: (...args: unknown[]) => mockGetGenreId(...args),
    },
}));

describe('AvailabilityService', () => {
    beforeEach(() => {
        mockResolveToTmdb.mockReset();
        mockGetDb.mockReset();
        mockGetGenreId.mockReset();
    });

    describe('determineAvailability — resolution failures', () => {
        it('returns unavailable when provider resolution fails', async () => {
            mockResolveToTmdb.mockResolvedValue({
                success: false,
                error: 'No IDs',
                reason: 'no_valid_ids',
            });

            const result = await AvailabilityService.determineAvailability({}, 'movie');

            expect(result.is_available).toBe(false);
            expect(result.can_request).toBe(false);
            expect(result.availability_source).toBe('none');
        });
    });

    describe('determineAvailability — Jellyfin source', () => {
        it('marks available when Jellyfin has matching item', async () => {
            mockResolveToTmdb.mockResolvedValue({
                success: true,
                tmdbId: 550,
                resolvedFrom: 'tmdb',
            });
            mockGetDb.mockReturnValue(null);

            const jellyfinItem: JellyfinAvailabilityItem = {
                Id: 'jf-123',
                ProviderIds: { Tmdb: '550' },
                Type: 'Movie',
                DateCreated: '2024-01-01',
            };

            const result = await AvailabilityService.determineAvailability(
                { tmdb: '550' },
                'movie',
                { jellyfinItems: [jellyfinItem] },
            );

            expect(result.is_available).toBe(true);
            expect(result.availability_source).toBe('jellyfin');
            expect(result.jellyfin_id).toBe('jf-123');
            expect(result.can_request).toBe(false);
        });

        it('matches by both tmdb_id AND media_type to avoid collisions', async () => {
            mockResolveToTmdb.mockResolvedValue({
                success: true,
                tmdbId: 1429,
                resolvedFrom: 'tmdb',
            });
            mockGetDb.mockReturnValue(null);

            const movieItem: JellyfinAvailabilityItem = {
                Id: 'jf-movie',
                ProviderIds: { Tmdb: '1429' },
                Type: 'Movie',
            };
            const seriesItem: JellyfinAvailabilityItem = {
                Id: 'jf-series',
                ProviderIds: { Tmdb: '1429' },
                Type: 'Series',
            };

            const result = await AvailabilityService.determineAvailability({ tmdb: '1429' }, 'tv', {
                jellyfinItems: [movieItem, seriesItem],
            });

            expect(result.is_available).toBe(true);
            expect(result.jellyfin_id).toBe('jf-series');
        });

        it('resolves internal_id from database when Jellyfin match found', async () => {
            mockResolveToTmdb.mockResolvedValue({
                success: true,
                tmdbId: 550,
                resolvedFrom: 'tmdb',
            });
            const mockSql = vi.fn();
            mockSql.mockResolvedValue([{ id: 'internal-uuid-1' }]);
            mockGetDb.mockReturnValue(mockSql);

            const jellyfinItem: JellyfinAvailabilityItem = {
                Id: 'jf-123',
                ProviderIds: { Tmdb: '550' },
                Type: 'Movie',
            };

            const result = await AvailabilityService.determineAvailability(
                { tmdb: '550' },
                'movie',
                { jellyfinItems: [jellyfinItem] },
            );

            expect(result.internal_id).toBe('internal-uuid-1');
        });

        it.each([
            [640, 360, '360p'],
            [1920, 800, '1080p'],
            [1920, 1080, '1080p'],
        ])('labels a Jellyfin %ix%i video stream as %s', async (Width, Height, label) => {
            mockResolveToTmdb.mockResolvedValue({
                success: true,
                tmdbId: 550,
                resolvedFrom: 'tmdb',
            });
            mockGetDb.mockReturnValue(null);

            const result = await AvailabilityService.determineAvailability(
                { tmdb: '550' },
                'movie',
                {
                    jellyfinItems: [
                        {
                            Id: 'jf-123',
                            ProviderIds: { Tmdb: '550' },
                            Type: 'Movie',
                            MediaSources: [
                                {
                                    MediaStreams: [{ Type: 'Video', Width, Height }],
                                },
                            ],
                        } as unknown as JellyfinAvailabilityItem,
                    ],
                },
            );

            expect(result.additional_info?.file_quality).toBe(label);
        });
    });

    describe('determineAvailability — Radarr source', () => {
        it('marks available when Radarr has file', async () => {
            mockResolveToTmdb.mockResolvedValue({
                success: true,
                tmdbId: 550,
                resolvedFrom: 'tmdb',
            });

            const result = await AvailabilityService.determineAvailability(
                { tmdb: '550' },
                'movie',
                {
                    radarrItem: {
                        id: 1,
                        tmdbId: 550,
                        hasFile: true,
                        monitored: true,
                        movieFile: {
                            quality: { quality: { name: 'Bluray-1080p' } },
                            size: 5_000_000_000,
                        },
                    },
                },
            );

            expect(result.is_available).toBe(true);
            expect(result.availability_source).toBe('radarr');
            expect(result.additional_info?.file_quality).toBe('Bluray-1080p');
            expect(result.can_request).toBe(false);
        });

        it('marks processing when Radarr is monitored but no file', async () => {
            mockResolveToTmdb.mockResolvedValue({
                success: true,
                tmdbId: 550,
                resolvedFrom: 'tmdb',
            });

            const result = await AvailabilityService.determineAvailability(
                { tmdb: '550' },
                'movie',
                {
                    radarrItem: {
                        id: 1,
                        tmdbId: 550,
                        hasFile: false,
                        monitored: true,
                    },
                },
            );

            expect(result.is_available).toBe(false);
            expect(result.request_status).toBe('processing');
            // Note: Jellyseerr branch is the final authority on can_request;
            // when no jellyseerrItem exists, can_request defaults to true
            expect(result.can_request).toBe(true);
        });
    });

    describe('determineAvailability — Sonarr source', () => {
        it('marks available when >= 80% episodes present', async () => {
            mockResolveToTmdb.mockResolvedValue({
                success: true,
                tmdbId: 1399,
                resolvedFrom: 'tmdb',
            });

            const result = await AvailabilityService.determineAvailability({ tmdb: '1399' }, 'tv', {
                sonarrItem: {
                    tvdbId: 121361,
                    statistics: {
                        episodeFileCount: 8,
                        totalEpisodeCount: 10,
                    },
                    monitored: true,
                } as SonarrSeries,
            });

            expect(result.is_available).toBe(true);
            expect(result.availability_source).toBe('sonarr');
        });

        it('marks partial when < 100% episodes present', async () => {
            mockResolveToTmdb.mockResolvedValue({
                success: true,
                tmdbId: 1399,
                resolvedFrom: 'tmdb',
            });

            const result = await AvailabilityService.determineAvailability({ tmdb: '1399' }, 'tv', {
                sonarrItem: {
                    tvdbId: 121361,
                    statistics: {
                        episodeFileCount: 5,
                        totalEpisodeCount: 10,
                    },
                    monitored: true,
                } as SonarrSeries,
            });

            expect(result.is_available).toBe(false);
            expect(result.request_status).toBe('partial');
        });
    });

    describe('determineAvailability — Jellyseerr status', () => {
        it('maps Jellyseerr status 1 to available', async () => {
            mockResolveToTmdb.mockResolvedValue({
                success: true,
                tmdbId: 550,
                resolvedFrom: 'tmdb',
            });

            const result = await AvailabilityService.determineAvailability(
                { tmdb: '550' },
                'movie',
                {
                    jellyseerrItem: { id: 42, status: 1 },
                },
            );

            expect(result.is_available).toBe(true);
            expect(result.request_status).toBe('available');
            expect(result.can_request).toBe(false);
        });

        it('maps Jellyseerr status 2 to pending', async () => {
            mockResolveToTmdb.mockResolvedValue({
                success: true,
                tmdbId: 550,
                resolvedFrom: 'tmdb',
            });

            const result = await AvailabilityService.determineAvailability(
                { tmdb: '550' },
                'movie',
                {
                    jellyseerrItem: { id: 42, status: 2 },
                },
            );

            expect(result.request_status).toBe('pending');
            expect(result.can_request).toBe(false);
        });

        it('maps Jellyseerr status 4 to partial (can request missing)', async () => {
            mockResolveToTmdb.mockResolvedValue({
                success: true,
                tmdbId: 550,
                resolvedFrom: 'tmdb',
            });

            const result = await AvailabilityService.determineAvailability(
                { tmdb: '550' },
                'movie',
                {
                    jellyseerrItem: { id: 42, status: 4 },
                },
            );

            expect(result.is_available).toBe(true);
            expect(result.request_status).toBe('partial');
            expect(result.can_request).toBe(true);
        });

        it('allows request when no Jellyseerr item exists', async () => {
            mockResolveToTmdb.mockResolvedValue({
                success: true,
                tmdbId: 550,
                resolvedFrom: 'tmdb',
            });

            const result = await AvailabilityService.determineAvailability(
                { tmdb: '550' },
                'movie',
            );

            expect(result.can_request).toBe(true);
            expect(result.request_status).toBeUndefined();
        });
    });

    describe('canRequest', () => {
        const rules = {
            allowMovieRequests: true,
            allowTvRequests: true,
            requireApproval: false,
        };

        it('returns false when already available', () => {
            const item: AvailabilityInfo = {
                is_available: true,
                can_request: false,
                availability_source: 'jellyfin',
            };
            expect(AvailabilityService.canRequest(item, rules)).toBe(false);
        });

        it('returns false when pending', () => {
            const item: AvailabilityInfo = {
                is_available: false,
                can_request: false,
                availability_source: 'none',
                request_status: 'pending',
            };
            expect(AvailabilityService.canRequest(item, rules)).toBe(false);
        });

        it('returns false when movie requests disabled', () => {
            const item = {
                mediaType: 'movie',
                is_available: false,
                can_request: true,
                availability_source: 'none' as const,
            };
            expect(
                AvailabilityService.canRequest(item, {
                    ...rules,
                    allowMovieRequests: false,
                }),
            ).toBe(false);
        });

        it('returns false when TV requests disabled', () => {
            const item = {
                mediaType: 'tv',
                is_available: false,
                can_request: true,
                availability_source: 'none' as const,
            };
            expect(
                AvailabilityService.canRequest(item, {
                    ...rules,
                    allowTvRequests: false,
                }),
            ).toBe(false);
        });

        it('returns false when genre is blocked', () => {
            mockGetGenreId.mockReturnValue(27); // Horror

            const item = {
                mediaType: 'movie',
                is_available: false,
                can_request: true,
                availability_source: 'none' as const,
                genres: ['Horror'],
            };
            expect(
                AvailabilityService.canRequest(item, {
                    ...rules,
                    blockedGenres: [27],
                }),
            ).toBe(false);
            expect(mockGetGenreId).toHaveBeenCalledWith('Horror');
        });

        it('returns true when requestable', () => {
            const item = {
                mediaType: 'movie',
                is_available: false,
                can_request: true,
                availability_source: 'none' as const,
            };
            expect(AvailabilityService.canRequest(item, rules)).toBe(true);
        });
    });

    describe('getAvailabilityStats', () => {
        it('counts totals correctly', () => {
            const items = [
                {
                    availability: {
                        is_available: true,
                        can_request: false,
                        availability_source: 'jellyfin' as const,
                    },
                },
                {
                    availability: {
                        is_available: false,
                        can_request: true,
                        availability_source: 'none' as const,
                        request_status: 'pending' as const,
                    },
                },
            ];

            const stats = AvailabilityService.getAvailabilityStats(items);
            expect(stats.total).toBe(2);
            expect(stats.available).toBe(1);
            expect(stats.requestable).toBe(1);
            expect(stats.pending).toBe(1);
            expect(stats.bySource.jellyfin).toBe(1);
            expect(stats.bySource.none).toBe(1);
        });

        it('skips items without availability', () => {
            const items = [{}, { availability: undefined }];
            const stats = AvailabilityService.getAvailabilityStats(items);
            expect(stats.total).toBe(2);
            expect(stats.available).toBe(0);
        });
    });

    describe('filterByAvailability', () => {
        it('filters by available', () => {
            const items = [
                {
                    availability: {
                        is_available: true,
                        can_request: false,
                        availability_source: 'jellyfin' as const,
                    },
                },
                {
                    availability: {
                        is_available: false,
                        can_request: true,
                        availability_source: 'none' as const,
                    },
                },
            ];

            const filtered = AvailabilityService.filterByAvailability(items, 'available');
            expect(filtered).toHaveLength(1);
            expect(filtered[0].availability?.is_available).toBe(true);
        });

        it('returns unavailable when no availability data', () => {
            const items = [{}];
            const filtered = AvailabilityService.filterByAvailability(items, 'unavailable');
            expect(filtered).toHaveLength(1);
        });
    });
});
