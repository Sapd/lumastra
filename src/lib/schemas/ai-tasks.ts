// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Zod schemas for AI task endpoint options
 *
 * These schemas validate the options body sent to BullMQ task enqueue
 * endpoints. All fields use `.default()` so that omitted fields get their
 * default values during parsing.
 */

import { z } from 'zod';

// ============================================================================
// Metadata Update (update-metadata)
// ============================================================================

/**
 * Options for the metadata update task.
 * Updates existing items in the database with missing metadata from TMDB.
 */
export const MetadataUpdateOptionsSchema = z.object({
    batchSize: z.coerce.number().int().positive().default(50),
});

export type MetadataUpdateOptions = z.infer<typeof MetadataUpdateOptionsSchema>;

// ============================================================================
// TMDB Metadata Sync (sync-tmdb-metadata)
// ============================================================================

/**
 * Options for syncing metadata from TMDB API.
 * Phase 1: fetches metadata and stores it without generating embeddings.
 */
export const TmdbMetadataSyncOptionsSchema = z.object({
    maxMovies: z.coerce.number().int().positive().default(5000),
    maxSeries: z.coerce.number().int().positive().default(5000),
    minRating: z.coerce.number().min(0).default(4.0),
    minVotes: z.coerce.number().int().min(0).default(20),
    minPopularity: z.coerce.number().min(0).default(1),
    missingOnly: z.boolean().default(true),
    fetchDetails: z.boolean().default(false),
});

export type TmdbMetadataSyncOptions = z.infer<typeof TmdbMetadataSyncOptionsSchema>;

// ============================================================================
// Series Metadata Sync (sync-series-metadata)
// ============================================================================

/**
 * Options for syncing episode metadata from Jellyfin.
 */
export const SeriesMetadataSyncOptionsSchema = z.object({
    batchSize: z.coerce.number().int().positive().default(10),
    seriesIds: z
        .array(z.string())
        .optional()
        .transform((ids) => (ids && ids.length > 0 ? ids : undefined)),
    forceRefresh: z.boolean().default(false),
});

export type SeriesMetadataSyncOptions = z.infer<typeof SeriesMetadataSyncOptionsSchema>;

// ============================================================================
// Metadata Sync (sync-metadata)
// ============================================================================

const metadataSyncFieldSchema = z.enum([
    'imdb_id',
    'actors',
    'directors',
    'producers',
    'writers',
    'keywords',
    'networks',
]);

/**
 * Options for the metadata sync task.
 * Syncs missing fields from TMDB for items already in the database.
 */
export const MetadataSyncOptionsSchema = z.object({
    batchSize: z.coerce.number().int().positive().default(100),
    missingFields: z.array(metadataSyncFieldSchema).default(['imdb_id', 'actors', 'directors']),
    updateEmbeddings: z.boolean().default(false),
});

export type MetadataSyncOptions = z.infer<typeof MetadataSyncOptionsSchema>;

// ============================================================================
// MDBList Sync (sync-mdblist)
// ============================================================================

/**
 * Options for syncing ratings from MDBList.
 */
export const MdblistSyncOptionsSchema = z.object({
    limit: z.coerce.number().int().positive().optional(),
    mediaType: z.enum(['movie', 'tv', 'all']).default('all'),
    fullRefresh: z.boolean().default(false),
    refreshAfterHours: z.coerce.number().int().min(0).default(168),
});

export type MdblistSyncOptions = z.infer<typeof MdblistSyncOptionsSchema>;

// ============================================================================
// Jellyfin Metadata Sync (sync-jellyfin-metadata)
// ============================================================================

/**
 * Options for syncing metadata from Jellyfin.
 * Phase 1: fetches metadata without generating embeddings.
 */
export const JellyfinMetadataSyncOptionsSchema = z.object({
    missingOnly: z.boolean().default(true),
    batchSize: z.coerce.number().int().positive().default(50),
});

export type JellyfinMetadataSyncOptions = z.infer<typeof JellyfinMetadataSyncOptionsSchema>;

// ============================================================================
// Discovery Embeddings (discovery-embeddings)
// ============================================================================

/**
 * Options for discovery embedding generation.
 * Reads from the database (provider_metadata + mdblist ratings) — no external API calls.
 */
export const DiscoveryEmbeddingOptionsSchema = z.object({
    force: z.boolean().default(false),
    batchSize: z.coerce.number().int().positive().default(10),
});

export type DiscoveryEmbeddingOptions = z.infer<typeof DiscoveryEmbeddingOptionsSchema>;
