// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/sessions/broadcast/index.ts
 *
 * POST /api/admin/sessions/broadcast
 *
 * Send an admin toast to every active play session across the cluster.
 * Delivery is best-effort via Valkey pub/sub — we intentionally do NOT
 * return a delivery count. A per-pod sessionControllers.size would be
 * misleading on multi-pod deployments, and aggregating across pods is
 * not worth the round-trip.
 *
 * Auth: admin (sessions:write scope for token-based callers).
 * Surface: internal-only.
 * Response: { ok: true }
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { broadcastAdminMessage } from '$lib/server/services/play-session-events.service.js';
import { AdminMessageRequestSchema } from '$lib/schemas/api-admin-responses.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

const ResponseSchema = z.object({ ok: z.literal(true) });

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: AdminMessageRequestSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const username = event.locals.user?.username;
            if (!username) return ApiProblem.unauthorized();

            const { message, severity, durationMs } = ctx.input!.body!;
            broadcastAdminMessage({
                target: { kind: 'all' },
                severity,
                message,
                durationMs,
                sentBy: username,
            });

            auditLog('session.broadcast', 'all', auditActor(event), {
                message,
                severity,
                durationMs,
            });

            return json(ResponseSchema.parse({ ok: true }));
        },
    },
});
