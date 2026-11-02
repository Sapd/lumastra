// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/epg/search.ts
 *
 * GET /livetv/admin/epg/search?q=<query>&sourceId=<sourceId>
 *   Search EPG channels for manual override assignment.
 *   Returns empty results when query < 2 chars.
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * Response: { results: { id, displayName, iconUrl? }[] }  (bare object)
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { searchEpgChannels } from '$lib/server/database/queries/livetv-channels.queries.js';
import { EpgChannelSearchResponseSchema } from '$lib/schemas/livetv';

const EpgSearchQuerySchema = z.object({
    sourceId: z.string().meta({ description: 'Live TV source to search within (required)' }),
    q: z
        .string()
        .max(200)
        .optional()
        .meta({ description: 'Query text; results are empty below 2 characters' }),
});

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Live TV'],
            summary: 'Search EPG channels for manual override assignment',
            stability: 'experimental',
            auth: 'bearer',
            query: EpgSearchQuerySchema,
            responses: {
                200: {
                    schema: EpgChannelSearchResponseSchema,
                    description: 'Matching EPG channels',
                },
                401: 'Authentication required',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        query: z.object({
            q: z.string().max(200).optional(),
            sourceId: z.string(),
        }),
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { q = '', sourceId } = ctx.input!.query;

            if (!sourceId) {
                return ApiProblem.validationFailed('sourceId query parameter is required');
            }

            if (q.length < 2) {
                return json({ results: [] });
            }

            const rows = await searchEpgChannels(sql, sourceId, q);

            const results = rows.map((row) => ({
                id: row.id,
                displayName: row.display_name,
                iconUrl: row.icon_url ?? undefined,
            }));

            return json({ results });
        },
    },
});
