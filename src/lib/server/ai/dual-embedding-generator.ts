// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Dual-Source Embedding Generation for library + discovery sources
// Creates optimized embeddings for different content sources

import { generateMediaEmbedding } from './openai';
import type { Database } from '../database/connection';
import { Logger } from '../utils/logger';
import {
    createLibraryEmbeddingText,
    createDiscoveryEmbeddingText,
} from './embedding-text-formatter';
import { createCatalogService } from '../services/catalog.service';
import type { MediaType as ProviderMediaType } from '../providers/provider-types.js';
import { upsertMediaEmbedding } from '../database/queries/ai-sync.queries.js';
import { upsertProviderMetadataUnlessLocked } from '../database/queries/media-upsert.js';
import { EMBEDDING_SOURCE } from '../utils/embedding-source';
import { isDiscoveryCatalogEnabled } from '../config.js';
import { resolveExternalIdToUuid } from '../database/queries/media-lookup.queries.js';

const logger = Logger.for('DualEmbeddingGenerator');

export interface LibraryMediaData {
    Id: string;
    Name: string;
    ProviderIds?: { Tmdb?: string };
    Overview?: string;
    GenreItems?: Array<{ Name: string; Id: string }>;
    ProductionYear?: number;
    CommunityRating?: number; // IMDB rating
    CriticRating?: number; // RT rating
    RunTimeTicks?: number;
    People?: Array<{ Name: string; Type: string }>;
    OfficialRating?: string; // Content rating (PG, R, etc)
}

export interface JellyseerrMovieData {
    id: number;
    tmdbId: number;
    title: string;
    overview: string;
    releaseDate: string;
    genres: Array<{ id: number; name: string }>;
    voteAverage: number;
    voteCount: number;
    popularity: number;
    runtime?: number;
    mediaType?: 'movie' | 'tv';
    originalLanguage?: string;
    originalTitle?: string;
    adult?: boolean;

    // Image paths from TMDB
    poster_path?: string;
    backdrop_path?: string;

    // Rich TMDB metadata
    networks?: Array<{ id: number; name: string }>;
    productionCompanies?: Array<{ id: number; name: string }>;
    keywords?: Array<{ id: number; name: string }>;
    spokenLanguages?: Array<{ iso_639_1: string; name: string }>;
    productionCountries?: Array<{ iso_3166_1: string; name: string }>;
    releaseDates?: {
        results: Array<{
            iso_3166_1: string;
            release_dates: Array<{ certification: string }>;
        }>;
    };

    // Cast and crew information
    cast?: Array<{
        id: number;
        name: string;
        character?: string;
        order?: number;
        profile_path?: string;
    }>;
    crew?: Array<{
        id: number;
        name: string;
        job: string;
        department: string;
    }>;

    // MDBList enrichment data (fetched from database)
    mdblist_keywords?: string[];
    mdblist_score?: number;
    letterboxd_rating?: number;
    rt_rating?: number; // RT Critics score
    rt_audience_score?: number;
    trakt_score?: number;
    streaming_services?: string[];

    // TMDB extended metadata
    imdb_id?: string;
    budget?: number;
    revenue?: number;
    certification?: string;
}

/**
 * Generate dual embeddings for a movie from both sources
 */
export async function generateDualEmbeddings(
    libraryData?: LibraryMediaData,
    discoveryData?: JellyseerrMovieData,
): Promise<{
    library_embedding?: number[];
    discovery_embedding?: number[];
    library_text?: string;
    discovery_text?: string;
}> {
    const result: {
        library_embedding?: number[];
        discovery_embedding?: number[];
        library_text?: string;
        discovery_text?: string;
    } = {};

    // Extract tmdbId from available data for logging
    const tmdbId = libraryData?.ProviderIds?.Tmdb || discoveryData?.tmdbId;

    try {
        // Generate library embedding if data available
        if (libraryData) {
            const libraryText = createLibraryEmbeddingText(libraryData);
            result.library_text = libraryText;

            if (libraryText.trim()) {
                logger.info('Generating library embedding', {
                    title: libraryData.Name,
                    tmdbId,
                });
                const embedding = await generateMediaEmbedding({
                    title: libraryData.Name,
                    overview: libraryText,
                    genres: [], // Already included in text
                    release_date: undefined, // Already included in text
                });
                result.library_embedding = embedding ?? undefined;
            }
        }

        // Generate TMDB (discovery-sourced) embedding if data available
        if (discoveryData) {
            const discoveryText = createDiscoveryEmbeddingText(discoveryData);
            result.discovery_text = discoveryText;

            if (discoveryText.trim()) {
                logger.info('Generating TMDB embedding', {
                    title: discoveryData.title,
                    tmdbId,
                });
                const embedding = await generateMediaEmbedding({
                    title: discoveryData.title,
                    overview: discoveryText,
                    genres: [], // Already included in text
                    release_date: undefined, // Already included in text
                });
                result.discovery_embedding = embedding ?? undefined;
            }
        }

        return result;
    } catch (error) {
        logger.error('Error generating embeddings', error as Error, { tmdbId });
        return result;
    }
}

/**
 * Store dual embeddings in database with structured metadata
 * Updated to use UUID-based media_items, media_embeddings, and provider_metadata tables
 */
export async function storeDualEmbedding(
    db: Database,
    tmdbId: number,
    embeddings: {
        library_embedding?: number[];
        discovery_embedding?: number[];
    },
    metadata: {
        title: string;
        media_type: 'movie' | 'tv';
        library_data?: LibraryMediaData;
        discovery_data?: JellyseerrMovieData;
    },
): Promise<void> {
    try {
        const sql = db.sqlClient;
        const catalogService = createCatalogService(sql);

        // Get or create media item using CatalogService. When no discovery
        // surface can show a new fileless row, only an existing row is used.
        let mediaId: string;
        if (isDiscoveryCatalogEnabled()) {
            ({ id: mediaId } = await catalogService.getOrCreateByExternalId(
                {
                    provider: 'tmdb',
                    id: String(tmdbId),
                    mediaType: metadata.media_type as ProviderMediaType,
                },
                metadata.media_type as ProviderMediaType,
            ));
        } else {
            const existingId = await resolveExternalIdToUuid(
                sql,
                String(tmdbId),
                metadata.media_type,
                'tmdb',
            );
            if (!existingId) {
                logger.debug('Skipping embedding store: discovery catalog disabled, no row', {
                    tmdbId,
                });
                return;
            }
            mediaId = existingId;
        }

        // Store library embedding
        if (embeddings.library_embedding) {
            await upsertMediaEmbedding(
                sql,
                mediaId,
                EMBEDDING_SOURCE.LIBRARY,
                embeddings.library_embedding,
            );
        }

        // Store discovery embedding
        if (embeddings.discovery_embedding) {
            await upsertMediaEmbedding(
                sql,
                mediaId,
                EMBEDDING_SOURCE.DISCOVERY,
                embeddings.discovery_embedding,
            );
        }

        // Build provider metadata from discovery/TMDB data
        if (metadata.discovery_data) {
            const js = metadata.discovery_data;
            const tmdbMetadata: Record<string, unknown> = {};

            tmdbMetadata.tmdb_rating = js.voteAverage || null;
            tmdbMetadata.vote_count = js.voteCount || null;
            tmdbMetadata.popularity = js.popularity || null;

            if (js.poster_path) {
                tmdbMetadata.poster_path = js.poster_path;
            }
            if (js.backdrop_path) {
                tmdbMetadata.backdrop_path = js.backdrop_path;
            }
            if (js.runtime) {
                tmdbMetadata.runtime_minutes = js.runtime;
            }
            if (js.overview) {
                tmdbMetadata.overview = js.overview;
            }
            if (js.genres && js.genres.length > 0) {
                tmdbMetadata.genres = js.genres
                    .map((g) => g.id)
                    .filter((id) => id !== undefined && id !== null);
            }
            if (js.networks && js.networks.length > 0) {
                tmdbMetadata.networks = js.networks.map((n) => n.name).filter(Boolean);
            }
            if (js.productionCompanies && js.productionCompanies.length > 0) {
                tmdbMetadata.production_companies = js.productionCompanies
                    .map((c) => c.name)
                    .filter(Boolean);
            }
            if (js.keywords && js.keywords.length > 0) {
                tmdbMetadata.keywords = js.keywords.map((k) => k.name).filter(Boolean);
            }
            if (js.spokenLanguages && js.spokenLanguages.length > 0) {
                tmdbMetadata.spoken_languages = js.spokenLanguages
                    .map((l) => l.iso_639_1)
                    .filter(Boolean);
            }
            if (js.productionCountries && js.productionCountries.length > 0) {
                tmdbMetadata.production_countries = js.productionCountries
                    .map((c) => c.iso_3166_1)
                    .filter(Boolean);
            }

            // MDBList enrichment data
            if (js.mdblist_keywords) {
                tmdbMetadata.mdblist_keywords = js.mdblist_keywords;
            }
            if (js.mdblist_score != null) {
                tmdbMetadata.mdblist_score = js.mdblist_score;
            }
            if (js.letterboxd_rating != null) {
                tmdbMetadata.letterboxd_rating = js.letterboxd_rating;
            }
            if (js.rt_rating != null) {
                tmdbMetadata.rt_rating = js.rt_rating;
            }
            if (js.rt_audience_score != null) {
                tmdbMetadata.rt_audience_score = js.rt_audience_score;
            }
            if (js.trakt_score != null) {
                tmdbMetadata.trakt_score = js.trakt_score;
            }
            if (js.streaming_services) {
                tmdbMetadata.streaming_services = js.streaming_services;
            }
            if (js.imdb_id) {
                // Add IMDB external ID
                await catalogService.upsertExternalId(
                    mediaId,
                    {
                        provider: 'imdb',
                        id: js.imdb_id,
                        mediaType: metadata.media_type as ProviderMediaType,
                        source: 'embedding-generator',
                    },
                    false,
                );
            }

            // Clean undefined values
            const cleanTmdbMetadata = Object.fromEntries(
                Object.entries(tmdbMetadata).filter(
                    (entry): entry is [string, unknown] =>
                        entry[1] !== undefined && entry[1] !== null,
                ),
            );

            if (Object.keys(cleanTmdbMetadata).length > 0) {
                await upsertProviderMetadataUnlessLocked(sql, mediaId, 'tmdb', cleanTmdbMetadata);
            }

            // Add Jellyseerr external ID if we have it
            if (js.id) {
                await catalogService.upsertExternalId(
                    mediaId,
                    {
                        provider: 'jellyseerr',
                        id: String(js.id),
                        mediaType: metadata.media_type as ProviderMediaType,
                        source: 'embedding-generator',
                    },
                    false,
                );
            }
        }

        logger.info('Stored dual embeddings', {
            mediaId,
            tmdbId,
            title: metadata.title,
        });
    } catch (error) {
        logger.error('Failed to store embeddings', error as Error, {
            tmdbId,
            title: metadata.title,
        });
        throw error;
    }
}
