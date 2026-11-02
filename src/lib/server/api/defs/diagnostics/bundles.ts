// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /diagnostics/bundles — a gzipped log bundle from a client. Mounted on
 * /api and /api/v1. Rate-limited separately from /diagnostics/events since a
 * bundle upload is a much heavier, much rarer operation.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    diagnosticBundleSchema,
    DiagnosticBundleResponseSchema,
} from '$lib/schemas/client-diagnostics.js';
import { ingestLogBundle } from '$lib/server/services/client-diagnostics/ingest.service.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('DiagnosticsBundlesDef');

export const def = defineEndpoint({
    auth: { kind: 'user' },
    rateLimit: {
        limit: 10,
        windowSec: 3600,
        keyBy: (event) => `diagnostics-bundles:${event.locals.user?.userId ?? 'anonymous'}`,
    },
    request: { body: diagnosticBundleSchema, maxBodyBytes: 3 * 1024 * 1024 },
    docs: {
        POST: {
            tags: ['Diagnostics'],
            summary: 'Upload a client log bundle',
            stability: 'stable',
            description:
                'Uploads a gzipped log bundle (max 2 MiB compressed, 16 MiB inflated) from a client. ' +
                'Idempotent per eventId. Rate-limited to 10 requests/hour per user. ' +
                'Disabled entirely when the admin turned off log bundles (features.clientLogBundles).',
            body: diagnosticBundleSchema,
            responses: {
                202: { schema: DiagnosticBundleResponseSchema, description: 'Accepted' },
                401: 'Authentication required',
                403: 'Log bundles disabled on this server',
                413: 'Payload too large',
                422: 'Invalid bundle',
                429: 'Rate limited',
                503: 'Bundle upload capacity exhausted, retry shortly',
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
                const result = await ingestLogBundle(sql, userId, ctx.input!.body!);
                if (result.ok) {
                    return json(
                        DiagnosticBundleResponseSchema.parse({
                            diagnosticId: result.diagnosticId,
                            eventId: result.eventId,
                            shortId: result.shortId,
                        }),
                        { status: 202 },
                    );
                }
                switch (result.reason) {
                    case 'disabled':
                        return ApiProblem.forbidden('Log bundles are disabled on this server');
                    case 'budget':
                        return ApiProblem.rateLimited(3600);
                    case 'too_large':
                        return ApiProblem.payloadTooLarge(
                            'Bundle exceeds 2 MiB compressed or 16 MiB uncompressed',
                        );
                    case 'bad_gzip':
                        return ApiProblem.validationFailed('contentGzipBase64 is not valid gzip');
                    case 'busy':
                        return ApiProblem.dependencyUnavailable(
                            'Bundle upload capacity exhausted, retry shortly',
                        );
                }
            } catch (err) {
                logger.error('Failed to ingest log bundle', err as Error);
                return problem('internal_error', { error: 'Failed to ingest log bundle' });
            }
        },
    },
});
