// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/chapters/index.ts
 *
 * GET /api/admin/media/[id]/chapters[?fileId=uuid]
 *
 * Returns stored chapters for a media item.
 * Series: all chapters grouped by episode.
 * Episode (or specific fileId): chapters for that file/episode.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { chapters: unknown[], episodesWithChapters: number }
 * 503 dependency_unavailable when DB is down.
 */

import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getChaptersForEpisode,
    getChaptersForFile,
    getChaptersForSeries,
    countEpisodesWithChapters,
} from '$lib/server/database/queries/episode-chapters.queries.js';
import { getMediaItemType } from '$lib/server/database/queries/media-items.queries.js';
import type { EpisodeChapterRow } from '$lib/server/database/queries/episode-chapters.queries.js';
import { isSeries } from '$lib/server/utils/media-types.js';
import {
    MediaChaptersResponseSchema,
    type MediaChaptersResponse,
} from '$lib/schemas/api-media-responses.js';

// ---------------------------------------------------------------------------
// Response schema — single source in $lib/schemas/api-media-responses.
// Mirrors the stored EpisodeChapterRow shape; also referenced by the v1
// _openapi.ts at routes/api/v1/media/[id]/chapters.
// ---------------------------------------------------------------------------

export const ChaptersResponseSchema = MediaChaptersResponseSchema;

export type ChaptersResponse = MediaChaptersResponse;

function chapterResponseRow({ start_ticks, end_ticks, ...row }: EpisodeChapterRow): MediaChaptersResponse['chapters'][number] {
    return {
        ...row,
        startMs: Math.round(start_ticks / 10_000),
        endMs: end_ticks === null ? null : Math.round(end_ticks / 10_000),
    };
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: z.object({
            fileId: z.string().guid().optional().describe('Selected file UUID; ignored for series, which list all episode chapters'),
        }),
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const mediaType = await getMediaItemType(sql, internalId);
            if (!mediaType) return ApiProblem.notFound('Media item not found');

            const fileId = ctx.input?.query?.fileId;

            if (isSeries(mediaType)) {
                const chapters = await getChaptersForSeries(sql, internalId);
                const episodesWithChapters = await countEpisodesWithChapters(sql, internalId);
                return json(
                    ChaptersResponseSchema.parse({
                        chapters: chapters.map(chapterResponseRow),
                        episodesWithChapters,
                    }),
                );
            } else if (fileId) {
                const chapters = await getChaptersForFile(sql, fileId, internalId);
                return json(
                    ChaptersResponseSchema.parse({
                        chapters: chapters.map(chapterResponseRow),
                        episodesWithChapters: chapters.length > 0 ? 1 : 0,
                    }),
                );
            } else {
                const chapters = await getChaptersForEpisode(sql, internalId);
                return json(
                    ChaptersResponseSchema.parse({
                        chapters: chapters.map(chapterResponseRow),
                        episodesWithChapters: chapters.length > 0 ? 1 : 0,
                    }),
                );
            }
        },
    },
});
