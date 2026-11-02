// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/plugins/external/[id]/reload.ts — POST /api/v1/plugins/external/{id}/reload
 *
 * Reloads a previously installed external plugin, re-reading its managed bundle
 * and manifest. Because there is no per-plugin sandbox and unload is
 * restart-only, an already-registered plugin cannot be swapped in place: reload
 * is an honest no-op in that case (`reloaded: false, restartRequired: true`).
 * Only a plugin that is NOT currently registered (e.g. enabled-but-deferred, or
 * dropped in since boot) can actually be hot-loaded here. [Fable-6]
 *
 * The `{id}` path param is validated against the loader's `ID_PATTERN` before
 * any lookup, and every on-disk path is built from the resolved registry
 * `row.name`, never the raw param. [review C8]
 *
 * v1-only: HAND-MOUNTED from the bespoke v1 `+server.ts` — no internal twin.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { getDb } from '$lib/server/database/connection.js';
import { auditActor } from '$lib/server/utils/audit-log.js';
import { ID_PATTERN } from '$lib/server/tasks/registry.js';
import { reloadExternalPlugin } from '$lib/server/services/external-plugin-manager.service.js';

const ErrorSchema = z.object({ error: z.string() });

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Plugins'],
            summary: 'Reload an external plugin',
            stability: 'beta',
            description:
                'Reloads a previously installed external plugin, re-reading its managed bundle and manifest. If the plugin is already registered in the running process the reload is an honest no-op (`reloaded: false, restartRequired: true`) — unload is restart-only. A plugin that is not currently registered is hot-loaded, and `restartRequired` reflects whether that load actually took effect. Requires `admin` scope.',
            responses: {
                200: {
                    schema: z.object({
                        id: z.string().meta({ description: 'Plugin id (registry name)' }),
                        reloaded: z.boolean().meta({
                            description: 'Whether the plugin was reloaded in the running process',
                        }),
                        version: z
                            .string()
                            .optional()
                            .meta({ description: 'Plugin version after reload' }),
                        restartRequired: z.boolean().meta({
                            description:
                                'True when the reload only takes effect on the next restart (already-registered no-op, or a failed hot-load)',
                        }),
                    }),
                    description: 'Plugin reload result',
                },
                404: {
                    schema: ErrorSchema,
                    description: 'Unknown plugin (bad id or no registry row)',
                },
                500: {
                    schema: ErrorSchema,
                    description: 'Database unavailable',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
            },
        },
    },
    handlers: {
        POST: async (event: RequestEvent) => {
            const id = event.params.id ?? '';
            // ID_PATTERN FIRST, then the null-DB guard (shipped order).
            if (!ID_PATTERN.test(id)) return ApiResponses.notFound('unknown plugin');
            const sql = getDb();
            if (!sql) return ApiResponses.error('database unavailable');
            const actor = auditActor(event);
            const r = await reloadExternalPlugin(sql, id, actor);
            if (r.status === 404) return ApiResponses.notFound('unknown plugin');
            return Response.json(r.body, { status: r.status });
        },
    },
});
