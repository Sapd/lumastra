// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/attention/ack.ts
 *
 * POST /api/admin/attention/ack
 *
 * Acknowledges one attention item by id + fingerprint. The fingerprint ensures
 * the ack is for the exact incident state the admin reviewed — if the incident
 * state has changed the fingerprint will differ and the ack is a no-op.
 *
 * Body:     { id: string, fingerprint: string }
 * Response: { ok: boolean }
 * 503 dependency_unavailable when DB is down.
 * Cache-Control: no-store on success.
 *
 * Auth: admin.  Surface: internal-only.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { ackAttention } from '$lib/server/services/attention/attention-service.js';
import { bustAttentionCache } from '$lib/server/services/attention/attention-cache.js';
import {
    AttentionAckRequestSchema,
    AttentionAckResponseSchema,
} from '$lib/schemas/api-attention-responses.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: AttentionAckRequestSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { id, fingerprint } = ctx.input!.body;
            const ackedBy = event.locals.user?.username ?? 'admin';

            const ok = await ackAttention(sql, id, fingerprint, ackedBy);
            // Bust the short-TTL attention cache so the badge reflects the ack on
            // the next poll rather than waiting out the TTL.
            if (ok) await bustAttentionCache();

            return json(AttentionAckResponseSchema.parse({ ok }), {
                headers: { 'Cache-Control': 'no-store' },
            });
        },
    },
});
