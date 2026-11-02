// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/notifications/broadcast/index.ts
 *
 * POST /api/admin/notifications/broadcast
 *
 * Send a durable, optionally pinned announcement to every user, or to a chosen
 * subset. One `admin_broadcasts` row plus one `user_notifications` row per
 * recipient; see `admin-broadcast.service.ts` for why the fan-out is sequential
 * and why this is not the same feature as `POST /api/admin/sessions/broadcast`
 * (the perishable play-session toast, which is untouched).
 *
 * Auth: admin. Surface: internal-only.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { sendBroadcast } from '$lib/server/services/admin-broadcast.service.js';
import { auditActor } from '$lib/server/utils/audit-log.js';
import {
    SendBroadcastRequestSchema,
    SendBroadcastResponseSchema,
} from '$lib/schemas/admin-broadcasts.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: SendBroadcastRequestSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            // The username, not the user id: `created_by` is an actor field
            // stored as text so the record survives the account being erased
            // (migration 16.209.0's rationale).
            const username = event.locals.user?.username;
            if (!username) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const input = ctx.input!.body!;
            const result = await sendBroadcast(sql, {
                title: input.title,
                body: input.body ?? null,
                // Already scheme-checked by the request schema; an empty string
                // means "no link" and normalizes to null here rather than being
                // carried into the payload as a falsy value.
                linkUrl: input.linkUrl ? input.linkUrl : null,
                audience: input.audience,
                ...(input.userIds ? { userIds: input.userIds } : {}),
                pinned: input.pinned,
                ...(input.pinExpiresAt ? { pinExpiresAt: input.pinExpiresAt } : {}),
                pushEnabled: input.pushEnabled,
                createdBy: username,
                actor: auditActor(event),
            });

            if (!result.ok) {
                // Both refusals are 422s about the SELECTION, and both name what
                // was wrong with it. `unknown_recipients` lists the offending ids
                // rather than quietly delivering to the subset that did resolve
                // — an admin who picked twelve people and reached nine would
                // otherwise have no way to notice.
                if (result.reason === 'unknown_recipients') {
                    return ApiProblem.validationFailed([
                        {
                            field: 'userIds',
                            message: `Unknown, deleted or disabled user ids: ${result.unknownIds.join(', ')}`,
                        },
                    ]);
                }
                return ApiProblem.validationFailed([
                    {
                        field: 'audience',
                        message: 'No active users would receive this broadcast',
                    },
                ]);
            }

            return json(
                SendBroadcastResponseSchema.parse({
                    id: result.broadcast.id,
                    recipientCount: result.broadcast.recipientCount,
                    // Not a status code: a partial fan-out still produced the
                    // announcement and reached most of the audience, so 201 is
                    // the truthful outcome and the counts are what qualify it.
                    // Answering 5xx would tell the admin the send failed and
                    // invite a re-send that duplicates it for everyone who did
                    // get it.
                    deliveredCount: result.deliveredCount,
                    failedCount: result.failedCount,
                    pinnedAt: result.broadcast.pinnedAt,
                }),
                { status: 201 },
            );
        },
    },
});
