// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for keyword-media query module exports and types
 */

import { describe, it, expect } from 'vitest';
import { findKeywordMediaPersonalized, findKeywordMedia } from './keyword-media.queries.js';
import type {
    KeywordMediaRow,
    KeywordMediaParams,
    KeywordMediaPersonalizedParams,
} from './keyword-media.queries.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    denyAllAccess,
    restrictedAccess,
    unrestrictedAccess,
} from './builders/media-access-boundary.js';

describe('keyword-media.queries', () => {
    it('exports findKeywordMediaPersonalized as a function', () => {
        expect(typeof findKeywordMediaPersonalized).toBe('function');
    });

    it('exports findKeywordMedia as a function', () => {
        expect(typeof findKeywordMedia).toBe('function');
    });

    it('KeywordMediaRow type compiles', () => {
        const row: KeywordMediaRow = {
            internal_id: 'uuid-123',
            primary_ext_id: 'tmdb-456',
            title: 'Test Movie',
            media_type: 'movie',
            overview: 'A test movie',
            imdb_rating: 7.5,
            rt_rating: 80,
            rt_audience_score: 75,
            letterboxd_rating: 3.8,
            mdblist_score: 72,
            release_date: '2023-01-01',
            popularity: 45.2,
            is_available: true,
            can_request: false,
            quality_score: 76,
            ai_similarity: 0.85,
        };
        expect(row.title).toBe('Test Movie');
    });

    it('KeywordMediaRow type allows nullable fields', () => {
        const row: KeywordMediaRow = {
            internal_id: null,
            primary_ext_id: 'tmdb-456',
            title: 'Test Movie',
            media_type: 'tv',
            overview: null,
            imdb_rating: null,
            rt_rating: null,
            rt_audience_score: null,
            letterboxd_rating: null,
            mdblist_score: null,
            release_date: null,
            popularity: null,
            is_available: null,
            can_request: null,
            quality_score: null,
            ai_similarity: null,
        };
        expect(row.media_type).toBe('tv');
    });

    it('KeywordMediaParams type compiles', () => {
        const params: KeywordMediaParams = {
            keyword: 'action',
            limit: 20,
            offset: 0,
            access: unrestrictedAccess(),
        };
        expect(params.keyword).toBe('action');
    });

    it('KeywordMediaPersonalizedParams type compiles', () => {
        const testUserId = toUserId('00000000-0000-0000-0000-000000000001');
        const params: KeywordMediaPersonalizedParams = {
            keyword: 'thriller',
            limit: 10,
            offset: 40,
            userId: testUserId,
            access: restrictedAccess({
                deniedGroupIds: ['11111111-1111-1111-1111-111111111111'],
                maxAgeRating: 13,
                allowUnrated: false,
            }),
        };
        expect(params.userId).toBe(testUserId);
    });

    // -------------------------------------------------------------------
    // denyAll short-circuits BEFORE any SQL is issued. Asserted with an sql
    // stub that throws — if the boundary were ignored, the query would run.
    // -------------------------------------------------------------------

    describe('denyAll short-circuit', () => {
        const explodingSql = new Proxy(
            () => {
                throw new Error('query issued despite denyAll boundary');
            },
            {
                get() {
                    throw new Error('query issued despite denyAll boundary');
                },
            },
        ) as unknown as Parameters<typeof findKeywordMedia>[0];

        it('findKeywordMedia returns empty without querying', async () => {
            await expect(
                findKeywordMedia(explodingSql, {
                    keyword: 'action',
                    limit: 20,
                    offset: 0,
                    access: denyAllAccess(),
                }),
            ).resolves.toEqual([]);
        });

        it('findKeywordMediaPersonalized returns empty without querying', async () => {
            await expect(
                findKeywordMediaPersonalized(explodingSql, {
                    keyword: 'action',
                    limit: 20,
                    offset: 0,
                    userId: toUserId('00000000-0000-0000-0000-000000000001'),
                    access: denyAllAccess(),
                }),
            ).resolves.toEqual([]);
        });
    });
});
