// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/layout/import.ts
 *
 * POST /livetv/admin/layout/import
 *   Re-applies a previously exported channel layout to the current provider's
 *   channels (fuzzy match by name). Additive — never deletes channels.
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * Response: LayoutImportSummary (bare object — passed through from importChannelLayout)
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { ChannelLayoutSchema } from '$lib/schemas/livetv.js';
import { importChannelLayout } from '$lib/server/services/livetv/channel-layout.service.js';
import { LayoutImportResponseSchema } from '$lib/schemas/livetv';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Live TV'],
            summary: 'Import a channel layout snapshot',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: LayoutImportResponseSchema,
                    description: 'Import summary (matched, exportOnly, newOnly counts)',
                },
                401: 'Authentication required',
                422: 'Invalid layout payload',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        body: ChannelLayoutSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const summary = await importChannelLayout(sql, ctx.input!.body);
            return json(summary as unknown as Record<string, unknown>);
        },
    },
});
