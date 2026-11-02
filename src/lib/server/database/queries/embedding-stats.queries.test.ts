// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import type {
    QualityRow,
    CoverageRow,
    EmbeddingItemRow,
    MediaTypeCountRow,
    SourceCountRow,
    OverviewCountsRow,
    MusicQualityRow,
    MusicItemRow,
} from './embedding-stats.queries.js';
import {
    getEmbeddingOverviewStats,
    getVideoEmbeddingStats,
    getMusicEmbeddingStats,
} from './embedding-stats.queries.js';

describe('embedding-stats.queries exports', () => {
    it('exports getEmbeddingOverviewStats function', () => {
        expect(typeof getEmbeddingOverviewStats).toBe('function');
    });

    it('exports getVideoEmbeddingStats function', () => {
        expect(typeof getVideoEmbeddingStats).toBe('function');
    });

    it('exports getMusicEmbeddingStats function', () => {
        expect(typeof getMusicEmbeddingStats).toBe('function');
    });

    it('MediaTypeCountRow type has required fields', () => {
        const row: MediaTypeCountRow = { media_type: 'movie', count: '42' };
        expect(row.media_type).toBe('movie');
        expect(row.count).toBe('42');
    });

    it('SourceCountRow type has required fields', () => {
        const row: SourceCountRow = { source: 'library', count: '10' };
        expect(row.source).toBe('library');
    });

    it('OverviewCountsRow type has required fields', () => {
        const row: OverviewCountsRow = {
            without_external_id: '5',
            in_library: '80',
            requestable_only: '15',
        };
        expect(row.in_library).toBe('80');
    });

    it('QualityRow type has all required fields', () => {
        const row: QualityRow = {
            with_mdblist_keywords: '100',
            with_mdblist_score: '90',
            with_streaming_services: '80',
            missing_genres: '5',
            missing_overview: '3',
            missing_actors: '7',
            missing_directors: '4',
            very_short_overview: '2',
            avg_overview_length: 250,
            avg_actor_count: 5.2,
            avg_genre_count: 3.1,
        };
        expect(row.with_mdblist_keywords).toBe('100');
        expect(row.avg_overview_length).toBe(250);
    });

    it('CoverageRow type has all required fields', () => {
        const row: CoverageRow = {
            has_library_embedding: '50',
            has_discovery_embedding: '60',
            has_both_embeddings: '40',
            no_embeddings: '10',
        };
        expect(row.has_library_embedding).toBe('50');
        expect(row.no_embeddings).toBe('10');
    });

    it('EmbeddingItemRow type has all required fields', () => {
        const row: EmbeddingItemRow = {
            id: 'uuid-123',
            primary_ext_id: 'tmdb-456',
            title: 'Test Movie',
            media_type: 'movie',
            genres: [28, 12],
            created_at: new Date('2024-01-01'),
        };
        expect(row.id).toBe('uuid-123');
        expect(row.media_type).toBe('movie');
        expect(row.genres).toEqual([28, 12]);
    });

    it('EmbeddingItemRow allows null genres and optional created_at', () => {
        const row: EmbeddingItemRow = {
            id: 'uuid-456',
            primary_ext_id: '',
            title: 'Local Only',
            media_type: 'tv',
            genres: null,
        };
        expect(row.genres).toBeNull();
        expect(row.created_at).toBeUndefined();
    });

    it('MusicQualityRow type has all required fields', () => {
        const row: MusicQualityRow = {
            total_tracks: '100',
            with_embedding: '80',
            missing_artist: '5',
            missing_album: '10',
            missing_genre: '15',
            missing_bpm: '50',
            missing_mood_tags: '40',
            avg_genre_count: 2.5,
        };
        expect(row.total_tracks).toBe('100');
        expect(row.avg_genre_count).toBe(2.5);
    });

    it('MusicItemRow type has all required fields', () => {
        const row: MusicItemRow = {
            id: 'uuid-789',
            title: 'Test Track',
            artist: 'Test Artist',
            album: 'Test Album',
            genres: ['rock', 'pop'],
            has_embedding: true,
            created_at: new Date('2024-06-01'),
        };
        expect(row.title).toBe('Test Track');
        expect(row.has_embedding).toBe(true);
    });

    it('MusicItemRow allows null album and genres', () => {
        const row: MusicItemRow = {
            id: 'uuid-999',
            title: 'Minimal Track',
            artist: '',
            album: null,
            genres: null,
            has_embedding: false,
        };
        expect(row.album).toBeNull();
        expect(row.genres).toBeNull();
    });
});
