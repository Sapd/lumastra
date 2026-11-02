// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Media Test Fixtures
 *
 * Provides factory functions for creating test media items, external IDs, and embeddings.
 * All data is hallucinated to avoid conflicts with real production data.
 */

import type { Sql } from 'postgres';
import {
    EMBEDDING_SOURCE,
    type EmbeddingSource,
} from '../../../src/lib/server/utils/embedding-source.js';
import { normalizeJellyfinId } from '../../../src/lib/server/utils/jellyfin-id.js';

// =============================================================================
// Types
// =============================================================================

export type MediaType =
    | 'movie'
    | 'tv'
    | 'episode'
    | 'season'
    | 'track'
    // Container and auxiliary rows that also live in media_items. Needed to
    // build artist→album→track / tv→season→episode hierarchies in tests.
    | 'artist'
    | 'album'
    | 'extra'
    // AudiobookShelf-sourced books. A real `media_items.media_type` since the
    // audiobook work — it was missing here only because every audiobook suite so
    // far inserted its rows with raw SQL and never went through this fixture.
    | 'audiobook';

export interface TestMediaItem {
    id: string;
    title: string;
    original_title: string | null;
    media_type: MediaType;
    year: number | null;
    status: 'active' | 'merged' | 'deleted';
    parent_id: string | null;
    has_files: boolean;
}

export interface TestExternalId {
    media_id: string;
    provider: 'tmdb' | 'imdb' | 'jellyfin' | 'jellyseerr' | 'tvdb';
    external_id: string;
    media_type: MediaType | null;
    is_primary: boolean;
}

export interface TestMediaEmbedding {
    media_id: string;
    embedding: number[];
    source: EmbeddingSource | 'custom';
}

// =============================================================================
// Sample Hallucinated Content
// =============================================================================

/**
 * Hallucinated movies for testing.
 * These do NOT correspond to real TMDB entries.
 */
export const SAMPLE_MOVIES = [
    {
        title: 'The Quantum Paradox',
        original_title: 'The Quantum Paradox',
        year: 2024,
        tmdb_id: 990001,
        imdb_id: 'tt9990001',
        overview: 'A physicist discovers a way to communicate with parallel universes.',
        jellyfin_id: 'jf-quantum-paradox-001',
    },
    {
        title: 'Midnight Echoes',
        original_title: 'Midnight Echoes',
        year: 2023,
        tmdb_id: 990002,
        imdb_id: 'tt9990002',
        overview: 'A jazz musician uncovers secrets in abandoned recording studios.',
        jellyfin_id: 'jf-midnight-echoes-002',
    },
    {
        title: 'Silent Horizons',
        original_title: 'Silent Horizons',
        year: 2024,
        tmdb_id: 990003,
        imdb_id: 'tt9990003',
        overview: 'Deep space explorers face their greatest challenge.',
        jellyfin_id: 'jf-silent-horizons-003',
    },
    {
        title: 'Urban Legends',
        original_title: 'Urban Legends',
        year: 2022,
        tmdb_id: 990004,
        imdb_id: 'tt9990004',
        overview: 'A documentary filmmaker investigates city myths.',
        jellyfin_id: 'jf-urban-legends-004',
    },
    {
        title: 'Digital Frontier',
        original_title: 'Digital Frontier',
        year: 2025,
        tmdb_id: 990005,
        imdb_id: 'tt9990005',
        overview: 'Hackers race against time to prevent a global cyber attack.',
        jellyfin_id: 'jf-digital-frontier-005',
    },
] as const;

/**
 * Hallucinated TV shows for testing.
 */
export const SAMPLE_TV_SHOWS = [
    {
        title: 'Lumastra Chronicles',
        original_title: 'Lumastra Chronicles',
        year: 2024,
        tmdb_id: 880001,
        imdb_id: 'tt8880001',
        overview: 'The first human colony on Mars faces unexpected challenges.',
        jellyfin_id: 'jf-lumastra-chronicles-001',
        seasons: 3,
        episodes_per_season: 10,
    },
    {
        title: 'Code Runners',
        original_title: 'Code Runners',
        year: 2023,
        tmdb_id: 880002,
        imdb_id: 'tt8880002',
        overview: 'Elite programmers compete in underground coding battles.',
        jellyfin_id: 'jf-code-runners-002',
        seasons: 2,
        episodes_per_season: 8,
    },
    {
        title: 'Neon Nights',
        original_title: 'Neon Nights',
        year: 2024,
        tmdb_id: 880003,
        imdb_id: 'tt8880003',
        overview: 'A noir detective series set in a cyberpunk future.',
        jellyfin_id: 'jf-neon-nights-003',
        seasons: 4,
        episodes_per_season: 12,
    },
] as const;

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Create a test media item with sensible defaults.
 */
export function createTestMediaItem(
    overrides: Partial<TestMediaItem> & { media_type: MediaType } = {
        media_type: 'movie',
    },
): TestMediaItem {
    const id = overrides.id || crypto.randomUUID();
    const mediaType = overrides.media_type || 'movie';
    const sample = mediaType === 'movie' ? SAMPLE_MOVIES[0] : SAMPLE_TV_SHOWS[0];

    return {
        id,
        title: overrides.title || sample.title,
        original_title: overrides.original_title ?? sample.original_title,
        media_type: mediaType,
        year: overrides.year ?? sample.year,
        status: overrides.status || 'active',
        parent_id: overrides.parent_id ?? null,
        has_files: overrides.has_files ?? false,
    };
}

/**
 * Create test external ID records.
 */
export function createTestExternalIds(
    mediaId: string,
    options: {
        tmdbId?: number;
        imdbId?: string;
        jellyfinId?: string;
        mediaType: MediaType;
    },
): TestExternalId[] {
    const ids: TestExternalId[] = [];

    if (options.tmdbId) {
        ids.push({
            media_id: mediaId,
            provider: 'tmdb',
            external_id: String(options.tmdbId),
            media_type: options.mediaType,
            is_primary: true,
        });
    }

    if (options.imdbId) {
        ids.push({
            media_id: mediaId,
            provider: 'imdb',
            external_id: options.imdbId,
            media_type: options.mediaType,
            is_primary: false,
        });
    }

    if (options.jellyfinId) {
        ids.push({
            media_id: mediaId,
            provider: 'jellyfin',
            external_id: options.jellyfinId,
            media_type: options.mediaType,
            is_primary: false,
        });
    }

    return ids;
}

/**
 * Create a simple test embedding vector.
 * Generates normalized random vectors for testing similarity search.
 */
export function createTestEmbedding(
    mediaId: string,
    source: EmbeddingSource | 'custom' = EMBEDDING_SOURCE.LIBRARY,
    dimension: number = 1024,
): TestMediaEmbedding {
    // Generate a random unit vector
    const embedding: number[] = [];
    let magnitude = 0;

    for (let i = 0; i < dimension; i++) {
        const val = Math.random() * 2 - 1; // Random between -1 and 1
        embedding.push(val);
        magnitude += val * val;
    }

    // Normalize to unit vector
    magnitude = Math.sqrt(magnitude);
    for (let i = 0; i < dimension; i++) {
        embedding[i] /= magnitude;
    }

    return { media_id: mediaId, embedding, source };
}

// =============================================================================
// Insert Functions
// =============================================================================

/**
 * Insert a test media item into the database.
 */
export async function insertTestMediaItem(sql: Sql, item: TestMediaItem): Promise<string> {
    await sql`
        INSERT INTO media_items (id, title, original_title, media_type, year, status, parent_id, has_files)
        VALUES (
            ${item.id}::uuid,
            ${item.title},
            ${item.original_title},
            ${item.media_type.toLowerCase()},
            ${item.year},
            ${item.status},
            ${item.parent_id ? sql`${item.parent_id}::uuid` : null},
            ${item.has_files}
        )
    `;
    return item.id;
}

/**
 * Insert multiple test media items.
 */
export async function insertTestMediaItems(sql: Sql, items: TestMediaItem[]): Promise<string[]> {
    const ids: string[] = [];
    for (const item of items) {
        await insertTestMediaItem(sql, item);
        ids.push(item.id);
    }
    return ids;
}

/**
 * Insert test external IDs.
 */
export async function insertTestExternalIds(
    sql: Sql,
    externalIds: TestExternalId[],
): Promise<void> {
    for (const ext of externalIds) {
        // Normalize Jellyfin IDs to dashless format before inserting — queries
        // always normalize the lookup key, so the stored form must match.
        const externalId =
            ext.provider === 'jellyfin' ? normalizeJellyfinId(ext.external_id) : ext.external_id;
        // eslint-disable-next-line no-restricted-syntax -- Test fixtures use direct SQL
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (
                ${ext.media_id}::uuid,
                ${ext.provider},
                ${externalId},
                ${ext.media_type},
                ${ext.is_primary}
            )
        `;
    }
}

/**
 * Insert test embedding.
 */
export async function insertTestEmbedding(sql: Sql, embedding: TestMediaEmbedding): Promise<void> {
    const vectorString = `[${embedding.embedding.join(',')}]`;
    await sql`
        INSERT INTO media_embeddings (media_id, embedding, source)
        VALUES (
            ${embedding.media_id}::uuid,
            ${vectorString}::vector,
            ${embedding.source}
        )
    `;
}

// =============================================================================
// Convenience Functions
// =============================================================================

/**
 * Create and insert a complete test movie with all related records.
 */
export async function createAndInsertTestMovie(
    sql: Sql,
    options: {
        title?: string;
        tmdbId?: number;
        imdbId?: string;
        jellyfinId?: string;
        withEmbedding?: boolean;
        withFileItem?: boolean;
    } = {},
): Promise<{ id: string; tmdbId: number }> {
    const id = crypto.randomUUID();
    const sample = SAMPLE_MOVIES[Math.floor(Math.random() * SAMPLE_MOVIES.length)];

    const tmdbId = options.tmdbId || sample.tmdb_id + Math.floor(Math.random() * 900000);
    // Generate unique IDs if not provided to avoid conflicts in batch operations
    const imdbId = options.imdbId || `tt${tmdbId}`;
    const jellyfinId = options.jellyfinId || `jf-movie-${tmdbId}-${id.slice(0, 8)}`;

    const item = createTestMediaItem({
        id,
        title: options.title || sample.title,
        original_title: sample.original_title,
        media_type: 'movie',
        year: sample.year,
    });

    const externalIds = createTestExternalIds(id, {
        tmdbId,
        imdbId,
        jellyfinId,
        mediaType: 'movie',
    });

    const reserved = await sql.reserve();
    try {
        const rSql = reserved as unknown as Sql;
        await insertTestMediaItem(rSql, item);
        await insertTestExternalIds(rSql, externalIds);

        if (options.withFileItem) {
            const fileId = crypto.randomUUID();
            await rSql`
                INSERT INTO media_files (id, file_path, created_at, updated_at)
                VALUES (${fileId}::uuid, ${`/test/movies/${id}.mkv`}, NOW(), NOW())
            `;
            await rSql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${id}::uuid)
            `;
            await rSql`
                UPDATE media_items SET has_files = true WHERE id = ${id}::uuid
            `;
        }
    } finally {
        reserved.release();
    }

    // Insert embedding standalone (vector operations are safe on any connection)
    if (options.withEmbedding) {
        const embedding = createTestEmbedding(id);
        await insertTestEmbedding(sql, embedding);
    }

    return { id, tmdbId };
}

/**
 * Create and insert a complete test TV show with all related records.
 */
export async function createAndInsertTestTvShow(
    sql: Sql,
    options: {
        title?: string;
        tmdbId?: number;
        imdbId?: string;
        jellyfinId?: string;
        withEmbedding?: boolean;
    } = {},
): Promise<{ id: string; tmdbId: number }> {
    const id = crypto.randomUUID();
    const sample = SAMPLE_TV_SHOWS[Math.floor(Math.random() * SAMPLE_TV_SHOWS.length)];

    const tmdbId = options.tmdbId || sample.tmdb_id + 1 + Math.floor(Math.random() * 900000);
    // Generate unique IDs if not provided to avoid conflicts in batch operations
    const imdbId = options.imdbId || `tt${tmdbId}`;
    const jellyfinId = options.jellyfinId || `jf-tv-${tmdbId}-${id.slice(0, 8)}`;

    const item = createTestMediaItem({
        id,
        title: options.title || sample.title,
        original_title: sample.original_title,
        media_type: 'tv',
        year: sample.year,
    });

    const externalIds = createTestExternalIds(id, {
        tmdbId,
        imdbId,
        jellyfinId,
        mediaType: 'tv',
    });

    const reserved = await sql.reserve();
    try {
        const rSql = reserved as unknown as Sql;
        await insertTestMediaItem(rSql, item);
        await insertTestExternalIds(rSql, externalIds);
    } finally {
        reserved.release();
    }

    // Insert embedding standalone (vector operations are safe on any connection)
    if (options.withEmbedding) {
        const embedding = createTestEmbedding(id);
        await insertTestEmbedding(sql, embedding);
    }

    return { id, tmdbId };
}

/**
 * Create multiple test movies in bulk.
 */
export async function createTestMovieBatch(
    sql: Sql,
    count: number,
    options: { withEmbeddings?: boolean } = {},
): Promise<Array<{ id: string; tmdbId: number }>> {
    const results: Array<{ id: string; tmdbId: number }> = [];

    for (let i = 0; i < count; i++) {
        const sample = SAMPLE_MOVIES[i % SAMPLE_MOVIES.length];
        const result = await createAndInsertTestMovie(sql, {
            title: `${sample.title} - Test ${i + 1}`,
            tmdbId: sample.tmdb_id + i * 1000, // Ensure unique IDs
            withEmbedding: options.withEmbeddings,
        });
        results.push(result);
    }

    return results;
}
