// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/debug-report/client-diagnostics/[fingerprint].ts —
 * GET /api/v1/admin/debug-report/client-diagnostics/{fingerprint}
 *
 * One client-diagnostic group of the last 24 hours: its recent events' kind,
 * platform, app and OS version, and the client-written summary (untrusted text).
 * No user, device, device model, media, play session, payload or blob.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { diagnosticsAccessDenial } from '$lib/server/auth/diagnostics-grant.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { buildClientDiagnosticGroup } from '$lib/server/debug-report/build.js';
import {
    debugReportFailure,
    debugReportRateKey,
    NO_STORE_HEADERS,
    noStore,
} from '$lib/server/debug-report/http.js';
import { ClientDiagnosticGroupDetailSchema } from '$lib/schemas/debug-report.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['diagnostics:read'] },
    rateLimit: {
        limit: 1,
        windowSec: 2,
        keyBy: (event) => debugReportRateKey(event, 'debug-report-client-group'),
    },
    docs: {
        visibility: 'public',
        GET: {
            tags: ['Admin'],
            summary: 'Get one client-diagnostic group of the debug report',
            stability: 'beta',
            auth: 'bearer',
            description:
                'The recent events of one client-diagnostic group (fingerprint from the report, `none` for events without one) in the last 24 hours. Summaries are untrusted client text. Authorised by an administrator, or a service token with the `diagnostics:read` grant whose owner is an administrator.',
            responses: {
                200: {
                    schema: ClientDiagnosticGroupDetailSchema,
                    description: 'The group and its recent events',
                },
                401: 'Authentication required',
                403: 'Not an administrator and not a diagnostics:read token whose owner is an administrator',
                404: 'No events in this group in the last 24 hours',
                429: 'Rate limited: one request per 2 seconds per credential',
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

                const detail = await buildClientDiagnosticGroup(sql, event.params.fingerprint!);
                if (!detail)
                    return noStore(ApiProblem.notFound('Client diagnostic group not found'));
                return json(ClientDiagnosticGroupDetailSchema.parse(detail), {
                    headers: NO_STORE_HEADERS,
                });
            } catch (error) {
                return debugReportFailure(error);
            }
        },
    },
});
