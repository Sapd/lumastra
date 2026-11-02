// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mood Recommendations Queries
 *
 * SQL queries for keyword-mode mood-based media recommendations.
 * Supports personalized (user embedding) and non-personalized variants,
 * plus a trending supplement query.
 *
 * @module queries/mood-recommendations
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { isAvailableExpr, canRequestExpr } from './availability.queries.js';
import { buildOverrideAwareMetadataLateralJoinFragment } from './builders/provider-metadata.builder.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { buildDamperPenalty, DAMPER_LAMBDA } from './builders/damper-penalty.builder.js';
import type { DamperContext } from '$lib/server/services/taste-damper.service.js';
import { KIDS_GENRE_IDS, ANIME_GENRE_ID } from './content-affinity.queries.js';
import type {
    BaseMediaWithExtIdRow,
    AvailabilityFields,
    MetadataContent,
    ExtendedRatings,
    MetadataArrays,
    SimilarityFields,
} from './types/index.js';

// =============================================================================
// Types
// =============================================================================

/** Nullable variant of AvailabilityFields for queries where LEFT JOINs may produce nulls */
type NullableAvailability = {
    [K in keyof AvailabilityFields]: AvailabilityFields[K] | null;
};

/**
 * Personalized mood rows need at least this taste similarity (1 - cosine
 * distance to the user's catalog embedding). Rows without an embedding score a
 * neutral 0.5 and pass. Used twice in findMoodMediaPersonalized: as an early
 * filter before the jsonb laterals and in the final ranking cut.
 */
const MOOD_TASTE_FLOOR = 0.45;

export type MoodMediaRow = Omit<BaseMediaWithExtIdRow, 'media_id'> &
    NullableAvailability &
    Pick<MetadataContent, 'overview' | 'release_date' | 'runtime_minutes' | 'trailer_url'> &
    Pick<
        ExtendedRatings,
        | 'imdb_rating'
        | 'rt_rating'
        | 'rt_audience_score'
        | 'letterboxd_rating'
        | 'mdblist_score'
        | 'popularity'
    > &
    /**
     * The mood queries no longer project the raw `genres` / `mdblist_keywords`
     * arrays: match counting moved into single-pass LATERALs (see
     * buildKeywordStatsLateral / buildGenreStatsLateral), so materialising the
     * ~118-element keyword array per row was pure cost with no consumer.
     * `findTrendingMoodMedia` never selected them either, so these were already
     * absent on that path — now the type says so.
     */
    Partial<Pick<MetadataArrays, 'genres' | 'mdblist_keywords'>> &
    Partial<SimilarityFields> & {
        internal_id?: string | null;
        relevance_score?: number | null;
        /** Profile keyword hits in the winning provider blob (duplicates counted). */
        keyword_matches?: number | null;
        /** Profile genre hits in the winning provider blob (duplicates counted). */
        genre_matches?: number | null;
    };

export interface MoodQueryProfile {
    keywords: string[];
    genres: number[];
    excludeGenres: number[];
    excludeKeywords: string[];
    minRuntime?: number;
    maxRuntime?: number;
    minRating?: number;
    maxRating?: number;
    maxPopularity?: number;
    minPopularity?: number;
    minYear?: number;
    maxYear?: number;
}

// =============================================================================
// Constants
// =============================================================================

// =============================================================================
// Shared fragments
// =============================================================================

/**
 * Candidate prefilter: the set of media that could possibly match this mood.
 *
 * A mood matches when `keyword_matches > 0 OR genre_matches > 0`, so any row in
 * the final result MUST carry a profile genre or a profile keyword in *some*
 * provider's blob. `media_genres` / `media_keywords` are trigger-maintained
 * projections of exactly those JSONB arrays (verified on prod: zero drift in
 * either direction), so a source-agnostic union over them is a guaranteed
 * SUPERSET of the matches — a lossless prefilter, not a semantic filter. The
 * existing `keyword_matches`/`genre_matches` scoring still runs against the
 * winning provider blob afterwards, so results are byte-identical.
 *
 * This is what keeps the query off a full `media_items` scan: on prod it cuts
 * the rows entering the provider_metadata LATERAL from ~100k to ~6.5k.
 *
 * NOTE: this is NOT the embedding-prefilter mistake described on
 * `findMoodMediaPersonalized` below. That one dropped real matches because
 * nearest-neighbour proximity is not what defines a mood. This prefilter is
 * derived from the mood's own keyword/genre definition, so it cannot drop a
 * row the scoring would have kept.
 *
 * `media_keywords.keyword` is written as `lower(btrim(...))` by the
 * `media_keywords_sync` trigger, so the lowercased profile keywords match
 * directly and hit `idx_media_keywords_kw (keyword_type, keyword)`. Do NOT wrap
 * the column in `lower()` — that defeats the index (measured +270ms on prod).
 */
function buildMoodCandidatesCte(
    sql: postgres.Sql,
    profile: MoodQueryProfile,
): postgres.PendingQuery<postgres.Row[]> {
    const keywordsLower = profile.keywords.map((k) => k.toLowerCase());
    // An empty `= ANY(ARRAY[])` matches nothing, which is the correct
    // contribution for a profile half that isn't defined.
    return sql`
        SELECT media_id FROM media_genres
        WHERE genre_id = ANY(${profile.genres})
        UNION
        SELECT media_id FROM media_keywords
        WHERE keyword_type = 'mdblist' AND keyword = ANY(${keywordsLower})
    `;
}

/**
 * Keyword counters, computed in ONE pass over the keyword array.
 *
 * `mdblist_keywords` averages ~118 entries per item on prod. The previous shape
 * unnested it separately for each counter (match / exclude / anime) and again
 * for the ORDER BY, i.e. ~5 unnests of a 118-element array per row. Collapsing
 * them into a single LATERAL with FILTERed aggregates keeps the duplicate
 * counting semantics of the original (the arrays DO contain duplicates, and
 * `keyword_matches` intentionally counts them) while parsing the JSONB once.
 */
function buildKeywordStatsLateral(
    sql: postgres.Sql,
    profile: MoodQueryProfile,
): postgres.PendingQuery<postgres.Row[]> {
    const keywordsLower = profile.keywords.map((k) => k.toLowerCase());
    const excludeKeywordsLower = profile.excludeKeywords.map((k) => k.toLowerCase());
    return sql`
        LEFT JOIN LATERAL (
            SELECT
                count(*) FILTER (WHERE lower(kw) = ANY(${keywordsLower})) AS keyword_matches,
                count(*) FILTER (
                    WHERE lower(kw) = ANY(${excludeKeywordsLower.length > 0 ? excludeKeywordsLower : ['__none__']})
                ) AS excluded_keyword_matches,
                count(*) FILTER (WHERE lower(kw) = 'anime') AS anime_kw_matches
            FROM jsonb_array_elements_text(pm.metadata->'mdblist_keywords') AS t(kw)
            WHERE jsonb_typeof(pm.metadata->'mdblist_keywords') = 'array'
        ) kwstats ON true
    `;
}

/**
 * Genre counters, computed in ONE pass over the genre array — same rationale as
 * {@link buildKeywordStatsLateral}. Preserves the original element decoding
 * (objects carry `{id}`, bare numerics are ids) and its duplicate counting.
 */
function buildGenreStatsLateral(
    sql: postgres.Sql,
    profile: MoodQueryProfile,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        LEFT JOIN LATERAL (
            SELECT
                count(*) FILTER (WHERE gid = ANY(${profile.genres})) AS genre_matches,
                count(*) FILTER (
                    WHERE gid = ANY(${profile.excludeGenres.length > 0 ? profile.excludeGenres : [-1]})
                ) AS excluded_genre_matches,
                count(*) FILTER (WHERE gid = ANY(${KIDS_GENRE_IDS})) AS kids_genre_matches,
                count(*) FILTER (WHERE gid = ${ANIME_GENRE_ID}) AS animation_genre_matches
            FROM (
                SELECT CASE
                    WHEN jsonb_typeof(elem) = 'object' THEN (elem->>'id')::integer
                    WHEN elem::text ~ '^[0-9]+$' THEN (elem::text)::integer
                    ELSE NULL
                END AS gid
                FROM jsonb_array_elements(pm.metadata->'genres') AS elem
            ) g
            WHERE jsonb_typeof(pm.metadata->'genres') = 'array'
        ) gstats ON true
    `;
}

/**
 * Run a mood query with JIT disabled for the duration.
 *
 * These queries build enough expression nodes that Postgres JITs them, and the
 * compile cost is pure overhead on a query that returns 30 rows — measured at
 * ~840ms of a 3.9s execution before the rewrite, and still ~190ms of ~1.2s
 * after. `SET LOCAL` needs a transaction, hence the wrapper; the callback
 * receives the transaction handle so every interpolated fragment is built
 * against the SAME connection that has `jit = off` applied.
 *
 * The result is boxed in an object because postgres.js unwraps a bare array
 * returned from `begin()`.
 *
 * The callback receives the transaction handle typed as `postgres.Sql`, not
 * `TransactionSql`: postgres-js omits the template-tag call signature from
 * `TransactionSql`'s declaration even though it works at runtime, so the repo
 * convention is to widen at the boundary (same note as
 * `withAdvisoryLock` in database/with-advisory-lock.ts).
 */
async function runMoodQueryWithoutJit(
    sql: postgres.Sql,
    build: (tx: postgres.Sql) => Promise<MoodMediaRow[]>,
): Promise<MoodMediaRow[]> {
    const { rows } = await sql.begin(async (rawTx) => {
        // Widen once, here — see the note above on TransactionSql's missing
        // call signature. Everything downstream then uses a normal Sql handle.
        const tx = rawTx as unknown as postgres.Sql;
        await tx`SET LOCAL jit = off`;
        return { rows: await build(tx) };
    });
    return rows;
}

// =============================================================================
// Queries
// =============================================================================

/**
 * Personalized mood media query — incorporates user taste vector similarity.
 * AI similarity acts as a filter (must be > 0.45) to exclude content the user doesn't watch.
 *
 * Always a full keyword/genre scan — moods are DEFINED by keywords/genres, not
 * by embedding proximity, so an HNSW two-phase prefilter is the wrong access
 * path here: it would restrict candidates to the library-source items nearest a
 * synthetic mood vector, dropping (a) every requestable/discovery item
 * (`source != 'library'`) and (b) any keyword/genre match whose embedding is not
 * among the nearest neighbours. On prod that collapsed a 700+-match mood to ~4
 * (or "no matches"). The two-phase variant was removed for this reason; do NOT
 * reintroduce it behind `FEATURE_TWO_PHASE_ANN` — that flag governs the
 * embedding-driven similar/genre rails only, never mood.
 */
export async function findMoodMediaPersonalized(
    sql: postgres.Sql,
    params: {
        profile: MoodQueryProfile;
        mediaType?: 'movie' | 'tv';
        userId: UserId;
        limit: number;
        /**
         * REQUIRED access boundary. No permissive default: a caller that wants
         * unrestricted results must say so with `unrestrictedAccess()`.
         */
        access: MediaAccessBoundary;
        damper?: DamperContext | null;
        /**
         * Soft down-rank items whose genres include Family/Kids (10751/10762).
         * Never excludes — subtracts a flat penalty from relevance_score so a
         * family-heavy library still fills the rail rather than returning empty.
         */
        suppressKidsContent?: boolean;
        /**
         * Soft down-rank anime items (mdblist keyword 'anime', OR genre 16
         * (Animation) AND Japanese original language). Never excludes — same
         * flat-penalty shape as `suppressKidsContent`.
         */
        suppressAnimeContent?: boolean;
    },
): Promise<MoodMediaRow[]> {
    const {
        profile,
        mediaType,
        userId,
        limit,
        access,
        damper = null,
        suppressKidsContent = false,
        suppressAnimeContent = false,
    } = params;
    // Access short-circuit FIRST, ahead of the profile fast-path: a caller that
    // may see nothing must never reach the query regardless of its profile.
    if (deniesEverything(access)) return [];
    if (profile.keywords.length === 0 && profile.genres.length === 0) return [];

    return runMoodQueryWithoutJit(sql, (tx) => {
        // Built against `tx`, NOT the outer `sql` — runMoodQueryWithoutJit applies
        // `SET LOCAL jit = off` to this transaction, and every interpolated
        // fragment must be bound to that same connection.
        const libraryFilter = buildLibraryAccessFilter(tx, access.library);
        const ageFilter = buildAgeRatingFilter(tx, access.age);

        return tx<MoodMediaRow[]>`
        WITH user_profile AS (
            SELECT catalog_embedding
            FROM user_profiles
            WHERE user_id = ${userId}
        ),
        candidates AS (
            ${buildMoodCandidatesCte(tx, profile)}
        ),
        mood_matches AS (
            SELECT DISTINCT ON (primary_ext.external_id, mi.media_type)
                mi.id::text as internal_id,
                primary_ext.external_id as primary_ext_id,
                mi.title,
                mi.media_type,
                (pm.metadata->>'overview')::text as overview,
                (pm.metadata->>'imdb_rating')::float as imdb_rating,
                (pm.metadata->>'rt_rating')::integer as rt_rating,
                (pm.metadata->>'rt_audience_score')::integer as rt_audience_score,
                (pm.metadata->>'letterboxd_rating')::float as letterboxd_rating,
                (pm.metadata->>'mdblist_score')::float as mdblist_score,
                (pm.metadata->>'trailer_url')::text as trailer_url,
                CASE WHEN mi.year IS NOT NULL AND mi.year BETWEEN 1 AND 9999
                    THEN make_date(mi.year, 1, 1)
                    ELSE NULL
                END as release_date,
                (pm.metadata->>'popularity')::float as popularity,
                (pm.metadata->>'runtime_minutes')::integer as runtime_minutes,
                ${isAvailableExpr(tx)} AS is_available,
                ${canRequestExpr(tx)} AS can_request,
                (pm.metadata->>'original_language')::text as original_language,
                jf_emb.embedding as jellyfin_embedding,
                COALESCE(kwstats.keyword_matches, 0) as keyword_matches,
                COALESCE(kwstats.excluded_keyword_matches, 0) as excluded_keyword_matches,
                COALESCE(kwstats.anime_kw_matches, 0) as anime_kw_matches,
                COALESCE(gstats.genre_matches, 0) as genre_matches,
                COALESCE(gstats.excluded_genre_matches, 0) as excluded_genre_matches,
                COALESCE(gstats.kids_genre_matches, 0) as kids_genre_matches,
                COALESCE(gstats.animation_genre_matches, 0) as animation_genre_matches,
                -- AI similarity score (0-1, higher is better)
                CASE
                    WHEN jf_emb.embedding IS NOT NULL AND up.catalog_embedding IS NOT NULL
                    THEN 1 - (jf_emb.embedding <=> up.catalog_embedding)
                    ELSE 0.5
                END as ai_similarity
            FROM candidates c
            JOIN media_items mi ON mi.id = c.media_id
            JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
            ${buildOverrideAwareMetadataLateralJoinFragment(tx)}
            ${buildKeywordStatsLateral(tx, profile)}
            ${buildGenreStatsLateral(tx, profile)}
            LEFT JOIN media_embeddings jf_emb ON jf_emb.media_id = mi.id AND jf_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
            CROSS JOIN user_profile up
            WHERE mi.status = 'active'
            -- The ai_similarity > MOOD_TASTE_FLOOR cut of mood_ranked, applied here so the
            -- ~80% of candidates it drops never reach the jsonb-heavy keyword and
            -- genre laterals (prod: 3.1 s -> 0.8 s). Rows without an embedding
            -- score 0.5 there and pass, so they pass here too.
            AND (
                jf_emb.embedding IS NULL
                OR up.catalog_embedding IS NULL
                OR 1 - (jf_emb.embedding <=> up.catalog_embedding) > ${MOOD_TASTE_FLOOR}
            )
            ${libraryFilter}
            ${ageFilter}
            ${mediaType ? tx`AND mi.media_type = ${mediaType}` : tx``}
            -- Runtime filters for mood recipes (Short & Sweet, Brain Food, etc.)
            ${profile.minRuntime ? tx`AND (pm.metadata->>'runtime_minutes')::integer >= ${profile.minRuntime}` : tx``}
            ${profile.maxRuntime ? tx`AND (pm.metadata->>'runtime_minutes')::integer <= ${profile.maxRuntime}` : tx``}
            -- Popularity filters for Hidden Gems
            ${profile.minPopularity ? tx`AND (pm.metadata->>'popularity')::float >= ${profile.minPopularity}` : tx``}
            ${profile.maxPopularity ? tx`AND (pm.metadata->>'popularity')::float <= ${profile.maxPopularity}` : tx``}
            -- Quality thresholds
            ${profile.minRating ? tx`AND (pm.metadata->>'imdb_rating')::float >= ${profile.minRating}` : tx``}
            ${profile.maxRating ? tx`AND (pm.metadata->>'imdb_rating')::float <= ${profile.maxRating}` : tx``}
            -- Year filters for Nostalgia, etc.
            ${profile.minYear ? tx`AND mi.year >= ${profile.minYear}` : tx``}
            ${profile.maxYear ? tx`AND mi.year <= ${profile.maxYear}` : tx``}
            -- Exclude disliked content (rating <= 4). Same idiom as
            -- binge-worthy/featured-pick — user-scoped, so safe to bake into
            -- the per-user mood query. Rewatching by mood is intentionally
            -- allowed, so unlike binge-worthy this does NOT also exclude
            -- watched items.
            AND NOT EXISTS (
                SELECT 1 FROM user_ratings ur
                WHERE ur.user_id = ${userId} AND ur.media_id = mi.id AND ur.rating <= 4
            )
        ),
        mood_scored AS (
            SELECT *,
                -- Anime match: mdblist keyword 'anime', OR (Animation genre 16
                -- AND Japanese original language) — soft down-rank signal only,
                -- never a hard exclusion. Mirrors kids_genre_matches' shape.
                (
                    CASE WHEN (
                        anime_kw_matches > 0
                        OR (animation_genre_matches > 0 AND original_language = 'ja')
                    ) THEN 1 ELSE 0 END
                ) as anime_matches
            FROM mood_matches
            WHERE (is_available = true OR can_request = true)
        ),
        mood_ranked AS (
            SELECT *,
                -- Combined relevance score with AI personalization
                (
                    -- AI similarity contributes significantly (0-40 points based on match)
                    ai_similarity * 40 +
                    -- Keyword/genre matching
                    keyword_matches * 10 +
                    genre_matches * 6 +
                    -- Quality scores
                    COALESCE(mdblist_score, 0) * 0.25 +
                    COALESCE(imdb_rating::numeric, 0) * 2.5 +
                    COALESCE(letterboxd_rating, 0) * 4 +
                    LEAST(COALESCE(popularity, 0) / 15, 8) +
                    -- Recency bonus
                    CASE
                        WHEN release_date IS NOT NULL AND release_date > NOW() - INTERVAL '2 years'
                        THEN 4
                        WHEN release_date IS NOT NULL AND release_date > NOW() - INTERVAL '5 years'
                        THEN 2
                        ELSE 0
                    END
                    -- Soft cluster (kids/anime) down-rank (flat penalty, no exclusion)
                    - (CASE WHEN (${suppressKidsContent} AND kids_genre_matches > 0)
                            OR (${suppressAnimeContent} AND anime_matches > 0)
                       THEN 60 ELSE 0 END)
                ) as relevance_score
            FROM mood_scored
            WHERE (keyword_matches > 0 OR genre_matches > 0)
            AND excluded_genre_matches = 0
            AND excluded_keyword_matches = 0
            AND ai_similarity > ${MOOD_TASTE_FLOOR}  -- Filter out content user doesn't watch
        )
        SELECT *
        FROM mood_ranked
        ORDER BY
            -- Suppressed kids/anime items also forfeit the availability boost:
            -- in a small library where most short/available titles are kids/
            -- anime content, the relevance penalty alone can't push them below
            -- requestable adult titles (availability sorts first). They stay
            -- in the pool.
            (CASE WHEN (${suppressKidsContent} AND kids_genre_matches > 0)
                  OR (${suppressAnimeContent} AND anime_matches > 0)
             THEN false ELSE is_available END) DESC,
            -- "Show less like this": demote picks near an active damper.
            (relevance_score - GREATEST(relevance_score, 0) * ${DAMPER_LAMBDA}::numeric * ${buildDamperPenalty(tx, tx`jellyfin_embedding`, damper)}) DESC,
            ai_similarity DESC,
            keyword_matches DESC,
            mdblist_score DESC NULLS LAST
        LIMIT ${limit}
    `;
    });
}

/**
 * Non-personalized mood media query — no user profile, uses keyword/genre matching only.
 */
export async function findMoodMedia(
    sql: postgres.Sql,
    params: {
        profile: MoodQueryProfile;
        mediaType?: 'movie' | 'tv';
        userId: UserId;
        limit: number;
        /**
         * REQUIRED access boundary. No permissive default: a caller that wants
         * unrestricted results must say so with `unrestrictedAccess()`.
         */
        access: MediaAccessBoundary;
        /**
         * Soft down-rank items whose genres include Family/Kids (10751/10762).
         * Never excludes — subtracts a flat penalty from relevance_score so a
         * family-heavy library still fills the rail rather than returning empty.
         */
        suppressKidsContent?: boolean;
        /**
         * Soft down-rank anime items (mdblist keyword 'anime', OR genre 16
         * (Animation) AND Japanese original language). Never excludes — same
         * flat-penalty shape as `suppressKidsContent`.
         */
        suppressAnimeContent?: boolean;
    },
): Promise<MoodMediaRow[]> {
    const {
        profile,
        mediaType,
        userId,
        limit,
        access,
        suppressKidsContent = false,
        suppressAnimeContent = false,
    } = params;
    // Access short-circuit FIRST — see findMoodMediaPersonalized.
    if (deniesEverything(access)) return [];
    if (profile.keywords.length === 0 && profile.genres.length === 0) return [];

    return runMoodQueryWithoutJit(sql, (tx) => {
        // Bound to `tx` for the same reason as findMoodMediaPersonalized.
        const libraryFilter = buildLibraryAccessFilter(tx, access.library);
        const ageFilter = buildAgeRatingFilter(tx, access.age);

        return tx<MoodMediaRow[]>`
        WITH candidates AS (
            ${buildMoodCandidatesCte(tx, profile)}
        ),
        mood_matches AS (
            SELECT DISTINCT ON (primary_ext.external_id, mi.media_type)
                mi.id::text as internal_id,
                primary_ext.external_id as primary_ext_id,
                mi.title,
                mi.media_type,
                (pm.metadata->>'overview')::text as overview,
                (pm.metadata->>'imdb_rating')::float as imdb_rating,
                (pm.metadata->>'rt_rating')::integer as rt_rating,
                (pm.metadata->>'rt_audience_score')::integer as rt_audience_score,
                (pm.metadata->>'letterboxd_rating')::float as letterboxd_rating,
                (pm.metadata->>'mdblist_score')::float as mdblist_score,
                (pm.metadata->>'trailer_url')::text as trailer_url,
                CASE WHEN mi.year IS NOT NULL AND mi.year BETWEEN 1 AND 9999
                    THEN make_date(mi.year, 1, 1)
                    ELSE NULL
                END as release_date,
                (pm.metadata->>'popularity')::float as popularity,
                (pm.metadata->>'runtime_minutes')::integer as runtime_minutes,
                ${isAvailableExpr(tx)} AS is_available,
                ${canRequestExpr(tx)} AS can_request,
                (pm.metadata->>'original_language')::text as original_language,
                COALESCE(kwstats.keyword_matches, 0) as keyword_matches,
                COALESCE(kwstats.excluded_keyword_matches, 0) as excluded_keyword_matches,
                COALESCE(kwstats.anime_kw_matches, 0) as anime_kw_matches,
                COALESCE(gstats.genre_matches, 0) as genre_matches,
                COALESCE(gstats.excluded_genre_matches, 0) as excluded_genre_matches,
                COALESCE(gstats.kids_genre_matches, 0) as kids_genre_matches,
                COALESCE(gstats.animation_genre_matches, 0) as animation_genre_matches
            FROM candidates c
            JOIN media_items mi ON mi.id = c.media_id
            JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
            ${buildOverrideAwareMetadataLateralJoinFragment(tx)}
            ${buildKeywordStatsLateral(tx, profile)}
            ${buildGenreStatsLateral(tx, profile)}
            WHERE mi.status = 'active'
            ${libraryFilter}
            ${ageFilter}
            ${mediaType ? tx`AND mi.media_type = ${mediaType}` : tx``}
            -- Runtime filters for mood recipes (Short & Sweet, Brain Food, etc.)
            ${profile.minRuntime ? tx`AND (pm.metadata->>'runtime_minutes')::integer >= ${profile.minRuntime}` : tx``}
            ${profile.maxRuntime ? tx`AND (pm.metadata->>'runtime_minutes')::integer <= ${profile.maxRuntime}` : tx``}
            -- Popularity filters for Hidden Gems
            ${profile.minPopularity ? tx`AND (pm.metadata->>'popularity')::float >= ${profile.minPopularity}` : tx``}
            ${profile.maxPopularity ? tx`AND (pm.metadata->>'popularity')::float <= ${profile.maxPopularity}` : tx``}
            -- Quality thresholds
            ${profile.minRating ? tx`AND (pm.metadata->>'imdb_rating')::float >= ${profile.minRating}` : tx``}
            ${profile.maxRating ? tx`AND (pm.metadata->>'imdb_rating')::float <= ${profile.maxRating}` : tx``}
            -- Year filters for Nostalgia, etc.
            ${profile.minYear ? tx`AND mi.year >= ${profile.minYear}` : tx``}
            ${profile.maxYear ? tx`AND mi.year <= ${profile.maxYear}` : tx``}
            -- Exclude disliked content (rating <= 4). Same idiom as
            -- binge-worthy/featured-pick — user-scoped, so safe to bake into
            -- the per-user mood query. Rewatching by mood is intentionally
            -- allowed, so unlike binge-worthy this does NOT also exclude
            -- watched items.
            AND NOT EXISTS (
                SELECT 1 FROM user_ratings ur
                WHERE ur.user_id = ${userId} AND ur.media_id = mi.id AND ur.rating <= 4
            )
        ),
        mood_scored AS (
            SELECT *,
                -- Anime match: mdblist keyword 'anime', OR (Animation genre 16
                -- AND Japanese original language) — soft down-rank signal only,
                -- never a hard exclusion. Mirrors kids_genre_matches' shape.
                (
                    CASE WHEN (
                        anime_kw_matches > 0
                        OR (animation_genre_matches > 0 AND original_language = 'ja')
                    ) THEN 1 ELSE 0 END
                ) as anime_matches
            FROM mood_matches
            WHERE (is_available = true OR can_request = true)
        )
        SELECT *,
            0.5 as ai_similarity,
            -- Combined relevance score
            (
                keyword_matches * 15 +
                genre_matches * 10 +
                COALESCE(mdblist_score, 0) * 0.3 +
                COALESCE(imdb_rating::numeric, 0) * 3 +
                COALESCE(letterboxd_rating, 0) * 5 +
                LEAST(COALESCE(popularity, 0) / 10, 10) +
                -- Recency bonus
                CASE
                    WHEN release_date IS NOT NULL AND release_date > NOW() - INTERVAL '2 years'
                    THEN 5
                    WHEN release_date IS NOT NULL AND release_date > NOW() - INTERVAL '5 years'
                    THEN 2
                    ELSE 0
                END
                -- Soft cluster (kids/anime) down-rank (flat penalty, no exclusion)
                - (CASE WHEN (${suppressKidsContent} AND kids_genre_matches > 0)
                        OR (${suppressAnimeContent} AND anime_matches > 0)
                   THEN 60 ELSE 0 END)
            ) as relevance_score
        FROM mood_scored
        WHERE (keyword_matches > 0 OR genre_matches > 0)
        AND excluded_genre_matches = 0
        AND excluded_keyword_matches = 0
        ORDER BY
            -- Suppressed kids/anime items also forfeit the availability boost
            -- (see findMoodMediaPersonalized) so a kids/anime-heavy small
            -- library can't pin them above requestable adult titles.
            (CASE WHEN (${suppressKidsContent} AND kids_genre_matches > 0)
                  OR (${suppressAnimeContent} AND anime_matches > 0)
             THEN false ELSE is_available END) DESC,
            relevance_score DESC,
            keyword_matches DESC,
            mdblist_score DESC NULLS LAST
        LIMIT ${limit}
    `;
    });
}

/**
 * Trending supplement query — fills in results when primary queries return fewer than limit.
 * Merges two variants (with/without exclusion list) into one function.
 */
export async function findTrendingMoodMedia(
    sql: postgres.Sql,
    params: {
        mediaType?: 'movie' | 'tv';
        limit: number;
        excludeList?: Array<{ primary_ext_id: string; media_type: string }>;
        /**
         * REQUIRED access boundary. No permissive default: a caller that wants
         * unrestricted results must say so with `unrestrictedAccess()`.
         */
        access: MediaAccessBoundary;
    },
): Promise<MoodMediaRow[]> {
    const { mediaType, limit, excludeList, access } = params;
    // Unlike the two mood queries this has no profile fast-path, so the access
    // short-circuit is the only early return.
    if (deniesEverything(access)) return [];
    // No runMoodQueryWithoutJit wrapper here, so these bind to the outer `sql`.
    const libraryFilter = buildLibraryAccessFilter(sql, access.library);
    const ageFilter = buildAgeRatingFilter(sql, access.age);

    if (excludeList && excludeList.length > 0) {
        return sql<MoodMediaRow[]>`
            SELECT
                mi.id::text as internal_id,
                primary_ext.external_id as primary_ext_id,
                mi.title,
                mi.media_type,
                (pm.metadata->>'overview')::text as overview,
                (pm.metadata->>'imdb_rating')::float as imdb_rating,
                (pm.metadata->>'rt_rating')::integer as rt_rating,
                (pm.metadata->>'letterboxd_rating')::float as letterboxd_rating,
                (pm.metadata->>'mdblist_score')::float as mdblist_score,
                (pm.metadata->>'popularity')::float as popularity,
                ${isAvailableExpr(sql)} AS is_available,
                ${canRequestExpr(sql)} AS can_request,
                0.5 as ai_similarity
            FROM media_items mi
            JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
            ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
            WHERE mi.status = 'active'
            ${libraryFilter}
            ${ageFilter}
            ${mediaType ? sql`AND mi.media_type = ${mediaType}` : sql``}
            AND COALESCE((pm.metadata->>'popularity')::float, 0) > 50
            AND NOT EXISTS (
                SELECT 1 FROM (VALUES ${sql(excludeList.map((e) => [e.primary_ext_id, e.media_type]))}) AS excluded(primary_ext_id, media_type)
                WHERE excluded.primary_ext_id::text = primary_ext.external_id AND excluded.media_type::text = mi.media_type
            )
            ORDER BY (pm.metadata->>'popularity')::float DESC
            LIMIT ${limit}
        `;
    }

    return sql<MoodMediaRow[]>`
        SELECT
            mi.id::text as internal_id,
            primary_ext.external_id as primary_ext_id,
            mi.title,
            mi.media_type,
            (pm.metadata->>'overview')::text as overview,
            (pm.metadata->>'imdb_rating')::float as imdb_rating,
            (pm.metadata->>'rt_rating')::integer as rt_rating,
            (pm.metadata->>'letterboxd_rating')::float as letterboxd_rating,
            (pm.metadata->>'mdblist_score')::float as mdblist_score,
            (pm.metadata->>'popularity')::float as popularity,
            ${isAvailableExpr(sql)} AS is_available,
            ${canRequestExpr(sql)} AS can_request,
            0.5 as ai_similarity
        FROM media_items mi
        JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.media_type = mi.media_type
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        WHERE mi.status = 'active'
        ${libraryFilter}
        ${ageFilter}
        ${mediaType ? sql`AND mi.media_type = ${mediaType}` : sql``}
        AND (pm.metadata->>'popularity')::float > 50
        ORDER BY (pm.metadata->>'popularity')::float DESC
        LIMIT ${limit}
    `;
}
