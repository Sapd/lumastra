// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/epg/review.ts
 *
 * GET /livetv/admin/epg/review
 *   Returns EPG channel match review data with stats.
 *   Accepts optional query params: sourceId (filter), filter (all|mismatches|unmatched).
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * Response: { channels: EpgMatchReviewItem[], stats: { total, matched, unmatched,
 *             lowConfidence, manualOverrides } }  (bare object)
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    getEpgMatchReviewData,
    type EpgMatchReviewRow,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import {
    EpgMatchReviewFilterSchema,
    type EpgMatchConfidenceLevel,
    type EpgMatchReviewItem,
} from '$lib/schemas/livetv.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import { channelImageSet } from '$lib/server/api/defs/livetv/channels/logo-url.js';
import { EpgMatchReviewResponseSchema } from '$lib/schemas/livetv';

const EpgReviewQuerySchema = z.object({
    sourceId: z.string().optional().meta({ description: 'Filter to one Live TV source' }),
    filter: z
        .string()
        .optional()
        .meta({ description: 'all | mismatches | unmatched (default all)' }),
});

function toConfidenceLevel(row: EpgMatchReviewRow): EpgMatchConfidenceLevel {
    if (row.epg_manual_override && !row.epg_channel_exists) return 'stale';
    if (row.epg_manual_override) return 'manual';
    if (row.epg_match_confidence !== null && row.epg_match_confidence >= 0.8) return 'high';
    if (row.epg_match_confidence !== null && row.epg_match_confidence >= 0.5) return 'medium';
    if (
        row.epg_channel_id !== null &&
        (row.epg_match_confidence === null || row.epg_match_confidence < 0.5)
    )
        return 'low';
    return 'unmatched';
}

function toReviewItem(row: EpgMatchReviewRow, surface: ApiSurface): EpgMatchReviewItem {
    const confidenceLevel = toConfidenceLevel(row);
    return {
        id: row.id,
        sourceId: row.source_id ?? undefined,
        name: row.name,
        adminDisplayName: row.admin_display_name ?? undefined,
        images: channelImageSet(surface, row.id, row.logo_url),
        epgChannelId: row.epg_channel_id ?? undefined,
        epgDisplayName: row.epg_display_name ?? undefined,
        confidenceLevel,
        confidenceScore: row.epg_match_confidence ?? undefined,
        matchSignals: row.epg_match_signals ?? undefined,
        isManualOverride: row.epg_manual_override,
        categoryName: row.category_name ?? undefined,
        currentProgram: row.current_program_title
            ? {
                  title: row.current_program_title,
                  startTime: row.current_program_start!.toISOString(),
                  endTime: row.current_program_end!.toISOString(),
              }
            : undefined,
    };
}

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Live TV'],
            summary: 'Get EPG channel-match review data',
            stability: 'experimental',
            auth: 'bearer',
            query: EpgReviewQuerySchema,
            responses: {
                200: {
                    schema: EpgMatchReviewResponseSchema,
                    description: 'EPG match review data with stats',
                },
                401: 'Authentication required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        query: z.object({
            sourceId: z.string().optional(),
            filter: z.string().optional(),
        }),
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { sourceId, filter: filterParam } = ctx.input!.query;
            const filterResult = EpgMatchReviewFilterSchema.safeParse(filterParam ?? 'all');
            const filter = filterResult.success ? filterResult.data : 'all';

            const rows = await getEpgMatchReviewData(sql, sourceId);
            const allChannels = rows.map((row) => toReviewItem(row, ctx.surface));

            const stats = {
                total: allChannels.length,
                matched: allChannels.filter((ch) => ch.confidenceLevel !== 'unmatched').length,
                unmatched: allChannels.filter((ch) => ch.confidenceLevel === 'unmatched').length,
                lowConfidence: allChannels.filter(
                    (ch) => ch.confidenceLevel === 'low' || ch.confidenceLevel === 'stale',
                ).length,
                manualOverrides: allChannels.filter((ch) => ch.isManualOverride).length,
            };

            let channels = allChannels;
            if (filter === 'mismatches') {
                channels = allChannels.filter(
                    (ch) => ch.confidenceLevel === 'low' || ch.confidenceLevel === 'stale',
                );
            } else if (filter === 'unmatched') {
                channels = allChannels.filter((ch) => ch.confidenceLevel === 'unmatched');
            }

            return json({ channels, stats });
        },
    },
});
