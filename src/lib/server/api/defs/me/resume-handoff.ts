// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/me/resume-handoff.ts — `me/resume-handoff`.
 *
 * A paused player asks: did I carry on from here on another device after my
 * last action, and where is that playback now? The answer is where to go;
 * absent means stay. Rules (chain continuity): resume-handoff.service.ts.
 *
 *   GET /me/resume-handoff?mediaId=&positionMs=&deviceId=&idleMs=
 *
 * Auth: user. An item the caller may not see answers "stay", never 404.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { resolveResumeHandoff } from '$lib/server/services/resume-handoff.service.js';
import {
    ResumeHandoffQuerySchema,
    ResumeHandoffResponseSchema,
    type ResumeHandoffResponse,
} from '$lib/schemas/resume-handoff.js';

export const def = defineEndpoint({
    docs: {
        GET: {
            operationId: 'getMyResumeHandoff',
            tags: ['Me'],
            summary: 'Catch up with another device',
            stability: 'stable',
            auth: 'bearer',
            description:
                "For a paused player: returns where this user carried on from here on another device. A chain of play sessions counts when its first session started after the player's last action and resumed within 90 s of its position (or opened the next episode after it finished), each later session continues the previous one the same way, none was started with `entry: explicit`, and the newest is not rewound more than 2 minutes below its furthest point. `handoff` is the same item at a new position, or a later episode of the same series. Absent `handoff` means stay. Call it when the app returns to the foreground or a paused player is about to resume, never while playing.",
            responses: {
                200: { schema: ResumeHandoffResponseSchema, description: 'Handoff or stay' },
                400: 'Invalid query parameters',
                401: 'Authentication required',
                429: 'Too many requests',
                503: 'Database unavailable',
            },
        },
    },

    auth: { kind: 'user' },
    // Asked on every return to a paused player; a loop would only burn queries.
    rateLimit: {
        limit: 30,
        windowSec: 60,
        keyBy: (event) =>
            `resume-handoff:${event.locals.principal?.userId ?? event.locals.user?.userId}`,
    },

    request: {
        query: ResumeHandoffQuerySchema,
    },

    handlers: {
        GET: async (event, ctx) => {
            // idleMs describes the player when this request arrived. Query
            // latency must not move its last-action cutoff past a TV session.
            const requestedAt = new Date();
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');

            const query = ctx.input!.query!;
            if (!(await checkMediaAccess(sql, query.mediaId, event.locals.user))) {
                return json({} satisfies ResumeHandoffResponse);
            }
            const handoff = await resolveResumeHandoff(sql, {
                userId,
                mediaId: query.mediaId,
                positionMs: query.positionMs,
                deviceId: query.deviceId,
                idleMs: query.idleMs,
                requestedAt,
            });
            const body: ResumeHandoffResponse =
                handoff && (await checkMediaAccess(sql, handoff.mediaId, event.locals.user))
                    ? { handoff }
                    : {};
            return json(body);
        },
    },
});
