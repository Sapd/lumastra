// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hero generic-fallback query.
 *
 * Supplies a single library item to use as the SSR hero first slide when the
 * viewer has no personalized Next Up. This is a discovery-adjacent surface so
 * it MUST stay access-scoped exactly like the trending / for-you queries:
 *   - only `status = 'active'` + `has_files` rows (real, playable library items)
 *   - denied library groups excluded (`buildLibraryAccessFilter`)
 *   - above-age-rating items excluded (`buildAgeRatingFilter`)
 *
 * The access predicates are the SAME shared builders the trending/for-you
 * helpers use (see `for-you-helpers.queries.ts::getRandomPopularItem`), so the
 * scoping matches the canonical pattern byte-for-byte. The caller pairs this
 * with an access-scoped `scopedCacheKey` so two users with different access
 * never share a cached slide.
 */

import type postgres from 'postgres';
import type { MediaEmbedding } from '../connection.js';
import { buildMetadataLateralJoinFragment } from './builders/provider-metadata.builder.js';
import { buildLibraryAccessFilter } from './builders/library-access.builder.js';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { deniesEverything } from './builders/media-access-boundary.js';
import type { MediaAccessBoundary } from './builders/media-access-boundary.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { Logger } from '../../utils/logger.js';

const logger = Logger.for('HeroFallbackQueries');

export interface HeroFallbackRow {
    media_id: string;
    title: string;
    media_type: string;
    overview: string | null;
    backdrop_blurhash: string | null;
    tmdb_id: string | null;
}

export interface GetHeroFallbackArgs {
    /** Ordering strategy. 'trending' = most-recently-added first; 'random' = shuffle. */
    source: 'trending' | 'random';
    /**
     * REQUIRED access boundary. Both axes must be stated — there is no permissive
     * default. A caller that genuinely wants every row must say so explicitly with
     * `unrestrictedAccess()` so the decision is greppable; a caller that may see
     * nothing uses `denyAllAccess()` (previously inexpressible).
     */
    access: MediaAccessBoundary;
}

/**
 * One access-scoped library movie to use as the generic hero slide.
 *
 * `media_items` has no `popularity` column, so 'trending' orders by recency of
 * library addition (a stable, cheap proxy) with a random tiebreak; 'random'
 * fully shuffles. Both restrict to active movies with files and a backdrop
 * blurhash (required for the hero LQIP).
 *
 * Returns null when nothing matches under the access boundary.
 */
export async function getHeroFallbackItem(
    sql: postgres.Sql,
    args: GetHeroFallbackArgs,
): Promise<HeroFallbackRow | null> {
    // denyAll short-circuits before the round trip. The builders would emit
    // `AND false` and return nothing anyway; this just skips the query.
    if (deniesEverything(args.access)) return null;

    const orderBy =
        args.source === 'random'
            ? sql`ORDER BY random()`
            : // No random() tiebreak for 'trending': the result is cached for the
              // 30–60s TTL, so a random tiebreak would be frozen for the whole
              // window anyway — recency (added_at, then created_at) is the order.
              sql`ORDER BY mi.library_added_at DESC NULLS LAST, mi.created_at DESC`;

    const rows = await sql<HeroFallbackRow[]>`
        SELECT mi.id::text          AS media_id,
               mi.title             AS title,
               mi.media_type        AS media_type,
               mi.overview          AS overview,
               mi.backdrop_blurhash AS backdrop_blurhash,
               ext_tmdb.external_id AS tmdb_id
        FROM media_items mi
        LEFT JOIN external_ids ext_tmdb
               ON ext_tmdb.media_id = mi.id
              AND ext_tmdb.provider = ${getPrimaryExternalIdProvider()}
              AND ext_tmdb.media_type = mi.media_type
        -- Movies only: they make the best hero backdrops; episode/next-up slides
        -- come from the personalized path, not this generic fallback.
        WHERE mi.media_type = 'movie'
          AND mi.status = 'active'
          AND mi.has_files
          AND mi.backdrop_blurhash IS NOT NULL
          ${buildLibraryAccessFilter(sql, args.access.library)}
          ${buildAgeRatingFilter(sql, args.access.age)}
        ${orderBy}
        LIMIT 1
    `;

    return rows[0] ?? null;
}

// =============================================================================
// Quality-Ranked Library Media (hero cold-start fallback)
// =============================================================================

export interface QualityLibraryMediaOptions {
    /**
     * media_items.media_type to filter: 'movie' or 'tv'.
     * Omit for "all" — this still constrains to movie+tv rows (never
     * tvchannel/music/episode). MUST stay optional-safe: postgres.js throws
     * UNDEFINED_VALUE on an undefined bind, which used to silently empty the
     * /feed for-you rail (strategy catch-all swallowed the throw).
     */
    mediaType?: 'movie' | 'tv';
    limit: number;
    /**
     * REQUIRED access boundary — see {@link GetHeroFallbackArgs.access}. This
     * previously was two OPTIONAL permissive fields, so omitting them compiled
     * fine and silently returned the whole library. Both callers are cached
     * surfaces, which made that the worst possible place for a silent omission.
     */
    access: MediaAccessBoundary;
}

/**
 * Get quality-ranked, available library media for the hero cold-start fallback.
 *
 * Called by GET /api/recommendations?type=movies|series when the AI engine has
 * no embeddings for the requesting user yet. Must NEVER be alphabetical — that
 * caused numeric-titled films (e.g. "08/15") to sort first.
 *
 * WHERE guarantees:
 *   - status = 'active' AND has_files = true (playable items only)
 *   - media_type matches the requested type
 *   - library access filter (deniedGroupIds)
 *   - age-rating filter
 *
 * ORDER BY (descending quality):
 *   mi.quality_score DESC NULLS LAST — materialized from provider_metadata JSONB
 *   by migration 16.109.0 (compute_media_quality_score). The score encodes the
 *   three-key lexicographic intent: backdrop-present items rank first (+1 000 000),
 *   then by imdb_rating (×1 000), then by popularity. Kept fresh by the
 *   trg_provider_metadata_quality trigger so no JSONB evaluation at query time.
 *   mi.id                — deterministic tiebreak (Phase D adds rotation)
 *
 * Returns MediaEmbedding rows shaped identically to getMediaAlphabetical so the
 * recommendations route's existing mappedItems transform works unchanged.
 *
 * @param sql - Postgres SQL instance
 * @param opts - mediaType, limit, and access-context filters
 * @returns Array of MediaEmbedding items in quality-rank order
 */
export async function getQualityLibraryMedia(
    sql: postgres.Sql,
    opts: QualityLibraryMediaOptions,
): Promise<MediaEmbedding[]> {
    const { mediaType, limit, access } = opts;
    // Undefined = both top-level types; never bind undefined (UNDEFINED_VALUE).
    const mediaTypes: string[] = mediaType ? [mediaType] : ['movie', 'tv'];

    // denyAll short-circuits before the round trip. Deliberately OUTSIDE the
    // try/catch below (which swallows every error into []) so this stays an
    // explicit, readable deny rather than an indistinguishable empty result.
    if (deniesEverything(access)) return [];

    try {
        const results = await sql`
            SELECT
                mi.id as media_uuid,
                COALESCE((SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = ${getPrimaryExternalIdProvider()} LIMIT 1), '') as primary_ext_id,
                (SELECT external_id FROM external_ids WHERE media_id = mi.id AND provider = 'imdb' LIMIT 1) as imdb_id,
                mi.media_type,
                mi.title,
                mi.original_title,
                mi.english_title,
                (pm.metadata->>'overview')::text as overview,
                CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                    THEN ARRAY(SELECT (elem->>'id')::integer FROM jsonb_array_elements(pm.metadata->'genres') AS elem)
                    ELSE NULL
                END as genres,
                mi.year as release_year,
                (pm.metadata->>'vote_count')::integer as vote_count,
                (pm.metadata->>'popularity')::float as popularity,
                (pm.metadata->>'runtime_minutes')::integer as runtime_minutes,
                (pm.metadata->>'poster_path')::text as poster_path,
                (pm.metadata->>'backdrop_path')::text as backdrop_path,
                (pm.metadata->>'trailer_url')::text as trailer_url,
                CASE WHEN pm.metadata->'actors' IS NOT NULL AND jsonb_typeof(pm.metadata->'actors') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'actors') AS elem)
                    ELSE NULL
                END as actors,
                CASE WHEN pm.metadata->'directors' IS NOT NULL AND jsonb_typeof(pm.metadata->'directors') = 'array'
                    THEN ARRAY(SELECT elem::text FROM jsonb_array_elements_text(pm.metadata->'directors') AS elem)
                    ELSE NULL
                END as directors,
                (pm.metadata->>'imdb_rating')::float as imdb_rating,
                -- vote_average (the actual TMDB rating), NOT popularity — otherwise
                -- a card without an imdb_rating would show popularity (~450) as a
                -- "rating". (getMediaAlphabetical has this mislabel; binge-worthy
                -- uses vote_average correctly — we follow the correct one.)
                (pm.metadata->>'vote_average')::float as tmdb_rating,
                (pm.metadata->>'rt_rating')::integer as rt_rating,
                (pm.metadata->>'rt_audience_score')::integer as rt_audience_score,
                mi.has_files as is_available,
                (NOT mi.has_files) as can_request,
                mi.created_at,
                mi.updated_at
            FROM media_items mi
            ${buildMetadataLateralJoinFragment(sql)}
            WHERE mi.status = 'active'
              AND mi.has_files = true
              AND mi.media_type = ANY(${mediaTypes})
              -- Top-level titles only (exclude any season/episode rows that could
              -- carry a 'tv' media_type), matching the sibling defensive pattern.
              AND mi.parent_id IS NULL
              ${buildLibraryAccessFilter(sql, access.library)}
              ${buildAgeRatingFilter(sql, access.age)}
            ORDER BY
                -- quality_score is materialized and indexed by migration 16.109.0;
                -- items with no score (new rows not yet trigger-updated) sort last.
                mi.quality_score DESC NULLS LAST,
                mi.id
            LIMIT ${limit}
        `;

        const items: MediaEmbedding[] = results.map((row) => ({
            id: 0,
            internal_id: row.media_uuid as string | undefined,
            tmdb_id: /^\d+$/.test(String(row.primary_ext_id))
                ? Number(row.primary_ext_id as string)
                : null,
            primary_ext_id: /^\d+$/.test(String(row.primary_ext_id))
                ? Number(row.primary_ext_id as string)
                : null,
            imdb_id: row.imdb_id as string | undefined,
            // constrained: the query filters `media_type = ANY(mediaTypes)`,
            // and mediaTypes derives from a 'movie' | 'tv' param (defaulting
            // to both), so no episode/season row can reach here.
            // eslint-disable-next-line callback-safety/no-narrowing-media-type-cast
            media_type: row.media_type as 'movie' | 'tv',
            title: row.title as string,
            original_title: row.original_title as string | undefined,
            english_title: row.english_title as string | undefined,
            overview: row.overview as string | undefined,
            genres: (row.genres as number[]) || [],
            release_year: row.release_year as number | undefined,
            vote_count: row.vote_count as number | undefined,
            popularity: row.popularity as number | undefined,
            runtime_minutes: row.runtime_minutes as number | undefined,
            poster_path: row.poster_path as string | undefined,
            backdrop_path: row.backdrop_path as string | undefined,
            trailer_url: row.trailer_url as string | undefined,
            actors: row.actors as string[] | undefined,
            directors: row.directors as string[] | undefined,
            imdb_rating: row.imdb_rating as number | undefined,
            tmdb_rating: row.tmdb_rating as number | undefined,
            rt_rating: row.rt_rating as number | undefined,
            rt_audience_score: row.rt_audience_score as number | undefined,
            is_available: row.is_available as boolean | undefined,
            can_request: row.can_request as boolean | undefined,
            created_at: row.created_at as Date,
            updated_at: row.updated_at as Date,
        }));

        return items;
    } catch (error) {
        logger.error('Failed to get quality library media for hero fallback', error as Error, opts);
        return [];
    }
}
