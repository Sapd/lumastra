// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/debug-report/index.ts — GET /api/v1/admin/debug-report
 *
 * The instance debug report: one redacted object (JSON) or the same report as
 * Markdown (`?format=md`), safe to paste into an AI assistant, an issue or a forum.
 * Design: docs/superpowers/specs/2026-10-21-admin-debug-report-design.md.
 *
 * Auth: `{kind:'scope', anyOf:['diagnostics:read']}` (admins pass by scopeGranted's
 * early return), then the handler's `diagnosticsAccessDenial()`: an administrator, or
 * a `diagnostics:read` service token whose owner is still an administrator. A
 * `?include=` toggle (hostnames, paths) is administrator-only: a grant token asking
 * for one gets 403.
 *
 * Responses are never cached (`Cache-Control: no-store`). Rate limit: one report per
 * 10 seconds per credential.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { diagnosticsAccessDenial } from '$lib/server/auth/diagnostics-grant.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { buildDebugReport } from '$lib/server/debug-report/build.js';
import {
    debugReportFailure,
    debugReportRateKey,
    NO_STORE_HEADERS,
    noStore,
} from '$lib/server/debug-report/http.js';
import { DebugReportQuerySchema, DebugReportSchema } from '$lib/schemas/debug-report.js';
import { formatDebugReport } from '$lib/shared/debug-report-format.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['diagnostics:read'] },
    request: {
        query: DebugReportQuerySchema,
    },
    rateLimit: {
        limit: 1,
        windowSec: 10,
        keyBy: (event) => debugReportRateKey(event, 'debug-report'),
    },
    raw: true,
    docs: {
        visibility: 'public',
        GET: {
            tags: ['Admin'],
            summary: 'Get the instance debug report',
            stability: 'beta',
            auth: 'bearer',
            query: DebugReportQuerySchema,
            description:
                'One redacted report of the instance: build and runtime, health and readiness, cluster nodes, background-task failures and queue, library health counts, client diagnostics of the last 24 hours (aggregates), settings with their source, and integrations (configured and reachable). Every free-text field is redacted; the report says what was removed. ' +
                'Use `format=md` for the same report as Markdown, ready to paste. ' +
                '`include=hostnames,paths` reveals host names and filesystem paths; only an administrator may ask for it. ' +
                'Follow the `links` in the response; drill-downs give one failed run, one client-diagnostic group or one cluster node. ' +
                'Authorised by an administrator session or token, or a service token with the `diagnostics:read` grant whose owner is an administrator. Rate limit: one report per 10 seconds per credential.',
            responses: {
                200: {
                    schema: DebugReportSchema,
                    description: 'The report as JSON, or as Markdown with `format=md`',
                },
                401: 'Authentication required',
                403: 'Not an administrator and not a diagnostics:read token whose owner is an administrator; or `include=` asked by a non-administrator',
                422: 'Invalid query: an unknown or repeated include value',
                429: 'Rate limited: one report per 10 seconds per credential',
                503: 'Database unavailable or configuration not loaded',
            },
        },
    },
    handlers: {
        GET: async (event, ctx) => {
            const denial = diagnosticsAccessDenial(event.locals.principal);
            if (denial) return noStore(denial);

            const query = ctx.input?.query;
            const include = query?.include ?? [];
            if (include.length > 0 && event.locals.principal?.isAdmin !== true) {
                return noStore(ApiProblem.forbidden('include= is for administrators only'));
            }

            try {
                const sql = getAdminDb();
                if (!sql) return noStore(ApiProblem.dependencyUnavailable('Database unavailable'));

                const report = DebugReportSchema.parse(
                    await buildDebugReport(sql, {
                        options: {
                            includeHostnames: include.includes('hostnames'),
                            includePaths: include.includes('paths'),
                        },
                    }),
                );

                if (query?.format === 'md') {
                    return new Response(formatDebugReport(report), {
                        headers: {
                            'Content-Type': 'text/markdown; charset=utf-8',
                            ...NO_STORE_HEADERS,
                        },
                    });
                }
                return json(report, { headers: NO_STORE_HEADERS });
            } catch (error) {
                return debugReportFailure(error);
            }
        },
    },
});
