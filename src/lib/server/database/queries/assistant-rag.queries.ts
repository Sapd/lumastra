// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Assistant RAG Query Module
 *
 * Pure SQL queries for the AI assistant RAG (Retrieval-Augmented Generation) endpoint.
 * Extracted from the assistant API route to follow three-tier architecture.
 *
 * Key patterns:
 * - All functions take sql: postgres.Sql as first parameter
 * - Uses buildOverrideAwareMetadataLateralJoinFragment for metadata joins
 * - Uses getPrimaryExternalIdProvider for provider-agnostic queries
 * - Vector similarity search returns all rows; sorting happens in-memory in the route
 *
 * ## Access boundary
 *
 * Every query here that reads `media_items` takes a REQUIRED
 * {@link MediaAccessBoundary}. There is no permissive default: a caller that
 * wants unfiltered rows must spell out `unrestrictedAccess()`, which makes the
 * decision greppable, and omitting the argument is a compile error rather than
 * a silent security downgrade. This matters more here than almost anywhere
 * else in the codebase — every row these queries return is serialised straight
 * into the LLM prompt, so an unfiltered read leaks titles, overviews, and IDs
 * into a context the user can then interrogate in natural language.
 *
 * Each such query short-circuits `deniesEverything(access)` to an empty result
 * BEFORE issuing SQL. The builders would emit `AND false` anyway, so this is
 * equivalent, just without the round trip.
 *
 * Every query in this module aliases `media_items` as `mi`, which is what
 * `buildLibraryAccessFilter` hardcodes and what `buildAgeRatingFilter` defaults
 * to. Re-aliasing any of them silently detaches both fragments with no type
 * error — see the per-query notes on findMediaByGenre / findMediaByKeyword,
 * where the boundary predicates deliberately sit at the OUTER `WHERE` rather
 * than inside the provider_metadata EXISTS subqueries.
 *
 * TWO functions here take NO boundary, both deliberately and both documented at
 * their definitions: `getUserRecentRatings` and `getAllProviderKeywords`. Read
 * those notes before copying either as a pattern — neither is an oversight, but
 * neither is fully closed either.
 *
 * @module queries/assistant-rag
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { buildOverrideAwareMetadataLateralJoinFragment } from './builders/provider-metadata.builder.js';
import { isAvailableExpr, canRequestExpr } from './availability.queries.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { buildSocialVisibilityFilter } from './builders/social-visibility.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import type {
    BaseMediaWithExtIdRow,
    AvailabilityFields,
    MetadataContent,
    MetadataRatings,
    ExtendedRatings,
    MetadataArrays,
} from './types/index.js';

// =============================================================================
// Types
// =============================================================================

export type AssistantMovieRow = BaseMediaWithExtIdRow &
    Partial<Pick<AvailabilityFields, 'is_available' | 'can_request'>> &
    Partial<Pick<MetadataContent, 'overview' | 'runtime_minutes'>> &
    // NOTE: no `tmdb_rating` — nothing writes that key; see the rating-expression
    // block below. Reading it always yielded null and misled both code and model.
    Partial<Pick<MetadataRatings, 'imdb_rating' | 'rt_rating'>> &
    Partial<Pick<ExtendedRatings, 'rt_audience_score'>> &
    Partial<Pick<MetadataArrays, 'genres' | 'actors' | 'directors'>> & {
        release_date?: string | null;
        user_rating?: number | null;
        /**
         * Whether THIS user has watched the title (from `user_media_state.is_watched`,
         * the canonical watched signal). `false` when unwatched; `null`/absent when
         * the query ran without a user context. Surfaced so the model never presents
         * an already-seen title as a fresh discovery.
         */
        watched?: boolean | null;
    };

export interface AssistantMovieSimilarityRow extends AssistantMovieRow {
    similarity: number;
}

export interface UserRatingContextRow {
    title: string;
    genres?: number[] | null;
    rating: number;
    is_available?: boolean | null;
}

// =============================================================================
// Query Functions
// =============================================================================

/**
 * Increment chat usage for a user via the stored function.
 * Returns the current usage count after incrementing.
 * Throws if the rate limit is exceeded.
 */
export async function incrementChatUsage(
    sql: postgres.Sql,
    userId: UserId,
    isAdmin: boolean,
    dailyLimit: number,
): Promise<{ count: number }> {
    const [result] = await sql<{ count: number }[]>`
        INSERT INTO assistant_rate_limits (user_id, date, message_count, is_admin)
        VALUES (${userId}::uuid, CURRENT_DATE, 1, ${isAdmin})
        ON CONFLICT (user_id, date)
        DO UPDATE SET
            message_count = assistant_rate_limits.message_count + 1,
            is_admin = ${isAdmin},
            last_reset_at = CASE
                WHEN assistant_rate_limits.date < CURRENT_DATE THEN NOW()
                ELSE assistant_rate_limits.last_reset_at
            END
        RETURNING message_count as count
    `;
    if (result.count > dailyLimit) {
        throw new Error(
            `Rate limit exceeded. Limit: ${dailyLimit} messages per day. Current: ${result.count}`,
        );
    }
    return result;
}

/**
 * Get the current message count for a user today.
 * Returns null if no record exists for today.
 */
export async function getUserRateLimitUsage(
    sql: postgres.Sql,
    userId: UserId,
): Promise<{ message_count: number } | null> {
    const [result] = await sql<{ message_count: number }[]>`
        SELECT message_count FROM assistant_rate_limits
        WHERE user_id = ${userId}::uuid AND date = CURRENT_DATE
    `;
    return result ?? null;
}

/**
 * Find relevant media items using pgvector similarity search.
 * Returns ALL rows above threshold — sorting and slicing happen in-memory in the route.
 *
 * The access boundary is REQUIRED so the LLM context can never include titles,
 * overviews, ratings, or IDs for content the user is not allowed to see.
 * The assistant route blocks age-restricted users entirely, but library
 * group restrictions still apply — and the age axis is kept here as
 * defense-in-depth in case the route gate ever changes.
 */
export async function findRelevantMediaByVector(
    sql: postgres.Sql,
    params: {
        queryEmbeddingStr: string;
        userId: UserId;
        /** Required access boundary. Use `unrestrictedAccess()` to opt out explicitly. */
        access: MediaAccessBoundary;
        /**
         * Media types to include. Defaults to video catalogue (`movie`, `tv`).
         * `media_items` also holds music (`track`/`album`/`artist`) which can
         * carry discovery embeddings, so WITHOUT this filter a movie query can
         * return music. Music has its own search/recommendation path.
         */
        mediaTypes?: string[];
        /**
         * When true, drop titles THIS user has already watched
         * (`user_media_state.is_watched = true`). Used by get_recommendations to
         * default-exclude seen titles from "what should I watch" picks.
         */
        excludeWatched?: boolean;
    },
): Promise<AssistantMovieSimilarityRow[]> {
    const { queryEmbeddingStr, userId, access } = params;
    if (deniesEverything(access)) return [];
    const mediaTypes =
        params.mediaTypes && params.mediaTypes.length > 0 ? params.mediaTypes : ['movie', 'tv'];
    const excludeWatchedFilter = params.excludeWatched
        ? sql`AND NOT EXISTS (SELECT 1 FROM user_media_state uwh WHERE uwh.user_id = ${userId}::uuid AND uwh.media_id = mi.id AND uwh.is_watched = true)`
        : sql``;
    return sql<AssistantMovieSimilarityRow[]>`
        SELECT
            mi.id AS media_id,
            primary_ext.external_id AS primary_ext_id,
            mi.title,
            pm.metadata->>'overview' AS overview,
            mi.media_type,
            pm.metadata->'genres' AS genres,
            ${ratingColumnsFragment(sql)},
            CAST(pm.metadata->>'runtime_minutes' AS INTEGER) AS runtime_minutes,
            CASE WHEN mi.year IS NOT NULL THEN (mi.year || '-01-01')::text ELSE NULL END AS release_date,
            pm.metadata->'actors' AS actors,
            pm.metadata->'directors' AS directors,
            ${isAvailableExpr(sql)} AS is_available,
            ${canRequestExpr(sql)} AS can_request,
            ur.rating AS user_rating,
            COALESCE((SELECT uws.is_watched FROM user_media_state uws WHERE uws.media_id = mi.id AND uws.user_id = ${userId}::uuid), false) AS watched,
            (me.embedding <=> ${queryEmbeddingStr}::vector) AS similarity
        FROM media_items mi
        JOIN external_ids primary_ext ON primary_ext.media_id = mi.id
            AND primary_ext.provider = ${getPrimaryExternalIdProvider()}
            AND primary_ext.is_primary = TRUE
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        -- has_files = true (below) scopes this to library-owned titles, which
        -- carry a LIBRARY-sourced embedding. DISCOVERY embeddings only exist
        -- for catalog items NOT in the library (mutually exclusive by has_files),
        -- so joining DISCOVERY here matched zero rows and the assistant returned
        -- no recommendations for every open-ended request.
        LEFT JOIN media_embeddings me ON me.media_id = mi.id AND me.source = ${EMBEDDING_SOURCE.LIBRARY}
        LEFT JOIN user_ratings ur ON ur.media_id = mi.id AND ur.user_id = ${userId}::uuid
        WHERE me.embedding IS NOT NULL
            AND mi.status = 'active'
            AND mi.has_files = true
            AND mi.media_type IN ${sql(mediaTypes)}
            ${excludeWatchedFilter}
            ${buildLibraryAccessFilter(sql, access.library)}
            ${buildAgeRatingFilter(sql, access.age)}
        LIMIT 500
    `;
}

// =============================================================================
// Rating expressions
// =============================================================================
//
// `tmdb_rating` IS NOT A KEY THIS PIPELINE WRITES. TMDB's own rating lands as
// `vote_average` on the `tmdb` provider row, while the row every query below
// selects is `aggregated` (see buildOverrideAwareMetadataLateralJoin: per-media
// override, then 'aggregated', then chain order). Measured on prod: 0 of 1951
// active movies with files carry `tmdb_rating`, against rt_rating 76%,
// rt_audience_score 86%, imdb_rating 88%, mdblist_score 98%.
//
// So `ORDER BY ${bestScoreExpr(sql)} DESC NULLS LAST, mi.title`
// sorted every row by NULL — "the best-rated horror films" came back in heap
// order. These helpers exist so no query re-derives that mistake.
//
// Every read is REGEX-GUARDED, matching suggestion-search.queries.ts. A bare
// cast in a WHERE clause is evaluated on rows the filter would otherwise
// reject, so a single dirty metadata value aborts the whole query with 22P02.

/** Rotten Tomatoes critic score (Tomatometer), 0-100, or NULL. */
function rtCriticExpr(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`CASE WHEN pm.metadata->>'rt_rating' ~ '^[0-9]+$' THEN (pm.metadata->>'rt_rating')::integer END`;
}

/** Rotten Tomatoes audience score (Popcornmeter), 0-100, or NULL. */
function rtAudienceExpr(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`CASE WHEN pm.metadata->>'rt_audience_score' ~ '^[0-9]+$' THEN (pm.metadata->>'rt_audience_score')::integer END`;
}

/** IMDb rating, 0-10, or NULL. */
function imdbExpr(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`CASE WHEN pm.metadata->>'imdb_rating' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (pm.metadata->>'imdb_rating')::numeric END`;
}

/** MDBList aggregate score, 0-10, or NULL. */
function mdblistExpr(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`CASE WHEN pm.metadata->>'mdblist_score' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (pm.metadata->>'mdblist_score')::numeric END`;
}

/**
 * ONE 0-100 quality axis built from whichever source a title actually has:
 * critic score, else IMDb rescaled from 0-10, else MDBList — which is ALREADY
 * 0-100. Use this for any "best / highest rated / top" ordering.
 *
 * The scales are NOT the same and getting it wrong is not subtle. This
 * originally multiplied mdblist_score by 10 as well, on the assumption it
 * matched IMDb's 0-10. Measured on prod it runs 0-94 (avg 63.5), so a title
 * with no critic or IMDb score scored 780 and outranked every title that had a
 * real Tomatometer — "the best-rated film in your library" came back as an
 * otherwise unrated one, and the model then narrated a justification for it.
 */
function bestScoreExpr(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`COALESCE(${rtCriticExpr(sql)}, (${imdbExpr(sql)}) * 10, ${mdblistExpr(sql)})`;
}

/**
 * The rating columns every assistant media query SELECTs, so the model can cite
 * real numbers. A null here means the library has no score — the tools say so
 * explicitly rather than letting the model supply one from memory.
 */
function ratingColumnsFragment(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`${imdbExpr(sql)} AS imdb_rating,
            ${rtCriticExpr(sql)} AS rt_rating,
            ${rtAudienceExpr(sql)} AS rt_audience_score`;
}

/** Access-scoped, objective candidate filtering for the assistant. */
export async function findMediaByConstraints(
    sql: postgres.Sql,
    params: {
        userId: UserId;
        access: MediaAccessBoundary;
        mediaType?: 'movie' | 'tv';
        genres?: string[];
        excludeGenres?: string[];
        addedWithinDays?: number;
        maxAgeRating?: number;
        minYear?: number;
        maxYear?: number;
        minRuntimeMinutes?: number;
        maxRuntimeMinutes?: number;
        minRtRating?: number;
        minRtAudienceScore?: number;
        minImdbRating?: number;
        watched?: boolean;
        unwatchedByUsername?: string;
        sortBy?:
            | 'rating'
            | 'rt_rating'
            | 'rt_audience_score'
            | 'imdb_rating'
            | 'newest_added'
            | 'oldest_added'
            | 'longest'
            | 'shortest';
        limit: number;
    },
): Promise<AssistantMovieRow[]> {
    if (deniesEverything(params.access)) return [];
    const types = params.mediaType ? [params.mediaType] : ['movie', 'tv'];
    // Reuses the SAME shape-aware predicate as `findMediaByGenre` — see
    // {@link buildGenreMatchFragment} for why a bare `jsonb_array_elements_text`
    // name compare silently matches nothing on the shapes actually stored.
    const genres = params.genres?.length ? buildGenreMatchFragment(sql, params.genres) : sql``;
    // Negation the vector path cannot express: "kein Horror" used to become a
    // mood string for an embedding search, which has no notion of NOT, so the
    // excluded genre came back and was presented as fitting.
    const excludeGenres = params.excludeGenres?.length
        ? buildGenreMatchFragment(sql, params.excludeGenres, { negate: true })
        : sql``;
    // CONTENT suitability, NOT the access boundary — different things, both
    // applied. This is a filter the CALLER asked for ("something for the kids");
    // the boundary further down is what this caller is permitted to see at all,
    // and no request can widen it.
    //
    // Needed because genre tags cannot answer it: anime rows on this install
    // carry no genres, so a Kids/Family/Animation filter degrades to "any
    // animation" and returned Elfen Lied and Death Note as Kinderserien. Age
    // rating is 97% covered on movies, 87% on series. NULL is excluded on
    // purpose — unrated is not the same as child-safe.
    const maxAge =
        params.maxAgeRating !== undefined
            ? sql`AND mi.age_rating IS NOT NULL AND mi.age_rating <= ${params.maxAgeRating}`
            : sql``;
    // Ingest date, NOT release year — the two are routinely decades apart, and
    // release year was the only lever the model had for "what's new".
    const addedWithin =
        params.addedWithinDays !== undefined
            ? sql`AND mi.created_at >= NOW() - make_interval(days => ${params.addedWithinDays})`
            : sql``;
    const minYear = params.minYear ? sql`AND mi.year >= ${params.minYear}` : sql``;
    const maxYear = params.maxYear ? sql`AND mi.year <= ${params.maxYear}` : sql``;
    const minRuntime = params.minRuntimeMinutes
        ? sql`AND CAST(pm.metadata->>'runtime_minutes' AS integer) >= ${params.minRuntimeMinutes}`
        : sql``;
    const maxRuntime = params.maxRuntimeMinutes
        ? sql`AND CAST(pm.metadata->>'runtime_minutes' AS integer) <= ${params.maxRuntimeMinutes}`
        : sql``;
    // ⚠️ SEPARATE ADJACENT FRAGMENTS WITH WHITESPACE in the WHERE list below.
    // postgres.js concatenates `${a}${b}` with NOTHING between them, so a
    // fragment ending in a bound value emits `... >= $3` immediately followed by
    // the next fragment's `AND` — `$3AND` — and Postgres rejects the whole
    // statement with "trailing junk after parameter". It only bites when two
    // value-ending fragments happen to be adjacent, which is why it survived
    // review and then broke every find_media call combining minRtRating with
    // watched:false on prod. See the serialization test in
    // assistant-rag.sql-assembly.test.ts, which pins this without a database.
    //
    // Separately: never hoist an expression into a const and interpolate the same
    // object twice. A
    // postgres.js fragment carries its OWN parameter slots, so reusing one
    // across SELECT / WHERE / ORDER BY renumbers the placeholders and Postgres
    // rejects the statement with `trailing junk after parameter at or near
    // "$4AND"`. That is not theoretical: it shipped, and every find_media call
    // carrying minRtRating failed on prod while the unit tests — which mock this
    // whole module — stayed green. The same warning is on
    // effectiveDesignatedGroups in social-visibility.builder.ts. Build fresh at
    // every use site.
    // There is deliberately NO tmdb_rating filter. `tmdb_rating` is not a key
    // this pipeline ever writes — TMDB's own rating lands as `vote_average` on
    // the tmdb provider row, while the row selected here is `aggregated`.
    // Verified on prod: 0 of 1951 movies have it, so the `minTmdbRating` this
    // replaced silently matched NOTHING. Filter on rt/imdb, which are real.
    const rtCriticFilter =
        params.minRtRating !== undefined
            ? sql`AND ${rtCriticExpr(sql)} >= ${params.minRtRating}`
            : sql``;
    const rtAudienceFilter =
        params.minRtAudienceScore !== undefined
            ? sql`AND ${rtAudienceExpr(sql)} >= ${params.minRtAudienceScore}`
            : sql``;
    const imdbFilter =
        params.minImdbRating !== undefined
            ? sql`AND ${imdbExpr(sql)} >= ${params.minImdbRating}`
            : sql``;
    const watched =
        params.watched === undefined
            ? sql``
            : params.watched
              ? sql`AND EXISTS (SELECT 1 FROM user_media_state uws WHERE uws.user_id = ${params.userId}::uuid AND uws.media_id = mi.id AND uws.is_watched = true)`
              : sql`AND NOT EXISTS (SELECT 1 FROM user_media_state uws WHERE uws.user_id = ${params.userId}::uuid AND uws.media_id = mi.id AND uws.is_watched = true)`;
    const peerUnwatched = params.unwatchedByUsername
        ? sql`AND EXISTS (SELECT 1 FROM users peer WHERE lower(peer.username) = lower(${params.unwatchedByUsername}) ${buildSocialVisibilityFilter(sql, { viewerId: params.userId, subjectAlias: 'peer', media: { alias: 'mi', column: 'id' } })} AND NOT EXISTS (SELECT 1 FROM user_media_state peer_state WHERE peer_state.user_id = peer.id AND peer_state.media_id = mi.id AND peer_state.is_watched = true))`
        : sql``;
    // Runtime superlatives have to be ordered in SQL. Without these the model
    // pulled a batch and compared it by hand, then answered "the longest film in
    // your library is X" — a claim about the whole library derived from one
    // page. It was demonstrably wrong on prod: three longer films sat in the
    // same library, in a batch it had seen on another question.
    const runtimeExpr = sql`CASE WHEN pm.metadata->>'runtime_minutes' ~ '^[0-9]+$' THEN (pm.metadata->>'runtime_minutes')::integer END`;
    const orderBy =
        params.sortBy === 'longest'
            ? sql`${runtimeExpr} DESC NULLS LAST, mi.title`
            : params.sortBy === 'shortest'
              ? sql`CASE WHEN pm.metadata->>'runtime_minutes' ~ '^[0-9]+$' THEN (pm.metadata->>'runtime_minutes')::integer END ASC NULLS LAST, mi.title`
              : params.sortBy === 'newest_added'
                ? sql`mi.created_at DESC NULLS LAST, ${bestScoreExpr(sql)} DESC NULLS LAST, mi.title`
                : params.sortBy === 'oldest_added'
                  ? sql`mi.created_at ASC NULLS LAST, ${bestScoreExpr(sql)} DESC NULLS LAST, mi.title`
                  : params.sortBy === 'rt_rating'
                    ? sql`${rtCriticExpr(sql)} DESC NULLS LAST, mi.title`
                    : params.sortBy === 'rt_audience_score'
                      ? sql`${rtAudienceExpr(sql)} DESC NULLS LAST, mi.title`
                      : params.sortBy === 'imdb_rating'
                        ? sql`${imdbExpr(sql)} DESC NULLS LAST, mi.title`
                        : sql`${bestScoreExpr(sql)} DESC NULLS LAST, mi.title`;
    return sql<AssistantMovieRow[]>`
        SELECT mi.id AS media_id, primary_ext.external_id AS primary_ext_id, mi.title,
          pm.metadata->>'overview' AS overview, mi.media_type, pm.metadata->'genres' AS genres,
          ${ratingColumnsFragment(sql)},
          CAST(pm.metadata->>'runtime_minutes' AS integer) AS runtime_minutes,
          CASE WHEN mi.year IS NOT NULL THEN (mi.year || '-01-01')::text ELSE NULL END AS release_date,
          ${isAvailableExpr(sql)} AS is_available, ${canRequestExpr(sql)} AS can_request,
          COALESCE((SELECT uws.is_watched FROM user_media_state uws WHERE uws.media_id = mi.id AND uws.user_id = ${params.userId}::uuid), false) AS watched
        FROM media_items mi
        JOIN external_ids primary_ext ON primary_ext.media_id = mi.id AND primary_ext.provider = ${getPrimaryExternalIdProvider()} AND primary_ext.is_primary = true
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        WHERE mi.status = 'active' AND mi.has_files = true AND mi.media_type IN ${sql(types)}
          ${genres} ${excludeGenres} ${maxAge} ${addedWithin} ${minYear} ${maxYear} ${minRuntime} ${maxRuntime}
          ${rtCriticFilter} ${rtAudienceFilter} ${imdbFilter} ${watched} ${peerUnwatched}
          ${buildLibraryAccessFilter(sql, params.access.library)} ${buildAgeRatingFilter(sql, params.access.age)}
        ORDER BY ${orderBy}
        LIMIT ${params.limit}`;
}

/**
 * Get the user's last 20 ratings for LLM context (preference understanding).
 *
 * ## Takes NO access boundary — deliberately, and NOT because it is closed
 *
 * This is a genuine gap, left open here only because closing it would change
 * which rows a restricted user sees, and the boundary migration is explicitly a
 * change of how access is *expressed*, not what it *means*.
 *
 * The query JOINs `media_items` (as `mi`) and its output is injected verbatim
 * into the assistant prompt as the user's taste block
 * (assistant-service.ts → `ratingsBlock` / `movieContext`). So a user who rated
 * a title and *later* lost access to its library group still sees that title's
 * name surface in their own LLM context. The blast radius is bounded — it is
 * strictly the user's own ratings, never another user's rows, and only the
 * title/genres/rating leak, not IDs or overviews — but it is not nothing.
 *
 * Adding `access: MediaAccessBoundary` here plus the two standard fragments
 * would close it; the alias is already `mi`, so both builders would attach
 * correctly with no other change. That is a deliberate follow-up, because it
 * REMOVES rows from a restricted user's result and therefore needs to be
 * decided on its own merits rather than smuggled in as a refactor side effect.
 *
 * Do not copy this signature as the pattern for a new query. Every other
 * media_items read in this module takes a required boundary.
 */
export async function getUserRecentRatings(
    sql: postgres.Sql,
    userId: UserId,
): Promise<UserRatingContextRow[]> {
    return sql<UserRatingContextRow[]>`
        SELECT
            mi.title,
            pm.metadata->'genres' AS genres,
            ur.rating,
            ${isAvailableExpr(sql)} AS is_available
        FROM user_ratings ur
        JOIN media_items mi ON mi.id = ur.media_id
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        WHERE ur.user_id = ${userId}::uuid
        ORDER BY ur.created_at DESC
        LIMIT 20
    `;
}

/**
 * Search for media by title with an optional year filter.
 * Merges the two title search variants (with/without year) into one function.
 * The access boundary is REQUIRED (defense-in-depth) so LLM-suggested titles
 * resolve only to library- and age-permitted rows.
 *
 * NOTE: the two branches below each build their OWN boundary fragments rather
 * than sharing one pair. They previously shared a single pair built up front and
 * embedded the same `postgres.PendingQuery` objects into two different template
 * literals. That happened to work because only one branch executes per call, but
 * it made the correctness of an access filter depend on a fragment being inert
 * and reusable. Building per branch removes that coupling.
 */
export async function searchMediaByTitle(
    sql: postgres.Sql,
    params: {
        title: string;
        year?: number;
        mediaTypes?: string[];
        /**
         * How many candidates to return. Defaults to 1 for callers that just
         * want the best match. Pass more when the CALLER has to disambiguate:
         * with a hard LIMIT 1 the row that won trigram similarity was the only
         * one anyone could see, so get_details' `mediaType` preference was dead
         * code — ask for "Fenwick, the series" and the film could win the sort and
         * be described as the series.
         */
        limit?: number;
        /** Required access boundary. Use `unrestrictedAccess()` to opt out explicitly. */
        access: MediaAccessBoundary;
    },
): Promise<AssistantMovieRow[]> {
    const { title, year, access } = params;
    const limit = params.limit ?? 1;
    if (deniesEverything(access)) return [];
    // Restrict to the requested media types (default movie/tv). Without this a
    // same-named episode/season/music row could resolve as the "title",
    // producing a wrong-type card/ref. NOTE: deliberately NO has_files gate —
    // check_availability must still see requestable (file-less) catalog items.
    const mediaTypes =
        params.mediaTypes && params.mediaTypes.length > 0 ? params.mediaTypes : ['movie', 'tv'];
    const mediaTypeFilter = sql`AND mi.media_type IN ${sql(mediaTypes)}`;

    if (year !== undefined) {
        return sql<AssistantMovieRow[]>`
            SELECT
                mi.id AS media_id,
                (SELECT ei.external_id FROM external_ids ei WHERE ei.media_id = mi.id AND ei.provider = ${getPrimaryExternalIdProvider()} AND ei.is_primary = TRUE LIMIT 1) AS primary_ext_id,
                mi.title,
                mi.media_type,
                pm.metadata->>'overview' AS overview,
                pm.metadata->'genres' AS genres,
                ${ratingColumnsFragment(sql)},
                CAST(pm.metadata->>'runtime_minutes' AS INTEGER) AS runtime_minutes,
                CASE WHEN mi.year IS NOT NULL THEN (mi.year || '-01-01')::text ELSE NULL END AS release_date,
                ${isAvailableExpr(sql)} AS is_available,
                ${canRequestExpr(sql)} AS can_request
            FROM media_items mi
            ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
            WHERE mi.status = 'active'
              ${mediaTypeFilter}
              AND mi.year = ${year}
              AND (
                mi.title ILIKE ${`%${title}%`}
                OR mi.original_title ILIKE ${`%${title}%`}
                OR mi.english_title ILIKE ${`%${title}%`}
                OR (mi.title % ${title} AND similarity(mi.title, ${title}) > 0.45)
                OR (mi.original_title % ${title} AND similarity(COALESCE(mi.original_title, ''), ${title}) > 0.45)
                OR (mi.english_title % ${title} AND similarity(COALESCE(mi.english_title, ''), ${title}) > 0.45)
              )
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildAgeRatingFilter(sql, access.age)}
            ORDER BY
                (mi.title ILIKE ${`%${title}%`} OR mi.original_title ILIKE ${`%${title}%`} OR mi.english_title ILIKE ${`%${title}%`}) DESC,
                GREATEST(similarity(mi.title, ${title}), similarity(COALESCE(mi.original_title, ''), ${title}), similarity(COALESCE(mi.english_title, ''), ${title})) DESC,
                ${bestScoreExpr(sql)} DESC NULLS LAST
            LIMIT ${limit}
        `;
    }

    return sql<AssistantMovieRow[]>`
        SELECT
            mi.id AS media_id,
            (SELECT ei.external_id FROM external_ids ei WHERE ei.media_id = mi.id AND ei.provider = ${getPrimaryExternalIdProvider()} AND ei.is_primary = TRUE LIMIT 1) AS primary_ext_id,
            mi.title,
            mi.media_type,
            pm.metadata->>'overview' AS overview,
            pm.metadata->'genres' AS genres,
            ${ratingColumnsFragment(sql)},
            CAST(pm.metadata->>'runtime_minutes' AS INTEGER) AS runtime_minutes,
            CASE WHEN mi.year IS NOT NULL THEN (mi.year || '-01-01')::text ELSE NULL END AS release_date,
            ${isAvailableExpr(sql)} AS is_available,
            ${canRequestExpr(sql)} AS can_request
        FROM media_items mi
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        WHERE mi.status = 'active'
          ${mediaTypeFilter}
          AND (
            mi.title ILIKE ${`%${title}%`}
            OR mi.original_title ILIKE ${`%${title}%`}
            OR mi.english_title ILIKE ${`%${title}%`}
            OR (mi.title % ${title} AND similarity(mi.title, ${title}) > 0.45)
            OR (mi.original_title % ${title} AND similarity(COALESCE(mi.original_title, ''), ${title}) > 0.45)
            OR (mi.english_title % ${title} AND similarity(COALESCE(mi.english_title, ''), ${title}) > 0.45)
          )
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY
            (mi.title ILIKE ${`%${title}%`} OR mi.original_title ILIKE ${`%${title}%`} OR mi.english_title ILIKE ${`%${title}%`}) DESC,
            GREATEST(similarity(mi.title, ${title}), similarity(COALESCE(mi.original_title, ''), ${title}), similarity(COALESCE(mi.english_title, ''), ${title})) DESC,
            ${bestScoreExpr(sql)} DESC NULLS LAST
        LIMIT ${limit}
    `;
}

/**
 * English TMDB genre names (+ the common synonyms/aliases the model may emit)
 * → TMDB genre IDs. We match stored genres by ID because genre data is both
 * shape-inconsistent (some provider rows store `[{id,name}]`, others bare
 * `[28, 35]`) AND localized (names stored as "Komödie", "Dokumentarfilm"),
 * so matching the requested ENGLISH name against stored names found almost
 * nothing (verified: "Comedy" matched 0 movies by name vs 558 by id). IDs are
 * language- and shape-independent. Includes TV genre IDs where they differ.
 */
const GENRE_NAME_TO_TMDB_IDS: Record<string, number[]> = {
    action: [28, 10759],
    adventure: [12, 10759],
    animation: [16],
    anime: [16],
    cartoon: [16],
    comedy: [35],
    crime: [80],
    documentary: [99],
    documentaries: [99],
    drama: [18],
    family: [10751],
    kids: [10762, 10751],
    children: [10762, 10751],
    fantasy: [14, 10765],
    history: [36, 10768],
    historical: [36, 10768],
    horror: [27],
    music: [10402],
    musical: [10402],
    mystery: [9648],
    romance: [10749],
    romantic: [10749],
    'science fiction': [878, 10765],
    'sci-fi': [878, 10765],
    scifi: [878, 10765],
    'sci fi': [878, 10765],
    thriller: [53],
    war: [10752, 10768],
    western: [37],
    reality: [10764],
    news: [10763],
    soap: [10766],
    talk: [10767],
};

/** Resolve requested English genre names (+ synonyms) to TMDB genre IDs. */
function resolveGenreNamesToTmdbIds(names: string[]): number[] {
    const ids = new Set<number>();
    for (const name of names) {
        const mapped = GENRE_NAME_TO_TMDB_IDS[name.trim().toLowerCase()];
        if (mapped) for (const id of mapped) ids.add(id);
    }
    return [...ids];
}

/**
 * THE genre predicate for the assistant's library queries.
 *
 * Provider-agnostic on purpose: it scans ALL `provider_metadata` rows for the
 * item (not just the chain-selected `pm` row) and matches by TMDB genre ID
 * across every stored shape — `[{id,name}]` objects, bare `[28,35]` ids, and
 * bare `["Comedy"]` name strings — with a case-insensitive name fallback.
 *
 * Shared rather than re-derived per call site. `findMediaByConstraints` shipped
 * with its own one-liner (`jsonb_array_elements_text(...) WHERE lower(g) = ANY`)
 * which reads plausible but matches ONLY the bare-name shape: on the
 * `[{id,name}]` shape this repo's own fixtures treat as canonical, that compares
 * `'{"id": 35, "name": "Comedy"}'` against `'comedy'` and every genre-filtered
 * `find_media` / `build_watch_plan` call silently returned zero rows.
 *
 * ALIAS NOTE: the EXISTS deliberately has no `mi` in scope beyond `pmg.media_id
 * = mi.id`, so caller boundary predicates must stay at the OUTER `WHERE` — see
 * {@link findMediaByGenre}.
 *
 * @returns a fragment with a leading `AND`, or empty when no genres requested.
 */
function buildGenreMatchFragment(
    sql: postgres.Sql,
    genres: string[],
    opts: { negate?: boolean } = {},
): postgres.PendingQuery<postgres.Row[]> {
    if (genres.length === 0) return sql``;
    // Empty when none of the requested names are recognised — then we rely on
    // the name fallback (which also covers providers that store genre names).
    const genreIds = resolveGenreNamesToTmdbIds(genres);
    const genreIdClause =
        genreIds.length > 0
            ? sql`OR (jsonb_typeof(g) = 'object' AND (g->>'id') ~ '^[0-9]+$' AND (g->>'id')::int = ANY(${genreIds}))
                  OR (jsonb_typeof(g) = 'number' AND (g::text)::int = ANY(${genreIds}))`
            : sql``;
    // NOT EXISTS for the negated form: a title is excluded when ANY provider
    // row tags it with the genre, so "not horror" stays true even if only one
    // provider calls it horror.
    const existence = opts.negate ? sql`NOT EXISTS` : sql`EXISTS`;
    return sql`
        AND ${existence} (
            SELECT 1 FROM provider_metadata pmg
            WHERE pmg.media_id = mi.id
              AND jsonb_typeof(pmg.metadata->'genres') = 'array'
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements(pmg.metadata->'genres') AS g
                WHERE g->>'name' ILIKE ANY(${genres})
                  OR (jsonb_typeof(g) = 'string' AND g #>> '{}' ILIKE ANY(${genres}))
                  ${genreIdClause}
              )
        )
    `;
}

/**
 * Find library media in a given GENRE (e.g. "Family", "Kids", "Comedy",
 * "Horror"). Matches by language-independent TMDB genre ID (resolved from the
 * requested English name) and falls back to a case-insensitive name match for
 * any unmapped genre. Use for genre/category requests like "kids series" or
 * "horror movies". Access-scoped and ghost-excluded (`has_files = true`).
 *
 * ALIAS NOTE: the genre match is an EXISTS over ALL `provider_metadata` rows
 * (`pmg`), which deliberately has no `mi` in scope. The boundary predicates
 * therefore attach at the OUTER `WHERE` against `mi`, AFTER that EXISTS — that
 * placement is load-bearing, not incidental. Moving either fragment inside the
 * subquery would bind it to `pmg` and silently stop filtering.
 */
export async function findMediaByGenre(
    sql: postgres.Sql,
    params: {
        genres: string[];
        mediaTypes?: string[];
        limit: number;
        userId: UserId;
        /** Required access boundary. Use `unrestrictedAccess()` to opt out explicitly. */
        access: MediaAccessBoundary;
    },
): Promise<AssistantMovieRow[]> {
    const { genres, limit, userId, access } = params;
    if (deniesEverything(access)) return [];
    const mediaTypes =
        params.mediaTypes && params.mediaTypes.length > 0 ? params.mediaTypes : ['movie', 'tv'];
    return sql<AssistantMovieRow[]>`
        SELECT
            mi.id AS media_id,
            (SELECT ei.external_id FROM external_ids ei WHERE ei.media_id = mi.id AND ei.provider = ${getPrimaryExternalIdProvider()} AND ei.is_primary = TRUE LIMIT 1) AS primary_ext_id,
            mi.title,
            mi.media_type,
            pm.metadata->>'overview' AS overview,
            pm.metadata->'genres' AS genres,
            ${ratingColumnsFragment(sql)},
            CAST(pm.metadata->>'runtime_minutes' AS INTEGER) AS runtime_minutes,
            CASE WHEN mi.year IS NOT NULL THEN (mi.year || '-01-01')::text ELSE NULL END AS release_date,
            ${isAvailableExpr(sql)} AS is_available,
            ${canRequestExpr(sql)} AS can_request,
            COALESCE((SELECT uws.is_watched FROM user_media_state uws WHERE uws.media_id = mi.id AND uws.user_id = ${userId}::uuid), false) AS watched
        FROM media_items mi
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        WHERE mi.status = 'active'
          AND mi.has_files = true
          AND mi.media_type IN ${sql(mediaTypes)}
          ${buildGenreMatchFragment(sql, genres)}
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY ${bestScoreExpr(sql)} DESC NULLS LAST, mi.title
        LIMIT ${limit}
    `;
}

/**
 * Find library media tagged with a given keyword/tag (e.g. "whodunit",
 * "heist", "time travel"). Matches mdblist keywords OR TMDB keywords as an
 * exact-ish boolean predicate — more precise than vector search for tag
 * queries. Access-scoped and ghost-excluded (`has_files = true`).
 *
 * ALIAS NOTE: as with findMediaByGenre, the keyword match is an EXISTS over ALL
 * `provider_metadata` rows (`pmk`) with no `mi` in scope, so the boundary
 * predicates attach at the OUTER `WHERE` against `mi`, AFTER that EXISTS. That
 * placement is load-bearing — moving either fragment inside the subquery would
 * bind it to `pmk` and silently stop filtering.
 */
export async function findMediaByKeyword(
    sql: postgres.Sql,
    params: {
        keywords: string[];
        mediaTypes?: string[];
        limit: number;
        userId: UserId;
        /** Required access boundary. Use `unrestrictedAccess()` to opt out explicitly. */
        access: MediaAccessBoundary;
    },
): Promise<AssistantMovieRow[]> {
    const { keywords, limit, userId, access } = params;
    if (deniesEverything(access)) return [];
    const mediaTypes =
        params.mediaTypes && params.mediaTypes.length > 0 ? params.mediaTypes : ['movie', 'tv'];
    // Match ANY of the keywords (union) so synonyms widen recall.
    const patterns = keywords.map((k) => `%${k}%`);
    return sql<AssistantMovieRow[]>`
        SELECT
            mi.id AS media_id,
            (SELECT ei.external_id FROM external_ids ei WHERE ei.media_id = mi.id AND ei.provider = ${getPrimaryExternalIdProvider()} AND ei.is_primary = TRUE LIMIT 1) AS primary_ext_id,
            mi.title,
            mi.media_type,
            pm.metadata->>'overview' AS overview,
            pm.metadata->'genres' AS genres,
            ${ratingColumnsFragment(sql)},
            CAST(pm.metadata->>'runtime_minutes' AS INTEGER) AS runtime_minutes,
            CASE WHEN mi.year IS NOT NULL THEN (mi.year || '-01-01')::text ELSE NULL END AS release_date,
            ${isAvailableExpr(sql)} AS is_available,
            ${canRequestExpr(sql)} AS can_request,
            COALESCE((SELECT uws.is_watched FROM user_media_state uws WHERE uws.media_id = mi.id AND uws.user_id = ${userId}::uuid), false) AS watched
        FROM media_items mi
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        WHERE mi.status = 'active'
          AND mi.has_files = true
          AND mi.media_type IN ${sql(mediaTypes)}
          -- Keyword/tag coverage differs per provider: the rich tag set
          -- (mdblist_keywords) lives on the mdblist provider_metadata row,
          -- which is NOT the row the override-aware chain selects into pm
          -- (that is usually aggregated/tmdb). Scanning only pm here made
          -- e.g. whodunit match 2 movies instead of the real 80. Match the
          -- keyword across ALL provider rows for the item; pm still supplies
          -- the display columns (overview/genres/ratings).
          AND EXISTS (
            SELECT 1 FROM provider_metadata pmk
            WHERE pmk.media_id = mi.id
              AND (
                (jsonb_typeof(pmk.metadata->'mdblist_keywords') = 'array'
                  AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(pmk.metadata->'mdblist_keywords') AS kw WHERE kw ILIKE ANY(${patterns})))
                OR (jsonb_typeof(pmk.metadata->'keywords') = 'array'
                  AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(pmk.metadata->'keywords') AS kw WHERE kw ILIKE ANY(${patterns})))
              )
          )
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY ${bestScoreExpr(sql)} DESC NULLS LAST, mi.title
        LIMIT ${limit}
    `;
}

/**
 * Collect the FULL keyword/tag set for one item across ALL provider rows
 * (union of `keywords` + `mdblist_keywords`). The override-aware detail query
 * reads tags from only the chain-selected row, which misses the rich mdblist
 * tag set — so `get_details` would under-report tags (e.g. say a known
 * "whodunit" has no such tag). Use this to report tags faithfully.
 *
 * ## Takes NO access boundary — GATED UPSTREAM, by caller discipline only
 *
 * This reads `provider_metadata` keyed by `mediaId` and never touches
 * `media_items`, so neither boundary builder has an `mi` to attach to; scoping
 * it would mean adding a join purely to re-check access.
 *
 * The ONLY caller is `get-details.tool.ts`, which resolves `mediaId` through the
 * access-scoped {@link searchMediaByTitle} first and passes the id it got back.
 * That resolution IS the gate. The invariant is therefore:
 *
 *   **`mediaId` must originate from an access-scoped query in the same request
 *   — never from caller/model-supplied input.**
 *
 * If `get_details` (or any future caller) is ever changed to accept a media id
 * directly from tool arguments, this function starts leaking the tag set of any
 * item in the catalogue to a user who cannot see it. Add the boundary and a
 * `media_items` join at that point rather than trusting the caller.
 */
export async function getAllProviderKeywords(
    sql: postgres.Sql,
    mediaId: string,
    limit: number = 60,
): Promise<string[]> {
    const rows = await sql<{ val: string }[]>`
        SELECT DISTINCT val FROM (
            SELECT jsonb_array_elements_text(pmk.metadata->'mdblist_keywords') AS val
            FROM provider_metadata pmk
            WHERE pmk.media_id = ${mediaId}
              AND jsonb_typeof(pmk.metadata->'mdblist_keywords') = 'array'
            UNION
            SELECT jsonb_array_elements_text(pmk.metadata->'keywords') AS val
            FROM provider_metadata pmk
            WHERE pmk.media_id = ${mediaId}
              AND jsonb_typeof(pmk.metadata->'keywords') = 'array'
        ) t
        WHERE val IS NOT NULL AND val <> ''
        LIMIT ${limit}
    `;
    return rows.map((r) => r.val);
}

/**
 * Find library media featuring a given PERSON (actor or director) by name.
 * Matches the metadata `actors` / `directors` name arrays (case-insensitive).
 * This is what makes "what else is <actor> in" / "movies with the cast of X"
 * answerable from real data instead of guesswork. Access-scoped, ghost-excluded.
 *
 * Unlike findMediaByGenre / findMediaByKeyword, the person match reads the
 * chain-selected `pm` row rather than scanning all provider rows, so it is
 * narrower by design (a name only present on a non-selected provider row will
 * not match). The boundary predicates still attach at the outer `WHERE`.
 */
export async function findMediaByPerson(
    sql: postgres.Sql,
    params: {
        person: string;
        mediaTypes?: string[];
        limit: number;
        userId: UserId;
        /** Required access boundary. Use `unrestrictedAccess()` to opt out explicitly. */
        access: MediaAccessBoundary;
    },
): Promise<AssistantMovieRow[]> {
    const { person, limit, userId, access } = params;
    if (deniesEverything(access)) return [];
    const mediaTypes =
        params.mediaTypes && params.mediaTypes.length > 0 ? params.mediaTypes : ['movie', 'tv'];
    const pattern = `%${person}%`;
    return sql<AssistantMovieRow[]>`
        SELECT
            mi.id AS media_id,
            (SELECT ei.external_id FROM external_ids ei WHERE ei.media_id = mi.id AND ei.provider = ${getPrimaryExternalIdProvider()} AND ei.is_primary = TRUE LIMIT 1) AS primary_ext_id,
            mi.title,
            mi.media_type,
            pm.metadata->>'overview' AS overview,
            pm.metadata->'genres' AS genres,
            ${ratingColumnsFragment(sql)},
            CAST(pm.metadata->>'runtime_minutes' AS INTEGER) AS runtime_minutes,
            CASE WHEN mi.year IS NOT NULL THEN (mi.year || '-01-01')::text ELSE NULL END AS release_date,
            ${isAvailableExpr(sql)} AS is_available,
            ${canRequestExpr(sql)} AS can_request,
            COALESCE((SELECT uws.is_watched FROM user_media_state uws WHERE uws.media_id = mi.id AND uws.user_id = ${userId}::uuid), false) AS watched
        FROM media_items mi
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        WHERE mi.status = 'active'
          AND mi.has_files = true
          AND mi.media_type IN ${sql(mediaTypes)}
          AND (
            (jsonb_typeof(pm.metadata->'actors') = 'array'
              AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(pm.metadata->'actors') AS p WHERE p ILIKE ${pattern}))
            OR (jsonb_typeof(pm.metadata->'directors') = 'array'
              AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(pm.metadata->'directors') AS p WHERE p ILIKE ${pattern}))
          )
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
        ORDER BY ${bestScoreExpr(sql)} DESC NULLS LAST, mi.title
        LIMIT ${limit}
    `;
}

/**
 * Get the number of remaining messages for a user today via the stored function.
 */
export async function getRemainingMessages(
    sql: postgres.Sql,
    userId: UserId,
    isAdmin: boolean,
    dailyLimit: number,
): Promise<{ remaining: number }> {
    const [result] = await sql<{ message_count: number }[]>`
        SELECT COALESCE(message_count, 0) as message_count
        FROM assistant_rate_limits
        WHERE user_id = ${userId}::uuid AND date = CURRENT_DATE
    `;
    const used = result?.message_count ?? 0;
    const remaining = isAdmin ? dailyLimit : Math.max(0, dailyLimit - used);
    return { remaining };
}

/**
 * Get full rate limit info for the GET endpoint (message count + date).
 * Returns null if no record exists for today.
 */
export async function getUserRateLimitInfo(
    sql: postgres.Sql,
    userId: UserId,
): Promise<{ message_count: number; date: string } | null> {
    const [result] = await sql<{ message_count: number; date: string }[]>`
        SELECT message_count, date
        FROM assistant_rate_limits
        WHERE user_id = ${userId}::uuid AND date = CURRENT_DATE
    `;
    return result ?? null;
}

// =============================================================================
// Token-budget rate limiting
// =============================================================================

/**
 * Total AI tokens the user has consumed today. 0 if no record yet.
 * (The daily limit is enforced by token budget, not message count.)
 */
export async function getDailyTokenUsage(sql: postgres.Sql, userId: UserId): Promise<number> {
    const [result] = await sql<{ tokens_used: string | number }[]>`
        SELECT tokens_used
        FROM assistant_rate_limits
        WHERE user_id = ${userId}::uuid AND date = CURRENT_DATE
    `;
    return Number(result?.tokens_used ?? 0);
}

/**
 * Record one assistant message: bump today's token usage by `tokens` and the
 * (informational) message_count by 1. Upserts on the (user_id, date) unique
 * key. Call AFTER the LLM round-trip, with the message's total token usage.
 */
export async function recordChatTokenUsage(
    sql: postgres.Sql,
    userId: UserId,
    isAdmin: boolean,
    tokens: number,
): Promise<void> {
    const safeTokens = Math.max(0, Math.round(tokens));
    await sql`
        INSERT INTO assistant_rate_limits (user_id, date, message_count, is_admin, tokens_used)
        VALUES (${userId}, CURRENT_DATE, 1, ${isAdmin}, ${safeTokens})
        ON CONFLICT (user_id, date)
        DO UPDATE SET
            message_count = assistant_rate_limits.message_count + 1,
            tokens_used = assistant_rate_limits.tokens_used + ${safeTokens}
    `;
}
