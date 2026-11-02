// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/users/[username]/stream-policy — per-user stream concurrency policy.
 *
 * GET    /api/admin/users/:username/stream-policy  → read effective policy
 * PUT    /api/admin/users/:username/stream-policy  → upsert policy
 * DELETE /api/admin/users/:username/stream-policy  → remove the per-user
 *   override row, falling back to the `__default__` row (or the synthetic
 *   fallback) on the next GET.
 *
 * Auth: users:admin scope OR admin session (internal surface only).
 *
 * Response contract: bare policy object (with updated_at as ISO string).
 * DELETE returns 204 with no body.
 * Errors: problem+json (incl. 503 dependency_unavailable).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import {
    getEffectivePolicy,
    upsertStreamPolicy,
    deleteStreamPolicy,
} from '$lib/server/services/play-sessions.service.js';
import { UpdatePolicyRequestSchema } from '$lib/schemas/play-sessions.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { json } from '@sveltejs/kit';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    visibility: 'internal',
    request: {
        body: UpdatePolicyRequestSchema,
    },
    handlers: {
        GET: async (event, _ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const username = (event.params.username ?? '__default__').toLowerCase();
            const policy = await getEffectivePolicy(db, username);
            return json({
                ...policy,
                updated_at: policy.updated_at.toISOString(),
            });
        },

        PUT: async (event, ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const updated_by =
                event.locals.principal?.username ?? event.locals.user?.username ?? 'admin';
            const policyUsername = (event.params.username ?? '__default__').toLowerCase();

            // Body already validated by mount(); ctx.input!.body is typed + stripped.
            const policy = await upsertStreamPolicy(
                db,
                policyUsername,
                ctx.input!.body,
                updated_by,
            );
            auditLog('user.stream_policy_update', policyUsername, auditActor(event), {
                changes: ctx.input!.body,
            });
            return json({
                ...policy,
                updated_at: policy.updated_at.toISOString(),
            });
        },

        DELETE: async (event, _ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const policyUsername = (event.params.username ?? '__default__').toLowerCase();

            await deleteStreamPolicy(db, policyUsername);
            auditLog('user.stream_policy_delete', policyUsername, auditActor(event));
            return new Response(null, { status: 204 });
        },
    },
});
