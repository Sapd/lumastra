// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PATCH /diagnostics/events/resolve — client reports a playback attempt recovered.
 * Mounted on /api and /api/v1, sharing the /diagnostics/events rate-limit bucket.
 */

import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { getDb } from '$lib/server/database/connection.js';
import { diagnosticResolveSchema } from '$lib/schemas/client-diagnostics.js';
import { resolvePlaybackIncident } from '$lib/server/services/playback-incident.service.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('DiagnosticsResolveDef');

export const def = defineEndpoint({
    auth: { kind: 'user' },
    // Same key string as diagnostics/events.ts — the two defs deliberately share one bucket.
    rateLimit: {
        limit: 60,
        windowSec: 60,
        keyBy: (event) => `diagnostics:${event.locals.user?.userId ?? 'anonymous'}`,
    },
    request: { body: diagnosticResolveSchema, maxBodyBytes: 512 * 1024 },
    docs: {
        PATCH: {
            tags: ['Diagnostics'],
            summary: 'Mark a playback attempt recovered',
            stability: 'stable',
            description:
                "Resolves this user's unresolved playback incidents for the attempt. " +
                'A no-op (still 204) when none exist. ' +
                'Rate-limited to 60 requests/minute per user (shared with /diagnostics/events).',
            body: diagnosticResolveSchema,
            responses: {
                204: 'Resolved (or no-op) — no content',
                401: 'Authentication required',
                413: 'Payload too large',
                422: 'Invalid payload',
                429: 'Rate limited',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        PATCH: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            try {
                await resolvePlaybackIncident(sql, userId, ctx.input!.body!);
                return new Response(null, { status: 204 });
            } catch (err) {
                logger.error('Failed to resolve playback incident', err as Error);
                return problem('internal_error', { error: 'Failed to resolve playback incident' });
            }
        },
    },
});
