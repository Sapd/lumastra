// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/episodes/index.ts
 *
 * GET /api/admin/media/[id]/episodes
 *
 * Returns episodes with file info for admin view.
 * Groups by season, ordered by season_number then episode_number.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { episodes: AdminEpisodeRow[] }
 * 503 dependency_unavailable when DB is down.
 */

import { EpisodeLanguageSummarySchema } from '$lib/schemas/admin-language-summary.js';
import { getEpisodeLanguageSummaries } from '$lib/server/database/queries/admin-language-summary.queries.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    buildAutoEpisodeOrderingJoinFragment,
    buildUnmappedEpisodeFilterFragment,
} from '$lib/server/database/queries/episode-search.queries.js';

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const ChapterSchema = z.object({
    index: z.number().int(),
    name: z.string().nullable(),
    startTicks: z.string(),
});

export const AdminEpisodeRowSchema = z.object({
    id: z.string().guid(),
    title: z.string().nullable(),
    season_number: z.number().nullable(),
    episode_number: z.number().nullable(),
    episode_number_end: z.number().nullable(),
    overview: z.string().nullable(),
    runtime_seconds: z.number().nullable(),
    premiere_date: z.string().nullable(),
    sort_order: z.number().nullable(),
    file_path: z.string().nullable(),
    edition: z.string().nullable(),
    jellyfin_id: z.string().nullable(),
    chapters: z.array(ChapterSchema),
    language_summary: EpisodeLanguageSummarySchema.optional(),
});

export const EpisodesResponseSchema = z.object({
    episodes: z.array(AdminEpisodeRowSchema),
});

export type AdminEpisodeRow = z.infer<typeof AdminEpisodeRowSchema>;
export type EpisodesResponse = z.infer<typeof EpisodesResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            interface ChapterRow {
                index: number;
                name: string | null;
                startTicks: string;
            }

            interface EpisodeQueryRow {
                id: string;
                title: string | null;
                season_number: number | null;
                episode_number: number | null;
                episode_number_end: number | null;
                overview: string | null;
                runtime_seconds: number | null;
                premiere_date: string | null;
                sort_order: number | null;
                file_path: string | null;
                edition: string | null;
                jellyfin_id: string | null;
                chapters: ChapterRow[] | null;
            }

            const episodes = await sql<EpisodeQueryRow[]>`
                SELECT mi.id, mi.title,
                       COALESCE(eo.order_season_number, mi.season_number) AS season_number,
                       COALESCE(eo.order_episode_number, mi.episode_number) AS episode_number,
                       eo.order_episode_number_end AS episode_number_end,
                       mi.overview, mi.runtime_seconds,
                       -- ::text, not raw. postgres.js registers a DEFAULT parser for
                       -- oids 1082/1114/1184 (date/timestamp/timestamptz) returning a native
                       -- JS Date; connection.ts overrides only bigint. Left raw,
                       -- premiere_date arrives as a Date, EpisodesResponseSchema.parse()
                       -- below declares it z.string().nullable(), and Zod 4 rejects a Date
                       -- for z.string() — so the endpoint 500s for every series whose
                       -- episodes carry an air date (83,875 of 88,003 on the prod catalogue).
                       mi.premiere_date::text AS premiere_date,
                       mi.sort_order,
                       mf.file_path, mf.edition,
                       (SELECT ei.external_id FROM external_ids ei
                        WHERE ei.media_id = mi.id AND ei.provider = 'jellyfin'
                        LIMIT 1) AS jellyfin_id,
                       -- ::text, not raw. start_ticks is bigint, and
                       -- json_build_object() renders a bigint as a JSON NUMBER —
                       -- the connection.ts bigint parser never sees it, because the
                       -- value arrives inside a json column that postgres.js hands
                       -- to JSON.parse(). ChapterSchema below declares
                       -- startTicks: z.string(), so left raw the EpisodesResponseSchema
                       -- .parse() at the bottom of this handler throws and the WHOLE
                       -- episodes list 500s for any series whose episodes have chapters.
                       -- The string is the intended wire type (a 100ns tick count is a
                       -- large integer, and a strict Swift decoder is generated from
                       -- this schema), so cast here rather than widening the schema.
                       (SELECT json_agg(json_build_object(
                           'index', ec.chapter_index,
                           'name', ec.chapter_name,
                           'startTicks', ec.start_ticks::text
                       ) ORDER BY ec.chapter_index)
                        FROM episode_chapters ec
                        JOIN media_file_items mfi_ch ON mfi_ch.file_id = ec.file_id
                        WHERE mfi_ch.media_item_id = mi.id
                          AND mfi_ch.is_default = true
                       ) AS chapters
                FROM media_items mi
                LEFT JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
                ${buildAutoEpisodeOrderingJoinFragment(sql, 'mi')}
                LEFT JOIN LATERAL (
                    SELECT mfiles.file_path, mfiles.edition
                    FROM media_file_items mfitems
                    JOIN media_files mfiles ON mfiles.id = mfitems.file_id
                    WHERE mfitems.media_item_id = mi.id
                    ORDER BY mfitems.is_default DESC NULLS LAST, mfitems.sort_order ASC NULLS LAST, mfiles.id
                    LIMIT 1
                ) mf ON true
                WHERE mi.media_type = 'episode'
                  ${buildUnmappedEpisodeFilterFragment(sql, 'mi')}
                  AND (
                      mi.parent_id = ${internalId}
                      OR mi.parent_id IN (
                          SELECT s.id FROM media_items s
                          WHERE s.parent_id = ${internalId} AND s.media_type = 'season'
                      )
                  )
                ORDER BY COALESCE(eo.order_season_number, mi.season_number),
                         COALESCE(eo.order_episode_number, mi.sort_order, mi.episode_number)
            `;

            const languages = await getEpisodeLanguageSummaries(
                sql,
                episodes.map((episode) => episode.id),
            );
            const result: AdminEpisodeRow[] = episodes.map((ep) => ({
                ...ep,
                chapters: ep.chapters ?? [],
                language_summary: languages.get(ep.id),
            }));

            return json(EpisodesResponseSchema.parse({ episodes: result }));
        },
    },
});
