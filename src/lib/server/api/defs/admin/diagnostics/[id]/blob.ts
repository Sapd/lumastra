// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/diagnostics/[id]/blob.ts
 *
 * GET /api/admin/diagnostics/{id}/blob?format=gzip|text — downloads the log
 * bundle attached to a `log_bundle` diagnostic.
 *
 * `format=gzip` (default) streams the stored, server-sanitized gzip as an
 * `application/gzip` attachment named after the diagnostic's short id.
 * `format=text` inflates it server-side, bounded by
 * `EVENT_LIMITS.bundleInflatedBytes`, and returns `text/plain`. The inflate
 * runs inside `withBundleSlot` (shared with ingest decode), so a saturated
 * decode semaphore maps to 503 dependency_unavailable rather than piling up
 * unboundedly. An inflate failure (corrupt/oversized content) maps to a
 * problem response — never a thrown 500 leaking internals.
 *
 * Class R (non-JSON success response) — error responses stay problem+json.
 * Auth: admin. Internal surface only — see ../index.ts's doc comment.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getLogBundleBlob } from '$lib/server/database/queries/client-diagnostics.queries.js';
import { EVENT_LIMITS } from '$lib/schemas/client-diagnostics.js';
import { inflateBounded } from '$lib/server/services/client-diagnostics/gzip.js';
import { shortIdFor } from '$lib/server/services/client-diagnostics/summary.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import {
    withBundleSlot,
    BundleBusyError,
} from '$lib/server/services/client-diagnostics/semaphore.js';

// Bounded: a 20-digit id is an "integer" to zod and an out-of-range 500 to Postgres.
const ParamsSchema = z.object({
    id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});
const QuerySchema = z.object({ format: z.enum(['gzip', 'text']).optional().default('gzip') });

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    raw: true,
    request: { params: ParamsSchema, query: QuerySchema },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin', 'Diagnostics'],
            summary: 'Download a diagnostic log bundle',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Streams the stored log bundle. `format=gzip` (default) returns the raw gzip as ' +
                'an attachment; `format=text` inflates it server-side and returns plain text.',
            responses: {
                200: { binary: ['application/gzip', 'text/plain'], description: 'The log bundle' },
                401: 'Authentication required',
                403: 'Admin access required',
                404: 'No log bundle for this diagnostic',
                422: 'Bundle could not be decompressed',
                503: 'Database unavailable',
            },
        },
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { id } = ctx.input!.params!;
            const { format } = ctx.input!.query!;

            const blob = await getLogBundleBlob(sql, id);
            if (!blob) return ApiProblem.notFound('No log bundle for this diagnostic');

            const shortId = shortIdFor(blob.event_id);
            auditLog('client_diagnostics.blob_download', String(id), auditActor(event), { format });

            if (format === 'text') {
                try {
                    const { text } = await withBundleSlot(() =>
                        inflateBounded(blob.content, EVENT_LIMITS.bundleInflatedBytes, {
                            keepText: true,
                        }),
                    );
                    return new Response(text, {
                        headers: {
                            'Content-Type': 'text/plain; charset=utf-8',
                            'Content-Disposition': `inline; filename="diagnostic-${shortId}.log"`,
                            'X-Content-Type-Options': 'nosniff',
                            'Cache-Control': 'no-store',
                        },
                    });
                } catch (err) {
                    if (err instanceof BundleBusyError) {
                        return ApiProblem.dependencyUnavailable('busy, retry shortly');
                    }
                    // Never surface inflate internals (stack traces, zlib error text) to the client.
                    return ApiProblem.validationFailed('Bundle could not be decompressed');
                }
            }

            return new Response(new Uint8Array(blob.content), {
                headers: {
                    'Content-Type': 'application/gzip',
                    'Content-Disposition': `attachment; filename="diagnostic-${shortId}.log.gz"`,
                    'X-Content-Type-Options': 'nosniff',
                    'Cache-Control': 'no-store',
                },
            });
        },
    },
});
