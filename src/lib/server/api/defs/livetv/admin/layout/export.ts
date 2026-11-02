// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/layout/export.ts
 *
 * GET /livetv/admin/layout/export
 *   Returns the channel-curation snapshot as a downloadable JSON file.
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 * Response: raw JSON download (Content-Disposition attachment) — Class R.
 *   Pre-stream error responses use problem+json.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { buildChannelLayout } from '$lib/server/services/livetv/channel-layout.service.js';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Live TV'],
            summary: 'Export channel layout as JSON file',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    binary: ['application/json'],
                    description: 'Channel layout snapshot (Content-Disposition: attachment)',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    raw: true,
    handlers: {
        GET: async () => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const layout = await buildChannelLayout(sql);
            return new Response(JSON.stringify(layout, null, 2), {
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Disposition': 'attachment; filename="livetv-channel-layout.json"',
                },
            });
        },
    },
});
