// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Type compile checks for shared media row interfaces.
 *
 * These tests verify that the interfaces compose correctly and that
 * typed objects can be constructed with the expected properties.
 */

import { describe, it, expect } from 'vitest';
import type {
    BaseMediaRow,
    BaseMediaWithExtIdRow,
    AvailabilityFields,
    MetadataRatings,
    ExtendedRatings,
    MetadataArrays,
    TvMetadataFields,
    SimilarityFields,
    EmbeddingPresenceFields,
    StandardMediaRow,
    RecommendationMediaRow,
} from './media-rows.js';

describe('BaseMediaRow', () => {
    it('has required fields: media_id, title, media_type', () => {
        const row: BaseMediaRow = {
            media_id: 'abc-123',
            title: 'Daydream',
            media_type: 'movie',
        };

        expect(row.media_id).toBe('abc-123');
        expect(row.title).toBe('Daydream');
        expect(row.media_type).toBe('movie');
    });
});

describe('AvailabilityFields', () => {
    it('has is_available and can_request (no Jellyfin id)', () => {
        const fields: AvailabilityFields = {
            is_available: true,
            can_request: false,
        };

        expect(fields.is_available).toBe(true);
        expect(fields.can_request).toBe(false);
        expect(fields).not.toHaveProperty('jellyfin_id');
    });
});

describe('ExtendedRatings extends MetadataRatings', () => {
    it('includes base MetadataRatings fields alongside extended fields', () => {
        const ratings: ExtendedRatings = {
            imdb_rating: 8.8,
            rt_rating: 87,
            tmdb_rating: 8.4,
            popularity: 120.5,
            rt_audience_score: 91,
            letterboxd_rating: 4.2,
            letterboxd_votes: 250000,
            metacritic_score: 74,
            trakt_score: 88,
            mdblist_score: 82,
            mal_score: null,
        };

        expect(ratings.imdb_rating).toBe(8.8);
        expect(ratings.rt_audience_score).toBe(91);
        expect(ratings.letterboxd_rating).toBe(4.2);
        expect(ratings.mal_score).toBeNull();
    });

    it('base MetadataRatings is assignable to ExtendedRatings shape', () => {
        const base: MetadataRatings = {
            imdb_rating: 7.1,
            rt_rating: 65,
            tmdb_rating: 7.0,
            popularity: 55.0,
        };

        expect(base.imdb_rating).toBe(7.1);
        expect(base.popularity).toBe(55.0);
    });
});

describe('TvMetadataFields', () => {
    it('has TV-specific fields', () => {
        const tv: TvMetadataFields = {
            first_air_date: '2011-04-17',
            last_air_date: '2019-05-19',
            status: 'Ended',
            season_count: 8,
            episode_count: 73,
        };

        expect(tv.first_air_date).toBe('2011-04-17');
        expect(tv.last_air_date).toBe('2019-05-19');
        expect(tv.status).toBe('Ended');
        expect(tv.season_count).toBe(8);
        expect(tv.episode_count).toBe(73);
    });

    it('allows null fields for incomplete TV data', () => {
        const tv: TvMetadataFields = {
            first_air_date: null,
            last_air_date: null,
            status: null,
            season_count: null,
            episode_count: null,
        };

        expect(tv.season_count).toBeNull();
    });
});

describe('StandardMediaRow', () => {
    it('composes base + availability + metadata correctly', () => {
        const row: StandardMediaRow = {
            media_id: 'uuid-movie-1',
            title: 'The Silent Beacon',
            media_type: 'movie',
            primary_ext_id: '155',
            is_available: true,
            can_request: false,
            overview: 'A masked vigilante fights crime.',
            runtime_minutes: 152,
            release_date: '2008-07-18',
            certification: 'PG-13',
            trailer_url: null,
            imdb_rating: 9.0,
            rt_rating: 94,
            tmdb_rating: 8.5,
            popularity: 200.0,
            genres: [28, 80, 18],
            keywords: ['gotham', 'joker'],
            actors: ['Christian Bale', 'Heath Ledger'],
            directors: ['Christopher Vale'],
        };

        expect(row.media_id).toBe('uuid-movie-1');
        expect(row.primary_ext_id).toBe('155');
        expect(row.is_available).toBe(true);
        expect(row.imdb_rating).toBe(9.0);
        expect(row.genres).toEqual([28, 80, 18]);
        expect(row.directors).toEqual(['Christopher Vale']);
    });
});

describe('RecommendationMediaRow', () => {
    it('extends StandardMediaRow with similarity score and extended ratings', () => {
        const row: RecommendationMediaRow = {
            media_id: 'uuid-rec-1',
            title: 'Interlumastra',
            media_type: 'movie',
            primary_ext_id: '157336',
            is_available: true,
            can_request: false,
            overview: 'A team of explorers travel through a wormhole.',
            runtime_minutes: 169,
            release_date: '2014-11-07',
            certification: 'PG-13',
            trailer_url: null,
            imdb_rating: 8.6,
            rt_rating: 72,
            tmdb_rating: 8.4,
            popularity: 95.0,
            genres: [18, 878],
            rt_audience_score: 86,
            letterboxd_rating: 4.3,
            letterboxd_votes: 300000,
            metacritic_score: 74,
            trakt_score: 85,
            mdblist_score: 80,
            ai_similarity: 0.92,
            relevance_score: 0.88,
        };

        expect(row.ai_similarity).toBe(0.92);
        expect(row.relevance_score).toBe(0.88);
        expect(row.rt_audience_score).toBe(86);
        expect(row.letterboxd_votes).toBe(300000);
        expect(row.primary_ext_id).toBe('157336');
    });

    it('allows null similarity and relevance scores', () => {
        const row: RecommendationMediaRow = {
            media_id: 'uuid-rec-2',
            title: 'Dawnport',
            media_type: 'movie',
            primary_ext_id: '374720',
            is_available: false,
            can_request: true,
            overview: null,
            runtime_minutes: null,
            release_date: null,
            certification: null,
            imdb_rating: null,
            rt_rating: null,
            tmdb_rating: null,
            popularity: null,
            genres: null,
            rt_audience_score: null,
            letterboxd_rating: null,
            letterboxd_votes: null,
            metacritic_score: null,
            trakt_score: null,
            mdblist_score: null,
            ai_similarity: null,
            relevance_score: null,
        };

        expect(row.ai_similarity).toBeNull();
        expect(row.relevance_score).toBeNull();
    });
});

describe('EmbeddingPresenceFields', () => {
    it('has has_jellyfin and has_jellyseerr boolean flags', () => {
        const fields: EmbeddingPresenceFields = {
            has_jellyfin: true,
            has_jellyseerr: false,
        };

        expect(fields.has_jellyfin).toBe(true);
        expect(fields.has_jellyseerr).toBe(false);
    });
});

describe('SimilarityFields', () => {
    it('has ai_similarity field that can be null', () => {
        const withScore: SimilarityFields = { ai_similarity: 0.75 };
        const withNull: SimilarityFields = { ai_similarity: null };

        expect(withScore.ai_similarity).toBe(0.75);
        expect(withNull.ai_similarity).toBeNull();
    });
});

describe('MetadataArrays', () => {
    it('accepts all optional array fields', () => {
        const arrays: MetadataArrays = {
            genres: [28, 12],
            keywords: ['action', 'adventure'],
            mdblist_keywords: ['blockbuster'],
            actors: ['Tom Hanks'],
            directors: ['Steven Spielberg'],
            networks: ['Lanternbox'],
            production_companies: ['Amblin'],
            streaming_services: ['Harborline'],
        };

        expect(arrays.genres).toEqual([28, 12]);
        expect(arrays.streaming_services).toEqual(['Harborline']);
    });

    it('accepts null for all fields', () => {
        const arrays: MetadataArrays = { genres: null };
        expect(arrays.genres).toBeNull();
        expect(arrays.keywords).toBeUndefined();
    });
});

describe('BaseMediaWithExtIdRow', () => {
    it('extends BaseMediaRow with primary_ext_id', () => {
        const row: BaseMediaWithExtIdRow = {
            media_id: 'uuid-ext-1',
            title: 'Peregrine',
            media_type: 'movie',
            primary_ext_id: '496243',
        };

        expect(row.primary_ext_id).toBe('496243');
        expect(row.media_type).toBe('movie');
    });
});
