// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/rate/queue.ts — GET /api/rate/queue
 *
 * Rating-trainer queue. `filter=seen` returns only watched-but-unrated library
 * items. `filter=all` ("Everything") returns an adaptive blend that leans seen
 * but always includes a guaranteed share of unseen "explore" catalog items:
 * the explore share is a step function of the user's remaining unrated-seen
 * backlog (see shareForBacklog in queue-blend.ts), floored so explore is never
 * crowded out, and the two sources are even-spread interleaved. The seen and
 * explore pools are DISJOINT — the explore CTEs exclude anything the user has
 * watched — so no title appears twice and watched titles keep their "seen"
 * source label. The popular-sampler SQL is PORTED (not moved) from the two
 * candidate queries in onboarding-movies/[userId]/+server.ts; see the notes on
 * communityRating (never fabricated), the >=7.0 floors, and the movie/series
 * split + reallocation below.
 *
 * A server-tracked "served set" (Valkey, `CACHE_NAMESPACES.rateQueueServed`,
 * 6h TTL) keyed by `${userId}:${sessionId}:${boundary}` prevents repeats across
 * pages of the same rating session; the boundary token partitions it so two
 * calls for one user under different access boundaries cannot suppress each
 * other's titles. ONLY rows actually served on a page are recorded —
 * the overfetched-but-unserved watched tail is not. `sessionId` is an opaque
 * UUID: a fresh one is minted whenever no cursor is supplied, or the supplied
 * cursor isn't syntactically a UUID.
 *
 * `buildRateQueue` is exported for direct integration testing; the GET handler
 * is a thin wrapper. Auth: user; age-restricted profiles excluded; rate-limited
 * 20 req / 60 s per IP+username.
 */

import { randomUUID } from 'node:crypto';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import type postgres from 'postgres';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { buildLibraryAccessFilter } from '$lib/server/database/queries/builders/library-access.builder.js';
import { buildAgeRatingFilter } from '$lib/server/database/queries/builders/age-rating.builder.js';
import {
    boundaryCacheKey,
    deniesEverything,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { movieOrSeriesOf } from '$lib/server/utils/media-types.js';
import { EMBEDDING_SOURCE } from '$lib/server/utils/embedding-source.js';
import { RateQueueResponseSchema, type RatingCandidate } from '$lib/schemas/api-ai-responses.js';
import type { UserContext } from '$lib/server/types.js';
import { MIN_DISPLAY_VOTE_COUNT } from '$lib/server/utils/rating-utils.js';
import { shareForBacklog, evenSpreadInterleave } from './queue-blend.js';

const logger = Logger.for('RateQueueDef');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Watched overfetch limit in `all` mode: fetch up to this many so the backlog
 *  depth is observable (the share table saturates at 20) while only a slice is
 *  served — the unserved tail is an in-memory explore-shortfall backfill. */
const DEPTH_PROBE = 25;

/** A durable skip (user_rate_skips) suppresses a title from the queue for
 *  this many days; skips age out so a title can eventually resurface (skip
 *  != rating, which is permanent). */
const SKIP_SUPPRESSION_DAYS = 30;

/**
 * TMDB's community score on the chain-picked `pm` row, 0-10, or NULL.
 *
 * The key is `vote_average`. `tmdb_rating` — which the series sampler used to
 * filter on — is written by nothing in this pipeline; see the "Rating
 * expressions" block in assistant-rag.queries.ts.
 */
function tmdbVoteAverageExpr(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`CASE WHEN pm.metadata->>'vote_average' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (pm.metadata->>'vote_average')::float END`;
}

/** Vote count behind {@link tmdbVoteAverageExpr}, or NULL. */
function tmdbVoteCountExpr(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`CASE WHEN pm.metadata->>'vote_count' ~ '^[0-9]+$' THEN (pm.metadata->>'vote_count')::integer END`;
}

/** Garbage/foreign cursors are never an error — they just start a fresh session. */
function isValidSessionToken(token: string): boolean {
    return UUID_RE.test(token);
}

export interface RateQueueOpts {
    filter: 'seen' | 'all';
    /**
     * Clamped 1..50 by the caller (query schema for the HTTP handler);
     * `buildRateQueue` additionally re-clamps defensively for direct callers.
     */
    count: number;
    /** Opaque session token from a previous page's `nextCursor`. */
    cursor?: string;
}

export interface RateQueuePage {
    status: 'ready' | 'exhausted';
    items: RatingCandidate[];
    nextCursor: string;
}

interface WatchedCandidateRow {
    id: string;
    title: string | null;
    overview: string | null;
    media_type: 'movie' | 'tv';
    last_watched_at: Date | string | null;
    watch_count: number | null;
}

/**
 * Popular-sampler row shape — mirrors `CatalogSuggestionRow` in
 * onboarding-movies/[userId]/+server.ts (the query this is ported from).
 */
interface PopularCandidateRow {
    id: string;
    primary_ext_id: string;
    title: string | null;
    overview: string | null;
    has_jf_emb: boolean;
    has_js_emb: boolean;
    imdb_rating: number | null;
    rt_rating: number | null;
    media_type: 'movie' | 'tv';
}

/**
 * `communityRating = imdb_rating ?? (rt_rating / 10)`. NEVER fabricates a
 * placeholder value — when both are unknown the field is omitted (returns
 * `undefined`, which `json()`/JSON.stringify drop from the response).
 */
function communityRatingFrom(row: {
    imdb_rating: number | null;
    rt_rating: number | null;
}): number | undefined {
    if (row.imdb_rating != null) return row.imdb_rating;
    if (row.rt_rating != null) return row.rt_rating / 10;
    return undefined;
}

/**
 * `media_items.media_type` stores lowercase 'movie'/'tv' (canonical DB
 * convention); the public schema's discriminator is 'movie'/'series'.
 * RatingCandidateSchema's `mediaType` also accepts raw 'tv' at parse time
 * (publicMovieSeriesSchema preprocesses it to 'series'), but the TS type is
 * the post-preprocess OUTPUT — map explicitly instead of relying on an
 * unchecked cast.
 *
 * This used to be a LOCAL `toPublicMediaType(mediaType: 'movie' | 'tv')` whose
 * body was `mediaType === 'tv' ? 'series' : 'movie'` — a bare literal comparison
 * that shadowed the shared helper of the same name. It now delegates to the one
 * owner of the mapping. `?? 'movie'` is unreachable: the parameter type is the
 * two-member union `'movie' | 'tv'`, both of which map non-null.
 */
function toRatingCandidateType(mediaType: 'movie' | 'tv'): 'movie' | 'series' {
    return movieOrSeriesOf(mediaType) ?? 'movie';
}

function mapWatchedRow(row: WatchedCandidateRow): RatingCandidate {
    return {
        // Watched-source rows carry no external-id lookup (see the SQL below) —
        // UUID-first is sufficient: posters/ratings resolve via the internal id.
        externalIds: { internal: row.id },
        title: row.title || 'Unknown',
        overview: row.overview ?? undefined,
        mediaType: toRatingCandidateType(row.media_type),
        source: 'watched',
        playCount: row.watch_count ?? undefined,
        lastPlayed: row.last_watched_at ? new Date(row.last_watched_at).toISOString() : undefined,
    };
}

function mapPopularRow(row: PopularCandidateRow): RatingCandidate {
    return {
        externalIds: {
            internal: row.id,
            ...(row.primary_ext_id ? { [getPrimaryExternalIdProvider()]: row.primary_ext_id } : {}),
        },
        title: row.title || 'Unknown',
        overview: row.overview ?? undefined,
        genres: [],
        communityRating: communityRatingFrom(row),
        criticRating: row.rt_rating ?? undefined,
        playCount: 0,
        hasEmbedding: !!(row.has_jf_emb || row.has_js_emb),
        source: 'popular',
        mediaType: toRatingCandidateType(row.media_type),
    };
}

/**
 * Composition function — builds one page of the rating-trainer queue.
 * Exported for direct integration testing; the GET handler is a thin wrapper.
 *
 * `access` is REQUIRED and has no permissive default: every media-selecting
 * query in here is gated by it, so there is no way to reach the catalog without
 * having stated a boundary. A caller that genuinely wants everything must say
 * so with `unrestrictedAccess()`; the GET handler derives the real boundary
 * from the request's user via {@link searchAccessBoundary}.
 *
 * A `denyAll` boundary short-circuits to an empty page. The `AND false` the
 * builders would emit is not relied upon here: `drawExplore` has `limit <= 0`
 * early returns that bypass SQL entirely, so a boundary enforced only in SQL
 * would not be enforced on every path.
 */
export async function buildRateQueue(
    sql: postgres.Sql,
    user: UserContext,
    access: MediaAccessBoundary,
    opts: RateQueueOpts,
): Promise<RateQueuePage> {
    // Defensive clamp — the HTTP handler's query schema already clamps to
    // 1..50, but `buildRateQueue` is exported for direct callers (tests,
    // future internal callers) that can pass anything.
    const count = Math.min(Math.max(Math.trunc(opts.count), 1), 50);

    const libraryFilter = buildLibraryAccessFilter(sql, access.library);
    const ageFilter = buildAgeRatingFilter(sql, access.age);

    // --- served-set cursor ---
    const sessionId = opts.cursor && isValidSessionToken(opts.cursor) ? opts.cursor : randomUUID();

    // Deny-everything: return an empty page without touching the DB or the
    // served set. Recording nothing keeps the cursor reusable if the caller's
    // boundary later widens.
    if (deniesEverything(access)) {
        return { status: 'exhausted', items: [], nextCursor: sessionId };
    }

    const servedCache = cacheManager.for(CACHE_NAMESPACES.rateQueueServed);
    // The served set is partitioned by boundary as well as by user+session:
    // `buildRateQueue` takes the boundary as an argument, so the same user can
    // legitimately be called under two different boundaries (an internal caller
    // widening or narrowing access). Without the boundary token both calls would
    // share one served set and a title suppressed under boundary A would stay
    // suppressed under boundary B. `v2:` because adding the token reshapes the key.
    const servedKey = `v2:${user.userId}:${sessionId}:${boundaryCacheKey(access)}`;
    const served = (await servedCache.get<string[]>(servedKey)) ?? [];

    // --- source 1: watched-but-unrated ---
    // has_files-lint justification (callback-safety/require-has-files-with-active-status):
    // watched items are by definition things the user could access (a file existed at
    // watch time), so no has_files gate is needed on top of that; candidates are
    // access-scoped via libraryFilter + ageFilter, both derived from the REQUIRED
    // `access` boundary (a caller cannot reach this query unfiltered by omission —
    // it has to pass `unrestrictedAccess()` explicitly). (Plain comment, not a live disable
    // directive — defs/ is outside the rule's path allowlist so a directive here is
    // auto-stripped by the pre-commit eslint --fix.)
    const isAll = opts.filter === 'all';
    // Overfetch in 'all' mode so the backlog depth is observable and the unserved
    // tail can backfill an explore shortfall without another query.
    const watchedLimit = isAll ? Math.max(count, DEPTH_PROBE) : count;
    const watchedRows = await sql<WatchedCandidateRow[]>`
        SELECT mi.id, mi.title, mi.overview, mi.media_type, ums.last_watched_at, ums.watch_count
        FROM media_items mi
        JOIN user_media_state ums ON ums.media_id = mi.id
            AND ums.user_id = ${user.userId} AND ums.is_watched = true
        WHERE mi.status = 'active'
          AND mi.media_type IN ('movie', 'tv')
          AND NOT EXISTS (
            SELECT 1 FROM user_ratings ur WHERE ur.user_id = ${user.userId} AND ur.media_id = mi.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM user_rate_skips urs
            WHERE urs.user_id = ${user.userId} AND urs.media_id = mi.id
              AND urs.skipped_at > now() - make_interval(days => ${SKIP_SUPPRESSION_DAYS})
          )
          ${served.length > 0 ? sql`AND NOT (mi.id = ANY(${served}::uuid[]))` : sql``}
          ${libraryFilter}
          ${ageFilter}
        ORDER BY ums.last_watched_at DESC NULLS LAST
        LIMIT ${watchedLimit}
    `;

    // --- source 2: popular sampler (filter === 'all' only, when room remains) ---
    //
    // `fetchPopularMovies`/`fetchPopularSeries` are factored out (not inlined,
    // as they were pre-reallocation) so the SAME CTE can be re-run for the
    // 70/30-split top-up below without duplicating ~50 lines of SQL text.
    //
    // has_files-lint justification (callback-safety/require-has-files-with-active-status):
    // ported from the onboarding-movies popular sampler — intentionally
    // suggests discovery (TMDB-only, requestable) titles the user has no
    // files for; access-scoped via libraryFilter + ageFilter, both derived
    // from the REQUIRED `access` boundary. Note both fragments are spliced
    // INSIDE the `candidates` CTE, where media_items is aliased `mi` (the
    // alias both builders hardcode); the outer SELECT aliases the CTE as `c`
    // and has no `mi` in scope, so neither fragment may be hoisted there.
    // They also gate the CTE BEFORE the rating floors, the LATERAL provider
    // pick and the LIMIT — moving them later would change which rows the
    // random-weighted sampler draws from. (Plain
    // comment, not a directive — see the watched-source note above:
    // unused directives in defs/ are auto-stripped by the pre-commit
    // eslint --fix. The onboarding source carries no directive on its
    // series query — the rule only targets 'movie'-literal queries —
    // so none is mirrored on the series CTE below either.)
    async function fetchPopularMovies(
        limit: number,
        excludeIds: string[],
    ): Promise<PopularCandidateRow[]> {
        if (limit <= 0) return [];
        return sql<PopularCandidateRow[]>`
            WITH candidates AS MATERIALIZED (
                SELECT mi.id, mi.title, mi.media_type, mi.preferred_provider
                FROM media_items mi
                WHERE mi.status = 'active'
                  AND mi.media_type = 'movie'
                  AND EXISTS (
                    SELECT 1 FROM media_embeddings me
                    WHERE me.media_id = mi.id
                      AND me.source IN (${EMBEDDING_SOURCE.LIBRARY}, ${EMBEDDING_SOURCE.DISCOVERY})
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM user_ratings ur
                    WHERE ur.user_id = ${user.userId} AND ur.media_id = mi.id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM user_media_state ums
                    WHERE ums.user_id = ${user.userId} AND ums.media_id = mi.id
                      AND ums.is_watched = true
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM user_rate_skips urs
                    WHERE urs.user_id = ${user.userId} AND urs.media_id = mi.id
                      AND urs.skipped_at > now() - make_interval(days => ${SKIP_SUPPRESSION_DAYS})
                  )
                  ${excludeIds.length > 0 ? sql`AND NOT (mi.id = ANY(${excludeIds}::uuid[]))` : sql``}
                  ${libraryFilter}
                  ${ageFilter}
            ),
            enabled_providers AS MATERIALIZED (
                SELECT provider, priority FROM provider_capabilities WHERE enabled = true
            )
            SELECT
                c.id,
                COALESCE((SELECT external_id FROM external_ids WHERE media_id = c.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1), '') as primary_ext_id,
                c.title,
                (pm.metadata->>'overview')::text as overview,
                EXISTS(SELECT 1 FROM media_embeddings WHERE media_id = c.id AND source = ${EMBEDDING_SOURCE.LIBRARY}) as has_jf_emb,
                EXISTS(SELECT 1 FROM media_embeddings WHERE media_id = c.id AND source = ${EMBEDDING_SOURCE.DISCOVERY}) as has_js_emb,
                (pm.metadata->>'imdb_rating')::float as imdb_rating,
                (pm.metadata->>'rt_rating')::integer as rt_rating,
                c.media_type
            FROM candidates c
            LEFT JOIN LATERAL (
                SELECT pmd.metadata
                FROM provider_metadata pmd
                JOIN enabled_providers ep ON ep.provider = pmd.provider
                WHERE pmd.media_id = c.id
                ORDER BY
                  CASE WHEN c.preferred_provider IS NOT NULL AND pmd.provider = (c.preferred_provider)::text THEN 0 ELSE 1 END,
                  CASE WHEN pmd.provider = 'aggregated' THEN 0 ELSE 1 END,
                  COALESCE(ep.priority, 999)
                LIMIT 1
            ) pm ON true
            WHERE ((pm.metadata->>'imdb_rating')::float IS NOT NULL OR (pm.metadata->>'rt_rating')::integer IS NOT NULL)
              AND (pm.metadata->>'imdb_rating')::float >= 7.0 -- Only well-rated movies
            -- Rating-weighted RANDOM sampling (see onboarding-movies for rationale).
            ORDER BY
              RANDOM() * COALESCE((pm.metadata->>'imdb_rating')::float, (pm.metadata->>'rt_rating')::float / 10.0, 7.0) DESC
            LIMIT ${limit}
          `;
    }

    async function fetchPopularSeries(
        limit: number,
        excludeIds: string[],
    ): Promise<PopularCandidateRow[]> {
        if (limit <= 0) return [];
        return sql<PopularCandidateRow[]>`
            WITH candidates AS MATERIALIZED (
                SELECT mi.id, mi.title, mi.media_type, mi.preferred_provider
                FROM media_items mi
                WHERE mi.status = 'active'
                  AND mi.media_type = 'tv'
                  AND EXISTS (
                    SELECT 1 FROM media_embeddings me
                    WHERE me.media_id = mi.id
                      AND me.source IN (${EMBEDDING_SOURCE.LIBRARY}, ${EMBEDDING_SOURCE.DISCOVERY})
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM user_ratings ur
                    WHERE ur.user_id = ${user.userId} AND ur.media_id = mi.id
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM user_media_state ums
                    WHERE ums.user_id = ${user.userId} AND ums.media_id = mi.id
                      AND ums.is_watched = true
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM user_rate_skips urs
                    WHERE urs.user_id = ${user.userId} AND urs.media_id = mi.id
                      AND urs.skipped_at > now() - make_interval(days => ${SKIP_SUPPRESSION_DAYS})
                  )
                  ${excludeIds.length > 0 ? sql`AND NOT (mi.id = ANY(${excludeIds}::uuid[]))` : sql``}
                  ${libraryFilter}
                  ${ageFilter}
            ),
            enabled_providers AS MATERIALIZED (
                SELECT provider, priority FROM provider_capabilities WHERE enabled = true
            )
            SELECT
                c.id,
                COALESCE((SELECT external_id FROM external_ids WHERE media_id = c.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1), '') as primary_ext_id,
                c.title,
                (pm.metadata->>'overview')::text as overview,
                EXISTS(SELECT 1 FROM media_embeddings WHERE media_id = c.id AND source = ${EMBEDDING_SOURCE.LIBRARY}) as has_jf_emb,
                EXISTS(SELECT 1 FROM media_embeddings WHERE media_id = c.id AND source = ${EMBEDDING_SOURCE.DISCOVERY}) as has_js_emb,
                (pm.metadata->>'imdb_rating')::float as imdb_rating,
                (pm.metadata->>'rt_rating')::integer as rt_rating,
                c.media_type
            FROM candidates c
            LEFT JOIN LATERAL (
                SELECT pmd.metadata
                FROM provider_metadata pmd
                JOIN enabled_providers ep ON ep.provider = pmd.provider
                WHERE pmd.media_id = c.id
                ORDER BY
                  CASE WHEN c.preferred_provider IS NOT NULL AND pmd.provider = (c.preferred_provider)::text THEN 0 ELSE 1 END,
                  CASE WHEN pmd.provider = 'aggregated' THEN 0 ELSE 1 END,
                  COALESCE(ep.priority, 999)
                LIMIT 1
            ) pm ON true
            -- 'tmdb_rating' is NOT a key this pipeline writes, so this filter
            -- matched ZERO rows and the explore queue's series pool was always
            -- empty (drawExplore silently reallocated the 30% share to movies).
            -- TMDB's score is 'vote_average'; 'vote_count' gates it the same way
            -- pickDisplayRating does, so a 3-vote 10.0 can't win the weighted
            -- draw. Series can't reuse the movie branch's imdb_rating: only 17%
            -- of active series carry one on prod, against 99% for vote_average.
            -- Casts are regex-guarded — these run in WHERE, where a bare cast is
            -- evaluated on rows the filter would otherwise reject, so one dirty
            -- value aborts the whole query with 22P02.
            WHERE ${tmdbVoteAverageExpr(sql)} >= 7.0
              AND ${tmdbVoteCountExpr(sql)} >= ${MIN_DISPLAY_VOTE_COUNT}
            ORDER BY
              RANDOM() * ${tmdbVoteAverageExpr(sql)} DESC
            LIMIT ${limit}
          `;
    }

    // Draw up to `limit` explore rows: 70/30 movie/series split with a one-shot
    // cross-category reallocation when one category comes up short (ported from
    // onboarding-movies; unchanged in spirit — now sized by `limit` instead of
    // the old `remaining`). Pools are disjoint from watched via the CTEs above,
    // so `exclude` only needs the persisted served-set.
    async function drawExplore(limit: number, exclude: string[]): Promise<PopularCandidateRow[]> {
        if (limit <= 0) return [];
        const movieCount = Math.ceil(limit * 0.7);
        const seriesCount = Math.floor(limit * 0.3);
        const [popularMovies, popularSeries] = await Promise.all([
            fetchPopularMovies(movieCount, exclude),
            fetchPopularSeries(seriesCount, exclude),
        ]);
        let rows = [...popularMovies, ...popularSeries];
        if (rows.length < limit) {
            const excludeForTopUp = [...exclude, ...rows.map((r) => r.id)];
            if (popularMovies.length < movieCount) {
                const deficit = movieCount - popularMovies.length;
                rows = [...rows, ...(await fetchPopularSeries(deficit, excludeForTopUp))];
            } else if (popularSeries.length < seriesCount) {
                const deficit = seriesCount - popularSeries.length;
                rows = [...rows, ...(await fetchPopularMovies(deficit, excludeForTopUp))];
            }
        }
        return rows;
    }

    // --- allocation ---
    let items: RatingCandidate[];
    let servedNew: string[];

    if (!isAll) {
        // 'seen' mode: watched-source only, unchanged behavior.
        const seen = watchedRows.map(mapWatchedRow);
        items = seen;
        servedNew = watchedRows.map((r) => r.id);
    } else {
        // Adaptive seen/explore blend. `backlog` saturates at DEPTH_PROBE.
        const backlog = watchedRows.length;
        const share = shareForBacklog(backlog);
        const exploreFloorSlots = Math.round(count * share); // guaranteed MIN explore
        const seenTarget = count - exploreFloorSlots;
        const seenServeCount = Math.min(seenTarget, watchedRows.length);
        const exploreTarget = count - seenServeCount; // floor + any seen shortfall

        let servedSeen = watchedRows.slice(0, seenServeCount);
        // Pools disjoint → exclude only the persisted served-set.
        const exploreRows = await drawExplore(exploreTarget, served);

        // If explore ALSO underfills (thin catalog), extend into the already-
        // fetched watched tail — no extra query, and (pools disjoint) no dupes.
        if (servedSeen.length + exploreRows.length < count) {
            const need = count - servedSeen.length - exploreRows.length;
            servedSeen = watchedRows.slice(0, seenServeCount + need);
        }

        items = evenSpreadInterleave(servedSeen.map(mapWatchedRow), exploreRows.map(mapPopularRow));
        // ONLY served rows go to the served-set (never the unserved watched tail).
        servedNew = [...servedSeen.map((r) => r.id), ...exploreRows.map((r) => r.id)];
    }

    // --- record served ids, decide status ---
    if (servedNew.length > 0) {
        await servedCache.set(servedKey, [...served, ...servedNew]);
    }

    return {
        status: items.length === 0 ? 'exhausted' : 'ready',
        items,
        nextCursor: sessionId,
    };
}

const rateQueueQuerySchema = z.object({
    filter: z.enum(['seen', 'all']).optional().default('all'),
    count: z.coerce.number().int().min(1).max(50).optional().default(20),
    cursor: z.string().optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    docs: {
        GET: {
            tags: ['AI'],
            summary: 'Get the next page of the rating-trainer queue',
            stability: 'beta',
            auth: 'bearer',
            query: rateQueueQuerySchema,
            responses: {
                200: { schema: RateQueueResponseSchema, description: 'Rating trainer queue page' },
                401: 'Authentication required',
                403: 'AI features unavailable for age-restricted profiles',
                429: 'Rate limited',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    request: {
        query: rateQueueQuerySchema,
    },

    handlers: {
        GET: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            // Age-restricted profiles cannot use AI rating (feeds the AI taste
            // profile) — mirrors defs/ai/rate.ts.
            if (user.isAgeRestricted) {
                return ApiProblem.forbidden(
                    'AI features are not available for age-restricted profiles',
                );
            }

            // Rate-limit: 20 req / 60 s per IP+username (mirrors defs/ai/rate.ts).
            {
                const { checkRateLimit } =
                    await import('$lib/server/middleware/valkey-rate-limit.js');
                const { getClientIp } = await import('$lib/server/utils/client-ip.js');
                const ip = getClientIp(event);
                const key = `${ip}:${user.username}:rate-queue`;
                const rl = await checkRateLimit(key, 20, 60);
                if (!rl.allowed) {
                    const retryAfter = rl.resetAt - Math.floor(Date.now() / 1000);
                    return ApiProblem.rateLimited(retryAfter > 0 ? retryAfter : 60);
                }
            }

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const { filter, count, cursor } = ctx.input!.query;

            try {
                // Real per-user boundary — never a permissive default. The
                // isAgeRestricted 403 above closes the age axis for restricted
                // profiles, but that gate lives only in this handler; the
                // boundary is what actually filters the queries.
                const access = searchAccessBoundary(await buildSearchAccessContext(sql, user));
                const page = await buildRateQueue(sql, user, access, { filter, count, cursor });
                return json(
                    RateQueueResponseSchema.parse({
                        status: page.status,
                        items: page.items,
                        page: {
                            limit: count,
                            hasMore: page.status !== 'exhausted',
                            nextCursor: page.nextCursor,
                        },
                    }),
                );
            } catch (err) {
                logger.error('Failed to build rate queue', err as Error);
                return ApiProblem.dependencyUnavailable('Database not available');
            }
        },
    },
});
