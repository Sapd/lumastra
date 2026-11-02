// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/debug-report/health.ts — GET /api/v1/admin/debug-report/health
 *
 * Readiness booleans, per-component reasons and health findings, current. The same
 * redaction as the report (`debug-report/build.ts`). Auth and headers as the report.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { diagnosticsAccessDenial } from '$lib/server/auth/diagnostics-grant.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { buildHealthDetail } from '$lib/server/debug-report/build.js';
import {
    debugReportFailure,
    debugReportRateKey,
    NO_STORE_HEADERS,
    noStore,
} from '$lib/server/debug-report/http.js';
import { ReportHealthSchema } from '$lib/schemas/debug-report.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['diagnostics:read'] },
    rateLimit: {
        limit: 1,
        windowSec: 5,
        keyBy: (event) => debugReportRateKey(event, 'debug-report-health'),
    },
    docs: {
        visibility: 'public',
        GET: {
            tags: ['Admin'],
            summary: 'Get readiness and health findings of the instance',
            stability: 'beta',
            auth: 'bearer',
            description:
                'The readiness booleans of /api/health/ready, the reason of each component that is not passing, and the health findings with their current status. Redacted like the debug report. Authorised by an administrator, or a service token with the `diagnostics:read` grant whose owner is an administrator.',
            responses: {
                200: {
                    schema: ReportHealthSchema,
                    description: 'Readiness, components and findings',
                },
                401: 'Authentication required',
                403: 'Not an administrator and not a diagnostics:read token whose owner is an administrator',
                429: 'Rate limited: one request per 5 seconds per credential',
                503: 'Database unavailable or configuration not loaded',
            },
        },
    },
    handlers: {
        GET: async (event) => {
            const denial = diagnosticsAccessDenial(event.locals.principal);
            if (denial) return noStore(denial);

            try {
                const sql = getAdminDb();
                if (!sql) return noStore(ApiProblem.dependencyUnavailable('Database unavailable'));

                const health = await buildHealthDetail(sql);
                return json(ReportHealthSchema.parse(health), { headers: NO_STORE_HEADERS });
            } catch (error) {
                return debugReportFailure(error);
            }
        },
    },
});
