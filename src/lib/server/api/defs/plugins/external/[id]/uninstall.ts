// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/plugins/external/[id]/uninstall.ts — POST /api/v1/plugins/external/{id}/uninstall
 *
 * Uninstalls a previously installed external plugin: marks the registry row
 * uninstalled, then removes its managed on-disk directory. Because there is no
 * per-plugin sandbox and unload is restart-only, an already-loaded plugin stays
 * live in the current process until the next restart — so `restartRequired` is
 * always true.
 *
 * If the directory removal fails, the registry row is already updated, so the
 * handler returns a soft 500 (row updated, disk cleanup incomplete) with a
 * `warning` — the response body still reports `uninstalled: true`. [review —
 * uninstall drift]
 *
 * The `{id}` path param is validated against the loader's `ID_PATTERN` before
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
import { uninstallExternalPlugin } from '$lib/server/services/external-plugin-manager.service.js';

const ErrorSchema = z.object({ error: z.string() });

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Plugins'],
            summary: 'Uninstall an external plugin',
            stability: 'beta',
            description:
                'Uninstalls a previously installed external plugin: marks the registry row uninstalled then removes its managed on-disk directory. `restartRequired` is always true — an already-loaded plugin stays live until the next restart (unload is restart-only). If the directory removal fails the registry row is still updated and a soft 500 with a `warning` is returned. Requires `admin` scope.',
            responses: {
                200: {
                    schema: z.object({
                        id: z
                            .string()
                            .meta({ description: 'Uninstalled plugin id (registry name)' }),
                        uninstalled: z.literal(true).meta({
                            description: 'Whether the plugin was uninstalled',
                        }),
                        restartRequired: z.literal(true).meta({
                            description:
                                'Always true — unload only takes effect on the next restart',
                        }),
                    }),
                    description: 'Plugin uninstalled',
                },
                404: {
                    schema: ErrorSchema,
                    description: 'Unknown plugin (bad id or no registry row)',
                },
                500: {
                    schema: z.object({
                        id: z
                            .string()
                            .meta({ description: 'Uninstalled plugin id (registry name)' }),
                        uninstalled: z.literal(true).meta({
                            description: 'Registry row was still marked uninstalled',
                        }),
                        restartRequired: z.literal(true).meta({
                            description:
                                'Always true — unload only takes effect on the next restart',
                        }),
                        warning: z.string().meta({
                            description: 'Directory-removal failure detail (row already updated)',
                        }),
                    }),
                    description:
                        'Registry row updated but on-disk directory removal failed (soft failure)',
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
            const r = await uninstallExternalPlugin(sql, id, actor);
            if (r.status === 404) return ApiResponses.notFound('unknown plugin');
            // 200 + the soft-500 dir-removal failure both stay bare Response.json (as today).
            return Response.json(r.body, { status: r.status });
        },
    },
});
