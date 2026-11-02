// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/play-sessions/[id]/kill/index.ts
 *
 * POST /api/admin/play-sessions/[id]/kill
 *
 * Terminate (kill) a specific play session identified by the [id] path param.
 * Returns 204 No Content on success.
 *
 * INTENTIONAL: no body. Session kill is identified entirely by the [id] path
 * param + the authenticated admin's username (from locals). A future `reason`
 * audit field would be added by introducing a body schema.
 *
 * Auth: admin (sessions:write scope for token-based callers).
 * Surface: internal-only.
 * Response: 204 No Content on success.
 * 404 not_found when session does not exist or has already ended.
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { killSessionUnified } from '$lib/server/services/session-kill.service.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    raw: true,
    request: {
        params: z.object({ id: z.string().min(1) }),
    },
    handlers: {
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const sessionId = ctx.input!.params!.id;
            const killed_by = event.locals.user?.username ?? 'admin';

            const result = await killSessionUnified(sql, sessionId, killed_by);
            if (!result) return ApiProblem.notFound('Session not found or already ended');

            auditLog('play_session.kill', sessionId, auditActor(event));
            return new Response(null, { status: 204 });
        },
    },
});
