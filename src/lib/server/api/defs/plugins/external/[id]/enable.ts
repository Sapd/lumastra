// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/plugins/external/[id]/enable.ts — POST /api/v1/plugins/external/{id}/enable
 *
 * Enables a previously installed external plugin. Flips the registry row's
 * `enabled` flag then attempts a hot-load: if the plugin is already registered
 * this is a no-op (`loaded: true, restartRequired: false`); if its managed
 * `index.js` is missing it is deferred to the next restart; otherwise the
 * bundle is loaded + wired in-process, and `restartRequired` reflects whether
 * that load actually succeeded (honest — no per-plugin sandbox, unload is
 * restart-only).
 *
 * The `{id}` path param is validated against the loader's `ID_PATTERN` BEFORE
 * any filesystem touch, and every on-disk path is built from the resolved
 * registry `row.name`, never the raw param. [review C8]
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
import { enableExternalPlugin } from '$lib/server/services/external-plugin-manager.service.js';

const ErrorSchema = z.object({ error: z.string() });

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Plugins'],
            summary: 'Enable an external plugin',
            stability: 'beta',
            description:
                'Enables a previously installed external plugin without re-installing it. Flips the registry `enabled` flag then attempts to hot-load the bundle. `restartRequired` is true only when the load could not take effect in the running process (missing managed `index.js`, or a load that failed). Requires `admin` scope.',
            responses: {
                200: {
                    schema: z.object({
                        id: z.string().meta({ description: 'Plugin id (registry name)' }),
                        enabled: z.literal(true).meta({
                            description: 'Enabled state after the operation',
                        }),
                        loaded: z.boolean().meta({
                            description:
                                'Whether the plugin is currently loaded into the running process',
                        }),
                        error: z.string().optional().meta({
                            description:
                                'Load failure reason, when a hot-load was attempted and failed',
                        }),
                        restartRequired: z.boolean().meta({
                            description:
                                'True when enabling only takes effect on the next restart (deferred or failed hot-load)',
                        }),
                    }),
                    description: 'Plugin enabled',
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
            // ID_PATTERN FIRST, then the null-DB guard — a bad id with a null DB must
            // return 404 'unknown plugin', not 500 'database unavailable' (shipped order).
            if (!ID_PATTERN.test(id)) return ApiResponses.notFound('unknown plugin');
            const sql = getDb();
            if (!sql) return ApiResponses.error('database unavailable');
            const actor = auditActor(event);
            const r = await enableExternalPlugin(sql, id, actor);
            if (r.status === 404) return ApiResponses.notFound('unknown plugin');
            return Response.json(r.body, { status: r.status });
        },
    },
});
