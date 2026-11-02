// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /diagnostics/events — batch of client diagnostics (crash, hang, js_error,
 * api_failures, playback_incident). Idempotent per eventId. Mounted on /api and /api/v1.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    diagnosticEventBatchSchema,
    DiagnosticIngestResponseSchema,
} from '$lib/schemas/client-diagnostics.js';
import {
    ingestDiagnosticEvents,
    InvalidIncidentError,
} from '$lib/server/services/client-diagnostics/ingest.service.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('DiagnosticsEventsDef');

export const def = defineEndpoint({
    auth: { kind: 'user' },
    rateLimit: {
        limit: 60,
        windowSec: 60,
        keyBy: (event) => `diagnostics:${event.locals.user?.userId ?? 'anonymous'}`,
    },
    request: { body: diagnosticEventBatchSchema, maxBodyBytes: 512 * 1024 },
    docs: {
        POST: {
            tags: ['Diagnostics'],
            summary: 'Report client diagnostics',
            stability: 'stable',
            description:
                'Batch of up to 50 diagnostics events (crash, hang, js_error, api_failures, playback_incident). ' +
                'Idempotent per eventId: resending a batch after a timeout inserts only the missing events. ' +
                'Automatic kinds are silently dropped when the admin disabled them (features.clientDiagnostics) ' +
                'or the user exceeded the daily byte budget; the response counts them as dropped. ' +
                'Rate-limited to 60 requests/minute per user (shared with /diagnostics/events/resolve).',
            body: diagnosticEventBatchSchema,
            responses: {
                202: { schema: DiagnosticIngestResponseSchema, description: 'Accepted' },
                401: 'Authentication required',
                413: 'Payload too large',
                422: 'Invalid event',
                429: 'Rate limited',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        POST: async (event, ctx) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            try {
                const result = await ingestDiagnosticEvents(sql, userId, ctx.input!.body!.events);
                return json(DiagnosticIngestResponseSchema.parse(result), { status: 202 });
            } catch (err) {
                if (err instanceof InvalidIncidentError)
                    return ApiProblem.validationFailed(err.message);
                logger.error('Failed to ingest diagnostics', err as Error);
                return problem('internal_error', { error: 'Failed to ingest diagnostics' });
            }
        },
    },
});
