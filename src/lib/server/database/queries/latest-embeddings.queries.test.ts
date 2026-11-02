// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import type { LatestEmbeddingRow } from './latest-embeddings.queries.js';
import { getLatestEmbeddings } from './latest-embeddings.queries.js';

describe('latest-embeddings.queries exports', () => {
    it('exports getLatestEmbeddings function', () => {
        expect(typeof getLatestEmbeddings).toBe('function');
    });

    it('LatestEmbeddingRow type has required fields', () => {
        const row: LatestEmbeddingRow = {
            internal_id: 'uuid-123',
            primary_ext_id: 'tmdb-456',
            media_type: 'movie',
            title: 'Test Movie',
            has_library: false,
            has_discovery: true,
        };
        expect(row.internal_id).toBe('uuid-123');
        expect(row.media_type).toBe('movie');
        expect(row.has_library).toBe(false);
        expect(row.has_discovery).toBe(true);
    });

    it('LatestEmbeddingRow allows optional nullable fields', () => {
        const row: LatestEmbeddingRow = {
            internal_id: 'uuid-789',
            primary_ext_id: '',
            media_type: 'tv',
            title: 'Test Series',
            has_library: true,
            has_discovery: false,
            overview: null,
            genres: null,
            actors: null,
            directors: null,
            release_date: null,
            runtime_minutes: null,
            updated_at: null,
            created_at: null,
            library_last_updated: null,
            discovery_last_updated: null,
        };
        expect(row.overview).toBeNull();
        expect(row.genres).toBeNull();
    });

    it('LatestEmbeddingRow accepts Date objects for date fields', () => {
        const now = new Date();
        const row: LatestEmbeddingRow = {
            internal_id: 'uuid-abc',
            primary_ext_id: 'tmdb-789',
            media_type: 'movie',
            title: 'Another Movie',
            has_library: true,
            has_discovery: true,
            release_date: now,
            updated_at: now,
            created_at: now,
            library_last_updated: now,
            discovery_last_updated: now,
        };
        expect(row.release_date).toBe(now);
        expect(row.updated_at).toBe(now);
    });

    it('LatestEmbeddingRow accepts arrays for array fields', () => {
        const row: LatestEmbeddingRow = {
            internal_id: 'uuid-def',
            primary_ext_id: 'tmdb-321',
            media_type: 'movie',
            title: 'Array Movie',
            has_library: false,
            has_discovery: false,
            genres: [28, 12, 878],
            keywords: ['action', 'sci-fi'],
            actors: ['Actor One', 'Actor Two'],
            directors: ['Director One'],
            streaming_services: ['Harborline', 'Lanternbox'],
        };
        expect(row.genres).toEqual([28, 12, 878]);
        expect(row.keywords).toEqual(['action', 'sci-fi']);
        expect(row.actors).toHaveLength(2);
    });
});
