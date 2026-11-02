// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/attention/snooze.ts
 *
 * POST /api/admin/attention/snooze
 *
 * Snoozes one attention item for a duration (time-boxed suppression). Unlike
 * ack, snooze hides the item from the bell/verdict regardless of fingerprint
 * drift — it is for muting known-recurring noise — but a later severity
 * escalation re-surfaces it (handled in reconcile). The fingerprint guard
 * prevents snoozing an incident that changed between render and click.
 *
 * Body:     { id: string, fingerprint: string, durationMs: number }
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
import { snoozeAttention } from '$lib/server/services/attention/attention-service.js';
import { bustAttentionCache } from '$lib/server/services/attention/attention-cache.js';
import {
    AttentionSnoozeRequestSchema,
    AttentionSnoozeResponseSchema,
} from '$lib/schemas/api-attention-responses.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: AttentionSnoozeRequestSchema,
    },
    handlers: {
        POST: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { id, fingerprint, durationMs } = ctx.input!.body;

            const ok = await snoozeAttention(sql, id, fingerprint, durationMs);
            if (ok) await bustAttentionCache();

            return json(AttentionSnoozeResponseSchema.parse({ ok }), {
                headers: { 'Cache-Control': 'no-store' },
            });
        },
    },
});
