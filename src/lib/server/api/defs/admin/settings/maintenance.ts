// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/settings/maintenance.ts
 *
 * GET    /api/admin/maintenance — return the currently active notice (or null)
 * POST   /api/admin/maintenance — set a new notice (rejects if one is active)
 * DELETE /api/admin/maintenance — clear any active notice (idempotent)
 *
 * The notice is persisted in Valkey with TTL and fan-out via pub/sub.
 * Body validation for POST is done per-handler because DELETE carries no body.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * GET    → { notice: MaintenanceNotice | null, reach?: { total, supporting } }
 *           `reach` says how many live sessions announced they can render the
 *           banner. It informs the operator; it never gates the button — see
 *           `maintenanceReach()` below.
 * POST   → { notice: MaintenanceNotice }  (201)
 * DELETE → { ok: true }
 * 503    → dependency_unavailable when Valkey is down
 * 409    → conflict when a notice is already active (POST only)
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import {
    setMaintenanceNotice,
    clearMaintenanceNotice,
    getActiveMaintenanceNotice,
    withRemaining,
} from '$lib/server/services/play-session-events.service.js';
import { MaintenanceNoticeRequestSchema } from '$lib/schemas/api-admin-responses.js';
import { getDb } from '$lib/server/database/connection.js';
import { countLiveSessionsAnnouncing } from '$lib/server/database/queries/play-sessions.queries.js';
import { CLIENT_FEATURE_MAINTENANCE_NOTICE } from '$lib/shared/client-features.js';

/**
 * Audience estimate for a maintenance banner: how many live sessions there are
 * and how many announced they can render one.
 *
 * The maintenance button is NOT gated on this — a notice is a global broadcast
 * with no single target session, and a client that does not understand the
 * frame ignoring it is the correct failure mode. The operator gets a count so
 * the decision is informed, not taken away.
 *
 * Best-effort: on a DB outage the field is simply absent and the notice
 * surface keeps working. A notice an operator cannot send because the reach
 * probe failed would be a worse outcome than one sent without the estimate.
 */
async function maintenanceReach(): Promise<{ total: number; supporting: number } | undefined> {
    const sql = getDb();
    if (!sql) return undefined;
    try {
        return await countLiveSessionsAnnouncing(sql, CLIENT_FEATURE_MAINTENANCE_NOTICE);
    } catch {
        return undefined;
    }
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const [notice, reach] = await Promise.all([
                getActiveMaintenanceNotice(),
                maintenanceReach(),
            ]);
            return json({
                notice: notice ? withRemaining(notice) : null,
                ...(reach ? { reach } : {}),
            });
        },

        POST: async (event) => {
            const username = event.locals.user?.username;
            if (!username) return ApiProblem.unauthorized();

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Invalid request body');
            }
            const parsed = MaintenanceNoticeRequestSchema.safeParse(body);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((i) => ({
                        field: i.path.join('.'),
                        message: i.message,
                    })),
                );
            }

            const { message, minutes } = parsed.data;
            const endsAt = Date.now() + minutes * 60_000;

            try {
                const notice = await setMaintenanceNotice({
                    message,
                    endsAt,
                    createdBy: username,
                });
                return json({ notice: withRemaining(notice) }, { status: 201 });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (/already/i.test(msg)) {
                    return ApiProblem.conflict('A maintenance notice is already active');
                }
                if (/past/i.test(msg) || /24 hours/i.test(msg)) {
                    return ApiProblem.validationFailed(msg);
                }
                if (/valkey unavailable/i.test(msg)) {
                    return ApiProblem.dependencyUnavailable(msg);
                }
                throw err;
            }
        },

        DELETE: async () => {
            await clearMaintenanceNotice();
            return json({ ok: true });
        },
    },
});
