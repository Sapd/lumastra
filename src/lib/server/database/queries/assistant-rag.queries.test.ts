// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Type-level and export tests for assistant-rag.queries.ts
 *
 * Verifies all 7 functions and 3 interfaces are exported with correct signatures.
 */
import { describe, it, expect } from 'vitest';
import type {
    AssistantMovieRow,
    AssistantMovieSimilarityRow,
    UserRatingContextRow,
} from './assistant-rag.queries.js';
import {
    incrementChatUsage,
    getUserRateLimitUsage,
    findRelevantMediaByVector,
    getUserRecentRatings,
    searchMediaByTitle,
    getRemainingMessages,
    getUserRateLimitInfo,
} from './assistant-rag.queries.js';

describe('assistant-rag.queries exports', () => {
    it('exports all 7 query functions', () => {
        expect(typeof incrementChatUsage).toBe('function');
        expect(typeof getUserRateLimitUsage).toBe('function');
        expect(typeof findRelevantMediaByVector).toBe('function');
        expect(typeof getUserRecentRatings).toBe('function');
        expect(typeof searchMediaByTitle).toBe('function');
        expect(typeof getRemainingMessages).toBe('function');
        expect(typeof getUserRateLimitInfo).toBe('function');
    });
});

describe('AssistantMovieRow interface', () => {
    it('accepts valid row shape', () => {
        const row: AssistantMovieRow = {
            media_id: 'uuid-1',
            primary_ext_id: '550',
            title: 'Quiet Orbit',
            media_type: 'movie',
            overview: 'A depressed man...',
            genres: [18, 53],
            imdb_rating: 8.8,
            rt_rating: 79,
            runtime_minutes: 139,
            release_date: '1999-01-01',
            actors: ['Bram Fenwick', 'Edward Vale'],
            directors: ['David Fincher'],
            is_available: true,
            can_request: false,
            user_rating: 9,
        };
        expect(row.media_id).toBe('uuid-1');
        expect(row.media_type).toBe('movie');
    });

    it('accepts tv media_type', () => {
        const row: AssistantMovieRow = {
            media_id: 'uuid-2',
            primary_ext_id: '1234',
            title: 'Drifting Clouds',
            media_type: 'tv',
        };
        expect(row.media_type).toBe('tv');
    });
});

describe('AssistantMovieSimilarityRow interface', () => {
    it('extends AssistantMovieRow with similarity field', () => {
        const row: AssistantMovieSimilarityRow = {
            media_id: 'uuid-3',
            primary_ext_id: '9876',
            title: 'The Lantern',
            media_type: 'movie',
            similarity: 0.12345,
        };
        expect(row.similarity).toBeTypeOf('number');
    });
});

describe('UserRatingContextRow interface', () => {
    it('accepts valid rating context shape', () => {
        const row: UserRatingContextRow = {
            title: 'Daydream',
            genres: [878, 28],
            rating: 8,
            is_available: true,
        };
        expect(row.rating).toBe(8);
    });
});
