// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Embedding Similarity Query Module
 *
 * Pure SQL queries for vector-similarity-based recommendations.
 * Used by the /api/for-you/similar endpoint.
 */

import type postgres from 'postgres';
import { isAvailableExpr, canRequestExpr } from './availability.queries.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { EMBEDDING_SOURCE } from '$lib/server/utils/embedding-source.js';
import { buildOverrideAwareMetadataLateralJoinFragment } from './builders/provider-metadata.builder.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything, isUnrestricted } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { buildFusedSimilarityExpr } from './fragments/embedding-fusion.fragments.js';

// =============================================================================
// Types
// =============================================================================

export interface UuidToProviderRow {
    tmdb_id: string;
    media_type: string;
    title: string;
}

export interface SourceEmbeddingRow {
    embedding: string | number[];
}

export interface SteeredSimilarityRow {
    internal_id: string | null;
    primary_ext_id: string;
    media_type: 'movie' | 'tv';
    title: string;
    imdb_rating: number | null;
    trailer_url: string | null;
    overview: string | null;
    combined_score: number;
    is_available: boolean;
    can_request: boolean;
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Resolve a UUID to its primary external provider ID and media type.
 * Used when the /similar endpoint receives a UUID key.
 *
 * NOTE: takes no {@link MediaAccessBoundary} and applies no access predicate
 * of its own — deliberately, per the access-boundary migration: adding one
 * here would change which rows a restricted user sees, which the migration
 * forbids. This was a real gap (C14, 2026-09-18 fix plan 4) until the sole
 * caller, `api/defs/for-you/similar.ts`, started gating the result with an
 * explicit `checkMediaAccess(db, uuid, user)` call immediately after
 * resolution and before any of it reaches the response — 404ing a denied
 * UUID with the same body an unresolvable one gets. Any NEW caller of this
 * function must add the same gate itself; it will not happen here.
 */
export async function resolveUuidToProvider(
    sql: postgres.Sql,
    uuid: string,
): Promise<UuidToProviderRow | null> {
    const rows = await sql<UuidToProviderRow[]>`
        SELECT
            ei.external_id as tmdb_id,
            mi.media_type,
            mi.title
        FROM media_items mi
        JOIN external_ids ei ON ei.media_id = mi.id
            AND ei.provider = ${getPrimaryExternalIdProvider()}
            AND ei.media_type = mi.media_type
        WHERE mi.id = ${uuid}
            AND mi.status = 'active'
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Fetch the source embedding for a media item identified by its primary external ID.
 * Prefers library embedding, falls back to discovery embedding.
 *
 * NOTE: takes no {@link MediaAccessBoundary}, for the same reason as
 * {@link resolveUuidToProvider} — it has never applied one, and adding one now
 * would change visible rows. It currently has NO production caller at all; the
 * live path uses a hand-inlined duplicate of this query in
 * `services/dismiss.service.ts`, which likewise applies no access filter.
 * Tracked as a follow-up.
 */
export async function getSourceEmbedding(
    sql: postgres.Sql,
    tmdbId: string,
    mediaType: 'movie' | 'tv',
): Promise<SourceEmbeddingRow | null> {
    const rows = await sql<SourceEmbeddingRow[]>`
        SELECT COALESCE(lib_emb.embedding, disc_emb.embedding)::text as embedding
        FROM media_items mi
        JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
            AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
            AND primary_ext.media_type = mi.media_type
        LEFT JOIN media_embeddings lib_emb ON lib_emb.media_id = mi.id
            AND lib_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
        LEFT JOIN media_embeddings disc_emb ON disc_emb.media_id = mi.id
            AND disc_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
        WHERE primary_ext.external_id = ${tmdbId}
            AND mi.media_type = ${mediaType}
            AND mi.status = 'active'
            AND (lib_emb.embedding IS NOT NULL OR disc_emb.embedding IS NOT NULL)
        LIMIT 1
    `;
    return rows[0] ?? null;
}

/**
 * Candidate-pool multiplier for the HNSW two-phase similarity rewrite.
 *
 * Phase 1 pulls the nearest `limit * MULTIPLIER` (floored at MIN) candidates
 * per embedding source via the raw `<=>` operator so PostgreSQL can use the
 * `idx_me_library_hnsw` / `idx_me_discovery_hnsw` HNSW indexes. Phase 2 then
 * re-scores that bounded pool with the late-fusion / availability expression
 * and applies the final ordering. The over-fetch headroom preserves recall:
 * an item that ranks just outside the top-N on raw distance can still surface
 * once quality / availability weighting is applied.
 */
const STEERED_CANDIDATE_POOL_MULTIPLIER = 5;
const STEERED_CANDIDATE_POOL_MIN = 200;

/**
 * Query similar media items using a steered vector (dismiss-based steering).
 * Bypasses cache — returns ranked results ordered by cosine similarity.
 *
 * Two-phase HNSW design: a candidate pool is gathered per source via raw
 * `ORDER BY embedding <=> vec` (HNSW-eligible), then re-scored and re-ordered.
 * Ordering directly by the `combined_score` expression would force a full
 * sequential scan because HNSW cannot accelerate a wrapped distance expression.
 *
 * `access` is REQUIRED. A caller that genuinely wants unfiltered results must
 * pass `unrestrictedAccess()` so the decision is explicit and greppable.
 */
export async function querySteeredSimilarity(
    sql: postgres.Sql,
    params: {
        steeredVectorStr: string;
        mediaType: 'movie' | 'tv';
        sourceTmdbId: string;
        dismissedTmdbIds: string[];
        watchedTmdbIds: string[];
        limit: number;
        access: MediaAccessBoundary;
    },
): Promise<SteeredSimilarityRow[]> {
    const {
        steeredVectorStr,
        mediaType,
        sourceTmdbId,
        dismissedTmdbIds,
        watchedTmdbIds,
        limit,
        access,
    } = params;

    // A deny-everything boundary can only ever produce an empty result, so
    // short-circuit BEFORE `sql.begin` below: otherwise we would open a
    // transaction and run a full `hnsw.ef_search` ANN scan purely to have every
    // row eliminated by an `AND false` predicate in phase 2.
    if (deniesEverything(access)) return [];

    // Phase 2 (below) drops rows via dismissed/watched exclusion AND
    // buildLibraryAccessFilter/buildAgeRatingFilter, none of which are
    // accounted for by a pool sized off `limit` alone — a restricted user (or
    // one with a long dismissed/watched list) can have most of the phase-1
    // pool filtered away before scoring. Widen 3× when restricted (mirrors
    // querySimilarMediaWithAvailabilityTwoPhase in for-you-helpers.queries.ts)
    // and additionally fold in the caller-known dismissed/watched exclusion
    // volume. Clamp to 1000: pgvector rejects an hnsw.ef_search above that.
    //
    // `isUnrestricted` is exactly the condition under which BOTH builders emit
    // an empty fragment, so the widener and the emitted SQL can no longer
    // disagree. (The legacy guard used `ageRating != null`, which was true for
    // `{ maxAgeRating: null }` — an object the age builder treats as no filter
    // at all — and so widened the pool 3× for unrestricted users.)
    const restricted = !isUnrestricted(access);
    const excludedCount = dismissedTmdbIds.length + watchedTmdbIds.length;
    const candidatePoolSize = Math.min(
        Math.max(limit * STEERED_CANDIDATE_POOL_MULTIPLIER, STEERED_CANDIDATE_POOL_MIN) *
            (restricted ? 3 : 1) +
            excludedCount,
        1000,
    );

    // The phase-1 candidate CTE below is deliberately ACCESS-BLIND. It aliases
    // media_items as `cmi`, while buildLibraryAccessFilter hardcodes `mi` in its
    // correlated subqueries — pushing the access filters down there would emit
    // `mi.id` against a scope where only `cmi` exists and fail at RUNTIME, not
    // at compile time. The boundary is applied exactly once, in phase 2, over
    // the `mi` alias (which is also buildAgeRatingFilter's default alias). Same
    // row set either way; the only cost is recall, which the widener above pays
    // for. Do not "helpfully" move these filters into the CTE.
    //
    // ef_search must be >= candidatePoolSize so the HNSW graph traversal visits
    // enough nodes to return the requested KNN candidate pool. The pgvector
    // default (40) is far too small for candidatePoolSize (200+). SET LOCAL
    // scopes the change to this transaction only — no effect on other queries.
    return await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT set_config('hnsw.ef_search', ${String(candidatePoolSize)}, true)`;

        return tx<SteeredSimilarityRow[]>`
        WITH steered_vec AS (
            SELECT ${steeredVectorStr}::vector as vec
        ),
        -- Phase 1: HNSW-accelerated KNN candidate pool per embedding source.
        -- Each branch orders by the raw <=> operator so the partial HNSW
        -- indexes (idx_me_library_hnsw / idx_me_discovery_hnsw) are used.
        -- Deliberately access-blind; see the note above this query.
        candidate_ids AS (
            (
                SELECT lib_emb.media_id
                FROM media_embeddings lib_emb
                JOIN media_items cmi ON cmi.id = lib_emb.media_id
                    AND cmi.status = 'active'
                    AND cmi.media_type = ${mediaType}
                CROSS JOIN steered_vec sv
                WHERE lib_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
                ORDER BY lib_emb.embedding <=> sv.vec
                LIMIT ${candidatePoolSize}
            )
            UNION
            (
                SELECT disc_emb.media_id
                FROM media_embeddings disc_emb
                JOIN media_items cmi ON cmi.id = disc_emb.media_id
                    AND cmi.status = 'active'
                    AND cmi.media_type = ${mediaType}
                CROSS JOIN steered_vec sv
                WHERE disc_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
                ORDER BY disc_emb.embedding <=> sv.vec
                LIMIT ${candidatePoolSize}
            )
        )
        -- Phase 2: re-score the bounded candidate pool with the full
        -- combined-score expression and apply filters + final ordering.
        SELECT
            mi.id as internal_id,
            primary_ext.external_id as primary_ext_id,
            mi.media_type,
            mi.title,
            (pm.metadata->>'imdb_rating')::float as imdb_rating,
            (pm.metadata->>'trailer_url')::text as trailer_url,
            (pm.metadata->>'overview')::text as overview,
            ${buildFusedSimilarityExpr(sql, sql`lib_emb.embedding`, sql`disc_emb.embedding`, sql`sv.vec`)} as combined_score,
            ${isAvailableExpr(sql)} AS is_available,
            ${canRequestExpr(sql)} AS can_request
        FROM candidate_ids c
        JOIN media_items mi ON mi.id = c.media_id
        JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
            AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
            AND primary_ext.media_type = mi.media_type
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        LEFT JOIN media_embeddings lib_emb ON lib_emb.media_id = mi.id AND lib_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
        LEFT JOIN media_embeddings disc_emb ON disc_emb.media_id = mi.id AND disc_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
        CROSS JOIN steered_vec sv
        WHERE mi.status = 'active'
            AND mi.media_type = ${mediaType}
            AND primary_ext.external_id != ${sourceTmdbId}
            AND (lib_emb.embedding IS NOT NULL OR disc_emb.embedding IS NOT NULL)
            ${dismissedTmdbIds.length > 0 ? sql`AND primary_ext.external_id != ALL(${dismissedTmdbIds}::text[])` : sql``}
            ${watchedTmdbIds.length > 0 ? sql`AND primary_ext.external_id != ALL(${watchedTmdbIds}::text[])` : sql``}
            ${buildLibraryAccessFilter(sql, access.library)}
            ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY combined_score DESC
        LIMIT ${limit}
    `;
    });
}
