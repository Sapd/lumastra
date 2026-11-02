// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/hierarchy.ts
 *
 * GET /api/admin/media/[id]/hierarchy
 *
 * Returns the media hierarchy tree for the admin sidebar.
 * Resolves up to the series root for episodes/seasons.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { series, seasons, currentItemId, resolvedFromChild }
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { isSeries } from '$lib/server/utils/media-types.js';
import {
    getHierarchyItem,
    getParentBasicInfo,
    getSeasonsForSeries,
    getEpisodesForSeriesHierarchy,
} from '$lib/server/database/queries/media-hierarchy.queries.js';

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const EpisodeNodeSchema = z.object({
    id: z.string(),
    title: z.string().nullable(),
    episodeNumber: z.number().nullable(),
    seasonNumber: z.number().nullable(),
    externalIds: z.object({ jellyfin: z.string().optional() }),
    hasFile: z.boolean(),
    isOrderingSegment: z.boolean(),
});

const SeasonNodeSchema = z.object({
    id: z.string(),
    title: z.string().nullable(),
    seasonNumber: z.number().int(),
    episodeCount: z.number().int(),
    externalIds: z.object({ jellyfin: z.string().optional() }),
    episodes: z.array(EpisodeNodeSchema),
});

export const HierarchyResponseSchema = z.object({
    series: z.object({
        id: z.string(),
        title: z.string(),
        externalIds: z.object({ jellyfin: z.string().optional() }),
    }),
    seasons: z.array(SeasonNodeSchema),
    currentItemId: z.string(),
    resolvedFromChild: z.boolean(),
});

export type HierarchyResponse = z.infer<typeof HierarchyResponseSchema>;

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

            const item = await getHierarchyItem(sql, internalId);
            if (!item) return ApiProblem.notFound('Media item not found');

            let seriesId: string;
            const currentItemId = internalId;

            if (isSeries(item.mediaType)) {
                seriesId = internalId;
            } else {
                let parentId = item.parentId;
                seriesId = internalId;
                for (let i = 0; i < 2 && parentId; i++) {
                    const parent = await getParentBasicInfo(sql, parentId);
                    if (!parent) break;
                    if (isSeries(parent.mediaType)) {
                        seriesId = parent.id;
                        break;
                    }
                    parentId = parent.parentId;
                }
            }

            const series = await getHierarchyItem(sql, seriesId);
            const seasonRows = await getSeasonsForSeries(sql, seriesId);
            const episodeRows = await getEpisodesForSeriesHierarchy(sql, seriesId);

            const episodesBySeason = new Map<number, z.infer<typeof EpisodeNodeSchema>[]>();
            for (const ep of episodeRows) {
                const sn = (ep.season_number as number) ?? 0;
                if (!episodesBySeason.has(sn)) episodesBySeason.set(sn, []);
                episodesBySeason.get(sn)!.push({
                    id: ep.id,
                    title: ep.title,
                    episodeNumber: ep.episode_number,
                    seasonNumber: ep.season_number,
                    externalIds: { jellyfin: ep.jellyfin_id ?? undefined },
                    hasFile: ep.has_file,
                    isOrderingSegment: ep.is_ordering_segment,
                });
            }

            const seasons: z.infer<typeof SeasonNodeSchema>[] = seasonRows.map((s) => ({
                id: s.id,
                title: s.title,
                seasonNumber: (s.season_number as number) ?? 0,
                episodeCount: Number(s.episode_count),
                externalIds: { jellyfin: s.jellyfin_id ?? undefined },
                episodes: episodesBySeason.get((s.season_number as number) ?? 0) ?? [],
            }));

            const seasonNumbers = new Set(seasonRows.map((s) => s.season_number as number));
            for (const [sn, eps] of episodesBySeason) {
                if (!seasonNumbers.has(sn)) {
                    seasons.push({
                        id: `virtual-season-${sn}`,
                        title: sn === 0 ? 'Specials' : `Season ${sn}`,
                        seasonNumber: sn,
                        episodeCount: eps.length,
                        externalIds: {},
                        episodes: eps,
                    });
                }
            }

            seasons.sort((a, b) => a.seasonNumber - b.seasonNumber);

            return json(
                HierarchyResponseSchema.parse({
                    series: {
                        id: series?.id ?? seriesId,
                        title: series?.title ?? 'Unknown Series',
                        externalIds: { jellyfin: series?.jellyfinId ?? undefined },
                    },
                    seasons,
                    currentItemId,
                    resolvedFromChild: seriesId !== internalId,
                }),
            );
        },
    },
});
