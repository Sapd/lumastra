// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/plugins/external/[id]/disable.ts — POST /api/v1/plugins/external/{id}/disable
 *
 * Disables a previously installed external plugin without uninstalling it.
 * Flips the registry row's `enabled` flag to false. Because there is no
 * per-plugin sandbox and unload is restart-only, an already-loaded plugin stays
 * live in the current process until the next restart — so `restartRequired` is
 * always true. [review C8]
 *
 * The `{id}` path param is validated against the loader's `ID_PATTERN` before
 * any lookup, and the registry `row.name` is the sole identity used downstream,
 * never the raw param.
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
import { disableExternalPlugin } from '$lib/server/services/external-plugin-manager.service.js';

const ErrorSchema = z.object({ error: z.string() });

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Plugins'],
            summary: 'Disable an external plugin',
            stability: 'beta',
            description:
                'Disables a previously installed external plugin without uninstalling it. Flips the registry `enabled` flag to false. Since unload is restart-only (no per-plugin sandbox), an already-loaded plugin stays live until the next restart — `restartRequired` is always true. Requires `admin` scope.',
            responses: {
                200: {
                    schema: z.object({
                        id: z.string().meta({ description: 'Plugin id (registry name)' }),
                        enabled: z.literal(false).meta({
                            description: 'Enabled state after the operation',
                        }),
                        restartRequired: z.literal(true).meta({
                            description:
                                'Always true — unload only takes effect on the next restart',
                        }),
                    }),
                    description: 'Plugin disabled',
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
            const r = await disableExternalPlugin(sql, id, actor);
            if (r.status === 404) return ApiResponses.notFound('unknown plugin');
            return Response.json(r.body, { status: r.status });
        },
    },
});
