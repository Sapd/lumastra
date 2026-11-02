// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Suggestion Search Query Module
 *
 * Pure SQL queries for similarity-based media recommendation searches.
 * Extracted from Database class to follow three-tier architecture.
 *
 * Key patterns:
 * - All functions take sql: postgres.Sql as first parameter
 * - Uses typed result interfaces instead of type assertions
 * - Uses buildMetadataLateralJoinFragment for metadata joins
 * - Handles composite key exclusions (tmdb_id + media_type)
 * - Supports embedding source filtering (jellyfin/jellyseerr/both)
 *
 * @module queries/suggestion-search
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { isAvailableExpr, canRequestExpr } from './availability.queries.js';
import {
    buildMetadataLateralJoinFragment,
    buildMediaScalarsLateralJoinFragment,
} from './builders/provider-metadata.builder.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';
import { buildFusedSimilarityExpr } from './fragments/embedding-fusion.fragments.js';
import type { AvailabilityFields, MetadataContent, ExtendedRatings } from './types/index.js';

// ---------------------------------------------------------------------------
// Access boundary contract (read before touching any query text here)
// ---------------------------------------------------------------------------
//
// `findSimilarMediaDual` takes a REQUIRED {@link MediaAccessBoundary} on its
// options bag. There is no permissive default: the old `deniedGroupIds?:
// string[] | null` was permissive-by-default in two ways at once — omitting it
// compiled and returned unfiltered rows, and there was no way to say "this
// caller may see nothing". A caller that genuinely wants unfiltered rows must
// now write `unrestrictedAccess()`, which makes the decision greppable.
//
// TWO-PHASE SCOPE. This is an HNSW two-phase query and the boundary belongs to
// phase 2 ONLY:
//   * phase 1 (`candidate_ids` CTE) picks the nearest `candidatePoolSize`
//     embeddings per source with NO access predicate — only status/media_type.
//   * phase 2 (`media_with_embeddings`) applies the boundary and discards the
//     denied rows.
// A restricted user's denied rows therefore DO occupy phase-1 slots and are
// thrown away afterwards. That is correct for row visibility and is compensated
// for by the pool widening below; do NOT "optimise" the predicate into phase 1.
// The phase-1 CTE aliases media_items as `cmi`, and BOTH builders below are
// hardcoded/defaulted to the `mi` alias, so a fragment moved there would either
// silently bind to the outer `mi` or fail to resolve.
//
// ALIAS CONTRACT. `buildLibraryAccessFilter` hardcodes `mi.id` in its correlated
// subqueries and `buildAgeRatingFilter` defaults its alias to `mi`. The single
// splice point (`media_with_embeddings`) selects `FROM media_items mi`, so
// neither call passes an alias override. Keep that alias.
//
// POOL WIDENING IS RESULT-AFFECTING. `candidatePoolSize` feeds
// `set_config('hnsw.ef_search', ...)`, so the `restricted` verdict changes which
// candidates the HNSW graph visits and therefore which rows come back. It is not
// a pure optimisation. `{ kind: 'denyGroups', ids: [] }` and `{ kind: 'all' }`
// must both read as unrestricted — the library builder emits an empty fragment
// for both, so widening for an empty deny-list would shift results for callers
// whose SQL is byte-identical to an unrestricted one.
//
// DENY-ALL. `deniesEverything` short-circuits to `[]` before any SQL. Both
// builders would emit `AND false`, which is equally correct, but the CTEs above
// the predicate would still be materialised for a guaranteed-empty result.
//
// AGE AXIS. Before this migration NO age predicate existed in this module at
// all; `/j/Items/.../Similar` age-gated its own hydration query inline and the
// modal endpoint relied on its age-scoped cache key. The splice site now exists
// so the boundary is honest, but every migrated call site passes
// `age: { kind: 'any' }` so the emitted SQL is unchanged. Tightening those two
// surfaces is a real fix and a real behaviour change — it belongs in its own
// separately-tested commit, not in this reshape.
//
// CACHE KEYS. Callers that cache these results MUST partition the cache by the
// same boundary (`scopedCacheKey` in search-access-context.ts). A correct SQL
// predicate paired with an unpartitioned cache key still leaks.

// =============================================================================
// Types
// =============================================================================

export type MediaType = 'movie' | 'tv';
export type EmbeddingSource = 'library' | 'discovery' | 'both';

/**
 * Composite key for excluding specific media items.
 * CRITICAL: External IDs are not unique across media types.
 */
export interface ExternalMediaKey {
    primary_ext_id: string;
    media_type: MediaType;
}
/** @deprecated Use ExternalMediaKey */
export type TmdbMediaKey = ExternalMediaKey;

/**
 * Row result from findSimilarMediaDual query.
 * Contains full MediaEmbedding fields plus scoring columns.
 */
export type SimilarMediaDualRow = AvailabilityFields &
    Pick<MetadataContent, 'overview' | 'runtime_minutes'> &
    Pick<
        ExtendedRatings,
        | 'imdb_rating'
        | 'rt_rating'
        | 'rt_audience_score'
        | 'mdblist_score'
        | 'letterboxd_rating'
        | 'letterboxd_votes'
        | 'metacritic_score'
        | 'trakt_score'
        | 'popularity'
    > & {
        media_uuid: string;
        id: number;
        primary_ext_id: string | null;
        imdb_id: string | null;
        media_type: MediaType;
        title: string;
        original_title: string | null;
        release_year: number | null;
        is_local_only: boolean;
        created_at: Date;
        updated_at: Date;
        genres: string[] | null;
        vote_count: number | null;
        actors: unknown | null;
        directors: unknown | null;
        poster_path: string | null;
        backdrop_path: string | null;
        // Presence flags instead of the full `embedding::text` (~12KB/vector at
        // 1024 dims). Downstream only needs to know whether each source exists
        // (availability determination). When the actual vector is required
        // (damper-penalty steering), fetch it for the surviving candidate ids
        // via fetchCandidateEmbeddings — see F9.
        has_library_embedding: boolean;
        has_discovery_embedding: boolean;
        library_similarity: number | null;
        discovery_similarity: number | null;
        quality_score: number | null;
        popularity_score: number | null;
        combined_score: number;
    };

/**
 * Options for findSimilarMediaDual query.
 */
export interface FindSimilarMediaDualOptions {
    limit?: number;
    /**
     * Availability blend ratio (0.0-1.0, default 0.7 ≈ 70% available). NOTE: as
     * of the ForYou engine-quality overhaul this NO LONGER affects the SQL
     * `combined_score` — availability is applied by the suggestion engine as an
     * explicit post-scoring interleave (`interleaveByAvailability`), not as a
     * score offset that would strictly partition library-first and prevent a
     * strong discovery match from ever surfacing. The engine reads this same
     * `availability_preference` semantic to derive the interleave ratio; the
     * option is retained here for call-site compatibility and is inert in SQL.
     */
    availabilityPreference?: number;
    qualityWeight?: number;
    popularityWeight?: number;
    source?: EmbeddingSource;
    mediaTypes?: MediaType[];
    excludeUserId?: UserId; // Exclude items already rated by this user
    excludeWatchedForUserId?: UserId; // Exclude items in user's watch history
    excludeItems?: ExternalMediaKey[]; // Exclude specific items using composite keys
    /**
     * REQUIRED access boundary — both axes, no permissive default.
     *
     * Build it from a real user's permissions (`searchAccessBoundary(ctx)` for a
     * SearchAccessContext holder), or state the bypass explicitly with
     * `unrestrictedAccess()`. Omission is a compile error by design: the field
     * this replaced (`deniedGroupIds?: string[] | null`) let a new call site
     * compile while silently returning unfiltered rows.
     *
     * See the access-boundary contract block at the top of this module for where
     * the boundary is spliced, why it must not move into phase 1, and why the
     * `denyGroups`-with-empty-ids case must read as unrestricted.
     */
    access: MediaAccessBoundary;
    /**
     * Lean projection for response-shaping callers (the modal's similar
     * endpoint) that only consume title/year/overview/score/ids/availability.
     *
     * Sources scalar fields from the normalized `media_scalars` projection
     * instead of detoasting the `provider_metadata` JSONB per candidate row
     * (the same rewrite that cut the For-You rails ~2.3×). In lean mode
     * `genres`, `vote_count`, `letterboxd_*`, `metacritic_score`,
     * `trakt_score`, `actors` and `directors` come back NULL — do NOT use it
     * from the suggestion engine, which consumes those fields.
     */
    lean?: boolean;
    /**
     * Only return rows with files (`has_files`). Applied inside the phase-1
     * candidate pool and phase 2, so `limit` counts available rows only
     * instead of callers dropping file-less rows after the fetch.
     */
    availableOnly?: boolean;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Candidate-pool sizing for the HNSW two-phase similarity rewrite. Phase 1
 * gathers the nearest `limit * MULTIPLIER` (floored at MIN) embeddings per
 * source via the raw `<=>` operator (HNSW-eligible); phase 2 re-scores that
 * bounded pool with the late-fusion / availability expression. The over-fetch
 * preserves recall when quality / availability weighting reorders candidates.
 */
const SIMILARITY_CANDIDATE_POOL_MULTIPLIER = 5;
const SIMILARITY_CANDIDATE_POOL_MIN = 200;

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Normalize a number value with fallback.
 */
function normalizeNumber(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : Number.parseFloat(`${value}`);
    return Number.isFinite(parsed) ? parsed : fallback;
}

// =============================================================================
// Query Functions
// =============================================================================

/**
 * Find similar media using dual embeddings with quality and popularity scoring.
 *
 * This is the primary recommendation query. It:
 * - Uses both Jellyfin and Jellyseerr embeddings
 * - Applies quality, popularity, and availability weighting
 * - Handles composite key exclusions (TMDB IDs are not unique across media types)
 * - Supports filtering by media type, ratings, and watch history
 *
 * @param sql - Postgres SQL client instance
 * @param userEmbedding - User preference embedding vector
 * @param options - Search and scoring options. `access` is REQUIRED; there is
 *   no permissive default and the whole options bag is therefore mandatory.
 * @returns Array of similar media with scoring columns
 */
export async function findSimilarMediaDual(
    sql: postgres.Sql,
    userEmbedding: number[],
    options: FindSimilarMediaDualOptions,
): Promise<SimilarMediaDualRow[]> {
    const {
        limit = 50,
        // availabilityPreference is intentionally NOT destructured: availability
        // no longer contributes to combined_score (see the option's doc + the
        // engine-side interleave). Kept in the options type for compatibility.
        qualityWeight = 0.2,
        popularityWeight = 0.1,
        source = 'both',
        mediaTypes = ['movie', 'tv'],
        excludeUserId,
        excludeWatchedForUserId,
        excludeItems = [],
        access,
        lean = false,
        availableOnly = false,
    } = options;

    // Deny-everything short-circuits before any SQL. Both builders would emit
    // `AND false`, but the phase-1 CTE would still be materialised first.
    if (deniesEverything(access)) return [];

    const qualityWeightValue = normalizeNumber(qualityWeight, 0.2);
    const popularityWeightValue = normalizeNumber(popularityWeight, 0.1);

    const userVector = `[${userEmbedding.join(',')}]`;

    // Max possible score for normalization. Availability is NO LONGER part of
    // the score (moved to the engine interleave), so it is dropped from both the
    // numerator (below) and this normalizer: similarity(≤1) + quality + pop.
    const maxPossibleScore = 1.0 + qualityWeightValue + popularityWeightValue;

    // Build excludeItems arrays for postgres unnest
    const excludeExtIds = excludeItems.map((e) => e.primary_ext_id);
    const excludeMediaTypes = excludeItems.map((e) => e.media_type);

    // Phase-1 candidate-pool size for the HNSW two-phase rewrite. We over-fetch
    // (limit * MULTIPLIER, floored at MIN) per embedding source so that the
    // late-fusion / availability re-scoring in phase 2 can promote items that
    // rank just outside the raw-distance top-N. See querySteeredSimilarity for
    // the same pattern.
    //
    // The access boundary is applied inside phase 2 (media_with_embeddings,
    // below) but a fixed pool doesn't account for it — a restricted caller can
    // have a large fraction of the phase-1 pool filtered away before scoring,
    // starving the result set. Widen the pool 3× when restricted, mirroring the
    // pattern in querySimilarMediaWithAvailabilityTwoPhase
    // (for-you-helpers.queries.ts).
    // Clamp to 1000: pgvector rejects an hnsw.ef_search above that.
    //
    // This verdict feeds hnsw.ef_search and is therefore RESULT-AFFECTING, not a
    // pure optimisation — it must agree exactly with whether a predicate is
    // actually emitted. `denyGroups` with an empty id list emits nothing (see
    // buildLibraryAccessFilter), so it must read as unrestricted here too;
    // otherwise two boundaries producing byte-identical SQL would return
    // different rows. `denyAll` never reaches this line (short-circuited above).
    //
    // The age axis is included for the same reason the library axis is: it now
    // has a real splice site in phase 2 and can starve the pool identically.
    // No current call site passes an age limit here (see the AGE AXIS note in
    // the contract block), so this is inert today.
    const libraryRestricted = access.library.kind === 'denyGroups' && access.library.ids.length > 0;
    const ageRestricted = access.age.kind === 'limit';
    const restricted = libraryRestricted || ageRestricted;
    const candidatePoolSize = Math.min(
        Math.max(limit * SIMILARITY_CANDIDATE_POOL_MULTIPLIER, SIMILARITY_CANDIDATE_POOL_MIN) *
            (restricted ? 3 : 1),
        1000,
    );

    // HNSW ef_search must be >= candidatePoolSize so the graph traversal visits
    // enough nodes to return the requested number of nearest neighbours. The
    // pgvector default (40) is far too small for candidatePoolSize (200+), which
    // degrades recall for the phase-1 KNN candidate pool. SET LOCAL scopes the
    // change to this transaction only — no effect on other concurrent queries.
    // Phase 1: HNSW-accelerated candidate pool. Each branch orders by the raw
    // `<=>` operator so the partial HNSW indexes (idx_me_library_hnsw /
    // idx_me_discovery_hnsw) are used; joining media_items keeps the index scan
    // (the join filter is applied as a Nested Loop inner lookup). Ordering the
    // final result directly by the computed `combined_score` would instead force
    // a full sequential scan + sort over every embedding row.
    const candidateCte = sql`
		candidate_ids AS (
			(
				SELECT lib_emb.media_id
				FROM media_embeddings lib_emb
				JOIN media_items cmi ON cmi.id = lib_emb.media_id
					AND cmi.status = 'active'
					AND cmi.media_type = ANY(${mediaTypes})
					${availableOnly ? sql`AND cmi.has_files` : sql``}
				WHERE lib_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
				ORDER BY lib_emb.embedding <=> ${userVector}::vector
				LIMIT ${candidatePoolSize}
			)
			UNION
			(
				SELECT disc_emb.media_id
				FROM media_embeddings disc_emb
				JOIN media_items cmi ON cmi.id = disc_emb.media_id
					AND cmi.status = 'active'
					AND cmi.media_type = ANY(${mediaTypes})
					${availableOnly ? sql`AND cmi.has_files` : sql``}
				WHERE disc_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
				ORDER BY disc_emb.embedding <=> ${userVector}::vector
				LIMIT ${candidatePoolSize}
			)
		)
	`;

    // Metadata source for the phase-2 candidate rows. Full mode detoasts the
    // provider_metadata JSONB per row (needed by the suggestion engine, which
    // consumes genres/actors/directors/long-tail ratings). Lean mode reads the
    // normalized media_scalars projection instead — typed columns, no detoast —
    // and returns NULLs for the fields only the engine needs.
    const metadataJoin = lean
        ? buildMediaScalarsLateralJoinFragment(sql)
        : buildMetadataLateralJoinFragment(sql);
    const metadataFields = lean
        ? sql`
				ms.overview as overview,
				NULL::text[] as genres,
				NULL::integer as vote_count,
				ms.popularity::float as popularity,
				ms.runtime_minutes as runtime_minutes,
				ms.imdb_rating::float as imdb_rating,
				ms.rt_rating as rt_rating,
				ms.rt_audience_score as rt_audience_score,
				ms.mdblist_score::float as mdblist_score,
				NULL::float as letterboxd_rating,
				NULL::integer as letterboxd_votes,
				NULL::integer as metacritic_score,
				NULL::float as trakt_score,
				NULL::jsonb AS actors,
				NULL::jsonb AS directors,
				ms.poster_path as poster_path,
				ms.backdrop_path as backdrop_path,`
        : sql`
				(pm.metadata->>'overview')::text as overview,
				CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
				THEN NULLIF(ARRAY(SELECT elem->>'name' FROM jsonb_array_elements(pm.metadata->'genres') AS elem
				                  WHERE jsonb_typeof(elem) = 'object' AND elem->>'name' IS NOT NULL), ARRAY[]::text[])
				ELSE NULL
			END as genres,
				CASE WHEN pm.metadata->>'vote_count' ~ '^[0-9]+$'
					 THEN (pm.metadata->>'vote_count')::integer ELSE NULL END as vote_count,
				CASE WHEN pm.metadata->>'popularity' ~ '^[0-9]+(\\.[0-9]+)?$'
					 THEN (pm.metadata->>'popularity')::float ELSE NULL END as popularity,
				CASE WHEN pm.metadata->>'runtime_minutes' ~ '^[0-9]+$'
					 THEN (pm.metadata->>'runtime_minutes')::integer ELSE NULL END as runtime_minutes,
				CASE WHEN pm.metadata->>'imdb_rating' ~ '^[0-9]+(\\.[0-9]+)?$'
					 THEN (pm.metadata->>'imdb_rating')::float ELSE NULL END as imdb_rating,
				CASE WHEN pm.metadata->>'rt_rating' ~ '^[0-9]+$'
					 THEN (pm.metadata->>'rt_rating')::integer ELSE NULL END as rt_rating,
				CASE WHEN pm.metadata->>'rt_audience_score' ~ '^[0-9]+$'
					 THEN (pm.metadata->>'rt_audience_score')::integer ELSE NULL END as rt_audience_score,
				CASE WHEN pm.metadata->>'mdblist_score' ~ '^[0-9]+(\\.[0-9]+)?$'
					 THEN (pm.metadata->>'mdblist_score')::float ELSE NULL END as mdblist_score,
				CASE WHEN pm.metadata->>'letterboxd_rating' ~ '^[0-9]+(\\.[0-9]+)?$'
					 THEN (pm.metadata->>'letterboxd_rating')::float ELSE NULL END as letterboxd_rating,
				CASE WHEN pm.metadata->>'letterboxd_votes' ~ '^[0-9]+$'
					 THEN (pm.metadata->>'letterboxd_votes')::integer ELSE NULL END as letterboxd_votes,
				CASE WHEN pm.metadata->>'metacritic_score' ~ '^[0-9]+$'
					 THEN (pm.metadata->>'metacritic_score')::integer ELSE NULL END as metacritic_score,
				CASE WHEN pm.metadata->>'trakt_score' ~ '^[0-9]+(\\.[0-9]+)?$'
					 THEN (pm.metadata->>'trakt_score')::float ELSE NULL END as trakt_score,
				pm.metadata->'actors' AS actors,
				pm.metadata->'directors' AS directors,
				(pm.metadata->>'poster_path')::text as poster_path,
				(pm.metadata->>'backdrop_path')::text as backdrop_path,`;

    // Common base query - builds MediaEmbedding-compatible results
    const baseQuery = sql`
		WITH ${candidateCte},
		media_with_embeddings AS (
			SELECT
				mi.id as media_uuid,
				0 as id,
				(SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1) as primary_ext_id,
				(SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = 'imdb' LIMIT 1) as imdb_id,
				mi.media_type,
				mi.title,
				mi.original_title,
				mi.year as release_year,
				mi.is_local_only,
				mi.created_at,
				mi.updated_at,
				${metadataFields}
				${isAvailableExpr(sql)} AS is_available,
				${canRequestExpr(sql)} AS can_request,
				jf_emb.embedding as jellyfin_embedding_vec,
				js_emb.embedding as jellyseerr_embedding_vec
			FROM media_items mi
			${metadataJoin}
			LEFT JOIN media_embeddings jf_emb ON jf_emb.media_id = mi.id AND jf_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
			LEFT JOIN media_embeddings js_emb ON js_emb.media_id = mi.id AND js_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
			WHERE mi.status = 'active'
			  AND mi.media_type = ANY(${mediaTypes})
			  AND mi.id IN (SELECT media_id FROM candidate_ids)
			  ${availableOnly ? sql`AND mi.has_files` : sql``}
			  ${buildLibraryAccessFilter(sql, access.library)}
			  ${buildAgeRatingFilter(sql, access.age)}
		)
	`;

    const mediaSelectFields = sql`
		mwe.media_uuid,
		mwe.id,
		mwe.primary_ext_id,
		mwe.imdb_id,
		mwe.media_type,
		mwe.title,
		mwe.original_title,
		mwe.release_year,
		mwe.is_local_only,
		mwe.created_at,
		mwe.updated_at,
		mwe.overview,
		mwe.genres,
		mwe.vote_count,
		mwe.popularity,
		mwe.runtime_minutes,
		mwe.imdb_rating,
		mwe.rt_rating,
		mwe.rt_audience_score,
		mwe.mdblist_score,
		mwe.letterboxd_rating,
		mwe.letterboxd_votes,
		mwe.metacritic_score,
		mwe.trakt_score,
		mwe.actors,
		mwe.directors,
		mwe.poster_path,
		mwe.backdrop_path,
		mwe.is_available,
		mwe.can_request,
		(mwe.jellyfin_embedding_vec IS NOT NULL) as has_library_embedding,
		(mwe.jellyseerr_embedding_vec IS NOT NULL) as has_discovery_embedding
	`;

    return await sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        // SET LOCAL hnsw.ef_search so HNSW graph traversal visits enough nodes to
        // serve the candidatePoolSize KNN request. The pgvector default (40) is
        // far too small; set it to candidatePoolSize so recall matches the fetch.
        await tx`SELECT set_config('hnsw.ef_search', ${String(candidatePoolSize)}, true)`;

        // Single-source queries (library or discovery only)
        if (source === EMBEDDING_SOURCE.LIBRARY) {
            return tx<SimilarMediaDualRow[]>`
			${baseQuery}
			SELECT ${mediaSelectFields},
				   1 - (jellyfin_embedding_vec <=> ${userVector}::vector) as library_similarity,
				   NULL::float as discovery_similarity,
				   NULL::float as quality_score,
				   NULL::float as popularity_score,
				   1 - (jellyfin_embedding_vec <=> ${userVector}::vector) as combined_score
			FROM media_with_embeddings mwe
			WHERE jellyfin_embedding_vec IS NOT NULL
			  ${excludeUserId ? tx`AND NOT EXISTS (SELECT 1 FROM user_ratings ur WHERE ur.user_id = ${excludeUserId} AND ur.media_id = mwe.media_uuid)` : tx``}
			  ${excludeExtIds.length > 0 ? tx`AND NOT EXISTS (SELECT 1 FROM unnest(${excludeExtIds}::text[], ${excludeMediaTypes}::text[]) AS excluded(primary_ext_id, media_type) WHERE excluded.primary_ext_id = mwe.primary_ext_id AND excluded.media_type = mwe.media_type)` : tx``}
			ORDER BY jellyfin_embedding_vec <=> ${userVector}::vector
			LIMIT ${limit}
		`;
        }

        if (source === EMBEDDING_SOURCE.DISCOVERY) {
            return tx<SimilarMediaDualRow[]>`
			${baseQuery}
			SELECT ${mediaSelectFields},
				   NULL::float as library_similarity,
				   1 - (jellyseerr_embedding_vec <=> ${userVector}::vector) as discovery_similarity,
				   NULL::float as quality_score,
				   NULL::float as popularity_score,
				   1 - (jellyseerr_embedding_vec <=> ${userVector}::vector) as combined_score
			FROM media_with_embeddings mwe
			WHERE jellyseerr_embedding_vec IS NOT NULL
			  ${excludeUserId ? tx`AND NOT EXISTS (SELECT 1 FROM user_ratings ur WHERE ur.user_id = ${excludeUserId} AND ur.media_id = mwe.media_uuid)` : tx``}
			  ${excludeExtIds.length > 0 ? tx`AND NOT EXISTS (SELECT 1 FROM unnest(${excludeExtIds}::text[], ${excludeMediaTypes}::text[]) AS excluded(primary_ext_id, media_type) WHERE excluded.primary_ext_id = mwe.primary_ext_id AND excluded.media_type = mwe.media_type)` : tx``}
			ORDER BY jellyseerr_embedding_vec <=> ${userVector}::vector
			LIMIT ${limit}
		`;
        }

        // Both sources with late fusion scoring
        return tx<SimilarMediaDualRow[]>`
		${baseQuery},
		scored_media AS (
			SELECT ${mediaSelectFields},
				   CASE
					   WHEN jellyfin_embedding_vec IS NOT NULL
					   THEN 1 - (jellyfin_embedding_vec <=> ${userVector}::vector)
					   ELSE NULL
				   END as library_similarity,
				   CASE
					   WHEN jellyseerr_embedding_vec IS NOT NULL
					   THEN 1 - (jellyseerr_embedding_vec <=> ${userVector}::vector)
					   ELSE NULL
				   END as discovery_similarity,

				   -- Quality score (normalized)
				   COALESCE(imdb_rating / 10.0, 0) * 0.6 +
				   COALESCE(rt_rating / 100.0, 0) * 0.4 as quality_score,

				   -- Popularity score (normalized and clamped)
				   LEAST(COALESCE(popularity / 1000.0, 0), 1.0) as popularity_score,

				   -- Combined score with quality + popularity weights. The embedding
				   -- term is a WEIGHTED FUSION of the library and discovery
				   -- similarities (blended when both present, single value when one
				   -- present) rather than GREATEST(), so both sources' signal
				   -- contributes instead of only the larger one.
				   --
				   -- Availability is deliberately ABSENT here: the old availability /
				   -- avoid-weight terms added a ~0.35 normalized offset that dwarfed
				   -- the (typically <0.02) similarity spread, hard-partitioning
				   -- results library-first so a strong discovery match could never
				   -- outrank a weak available one. The engine now interleaves
				   -- available vs requestable AFTER scoring.
				   (
					   (
						   ${buildFusedSimilarityExpr(tx, tx`jellyfin_embedding_vec`, tx`jellyseerr_embedding_vec`, tx`${userVector}::vector`)}
						   + (COALESCE(imdb_rating / 10.0, 0) * 0.6 + COALESCE(rt_rating / 100.0, 0) * 0.4) * ${qualityWeightValue}::float
						   + LEAST(COALESCE(popularity / 1000.0, 0), 1.0) * ${popularityWeightValue}::float
					   ) / ${maxPossibleScore}::float
				   ) as combined_score

			FROM media_with_embeddings mwe
			WHERE (jellyfin_embedding_vec IS NOT NULL OR jellyseerr_embedding_vec IS NOT NULL)
			  ${excludeUserId ? tx`AND NOT EXISTS (SELECT 1 FROM user_ratings ur WHERE ur.user_id = ${excludeUserId} AND ur.media_id = mwe.media_uuid)` : tx``}
			  ${excludeWatchedForUserId ? tx`AND NOT EXISTS (SELECT 1 FROM user_media_state uwh WHERE uwh.user_id = ${excludeWatchedForUserId} AND uwh.media_id = mwe.media_uuid AND uwh.is_watched = true)` : tx``}
			  ${excludeExtIds.length > 0 ? tx`AND NOT EXISTS (SELECT 1 FROM unnest(${excludeExtIds}::text[], ${excludeMediaTypes}::text[]) AS excluded(primary_ext_id, media_type) WHERE excluded.primary_ext_id = mwe.primary_ext_id AND excluded.media_type = mwe.media_type)` : tx``}
		),
		-- Callers (suggestion-engine.service.ts's interleaveByAvailability, the
		-- modal similar endpoint, and /j/Items/.../Similar) partition/filter this
		-- result by is_available AFTER the fetch. A single mixed LIMIT window
		-- lets one availability class evict the other entirely — discovery
		-- (unavailable) candidates can outnumber library items and score into the
		-- top of the fused ranking, starving the available bucket before it ever
		-- reaches the window. Rank each class independently so both survive to
		-- the caller's interleave/filter.
		availability_ranked AS (
			SELECT *, ROW_NUMBER() OVER (
				PARTITION BY is_available
				ORDER BY combined_score DESC
			) as availability_rank
			FROM scored_media
		)
		SELECT
			media_uuid, id, primary_ext_id, imdb_id, media_type, title, original_title,
			release_year, is_local_only, created_at, updated_at, overview, genres, vote_count,
			popularity, runtime_minutes, imdb_rating, rt_rating, rt_audience_score, mdblist_score,
			letterboxd_rating, letterboxd_votes, metacritic_score, trakt_score, actors, directors,
			poster_path, backdrop_path, is_available, can_request,
			has_library_embedding, has_discovery_embedding, library_similarity, discovery_similarity,
			quality_score, popularity_score, combined_score
		FROM availability_ranked
		WHERE availability_rank <= ${limit}
		ORDER BY combined_score DESC
	`;
    });
}

/**
 * One embedding vector (as pgvector text) per requested media UUID.
 * Used to hydrate the actual vectors for a bounded candidate set AFTER the
 * similarity search returned only presence booleans (see F9 / findSimilarMediaDual).
 */
export interface CandidateEmbeddingRow {
    media_uuid: string;
    library_embedding: string | null;
    discovery_embedding: string | null;
}

/**
 * Fetch the library/discovery embedding vectors (as text) for a specific set of
 * candidate media UUIDs in a single round trip.
 *
 * `findSimilarMediaDual` intentionally no longer ships `embedding::text` on every
 * row. Callers that genuinely need the raw vector for a bounded subset of
 * candidates (e.g. taste-damper penalty steering of the surviving pool) use this
 * to fetch only what they need — one query, only when required.
 *
 * TAKES NO ACCESS BOUNDARY, deliberately. It is a hydration step over an id list
 * the caller already holds, and it returns only embedding vectors — no title, no
 * metadata, nothing a denied row would leak. Its sole caller
 * (`_applyDamperSteering`) passes the `media_uuid`s of rows that
 * `findSimilarMediaDual` already gated. Do not treat it as an access-checking
 * entry point: called with arbitrary ids it will happily hydrate them.
 *
 * @param sql - Postgres SQL client instance
 * @param mediaUuids - Internal media UUIDs to fetch embeddings for
 * @returns One row per matched UUID with library/discovery embedding text (or null)
 */
export async function fetchCandidateEmbeddings(
    sql: postgres.Sql,
    mediaUuids: string[],
): Promise<CandidateEmbeddingRow[]> {
    if (mediaUuids.length === 0) return [];

    return await sql<CandidateEmbeddingRow[]>`
		SELECT
			mi.id as media_uuid,
			(SELECT embedding::text FROM media_embeddings
			 WHERE media_id = mi.id AND source = ${EMBEDDING_SOURCE.LIBRARY} LIMIT 1) as library_embedding,
			(SELECT embedding::text FROM media_embeddings
			 WHERE media_id = mi.id AND source = ${EMBEDDING_SOURCE.DISCOVERY} LIMIT 1) as discovery_embedding
		FROM media_items mi
		WHERE mi.id = ANY(${mediaUuids}::uuid[])
	`;
}
