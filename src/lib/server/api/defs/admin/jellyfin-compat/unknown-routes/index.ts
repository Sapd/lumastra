// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/jellyfin-compat/unknown-routes/index.ts
 *
 * GET /api/admin/jellyfin-compat/unknown-routes?days=7 — Jellyfin spec routes
 * (and probe shapes) that Jellyfin apps requested under /j but Lumastra does
 * not implement, summed over the last N days (<= 8), most requested first.
 * Counted per replica-shared Valkey hash; only spec routes are counted.
 *
 * Auth: admin. Internal surface only.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import {
    readUnknownRoutes,
    UNKNOWN_ROUTE_MAX_DAYS,
} from '$lib/server/compat/jellyfin-unknown-routes.js';

const QuerySchema = z.object({
    days: z.coerce.number().int().min(1).max(UNKNOWN_ROUTE_MAX_DAYS).default(7),
});

const ResponseSchema = z.object({
    items: z.array(z.object({ route: z.string(), client: z.string(), count: z.number().int() })),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    request: { query: QuerySchema },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin', 'Jellyfin compat'],
            summary: 'Unimplemented /j endpoints requested by Jellyfin apps',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Routes requested under /j that Lumastra does not implement, with the requesting client, summed over the last N days.',
            responses: {
                200: { schema: ResponseSchema, description: 'Unknown routes by request count' },
                401: 'Authentication required',
                403: 'Admin access required',
            },
        },
    },
    handlers: {
        GET: async (_event, ctx) => {
            const { days } = ctx.input!.query!;
            return json(ResponseSchema.parse({ items: await readUnknownRoutes(days) }));
        },
    },
});
