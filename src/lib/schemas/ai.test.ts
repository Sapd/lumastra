// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit Tests for AI Schema Validation
 *
 * Covers the episode ratings critical path:
 * - externalIdsSchema accepts { internal } UUID-only payloads
 * - rateContentBodySchema accepts episode-only (internal UUID) payloads
 */

import { describe, it, expect } from 'vitest';
import { externalIdsSchema } from './common.js';
import { rateContentBodySchema } from './ai.js';

// ============================================================================
// externalIdsSchema
// ============================================================================

describe('externalIdsSchema', () => {
    it('accepts internal UUID alone', () => {
        const result = externalIdsSchema.safeParse({
            internal: '550e8400-e29b-41d4-a716-446655440000',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.internal).toBe('550e8400-e29b-41d4-a716-446655440000');
        }
    });

    it('accepts tmdb alone', () => {
        const result = externalIdsSchema.safeParse({ tmdb: '12345' });
        expect(result.success).toBe(true);
    });

    it('accepts tmdb + internal together', () => {
        const result = externalIdsSchema.safeParse({
            tmdb: '12345',
            internal: '550e8400-e29b-41d4-a716-446655440000',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.tmdb).toBe('12345');
            expect(result.data.internal).toBe('550e8400-e29b-41d4-a716-446655440000');
        }
    });

    it('rejects empty object (no IDs)', () => {
        const result = externalIdsSchema.safeParse({});
        expect(result.success).toBe(false);
    });

    it('rejects object where all values are empty strings', () => {
        const result = externalIdsSchema.safeParse({ tmdb: '', imdb: '' });
        expect(result.success).toBe(false);
    });

    it('coerces numeric tmdb to string', () => {
        const result = externalIdsSchema.safeParse({ tmdb: 12345 });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.tmdb).toBe('12345');
        }
    });
});

// ============================================================================
// rateContentBodySchema — episode (internal UUID only)
// ============================================================================

describe('rateContentBodySchema', () => {
    it('accepts episode payload with internal UUID and rating', () => {
        const result = rateContentBodySchema.safeParse({
            externalIds: { internal: '550e8400-e29b-41d4-a716-446655440000' },
            mediaType: 'tv',
            rating: 8,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.externalIds.internal).toBe('550e8400-e29b-41d4-a716-446655440000');
            expect(result.data.mediaType).toBe('tv');
            expect(result.data.rating).toBe(8);
        }
    });

    it('accepts episode payload with skip flag', () => {
        const result = rateContentBodySchema.safeParse({
            externalIds: { internal: '550e8400-e29b-41d4-a716-446655440000' },
            mediaType: 'tv',
            skip: true,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.skip).toBe(true);
        }
    });

    it('accepts movie payload with tmdb ID', () => {
        const result = rateContentBodySchema.safeParse({
            externalIds: { tmdb: '550' },
            mediaType: 'movie',
            rating: 9,
        });
        expect(result.success).toBe(true);
    });

    it('rejects when no externalIds provided', () => {
        const result = rateContentBodySchema.safeParse({
            mediaType: 'tv',
            rating: 7,
        });
        expect(result.success).toBe(false);
    });

    it('rejects when externalIds has no recognized IDs', () => {
        const result = rateContentBodySchema.safeParse({
            externalIds: {},
            mediaType: 'tv',
            rating: 7,
        });
        expect(result.success).toBe(false);
    });

    it('rejects when neither rating nor skip provided', () => {
        const result = rateContentBodySchema.safeParse({
            externalIds: { tmdb: '550' },
            mediaType: 'movie',
        });
        expect(result.success).toBe(false);
    });

    it('rejects when mediaType missing', () => {
        const result = rateContentBodySchema.safeParse({
            externalIds: { tmdb: '550' },
            rating: 7,
        });
        expect(result.success).toBe(false);
    });

    it('normalizes snake_case media_type to mediaType', () => {
        const result = rateContentBodySchema.safeParse({
            externalIds: { tmdb: '550' },
            media_type: 'movie',
            rating: 7,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.mediaType).toBe('movie');
        }
    });

    it("accepts ratingStyle 'quick'", () => {
        const result = rateContentBodySchema.safeParse({
            externalIds: { tmdb: '550' },
            mediaType: 'movie',
            rating: 9,
            ratingStyle: 'quick',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.ratingStyle).toBe('quick');
        }
    });

    it("accepts ratingStyle 'stars'", () => {
        const result = rateContentBodySchema.safeParse({
            externalIds: { tmdb: '550' },
            mediaType: 'movie',
            rating: 6,
            ratingStyle: 'stars',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.ratingStyle).toBe('stars');
        }
    });

    it('ratingStyle is optional (omitted → undefined)', () => {
        const result = rateContentBodySchema.safeParse({
            externalIds: { tmdb: '550' },
            mediaType: 'movie',
            rating: 7,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.ratingStyle).toBeUndefined();
        }
    });

    it('rejects unknown ratingStyle values', () => {
        const result = rateContentBodySchema.safeParse({
            externalIds: { tmdb: '550' },
            mediaType: 'movie',
            rating: 7,
            ratingStyle: 'thumbs',
        });
        expect(result.success).toBe(false);
    });
});
