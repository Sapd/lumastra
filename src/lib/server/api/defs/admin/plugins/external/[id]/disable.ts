// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/plugins/external/[id]/disable.ts — POST /api/admin/plugins/external/{id}/disable
 *
 * Internal admin BFF (cookie/session) twin of the v1 disable endpoint. Delegates
 * to the shared manager wrapper. ID_PATTERN 404 guard runs FIRST.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { getDb } from '$lib/server/database/connection.js';
import { auditActor } from '$lib/server/utils/audit-log.js';
import { ID_PATTERN } from '$lib/server/tasks/registry.js';
import { disableExternalPlugin } from '$lib/server/services/external-plugin-manager.service.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        POST: async (event: RequestEvent) => {
            const id = event.params.id ?? '';
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
