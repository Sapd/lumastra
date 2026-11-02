// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for media-details query module
 */

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';

// Mock the provider-config module before importing the module under test
vi.mock('../../utils/provider-config.js', () => ({
    getMetadataProviderChain: vi.fn(() => ['aggregated', 'tmdb']),
}));

import {
    getMediaDetailByUuid,
    getMediaDetailByCompositeKey,
    getCachedListItemByCompositeKey,
    type MediaDetailRow,
    type CachedListItemRow,
} from './media-details.queries.js';

describe('media-details.queries', () => {
    describe('exports', () => {
        it('exports getMediaDetailByUuid function', () => {
            expect(typeof getMediaDetailByUuid).toBe('function');
        });

        it('exports getMediaDetailByCompositeKey function', () => {
            expect(typeof getMediaDetailByCompositeKey).toBe('function');
        });

        it('exports getCachedListItemByCompositeKey function', () => {
            expect(typeof getCachedListItemByCompositeKey).toBe('function');
        });
    });

    describe('MediaDetailRow type', () => {
        it('compiles with expected shape', () => {
            const row: MediaDetailRow = {
                media_id: 'uuid-123',
                title: 'Test Movie',
                media_type: 'movie',
                release_date: '2024-01-01',
                overview: 'A test movie',
                imdb_rating: 7.5,
                rt_rating: 85,
                tmdb_rating: 7.8,
                popularity: 100.5,
                vote_count: 5000,
                runtime_minutes: 120,
                genres: ['Action', 'Drama'],
                keywords: ['keyword1'],
                networks: null,
                actors: ['Actor One'],
                directors: ['Director One'],
                certification: 'PG-13',
                is_available: true,
                can_request: false,
                rt_audience_score: 90,
                letterboxd_rating: 4.0,
                letterboxd_votes: 1000,
                metacritic_score: 75,
                trakt_score: 80,
                mdblist_score: 72,
                first_air_date: null,
                last_air_date: null,
                status: null,
                season_count: null,
                episode_count: null,
                has_local_trailer: false,
                cast_structured: null,
                extras: [],
                resolution_tier: null,
                hdr_tier: null,
                hdr_type: null,
                best_audio: null,
            };

            expect(row.media_id).toBe('uuid-123');
            expect(row.media_type).toBe('movie');
            expect(row.is_available).toBe(true);
            expect(row.can_request).toBe(false);
        });

        it('compiles for TV series with TV-specific fields', () => {
            const row: MediaDetailRow = {
                media_id: 'uuid-456',
                title: 'Test Series',
                media_type: 'tv',
                release_date: null,
                overview: null,
                imdb_rating: null,
                rt_rating: null,
                tmdb_rating: null,
                popularity: null,
                vote_count: null,
                runtime_minutes: null,
                genres: null,
                keywords: null,
                networks: ['Harborline'],
                actors: null,
                directors: null,
                certification: null,
                is_available: false,
                can_request: true,
                rt_audience_score: null,
                letterboxd_rating: null,
                letterboxd_votes: null,
                metacritic_score: null,
                trakt_score: null,
                mdblist_score: null,
                first_air_date: '2020-01-01',
                last_air_date: '2023-05-15',
                status: 'Ended',
                season_count: 4,
                episode_count: 40,
                has_local_trailer: true,
                cast_structured: null,
                extras: [],
                resolution_tier: null,
                hdr_tier: null,
                hdr_type: null,
                best_audio: null,
            };

            expect(row.media_type).toBe('tv');
            expect(row.first_air_date).toBe('2020-01-01');
            expect(row.season_count).toBe(4);
            expect(row.episode_count).toBe(40);
        });
    });

    describe('CachedListItemRow type', () => {
        it('compiles with expected shape', () => {
            const row: CachedListItemRow = {
                media_id: 'uuid-789',
                queried_external_id: 'tmdb-550',
                title: 'Cached Movie',
                media_type: 'movie',
                release_year: 1999,
                score: 72,
                overview: 'A cached movie overview',
            };

            expect(row.media_id).toBe('uuid-789');
            expect(row.queried_external_id).toBe('tmdb-550');
            expect(row.release_year).toBe(1999);
        });

        it('compiles with null optional fields', () => {
            const row: CachedListItemRow = {
                media_id: 'uuid-000',
                queried_external_id: 'imdb-tt0137523',
                title: 'Minimal Cached',
                media_type: 'tv',
                release_year: null,
                score: null,
                overview: null,
            };

            expect(row.release_year).toBeNull();
            expect(row.overview).toBeNull();
        });
    });

    describe('getMediaDetailByUuid', () => {
        it('calls sql with uuid and returns first result', async () => {
            const mockRow: MediaDetailRow = {
                media_id: 'test-uuid',
                title: 'Test',
                media_type: 'movie',
                release_date: null,
                overview: null,
                imdb_rating: null,
                rt_rating: null,
                tmdb_rating: null,
                popularity: null,
                vote_count: null,
                runtime_minutes: null,
                genres: null,
                keywords: null,
                networks: null,
                actors: null,
                directors: null,
                certification: null,
                is_available: false,
                can_request: true,
                rt_audience_score: null,
                letterboxd_rating: null,
                letterboxd_votes: null,
                metacritic_score: null,
                trakt_score: null,
                mdblist_score: null,
                first_air_date: null,
                last_air_date: null,
                status: null,
                season_count: null,
                episode_count: null,
                has_local_trailer: false,
                cast_structured: null,
                extras: [],
                resolution_tier: null,
                hdr_tier: null,
                hdr_type: null,
                best_audio: null,
            };

            const mockSql = Object.assign(vi.fn().mockResolvedValue([mockRow]), {
                unsafe: vi.fn().mockReturnValue(''),
            }) as unknown as postgres.Sql;

            const result = await getMediaDetailByUuid(mockSql, 'test-uuid');
            expect(result).toBe(mockRow);
        });

        it('returns null when no results', async () => {
            const mockSql = Object.assign(vi.fn().mockResolvedValue([]), {
                unsafe: vi.fn().mockReturnValue(''),
            }) as unknown as postgres.Sql;

            const result = await getMediaDetailByUuid(mockSql, 'missing-uuid');
            expect(result).toBeNull();
        });
    });

    describe('getMediaDetailByCompositeKey', () => {
        it('returns null when no results', async () => {
            const mockSql = Object.assign(vi.fn().mockResolvedValue([]), {
                unsafe: vi.fn().mockReturnValue(''),
            }) as unknown as postgres.Sql;

            const result = await getMediaDetailByCompositeKey(mockSql, {
                provider: 'tmdb',
                externalId: '550',
                mediaType: 'movie',
            });
            expect(result).toBeNull();
        });
    });

    describe('getCachedListItemByCompositeKey', () => {
        it('returns null when no results', async () => {
            const mockSql = Object.assign(vi.fn().mockResolvedValue([]), {
                unsafe: vi.fn().mockReturnValue(''),
            }) as unknown as postgres.Sql;

            const result = await getCachedListItemByCompositeKey(mockSql, {
                provider: 'tmdb',
                externalId: '550',
                mediaType: 'movie',
            });
            expect(result).toBeNull();
        });
    });
});
