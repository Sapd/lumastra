// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MoodVectorService - Vector-based mood recommendations
 *
 * Generates and manages pre-computed mood direction vectors from seed movies.
 * Enables pure vector-based mood recommendations by combining mood vectors
 * with user preference embeddings.
 *
 * Formula: query_vec = normalize(mood_weight × mood_vec + user_weight × user_vec)
 */

import { Logger } from '$lib/server/utils/logger';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import {
    parseEmbedding,
    averageVectors,
    normalizeVector,
    combineMoodAndUserVectors,
} from '$lib/server/utils/embedding-utils';
import {
    getMoodSeedConfig,
    getAvailableMoodKeys,
    getMoodVectorSettings,
    MUSIC_MOOD_SEEDS,
} from './mood-vector-seeds';
import { buildOverrideAwareMetadataLateralJoinFragment } from '$lib/server/database/queries/builders/provider-metadata.builder.js';
import {
    isAvailableExpr,
    canRequestExpr,
} from '$lib/server/database/queries/availability.queries.js';
import { buildLibraryAccessFilter } from '$lib/server/database/queries/builders/library-access.builder.js';
import {
    buildDamperPenalty,
    DAMPER_LAMBDA,
} from '$lib/server/database/queries/builders/damper-penalty.builder.js';
import type { DamperContext } from '$lib/server/services/taste-damper.service.js';
import { buildAgeRatingFilter } from '$lib/server/database/queries/builders/age-rating.builder.js';
import {
    deniesEverything,
    type MediaAccessBoundary,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import type postgres from 'postgres';
import { EMBEDDING_SOURCE } from '$lib/server/utils/embedding-source';
import { MSCLAP_MODEL_ID } from '$lib/server/database/queries/sonic-constants.js';

const logger = Logger.for('MoodVectorService');

// Type-safe cache for mood vectors
const moodVectorCache = cacheManager.for(CACHE_NAMESPACES.moodVectors);

/** Result of mood vector query */
export interface MoodVectorQueryResult {
    mediaId: string;
    primaryExtId: string;
    mediaType: 'movie' | 'tv';
    title: string;
    similarity: number;
    isAvailable: boolean;
    canRequest: boolean;
    imdbRating?: number;
    mdblistScore?: number;
    overview?: string;
    trailerUrl?: string;
}

/** Stored mood vector */
export interface StoredMoodVector {
    moodKey: string;
    displayName: string;
    description: string;
    vector: number[];
    seedCount: number;
    seedMediaIds: string[];
    updatedAt: Date;
}

export class MoodVectorService {
    constructor(private sql: postgres.Sql) {}

    /**
     * Generate and store a mood vector from seed movies.
     * The vector is the normalized average of all seed movie embeddings.
     *
     * @param moodKey - The mood identifier (e.g., 'relaxing', 'epic')
     * @returns The generated mood vector, or null if generation failed
     */
    async generateMoodVector(moodKey: string): Promise<StoredMoodVector | null> {
        const config = getMoodSeedConfig(moodKey);
        if (!config) {
            logger.warn('Unknown mood key for vector generation', { moodKey });
            return null;
        }

        logger.info('Generating mood vector', {
            moodKey,
            seedCount: config.seeds.length,
        });

        // Resolve seed TMDB IDs to UUIDs and fetch embeddings
        const embeddings: number[][] = [];
        const seedMediaIds: string[] = [];

        for (const seed of config.seeds) {
            const result = await this.sql<{ media_id: string; embedding: string | number[] }[]>`
                SELECT
                    mi.id as media_id,
                    COALESCE(
                        jf_emb.embedding,
                        js_emb.embedding
                    )::text as embedding
                FROM media_items mi
                JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
                    AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
                    AND primary_ext.media_type = mi.media_type
                LEFT JOIN media_embeddings jf_emb ON jf_emb.media_id = mi.id
                    AND jf_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
                LEFT JOIN media_embeddings js_emb ON js_emb.media_id = mi.id
                    AND js_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
                WHERE primary_ext.external_id = ${String(seed.tmdbId)}
                    AND mi.media_type = ${seed.mediaType}
                    AND mi.status = 'active'
                    AND (jf_emb.embedding IS NOT NULL OR js_emb.embedding IS NOT NULL)
                LIMIT 1
            `;

            if (result.length > 0) {
                const embedding = parseEmbedding(result[0].embedding);
                if (embedding && embedding.length > 0) {
                    embeddings.push(embedding);
                    seedMediaIds.push(result[0].media_id);
                }
            } else {
                logger.debug('Seed not found or missing embedding', {
                    moodKey,
                    tmdbId: seed.tmdbId,
                    title: seed.title,
                });
            }
        }

        const settings = getMoodVectorSettings();
        if (embeddings.length < settings.minSeedsRequired) {
            logger.warn('Not enough seed embeddings for mood vector', {
                moodKey,
                found: embeddings.length,
                required: settings.minSeedsRequired,
            });
            return null;
        }

        // Compute mood vector: normalized average of seed embeddings
        const avgVector = averageVectors(embeddings);
        const moodVector = normalizeVector(avgVector);

        // Store in database
        const vectorStr = `[${moodVector.join(',')}]`;
        await this.sql`
            INSERT INTO mood_vectors (mood_key, model_id, display_name, description, vector, seed_media_ids, seed_count)
            VALUES (
                ${config.moodKey},
                'text',
                ${config.displayName},
                ${config.description},
                ${vectorStr}::vector,
                ${seedMediaIds},
                ${seedMediaIds.length}
            )
            ON CONFLICT (mood_key, model_id) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                description = EXCLUDED.description,
                vector = EXCLUDED.vector,
                seed_media_ids = EXCLUDED.seed_media_ids,
                seed_count = EXCLUDED.seed_count,
                updated_at = NOW()
        `;

        // Invalidate cache
        await moodVectorCache.delete(moodKey);

        const stored: StoredMoodVector = {
            moodKey: config.moodKey,
            displayName: config.displayName,
            description: config.description,
            vector: moodVector,
            seedCount: seedMediaIds.length,
            seedMediaIds,
            updatedAt: new Date(),
        };

        logger.info('Mood vector generated and stored', {
            moodKey,
            seedsUsed: embeddings.length,
            vectorDimension: moodVector.length,
        });

        return stored;
    }

    /**
     * Get a stored mood vector, optionally generating if not exists.
     *
     * @param moodKey - The mood identifier
     * @param autoGenerate - Whether to generate if not found (default: true)
     */
    async getMoodVector(
        moodKey: string,
        autoGenerate: boolean = true,
    ): Promise<StoredMoodVector | null> {
        // Check cache first
        const cached = await moodVectorCache.get<StoredMoodVector>(moodKey);
        if (cached) {
            return cached;
        }

        // Query database
        const result = await this.sql<
            {
                mood_key: string;
                display_name: string;
                description: string | null;
                vector: string | number[];
                seed_media_ids: string[];
                seed_count: number;
                updated_at: Date;
            }[]
        >`
            SELECT mood_key, display_name, description, vector::text, seed_media_ids, seed_count, updated_at
            FROM mood_vectors
            WHERE mood_key = ${moodKey}
              AND model_id = 'text'
        `;

        if (result.length > 0) {
            const row = result[0];
            const vector = parseEmbedding(row.vector);
            if (!vector) {
                logger.warn('Failed to parse stored mood vector', { moodKey });
                return null;
            }

            const stored: StoredMoodVector = {
                moodKey: row.mood_key,
                displayName: row.display_name,
                description: row.description || '',
                vector,
                seedCount: row.seed_count,
                seedMediaIds: row.seed_media_ids,
                updatedAt: row.updated_at,
            };

            // Cache for future lookups
            await moodVectorCache.set(moodKey, stored);
            return stored;
        }

        // Not found - generate if requested
        if (autoGenerate) {
            return this.generateMoodVector(moodKey);
        }

        return null;
    }

    /**
     * Refresh (regenerate) a mood vector from current seed configurations.
     * Use when seed data is updated.
     */
    async refreshMoodVector(moodKey: string): Promise<StoredMoodVector | null> {
        return this.generateMoodVector(moodKey);
    }

    /**
     * Generate all mood vectors from seed configurations.
     * Use on startup or when bulk regeneration is needed.
     */
    async generateAllMoodVectors(): Promise<Map<string, StoredMoodVector>> {
        const results = new Map<string, StoredMoodVector>();

        for (const moodKey of getAvailableMoodKeys()) {
            const vector = await this.generateMoodVector(moodKey);
            if (vector) {
                results.set(moodKey, vector);
            }
        }

        logger.info('All mood vectors generated', {
            total: results.size,
            moods: Array.from(results.keys()),
        });

        return results;
    }

    /**
     * Query media using a mood vector combined with user preferences.
     *
     * @param moodKey - The mood to query for
     * @param userId - User ID for personalization (optional)
     * @param options - Query options. `access` is REQUIRED and has no permissive
     *   default: a caller that genuinely wants every row must pass
     *   `unrestrictedAccess()` so that decision is explicit and greppable.
     */
    async queryWithMoodVector(
        moodKey: string,
        userId: string | null,
        options: {
            limit?: number;
            moodWeight?: number;
            userWeight?: number;
            excludeWatched?: boolean;
            mediaType?: 'movie' | 'tv' | null;
            access: MediaAccessBoundary;
            damper?: DamperContext | null;
        },
    ): Promise<MoodVectorQueryResult[]> {
        const {
            limit = 20,
            moodWeight = 0.6,
            userWeight = 0.4,
            excludeWatched = true,
            mediaType = null,
            access,
            damper = null,
        } = options;

        // A deny-everything boundary can see nothing on either axis. Short-circuit
        // rather than relying on the builders' `AND false`: it skips the round trip
        // (including the mood-vector lookup, which can trigger generation) and it
        // avoids depending on the `AND false` landing inside BOTH ANN CTEs.
        if (deniesEverything(access)) {
            return [];
        }

        // Get mood vector
        const moodVectorData = await this.getMoodVector(moodKey);
        if (!moodVectorData) {
            logger.warn('Mood vector not available', { moodKey });
            return [];
        }

        // Get user embedding if available
        let userEmbedding: number[] | null = null;
        if (userId) {
            const userProfile = await this.sql<{ catalog_embedding: string | number[] | null }[]>`
                SELECT catalog_embedding::text
                FROM user_profiles
                WHERE user_id = ${userId}
            `;

            if (userProfile.length > 0 && userProfile[0].catalog_embedding) {
                userEmbedding = parseEmbedding(userProfile[0].catalog_embedding);
            }
        }

        // Combine vectors
        const queryVector = combineMoodAndUserVectors(
            moodVectorData.vector,
            userEmbedding,
            moodWeight,
            userWeight,
        );

        const queryVectorStr = `[${queryVector.join(',')}]`;

        // Early filters applied INSIDE the ANN candidate retrieval (see below) — a
        // fresh fragment per call site since each is interpolated into two separate
        // CTEs (ann_library, ann_discovery) and postgres.js fragments carry their
        // own bound values, so the same JS object must not be reused across sites.
        const buildEarlyFilters = (): postgres.PendingQuery<postgres.Row[]> => this.sql`
            ${buildLibraryAccessFilter(this.sql, access.library)}
            ${buildAgeRatingFilter(this.sql, access.age)}
            ${mediaType ? this.sql`AND mi.media_type = ${mediaType}` : this.sql``}
            ${
                excludeWatched && userId
                    ? this.sql`
                        AND NOT EXISTS (
                            SELECT 1 FROM user_media_state uwh
                            WHERE uwh.media_id = mi.id
                            AND uwh.user_id = ${userId}
                            AND uwh.is_watched = true
                        )
                    `
                    : this.sql``
            }
        `;

        // Two-phase retrieval: ANN-prefilter each embedding source via its partial
        // HNSW index (idx_me_library_hnsw / idx_me_discovery_hnsw) to a generous
        // candidate pool — with status/media_type/access/watched filters applied
        // INSIDE that prefilter — THEN join out to media_items/external_ids/
        // provider_metadata and apply the exact damper-adjusted rank + final LIMIT
        // over just that pool.
        //
        // Doing the join the other way around — media_items LEFT JOIN media_embeddings,
        // filter to non-null, THEN rank — forces Postgres to detoast and cosine-compare
        // EVERY row with an embedding (thousands) before it can discard all but the
        // top `limit`. Measured on prod: ~1.6-2.3s full-scan vs ~0.2s ANN-prefiltered
        // for the same mood/user, with byte-identical top-20 output when unfiltered
        // (verified: the damper penalty only ever demotes a candidate's raw-similarity
        // rank, never promotes one from outside the pool, so a pool this much larger
        // than `limit` can't drop a true top-`limit` result).
        //
        // The filters must live INSIDE ann_library/ann_discovery, not applied after
        // pooling: a media_type (or access/watched) filter applied post-pool can
        // starve the result set when the pool's nearest neighbours happen to skew
        // toward the excluded type — measured on prod: a movie-only request against
        // a mixed movie/tv pool returned 9 results instead of the true 20+ available,
        // because most of the 600 nearest-by-raw-similarity candidates were TV shows
        // filtered out afterward. Filtering before the ORDER BY/LIMIT fixes this.
        //
        // `similarity` must be computed in an inner CTE, not the top-level SELECT:
        // Postgres only special-cases an output-column alias in ORDER BY when it's a
        // bare reference (`ORDER BY similarity DESC`) — nesting it inside another
        // expression (`GREATEST(similarity, 0)`) makes Postgres resolve `similarity`
        // as a FROM-clause column instead, which doesn't exist and throws
        // `column "similarity" does not exist`. Wrapping it in a CTE turns it into a
        // real column of the outer query, matching the pattern already used for
        // `relevance_score`/`ai_similarity` in mood-recommendations.queries.ts.
        const annPoolSize = Math.max(limit * 15, 200);

        const results = await this.sql<
            {
                media_id: string;
                primary_ext_id: string;
                media_type: 'movie' | 'tv';
                title: string;
                similarity: number;
                is_available: boolean;
                can_request: boolean;
                imdb_rating: number | null;
                mdblist_score: number | null;
                overview: string | null;
                trailer_url: string | null;
            }[]
        >`
            WITH query_vec AS (
                SELECT ${queryVectorStr}::vector as vec
            ),
            ann_library AS (
                SELECT me.media_id, me.embedding
                FROM media_embeddings me
                JOIN media_items mi ON mi.id = me.media_id AND mi.status = 'active'
                CROSS JOIN query_vec qv
                WHERE me.source = ${EMBEDDING_SOURCE.LIBRARY}
                    ${buildEarlyFilters()}
                ORDER BY me.embedding <=> qv.vec
                LIMIT ${annPoolSize}
            ),
            ann_discovery AS (
                SELECT me.media_id, me.embedding
                FROM media_embeddings me
                JOIN media_items mi ON mi.id = me.media_id AND mi.status = 'active'
                CROSS JOIN query_vec qv
                WHERE me.source = ${EMBEDDING_SOURCE.DISCOVERY}
                    ${buildEarlyFilters()}
                ORDER BY me.embedding <=> qv.vec
                LIMIT ${annPoolSize}
            ),
            candidate_embeddings AS (
                -- DISTINCT ON prefers the library-sourced embedding when a media item
                -- appears in both pools, matching the original COALESCE(jf_emb, js_emb).
                SELECT DISTINCT ON (media_id) media_id, embedding
                FROM (
                    SELECT media_id, embedding, 0 as source_pref FROM ann_library
                    UNION ALL
                    SELECT media_id, embedding, 1 as source_pref FROM ann_discovery
                ) pooled
                ORDER BY media_id, source_pref
            ),
            mood_vector_matches AS (
                SELECT
                    mi.id as media_id,
                    primary_ext.external_id as primary_ext_id,
                    mi.media_type,
                    mi.title,
                    1 - (ce.embedding <=> qv.vec) as similarity,
                    ce.embedding as candidate_embedding,
                    ${isAvailableExpr(this.sql)} AS is_available,
                    ${canRequestExpr(this.sql)} AS can_request,
                    (pm.metadata->>'imdb_rating')::float as imdb_rating,
                    (pm.metadata->>'mdblist_score')::float as mdblist_score,
                    (pm.metadata->>'overview')::text as overview,
                    (pm.metadata->>'trailer_url')::text as trailer_url
                FROM candidate_embeddings ce
                CROSS JOIN query_vec qv
                JOIN media_items mi ON mi.id = ce.media_id
                JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
                    AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
                    AND primary_ext.media_type = mi.media_type
                ${buildOverrideAwareMetadataLateralJoinFragment(this.sql)}
            )
            SELECT
                media_id, primary_ext_id, media_type, title, similarity,
                is_available, can_request, imdb_rating, mdblist_score, overview, trailer_url
            FROM mood_vector_matches
            ORDER BY (similarity - GREATEST(similarity, 0) * ${DAMPER_LAMBDA}::numeric * ${buildDamperPenalty(this.sql, this.sql`candidate_embedding`, damper)}) DESC
            LIMIT ${limit}
        `;

        return results.map((row) => ({
            mediaId: row.media_id,
            primaryExtId: row.primary_ext_id,
            mediaType: row.media_type,
            title: row.title,
            similarity: row.similarity,
            isAvailable: row.is_available,
            canRequest: row.can_request,
            imdbRating: row.imdb_rating ?? undefined,
            mdblistScore: row.mdblist_score ?? undefined,
            overview: row.overview ?? undefined,
            trailerUrl: row.trailer_url ?? undefined,
        }));
    }

    /**
     * Get all available moods with their current vector status.
     */
    async listMoodVectors(): Promise<
        Array<{
            moodKey: string;
            displayName: string;
            hasVector: boolean;
            seedCount: number;
            updatedAt?: Date;
        }>
    > {
        // Get all configured moods
        const configuredMoods = getAvailableMoodKeys();

        // Get all stored vectors
        const stored = await this.sql<
            {
                mood_key: string;
                display_name: string;
                seed_count: number;
                updated_at: Date;
            }[]
        >`
            SELECT mood_key, display_name, seed_count, updated_at
            FROM mood_vectors
            WHERE model_id = 'text'
        `;

        const storedMap = new Map(stored.map((s) => [s.mood_key, s]));

        return configuredMoods
            .map((moodKey) => {
                const config = getMoodSeedConfig(moodKey);
                if (!config) {
                    logger.warn('Mood config not found for key', { moodKey });
                    return null;
                }
                const storedData = storedMap.get(moodKey);

                return {
                    moodKey,
                    displayName: config.displayName,
                    hasVector: !!storedData,
                    seedCount: storedData?.seed_count ?? config.seeds.length,
                    updatedAt: storedData?.updated_at,
                };
            })
            .filter((item): item is NonNullable<typeof item> => item !== null);
    }
}

/**
 * Generate music mood vectors from track embeddings.
 *
 * For each music mood, finds tracks whose custom_metadata genres or mood_tags
 * match the mood keywords, averages their embeddings, and upserts into mood_vectors.
 *
 * @param sql - postgres.Sql connection
 */
export async function generateMusicMoodVectors(sql: postgres.Sql): Promise<void> {
    const settings = getMoodVectorSettings();

    for (const [moodKey, moodDef] of Object.entries(MUSIC_MOOD_SEEDS)) {
        logger.info('Generating music mood vector', {
            moodKey,
            keywords: moodDef.keywords,
        });

        // Query tracks matching any of the mood keywords in custom_metadata genres or mood_tags
        const rows = await sql<{ media_id: string; embedding: string | number[] }[]>`
            SELECT
                mi.id as media_id,
                me.embedding::text as embedding
            FROM media_items mi
            JOIN media_embeddings me ON me.media_id = mi.id
            WHERE mi.media_type = 'track'
                AND mi.status = 'active'
                AND me.embedding IS NOT NULL
                -- Indexed superset; EXISTS below preserves per-tag matching.
                AND music_mood_search_text(mi.custom_metadata) ILIKE ANY(${sql.array(moodDef.keywords.map((k) => `%${k}%`))})
                AND (
                    EXISTS (
                        SELECT 1
                        FROM jsonb_array_elements_text(
                            CASE
                                WHEN jsonb_typeof(mi.custom_metadata->'genre') = 'array'
                                THEN mi.custom_metadata->'genre'
                                ELSE '[]'::jsonb
                            END
                        ) AS genre
                        WHERE genre ILIKE ANY(${sql.array(moodDef.keywords.map((k) => `%${k}%`))})
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM jsonb_array_elements_text(
                            CASE
                                WHEN jsonb_typeof(mi.custom_metadata->'essentia'->'mood_tags') = 'array'
                                THEN mi.custom_metadata->'essentia'->'mood_tags'
                                ELSE '[]'::jsonb
                            END
                        ) AS tag
                        WHERE tag ILIKE ANY(${sql.array(moodDef.keywords.map((k) => `%${k}%`))})
                    )
                )
        `;

        const embeddings: number[][] = [];
        const seedMediaIds: string[] = [];

        for (const row of rows) {
            const embedding = parseEmbedding(row.embedding);
            if (embedding && embedding.length > 0) {
                embeddings.push(embedding);
                seedMediaIds.push(row.media_id);
            }
        }

        if (embeddings.length < settings.minSeedsRequired) {
            logger.warn('Not enough track embeddings for music mood vector', {
                moodKey,
                found: embeddings.length,
                required: settings.minSeedsRequired,
            });
            continue;
        }

        const avgVector = averageVectors(embeddings);
        const moodVector = normalizeVector(avgVector);
        const vectorStr = `[${moodVector.join(',')}]`;

        await sql`
            INSERT INTO mood_vectors (mood_key, model_id, display_name, description, vector, seed_media_ids, seed_count)
            VALUES (
                ${moodKey},
                'text',
                ${moodKey},
                ${moodDef.description},
                ${vectorStr}::vector,
                ${seedMediaIds},
                ${seedMediaIds.length}
            )
            ON CONFLICT (mood_key, model_id) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                description = EXCLUDED.description,
                vector = EXCLUDED.vector,
                seed_media_ids = EXCLUDED.seed_media_ids,
                seed_count = EXCLUDED.seed_count,
                updated_at = NOW()
        `;

        await moodVectorCache.delete(moodKey);

        logger.info('Music mood vector generated and stored', {
            moodKey,
            tracksUsed: embeddings.length,
            vectorDimension: moodVector.length,
        });
    }
}

/**
 * Cache-key helper for audio-space mood vectors, distinct from the text-space key
 * so text and audio reads from the in-process cache do not collide.
 */
function audioMoodCacheKey(moodKey: string): string {
    return `${moodKey}:${MSCLAP_MODEL_ID}`;
}

/**
 * Generate MSCLAP audio-space mood vectors from track embeddings.
 *
 * Mirrors generateMusicMoodVectors exactly, but sources embeddings from
 * `media_audio_embeddings` (model_id = 'msclap-2023') instead of
 * `media_embeddings` (text space). The resulting vectors live in the same
 * vector(1024) column with model_id = 'msclap-2023', making them geometrically
 * compatible with the sonic queue's GAMMA arm.
 *
 * Text mood-recommendations are unaffected — they read model_id = 'text' rows.
 *
 * @param sql - postgres.Sql connection
 */
export async function generateAudioMoodVectors(sql: postgres.Sql): Promise<void> {
    const settings = getMoodVectorSettings();

    for (const [moodKey, moodDef] of Object.entries(MUSIC_MOOD_SEEDS)) {
        logger.info('Generating audio mood vector (MSCLAP space)', {
            moodKey,
            keywords: moodDef.keywords,
        });

        // Query tracks matching any of the mood keywords in custom_metadata genres or
        // mood_tags, joining media_audio_embeddings instead of media_embeddings.
        const rows = await sql<{ media_id: string; embedding: string | number[] }[]>`
            SELECT
                mi.id as media_id,
                mae.embedding::text as embedding
            FROM media_items mi
            JOIN media_audio_embeddings mae
                ON mae.media_id = mi.id
               AND mae.model_id = ${MSCLAP_MODEL_ID}
            WHERE mi.media_type = 'track'
                AND mi.status = 'active'
                AND mae.embedding IS NOT NULL
                -- Indexed superset; EXISTS below preserves per-tag matching.
                AND music_mood_search_text(mi.custom_metadata) ILIKE ANY(${sql.array(moodDef.keywords.map((k) => `%${k}%`))})
                AND (
                    EXISTS (
                        SELECT 1
                        FROM jsonb_array_elements_text(
                            CASE
                                WHEN jsonb_typeof(mi.custom_metadata->'genre') = 'array'
                                THEN mi.custom_metadata->'genre'
                                ELSE '[]'::jsonb
                            END
                        ) AS genre
                        WHERE genre ILIKE ANY(${sql.array(moodDef.keywords.map((k) => `%${k}%`))})
                    )
                    OR EXISTS (
                        SELECT 1
                        FROM jsonb_array_elements_text(
                            CASE
                                WHEN jsonb_typeof(mi.custom_metadata->'essentia'->'mood_tags') = 'array'
                                THEN mi.custom_metadata->'essentia'->'mood_tags'
                                ELSE '[]'::jsonb
                            END
                        ) AS tag
                        WHERE tag ILIKE ANY(${sql.array(moodDef.keywords.map((k) => `%${k}%`))})
                    )
                )
        `;

        const embeddings: number[][] = [];
        const seedMediaIds: string[] = [];

        for (const row of rows) {
            const embedding = parseEmbedding(row.embedding);
            if (embedding && embedding.length > 0) {
                embeddings.push(embedding);
                seedMediaIds.push(row.media_id);
            }
        }

        if (embeddings.length < settings.minSeedsRequired) {
            logger.warn('Not enough audio track embeddings for MSCLAP mood vector', {
                moodKey,
                found: embeddings.length,
                required: settings.minSeedsRequired,
            });
            continue;
        }

        const avgVector = averageVectors(embeddings);
        const moodVector = normalizeVector(avgVector);
        const vectorStr = `[${moodVector.join(',')}]`;

        await sql`
            INSERT INTO mood_vectors (mood_key, model_id, display_name, description, vector, seed_media_ids, seed_count)
            VALUES (
                ${moodKey},
                ${MSCLAP_MODEL_ID},
                ${moodKey},
                ${moodDef.description},
                ${vectorStr}::vector,
                ${seedMediaIds},
                ${seedMediaIds.length}
            )
            ON CONFLICT (mood_key, model_id) DO UPDATE SET
                display_name = EXCLUDED.display_name,
                description = EXCLUDED.description,
                vector = EXCLUDED.vector,
                seed_media_ids = EXCLUDED.seed_media_ids,
                seed_count = EXCLUDED.seed_count,
                updated_at = NOW()
        `;

        await moodVectorCache.delete(audioMoodCacheKey(moodKey));

        logger.info('Audio mood vector generated and stored (MSCLAP space)', {
            moodKey,
            tracksUsed: embeddings.length,
            vectorDimension: moodVector.length,
        });
    }
}

// Singleton instance factory
let _instance: MoodVectorService | null = null;

export function getMoodVectorService(sql: postgres.Sql): MoodVectorService {
    if (!_instance) {
        _instance = new MoodVectorService(sql);
    }
    return _instance;
}
