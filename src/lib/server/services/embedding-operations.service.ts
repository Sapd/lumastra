// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Operations Service
 *
 * Handles complex embedding write operations with:
 * - Transaction management
 * - Race condition handling
 * - Metadata aggregation
 * - CatalogService coordination
 *
 * This service extracts the complex orchestration logic from Database class
 * that involves multiple table writes and service coordination.
 *
 * @module services/embedding-operations
 */

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import type { MediaEmbedding } from '../database/connection.js';
import { CatalogService } from './catalog.service.js';
import { MediaLifecycleService } from './media-lifecycle.service.js';
import { Logger } from '../utils/logger.js';
import { parseEmbedding as parseEmbeddingVector } from '../utils/embedding-utils.js';
import * as EmbeddingQueries from '../database/queries/embedding-operations.queries.js';
import { upsertProviderMetadataUnlessLocked } from '../database/queries/media-upsert.js';
import { EMBEDDING_SOURCE, type EmbeddingSource } from '../utils/embedding-source.js';
import { isDiscoveryCatalogEnabled } from '../config.js';
import { resolveExternalIdToUuid } from '../database/queries/media-lookup.queries.js';

const logger = Logger.for('EmbeddingOperationsService');

/**
 * Thrown by `upsertMediaEmbedding` when the item has no catalog row yet and no
 * discovery surface can show a new fileless row (`isDiscoveryCatalogEnabled()`
 * is false). Callers treat it as a skip, not a failure.
 */
export class DiscoveryCatalogDisabledError extends Error {
    constructor(tmdbId: number) {
        super(`Discovery catalog disabled: not creating a media item for TMDB ${tmdbId}`);
        this.name = 'DiscoveryCatalogDisabledError';
    }
}

// =============================================================================
// Types
// =============================================================================

export interface MediaEmbeddingInput {
    tmdb_id: number;
    /**
     * @deprecated Pass mediaType as an explicit boundary parameter to
     * upsertMediaEmbedding instead. This field is no longer used for
     * composite-key operations; the explicit parameter is authoritative.
     */
    media_type?: 'movie' | 'tv';
    title: string;
    original_title?: string;
    release_date?: string;
    release_year?: number;
    imdb_id?: string;
    embedding?: number[] | string;
    is_local_only?: boolean;
    // Additional fields...
}

// =============================================================================
// Service Class
// =============================================================================

/**
 * Service for managing complex embedding operations.
 * Coordinates with CatalogService for media item management.
 */
export class EmbeddingOperationsService {
    private catalogService: CatalogService;
    private readonly skipLifecycleHooks: boolean;

    constructor(
        private sql: postgres.Sql,
        catalogService?: CatalogService,
        opts?: { skipLifecycleHooks?: boolean },
    ) {
        this.skipLifecycleHooks = opts?.skipLifecycleHooks ?? false;
        // Use skipLifecycleHooks on the inner CatalogService so
        // getOrCreateMinimalByTmdb does NOT fire a fire-and-forget afterCreated
        // before the embedding/metadata transaction commits. upsertMediaEmbedding
        // fires afterCreated explicitly after the full write is durable (below).
        this.catalogService =
            catalogService ?? new CatalogService(sql, { skipLifecycleHooks: true });
    }

    /**
     * Upsert media embedding with full transaction management.
     *
     * Handles:
     * - Media item creation/lookup (race-safe)
     * - Title validation
     * - External ID management via CatalogService
     * - Provider metadata updates
     * - Embedding vector upserts
     * - Transaction coordination
     *
     * @param media - Media embedding data (without id/timestamps)
     * @param mediaType - Required: the media type for composite-key operations.
     *   Must be provided explicitly at the call boundary — do not rely on the
     *   deprecated `media.media_type` field for identity-critical lookups.
     *   Must be 'movie' or 'tv' (this service operates on TMDB-sourced content).
     * @param embeddingType - Source type (library/discovery)
     * @returns Complete MediaEmbedding record
     */
    async upsertMediaEmbedding(
        media: Omit<MediaEmbedding, 'id' | 'created_at' | 'updated_at' | 'media_type'> & {
            /** @deprecated Use the explicit mediaType boundary parameter instead. */
            media_type?: 'movie' | 'tv';
        },
        mediaType: 'movie' | 'tv',
        embeddingType?: EmbeddingSource,
    ): Promise<MediaEmbedding> {
        // Validate title - skip records with invalid titles
        if (
            !media.title ||
            media.title.trim() === '' ||
            media.title === 'undefined' ||
            media.title === 'null'
        ) {
            logger.warn('Skipping media embedding with invalid title', {
                tmdbId: media.tmdb_id,
                title: media.title,
            });
            throw new Error(`Invalid title for TMDB ${media.tmdb_id}`);
        }

        const sourceType = embeddingType ?? EMBEDDING_SOURCE.LIBRARY;

        // Format embedding vector for PostgreSQL
        const embeddingVector = this.formatEmbeddingVector(media.embedding);

        // Extract year from release_date if available
        const year = this.extractYear(media.release_date, media.release_year);

        const isValidTmdbId = media.tmdb_id != null && this.isValidTmdbId(media.tmdb_id);

        // Get or create the media item with UUID (race-safe via CatalogService).
        // Use the explicit mediaType boundary parameter for the composite-key
        // lookup — never media.media_type, which is a deprecated input-bag field.
        // The outer catalogService is constructed with skipLifecycleHooks=true so
        // afterCreated is NOT fired here; we fire it explicitly after the full
        // write (metadata + embedding) is durable below.
        let mediaId: string;
        let itemIsNew: boolean;
        if (isValidTmdbId) {
            if (isDiscoveryCatalogEnabled()) {
                const result = await this.catalogService.getOrCreateMinimalByTmdb(
                    media.tmdb_id!,
                    mediaType,
                    media.title,
                    media.original_title,
                    year,
                );
                mediaId = result.id;
                itemIsNew = result.isNew;
            } else {
                // No surface can show a new fileless row: only attach the
                // embedding to a row that already exists.
                const existingId = await resolveExternalIdToUuid(
                    this.sql,
                    String(media.tmdb_id),
                    mediaType,
                    'tmdb',
                );
                if (!existingId) throw new DiscoveryCatalogDisabledError(media.tmdb_id!);
                mediaId = existingId;
                itemIsNew = false;
            }
        } else {
            throw new Error(`Missing valid TMDB ID for item: ${media.title}`);
        }

        // Build metadata object for provider_metadata
        const metadata: Record<string, postgres.JSONValue> = {};
        if (media.overview) metadata.overview = media.overview;
        if (media.genres?.length) metadata.genres = media.genres;
        if (media.vote_average) metadata.vote_average = media.vote_average;
        if (media.vote_count) metadata.vote_count = media.vote_count;
        if (media.popularity) metadata.popularity = media.popularity;
        if (media.runtime_minutes) metadata.runtime_minutes = media.runtime_minutes;
        if (media.budget) metadata.budget = media.budget;
        if (media.revenue) metadata.revenue = media.revenue;
        if (media.actors?.length) metadata.actors = media.actors;
        if (media.directors?.length) metadata.directors = media.directors;
        if (media.producers?.length) metadata.producers = media.producers;
        if (media.writers?.length) metadata.writers = media.writers;
        if (media.keywords?.length) metadata.keywords = media.keywords;
        if (media.networks?.length) metadata.networks = media.networks;
        if (media.production_companies?.length)
            metadata.production_companies = media.production_companies;
        if (media.spoken_languages?.length) metadata.spoken_languages = media.spoken_languages;
        if (media.production_countries?.length)
            metadata.production_countries = media.production_countries;
        if (media.certification) metadata.certification = media.certification;
        if (media.imdb_rating) metadata.imdb_rating = media.imdb_rating;
        if (media.rt_rating) metadata.rt_rating = media.rt_rating;
        if (media.rt_audience_score) metadata.rt_audience_score = media.rt_audience_score;
        if (media.mdblist_score) metadata.mdblist_score = media.mdblist_score;
        if (media.mdblist_keywords?.length) metadata.mdblist_keywords = media.mdblist_keywords;
        if (media.letterboxd_rating) metadata.letterboxd_rating = media.letterboxd_rating;
        if (media.letterboxd_votes) metadata.letterboxd_votes = media.letterboxd_votes;
        if (media.metacritic_score) metadata.metacritic_score = media.metacritic_score;
        if (media.trakt_score) metadata.trakt_score = media.trakt_score;
        if (media.mal_score) metadata.mal_score = media.mal_score;
        if (media.mal_votes) metadata.mal_votes = media.mal_votes;
        if (media.streaming_services?.length)
            metadata.streaming_services = media.streaming_services;
        if (media.anime_genres?.length) metadata.anime_genres = media.anime_genres;
        if (media.poster_path) metadata.poster_path = media.poster_path;
        if (media.backdrop_path) metadata.backdrop_path = media.backdrop_path;
        if (media.trailer_url) metadata.trailer_url = media.trailer_url;

        // Wrap all multi-table writes in a single transaction so a mid-write
        // crash cannot leave a media item without its embedding or external IDs.
        // postgres.js types TransactionSql and Sql as distinct generics; cast via unknown.
        //
        // Use a CatalogService with skipLifecycleHooks=true inside the transaction,
        // then fire lifecycle hooks AFTER the transaction commits to avoid
        // cache invalidation racing with uncommitted data.
        let externalIdChanged = false;
        await withTx(this.sql, async (txRaw) => {
            const tx = txRaw as unknown as postgres.Sql;
            const txCatalog = new CatalogService(tx, {
                skipLifecycleHooks: true,
            });

            // Update media_items title/year if changed
            await EmbeddingQueries.updateMediaItemMetadata(tx, {
                mediaId,
                title: media.title,
                originalTitle: media.original_title || null,
                year: year || null,
                isLocalOnly: media.is_local_only || !isValidTmdbId,
            });

            // Use CatalogService for external_ids writes (centralized access).
            // Use the explicit mediaType boundary parameter for all composite-key
            // writes — never the deprecated media.media_type input-bag field.
            if (media.imdb_id) {
                await txCatalog.upsertExternalId(mediaId, {
                    provider: 'imdb',
                    id: media.imdb_id,
                    mediaType,
                    source: 'api',
                });
                externalIdChanged = true;
            }

            // Add Jellyseerr ID if provided
            if (media.jellyseerr_id) {
                await txCatalog.upsertExternalId(mediaId, {
                    provider: 'jellyseerr',
                    id: String(media.jellyseerr_id),
                    mediaType,
                    source: 'api',
                });
                externalIdChanged = true;
            }

            // Store embedding if provided
            if (embeddingVector) {
                await EmbeddingQueries.upsertMediaEmbedding(tx, {
                    mediaId,
                    source: sourceType,
                    embeddingVector,
                });
            }

            // Store metadata if we have any. Background embedding generation —
            // never force; a locked item's provider_metadata must not be
            // refreshed here (see upsertProviderMetadataUnlessLocked's doc
            // comment — C3).
            if (Object.keys(metadata).length > 0) {
                await upsertProviderMetadataUnlessLocked(tx, mediaId, 'tmdb', metadata);
            }
        });

        // Fire lifecycle hooks AFTER transaction commits — data is now durable.
        // afterCreated is fired here (not inside getOrCreateMinimalByTmdb) because
        // the outer catalogService uses skipLifecycleHooks=true; this deferred
        // placement ensures the hook sees the fully-written item (metadata + embedding).
        // Both hooks are suppressed when this.skipLifecycleHooks=true (test seam).
        if (!this.skipLifecycleHooks) {
            if (itemIsNew) {
                MediaLifecycleService.afterCreated(mediaId, 'upsertMediaEmbedding', this.sql).catch(
                    (err: unknown) => {
                        logger.error(
                            'afterCreated lifecycle hook failed',
                            err instanceof Error ? err : new Error(String(err)),
                            { mediaId, source: 'upsertMediaEmbedding' },
                        );
                    },
                );
            }
            if (externalIdChanged) {
                MediaLifecycleService.afterExternalIdChanged(mediaId, this.sql).catch(
                    (err: unknown) => {
                        logger.error(
                            'afterExternalIdChanged lifecycle hook failed',
                            err instanceof Error ? err : new Error(String(err)),
                            { mediaId, source: 'embedding-operations.upsertEmbedding' },
                        );
                    },
                );
            }
        }

        // Return MediaEmbedding object for backwards compatibility
        const result = await this.buildMediaEmbeddingFromUuid(mediaId);
        if (!result) {
            throw new Error(`Failed to retrieve upserted media ${mediaId}`);
        }
        return result;
    }

    /**
     * Build complete MediaEmbedding object from internal UUID.
     *
     * Aggregates data from:
     * - media_items (core item data)
     * - external_ids (provider IDs)
     * - provider_metadata (enriched metadata)
     * - media_embeddings (embedding vectors)
     * - library_availability (availability status)
     *
     * @param mediaId - Internal UUID
     * @returns Complete MediaEmbedding or null if not found
     */
    async buildMediaEmbeddingFromUuid(mediaId: string): Promise<MediaEmbedding | null> {
        // Get core media item first — early exit if not found avoids
        // issuing the remaining queries unnecessarily.
        const item = await EmbeddingQueries.getMediaItemCore(this.sql, mediaId);
        if (!item) return null;

        // Fetch remaining data in parallel — all four queries are independent reads.
        const [externalIds, metadata, embeddings, availability] = await Promise.all([
            EmbeddingQueries.getMediaItemExternalIds(this.sql, mediaId),
            EmbeddingQueries.getMediaItemProviderMetadata(this.sql, mediaId),
            EmbeddingQueries.getMediaItemEmbeddings(this.sql, mediaId),
            EmbeddingQueries.getMediaItemAvailability(this.sql, mediaId),
        ]);

        // Map external IDs
        const tmdbRow = externalIds.find((e) => e.provider === 'tmdb');
        const imdbRow = externalIds.find((e) => e.provider === 'imdb');
        const jellyseerrRow = externalIds.find((e) => e.provider === 'jellyseerr');

        // Map embeddings
        const libraryEmbedding = embeddings.find((e) => e.source === EMBEDDING_SOURCE.LIBRARY);
        const discoveryEmbedding = embeddings.find((e) => e.source === EMBEDDING_SOURCE.DISCOVERY);

        // Extract metadata fields
        const meta = metadata?.metadata || {};

        return {
            id: 0, // Not used with new schema
            internal_id: mediaId,
            tmdb_id: tmdbRow
                ? /^\d+$/.test(tmdbRow.external_id)
                    ? parseInt(tmdbRow.external_id, 10)
                    : null
                : null,
            imdb_id: imdbRow?.external_id,
            // MediaEmbedding.media_type is the deprecated input-bag field (see the
            // notes on writes below) — identity lookups use the resolved UUID,
            // not this. Widened so an episode is not relabelled a movie.
            media_type: item.media_type as MediaEmbedding['media_type'],
            title: item.title,
            original_title: item.original_title as string | undefined,
            overview: meta.overview as string | undefined,
            genres: (meta.genres as number[]) || [],
            release_date: undefined, // Stored as year now
            release_year: item.year ?? undefined,
            vote_average: meta.popularity as number | undefined,
            vote_count: meta.vote_count as number | undefined,
            popularity: meta.popularity as number | undefined,
            runtime_minutes: meta.runtime_minutes as number | undefined,
            budget: meta.budget as number | undefined,
            revenue: meta.revenue as number | undefined,
            actors: meta.actors as string[] | undefined,
            directors: meta.directors as string[] | undefined,
            producers: meta.producers as string[] | undefined,
            writers: meta.writers as string[] | undefined,
            keywords: meta.keywords as string[] | undefined,
            networks: meta.networks as string[] | undefined,
            production_companies: meta.production_companies as string[] | undefined,
            spoken_languages: meta.spoken_languages as string[] | undefined,
            production_countries: meta.production_countries as string[] | undefined,
            certification: meta.certification as string | undefined,
            library_embedding: libraryEmbedding
                ? parseEmbeddingVector(libraryEmbedding.embedding) || undefined
                : undefined,
            discovery_embedding: discoveryEmbedding
                ? parseEmbeddingVector(discoveryEmbedding.embedding) || undefined
                : undefined,
            imdb_rating: meta.imdb_rating as number | undefined,
            rt_rating: meta.rt_rating as number | undefined,
            rt_audience_score: meta.rt_audience_score as number | undefined,
            mdblist_score: meta.mdblist_score as number | undefined,
            mdblist_keywords: meta.mdblist_keywords as string[] | undefined,
            letterboxd_rating: meta.letterboxd_rating as number | undefined,
            letterboxd_votes: meta.letterboxd_votes as number | undefined,
            metacritic_score: meta.metacritic_score as number | undefined,
            trakt_score: meta.trakt_score as number | undefined,
            mal_score: meta.mal_score as number | undefined,
            mal_votes: meta.mal_votes as number | undefined,
            streaming_services: meta.streaming_services as string[] | undefined,
            anime_genres: meta.anime_genres as string[] | undefined,
            is_available: availability?.available || false,
            can_request: !availability?.available,
            jellyseerr_id: jellyseerrRow ? parseInt(jellyseerrRow.external_id, 10) : undefined,
            is_local_only: item.is_local_only,
            poster_path: meta.poster_path as string | undefined,
            backdrop_path: meta.backdrop_path as string | undefined,
            trailer_url: meta.trailer_url as string | undefined,
            created_at: item.created_at,
            updated_at: item.updated_at,
        };
    }

    /**
     * Batch build MediaEmbedding objects from multiple UUIDs.
     * More efficient than individual calls.
     * Reduces N*5 queries to just 5 bulk queries.
     *
     * @param mediaIds - Array of internal UUIDs
     * @returns Map of UUID -> MediaEmbedding
     */
    async batchBuildMediaEmbeddingsFromUuids(
        mediaIds: string[],
    ): Promise<Map<string, MediaEmbedding>> {
        if (mediaIds.length === 0) return new Map();

        // Deduplicate and drop falsy ids. A null/empty id can never match a row
        // (`id = ANY($1::uuid[])` — NULL never compares true; '' would throw on
        // the uuid cast), and a missing entry is already treated by callers as
        // "no media". Filtering at this choke point covers EVERY caller (the
        // recommendations route AND getUserSuggestionsWithMetadata, which bypasses
        // the DatabaseService wrapper) rather than just one.
        const uniqueIds = [...new Set(mediaIds.filter((id): id is string => Boolean(id)))];
        if (uniqueIds.length === 0) return new Map();

        // 1. Batch fetch media items
        const items = await EmbeddingQueries.batchGetMediaItems(this.sql, uniqueIds);
        const itemsMap = new Map(items.map((i) => [i.id, i]));

        // 2. Batch fetch external IDs
        const externalIds = await EmbeddingQueries.batchGetExternalIds(this.sql, uniqueIds);
        type ExternalIdRow = (typeof externalIds)[number];
        const externalIdsMap = new Map<string, ExternalIdRow[]>();
        for (const row of externalIds) {
            const existing = externalIdsMap.get(row.media_id) || [];
            existing.push(row);
            externalIdsMap.set(row.media_id, existing);
        }

        // 3. Batch fetch provider metadata (using configured provider chain)
        const metadata = await EmbeddingQueries.batchGetProviderMetadata(this.sql, uniqueIds);
        const metadataMap = new Map(metadata.map((m) => [m.media_id, m]));

        // 4. Batch fetch embeddings
        const embeddings = await EmbeddingQueries.batchGetEmbeddings(this.sql, uniqueIds);
        type EmbeddingRow = (typeof embeddings)[number];
        const embeddingsMap = new Map<string, EmbeddingRow[]>();
        for (const row of embeddings) {
            const existing = embeddingsMap.get(row.media_id) || [];
            existing.push(row);
            embeddingsMap.set(row.media_id, existing);
        }

        // 5. Batch fetch library availability
        const availability = await EmbeddingQueries.batchGetLibraryAvailability(
            this.sql,
            uniqueIds,
        );
        const availabilityMap = new Map(availability.map((a) => [a.media_id, a]));

        // Build MediaEmbedding objects
        const result = new Map<string, MediaEmbedding>();

        for (const mediaId of uniqueIds) {
            const item = itemsMap.get(mediaId);
            if (!item) continue;

            const itemExternalIds = externalIdsMap.get(mediaId) || [];
            const itemMetadata = metadataMap.get(mediaId);
            const itemEmbeddings = embeddingsMap.get(mediaId) || [];
            const itemAvailability = availabilityMap.get(mediaId);

            // Map external IDs
            const tmdbRow = itemExternalIds.find((e) => e.provider === 'tmdb');
            const imdbRow = itemExternalIds.find((e) => e.provider === 'imdb');
            const jellyseerrRow = itemExternalIds.find((e) => e.provider === 'jellyseerr');

            // Map embeddings
            const libraryEmbedding = itemEmbeddings.find(
                (e) => e.source === EMBEDDING_SOURCE.LIBRARY,
            );
            const discoveryEmbedding = itemEmbeddings.find(
                (e) => e.source === EMBEDDING_SOURCE.DISCOVERY,
            );

            // Extract metadata fields
            const meta: Record<string, unknown> =
                (itemMetadata?.metadata as Record<string, unknown>) || {};

            result.set(mediaId, {
                id: 0, // Not used with new schema
                internal_id: mediaId, // Parity with buildMediaEmbeddingFromUuid (single-item)
                tmdb_id: tmdbRow
                    ? /^\d+$/.test(String(tmdbRow.external_id))
                        ? parseInt(String(tmdbRow.external_id), 10)
                        : null
                    : null,
                imdb_id: imdbRow?.external_id,
                // MediaEmbedding.media_type is the deprecated input-bag field (see the
                // notes on writes below) — identity lookups use the resolved UUID,
                // not this. Widened so an episode is not relabelled a movie.
                media_type: item.media_type as MediaEmbedding['media_type'],
                title: item.title,
                original_title: item.original_title as string | undefined,
                overview: meta.overview as string | undefined,
                genres: (meta.genres as number[]) || [],
                release_date: undefined,
                release_year: item.year ?? undefined,
                vote_average: meta.popularity as number | undefined,
                vote_count: meta.vote_count as number | undefined,
                popularity: meta.popularity as number | undefined,
                runtime_minutes: meta.runtime_minutes as number | undefined,
                budget: meta.budget as number | undefined,
                revenue: meta.revenue as number | undefined,
                actors: meta.actors as string[] | undefined,
                directors: meta.directors as string[] | undefined,
                producers: meta.producers as string[] | undefined,
                writers: meta.writers as string[] | undefined,
                keywords: meta.keywords as string[] | undefined,
                networks: meta.networks as string[] | undefined,
                production_companies: meta.production_companies as string[] | undefined,
                spoken_languages: meta.spoken_languages as string[] | undefined,
                production_countries: meta.production_countries as string[] | undefined,
                certification: meta.certification as string | undefined,
                library_embedding: libraryEmbedding
                    ? parseEmbeddingVector(libraryEmbedding.embedding) || undefined
                    : undefined,
                discovery_embedding: discoveryEmbedding
                    ? parseEmbeddingVector(discoveryEmbedding.embedding) || undefined
                    : undefined,
                imdb_rating: meta.imdb_rating as number | undefined,
                rt_rating: meta.rt_rating as number | undefined,
                rt_audience_score: meta.rt_audience_score as number | undefined,
                mdblist_score: meta.mdblist_score as number | undefined,
                mdblist_keywords: meta.mdblist_keywords as string[] | undefined,
                letterboxd_rating: meta.letterboxd_rating as number | undefined,
                letterboxd_votes: meta.letterboxd_votes as number | undefined,
                metacritic_score: meta.metacritic_score as number | undefined,
                trakt_score: meta.trakt_score as number | undefined,
                mal_score: meta.mal_score as number | undefined,
                mal_votes: meta.mal_votes as number | undefined,
                streaming_services: meta.streaming_services as string[] | undefined,
                anime_genres: meta.anime_genres as string[] | undefined,
                is_available: itemAvailability?.available || false,
                can_request: !itemAvailability?.available,
                jellyseerr_id: jellyseerrRow ? parseInt(jellyseerrRow.external_id, 10) : undefined,
                is_local_only: item.is_local_only,
                poster_path: meta.poster_path as string | undefined,
                backdrop_path: meta.backdrop_path as string | undefined,
                trailer_url: meta.trailer_url as string | undefined,
                created_at: item.created_at,
                updated_at: item.updated_at,
            });
        }

        return result;
    }

    /**
     * Format embedding vector for PostgreSQL pgvector.
     * Handles: number[], string (JSON), undefined
     *
     * @param embedding - Raw embedding data
     * @returns Formatted vector string or null
     */
    private formatEmbeddingVector(embedding: number[] | string | undefined): string | null {
        if (!embedding) return null;

        if (Array.isArray(embedding)) {
            return `[${embedding.join(',')}]`;
        }

        if (typeof embedding === 'string') {
            return embedding.startsWith('[') ? embedding : `[${embedding}]`;
        }

        return `[${embedding}]`;
    }

    /**
     * Extract year from release_date string.
     *
     * @param releaseDate - Date string (YYYY-MM-DD format)
     * @param fallbackYear - Fallback year if parsing fails
     * @returns Extracted year or fallback
     */
    private extractYear(releaseDate?: string, fallbackYear?: number): number | undefined {
        if (releaseDate) {
            const year = parseInt(releaseDate.substring(0, 4), 10);
            if (!isNaN(year)) return year;
        }
        return fallbackYear;
    }

    /**
     * Validate TMDB ID is in reasonable range.
     *
     * @param tmdbId - TMDB ID to validate
     * @returns True if valid
     */
    private isValidTmdbId(tmdbId: number): boolean {
        return Number.isInteger(tmdbId) && tmdbId > 0 && tmdbId < 100000000;
    }
}

/**
 * Factory function for creating service instance.
 *
 * @param sql - Postgres SQL instance
 * @returns Service instance
 */
export function createEmbeddingOperationsService(
    sql: postgres.Sql,
    opts?: { skipLifecycleHooks?: boolean },
): EmbeddingOperationsService {
    return new EmbeddingOperationsService(sql, undefined, opts);
}
