// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Batch metadata hydration for recommendation rails.
 *
 * Rails (taste rail / hero) resolve their items as bare UUIDs + titles, then
 * need the display metadata the card and hero meta row render: overview,
 * ratings, runtime, genres, certification, and the quality/accessibility signals
 * behind the 4K / HDR / Dolby Vision / Atmos / CC / SDH / AD badges.
 *
 * PERFORMANCE CONTRACT — this is the homepage's critical path:
 *  - ONE round trip for the whole page of UUIDs (`= ANY($1::uuid[])`), never
 *    per-item. An N+1 here is a regression, not a style nit.
 *  - Ratings/overview/genres come from the provider_metadata LATERAL pick
 *    (one indexed lookup per row) — the same fragment the detail query uses,
 *    so provider precedence and admin overrides stay consistent.
 *  - Quality tiers come from the `media_item_quality` PROJECTION via a PK join.
 *    Deliberately NOT computed from media_streams at request time: that path
 *    (see getMediaStreamSummary) walks every episode of a series and is far too
 *    expensive for a rail. The projection already handles the episode rollup.
 *
 * ACCESS CONTROL — this helper does NOT apply library/age filtering. It is a
 * pure hydration step for UUIDs the CALLER has already access-filtered (the
 * taste rail intersects against its `allowed` set before hydrating). Never call
 * it with UUIDs sourced directly from user input.
 *
 * HOLIDAY RAIL (re-checked 2026-10-02): `editorial.strategy.ts` hydrates items from
 * `getHolidayRecommendations()` (`plugins/holidays/plugin.ts`). Since 2026-10-02 the
 * plugin DOES set an `internal` id — but only for items resolved through the caller's
 * library/age boundary (`getAccessibleMediaByTmdbIds` / `getMediaByTmdbKeyword` with the
 * `access` the strategy passes), so those UUIDs are already access-filtered. If that
 * plugin ever emits `internal` from an unscoped lookup, this becomes a leak. Do not
 * remove the `eslint-disable` from `getMediaRailMetadataBatch` without re-checking it.
 *
 * @module queries/media-rail-metadata
 */

import type postgres from 'postgres';
import { buildOverrideAwareMetadataLateralJoinFragment } from './builders/provider-metadata.builder.js';

/** Display metadata for one rail item. All fields best-effort/nullable. */
export interface MediaRailMetadata {
    mediaId: string;
    overview: string | null;
    imdbRating: number | null;
    /**
     * TMDB's `vote_average`, 0-10. NOT displayable on its own: pair it with
     * {@link MediaRailMetadata.voteCount} through `pickDisplayRating`, which
     * suppresses a near-perfect score backed by a handful of votes.
     */
    tmdbRating: number | null;
    /** TMDB vote count backing `tmdbRating`; gates whether it may be shown. */
    voteCount: number | null;
    rtRating: number | null;
    /** Minutes. Falls back to `media_items.runtime_seconds` when the provider omits it. */
    runtimeMinutes: number | null;
    genres: string[] | null;
    /** Age/content rating, e.g. "PG-13", "FSK 16". */
    certification: string | null;
    /** '4K' | '1080p' | '720p' | 'SD' — from the quality projection. */
    resolutionTier: string | null;
    /** 'dolby_vision' | 'hdr' | 'sdr' — from the quality projection. */
    hdrTier: string | null;
    /** Finer-grained HDR flavour (e.g. 'HDR10', 'HLG') when known. */
    hdrType: string | null;
    /** Dolby Atmos audio available (best-available across versions/episodes). */
    hasAtmos: boolean;
    /** Closed captions available. Series values are a strict majority of episodes. */
    hasCc: boolean;
    /** SDH subtitles available (embedded or sidecar). */
    hasSdh: boolean;
    /** Audio description track available. */
    hasAd: boolean;
}

interface RailMetadataRow {
    media_id: string;
    overview: string | null;
    imdb_rating: number | null;
    tmdb_rating: number | null;
    vote_count: number | null;
    rt_rating: number | null;
    runtime_minutes: number | null;
    genres: string[] | null;
    certification: string | null;
    resolution_tier: string | null;
    hdr_tier: string | null;
    hdr_type: string | null;
    has_atmos: boolean | null;
    has_cc: boolean | null;
    has_sdh: boolean | null;
    has_ad: boolean | null;
}

/**
 * Batch-hydrate display metadata for a page of media UUIDs.
 *
 * @param sql      - postgres client
 * @param mediaIds - already access-filtered internal UUIDs
 * @returns Map keyed by media UUID. Missing/unresolvable ids are simply absent —
 *          callers render what they have rather than failing the rail.
 */
export async function getMediaRailMetadataBatch(
    sql: postgres.Sql,
    mediaIds: string[],
): Promise<Map<string, MediaRailMetadata>> {
    const out = new Map<string, MediaRailMetadata>();
    if (mediaIds.length === 0) return out;

    // Deduplicate: a rail can legitimately repeat a UUID across pages, and
    // ANY() with duplicates just wastes comparisons.
    const uniqueIds = [...new Set(mediaIds)];

    // Hydration of caller-authorized UUIDs — see ACCESS CONTROL note above.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<RailMetadataRow[]>`
        SELECT
            mi.id::text AS media_id,
            (pm.metadata->>'overview')::text AS overview,
            -- 'tmdb_rating' IS NOT A KEY THIS PIPELINE WRITES. Reading it here
            -- meant 'tmdbRating' was ALWAYS null, so every consumer silently
            -- degraded to IMDb alone — or to no rating at all when IMDb is
            -- missing. TMDB's own score lands as 'vote_average', with
            -- 'vote_count' beside it. Measured on prod: the row this LATERAL
            -- picks carries vote_average/vote_count on 99.7% of active
            -- movie/series items against imdb_rating's 84%, and 322 of them
            -- have a vote-count-qualified TMDB score and NO IMDb score.
            -- See the "Rating expressions" block in assistant-rag.queries.ts.
            --
            -- Every cast is REGEX-GUARDED (same reason as that block): a bare
            -- cast aborts the WHOLE statement with 22P02 on a single dirty
            -- metadata value. This is the homepage's critical path, so one bad
            -- row would blank every rail on the page rather than one card.
            CASE WHEN pm.metadata->>'imdb_rating' ~ '^[0-9]+(\\.[0-9]+)?$'
                 THEN (pm.metadata->>'imdb_rating')::float END AS imdb_rating,
            CASE WHEN pm.metadata->>'vote_average' ~ '^[0-9]+(\\.[0-9]+)?$'
                 THEN (pm.metadata->>'vote_average')::float END AS tmdb_rating,
            CASE WHEN pm.metadata->>'vote_count' ~ '^[0-9]+$'
                 THEN (pm.metadata->>'vote_count')::integer END AS vote_count,
            CASE WHEN pm.metadata->>'rt_rating' ~ '^[0-9]+(\\.[0-9]+)?$'
                 THEN (pm.metadata->>'rt_rating')::float END AS rt_rating,
            -- runtime_seconds is an integer column, so a plain division truncates:
            -- a 45s item would report 0 minutes, which reads as "unknown" and
            -- both hides the runtime and defeats the preview's runtime-aware
            -- start position. Round instead, then NULLIF so a genuinely
            -- sub-30s runtime stays absent rather than becoming a bogus 0.
            COALESCE(
                (pm.metadata->>'runtime_minutes')::integer,
                NULLIF(ROUND(NULLIF(mi.runtime_seconds, 0)::numeric / 60), 0)::integer
            ) AS runtime_minutes,
            CASE
                WHEN pm.metadata->'genres' IS NOT NULL
                     AND jsonb_typeof(pm.metadata->'genres') = 'array'
                THEN NULLIF(
                    ARRAY(
                        SELECT elem->>'name'
                        FROM jsonb_array_elements(pm.metadata->'genres') AS elem
                        WHERE jsonb_typeof(elem) = 'object' AND elem->>'name' IS NOT NULL
                    ),
                    ARRAY[]::text[]
                )
                ELSE NULL
            END AS genres,
            (pm.metadata->>'certification')::text AS certification,
            q.resolution_tier,
            q.hdr_tier,
            q.hdr_type,
            q.has_atmos,
            q.has_cc,
            q.has_sdh,
            q.has_ad
        FROM media_items mi
        ${buildOverrideAwareMetadataLateralJoinFragment(sql)}
        LEFT JOIN media_item_quality q ON q.media_item_id = mi.id
        WHERE mi.id = ANY(${uniqueIds}::uuid[])
          AND mi.status = 'active'
    `;

    for (const row of rows) {
        out.set(row.media_id, {
            mediaId: row.media_id,
            overview: row.overview,
            imdbRating: row.imdb_rating,
            tmdbRating: row.tmdb_rating,
            voteCount: row.vote_count,
            rtRating: row.rt_rating,
            runtimeMinutes: row.runtime_minutes,
            genres: row.genres,
            certification: row.certification,
            resolutionTier: row.resolution_tier,
            hdrTier: row.hdr_tier,
            hdrType: row.hdr_type,
            // LEFT JOIN: an item with no projection row (never probed) yields
            // NULL, which must read as "no badge", not as a missing boolean.
            hasAtmos: row.has_atmos ?? false,
            hasCc: row.has_cc ?? false,
            hasSdh: row.has_sdh ?? false,
            hasAd: row.has_ad ?? false,
        });
    }

    return out;
}
