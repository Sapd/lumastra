// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/plugins/internal/index.ts — GET /api/v1/plugins/internal
 *
 * Lists registered internal (built-in) plugins. Requires `tasks:admin` scope
 * (WAS `tasks:read` — moved 2026-09-18 fix-plan-4 Task 2, Shape C ruling's
 * five-endpoint sweep; belt-and-braces on top of removing `tasks:read`'s
 * auto-grant to every non-admin session, the load-bearing fix. See
 * defs/library/paths.ts for the full rationale).
 *
 * Returns the set of plugin IDs that can be addressed via
 *   /api/v1/plugins/internal/{id}/run       (tasks:run)
 *   /api/v1/plugins/internal/{id}/settings  (tasks:admin)
 *
 * NOTE: full plugin registry introspection is not yet standardized; this
 * returns a stub list. Use /api/v1/tasks for task-type-level observability.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/plugins/internal/`
 * `+server.ts`, which did its own inline `enforce({kind:'scope',
 * anyOf:['tasks:read']})` call — mount() ran the SAME enforce() with the SAME
 * AuthSpec before the handler, preserving behaviour exactly AT PORT TIME.
 * The AuthSpec has since changed (`tasks:read` → `tasks:admin`, 2026-09-18
 * fix-plan-4 Task 2 — see the file header above); it no longer matches the
 * original inline call this paragraph once mirrored.
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin
 * (distinct from the sibling `defs/plugins/internal/[id]/*.ts` defs, which
 * back the per-plugin `/run`, `/cancel`, `/settings` sub-routes).
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { PageBlockSchema } from '$lib/schemas/api-for-you-responses';

const InternalPluginSchema = z
    .object({
        id: z.string().describe('Plugin identifier'),
    })
    .meta({ id: 'InternalPlugin', description: 'Internal plugin handle' });

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'List registered internal plugins',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: z
                        .object({
                            items: z.array(InternalPluginSchema),
                            page: PageBlockSchema,
                        })
                        .meta({ id: 'InternalPluginList', description: 'Internal plugin list' }),
                    description: 'Registered internal plugin list',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async () => {
            // Registry introspection is not yet formalized; return an empty collection.
            // Use GET /api/v1/tasks to observe task types and trigger internal plugin runs.
            return Response.json({
                items: [],
                page: { limit: 0, offset: 0, hasMore: false, total: 0 },
            });
        },
    },
});
