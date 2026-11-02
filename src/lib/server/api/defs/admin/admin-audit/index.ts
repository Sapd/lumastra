// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/admin-audit/index.ts
 *
 * GET /api/admin/admin-audit
 *
 * Lists audit_log (source='admin') rows newest-first for the Admin Audit Log UI.
 * Supports keyset pagination + multi-value actor/action filters.
 *
 * Query params:
 *   actor=  — repeatable, filters by actor username
 *   action= — repeatable, exact-match OR prefix-match with trailing `*`
 *   since=  — ISO timestamp lower bound
 *   until=  — ISO timestamp upper bound
 *   cursor= — keyset cursor (integer id); returns rows strictly older
 *   limit=  — 1..200, default 50
 *   format= — 'csv' to trigger the CSV export branch
 *
 * JSON response: { items: AdminAuditEventRow[], page: { limit, nextCursor?, hasMore } }
 * CSV response:  text/csv attachment (raw Response — `raw: true`)
 * 503 dependency_unavailable when DB is down.
 *
 * Auth: admin.  Surface: internal-only.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    listAdminAuditFeed,
    streamAdminAuditExport,
} from '$lib/server/database/queries/admin-audit.queries.js';
import { AdminAuditFeedResponseSchema } from '$lib/schemas/admin-audit.schema.js';
import { serializeToCSV } from '$lib/shared/csv.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const EXPORT_LIMIT = 10_000;
const CSV_COLUMNS = [
    'id',
    'ts',
    'actor',
    'principalKind',
    'credentialId',
    'action',
    'target',
    'outcome',
    'instanceId',
    'detail',
];

const querySchema = z.object({
    // Repeated params are collected in the handler via getAll(); the schema
    // doesn't model them — we only validate limit and the scalar params here.
    since: z.string().optional(),
    until: z.string().optional(),
    cursor: z.coerce.number().int().positive().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
    format: z.enum(['csv', 'json']).default('json'),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    // raw: true because the CSV branch returns a non-JSON Response.
    raw: true,
    request: {
        query: querySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            // Multi-value params not captured by Zod schema — collect from the URL directly.
            const actors = event.url.searchParams.getAll('actor').filter((a) => a.length > 0);
            const actions = event.url.searchParams.getAll('action').filter((a) => a.length > 0);

            const q = ctx.input!.query;

            // An unparseable bound is an error, never silently dropped: a CSV
            // export the caller believes is bounded must not return everything.
            let since: Date | undefined;
            let until: Date | undefined;
            for (const [field, raw] of [
                ['since', q.since],
                ['until', q.until],
            ] as const) {
                if (!raw) continue;
                const parsed = new Date(raw);
                if (Number.isNaN(parsed.getTime())) {
                    return problem('validation_failed', {
                        error: `Invalid \`${field}\` date`,
                        details: [{ field, message: 'Expected an ISO 8601 date-time' }],
                    });
                }
                if (field === 'since') since = parsed;
                else until = parsed;
            }

            if (event.url.searchParams.has('before'))
                return ApiProblem.validationFailed('before is retired; use cursor');
            const { limit, cursor: before } = q;

            // CSV export branch
            if (q.format === 'csv') {
                const rows = await streamAdminAuditExport(sql, {
                    actors: actors.length > 0 ? actors : undefined,
                    actions: actions.length > 0 ? actions : undefined,
                    since,
                    until,
                    before,
                    limit: EXPORT_LIMIT + 1,
                });

                const truncated = rows.length > EXPORT_LIMIT;
                const exportRows = truncated ? rows.slice(0, EXPORT_LIMIT) : rows;

                const csvRows = exportRows.map((ev) => ({
                    id: String(ev.id),
                    ts: ev.ts,
                    actor: ev.actor,
                    principalKind: ev.principalKind ?? '',
                    credentialId: ev.credentialId ?? '',
                    action: ev.action,
                    target: ev.target,
                    outcome: ev.outcome,
                    instanceId: ev.instanceId,
                    detail: JSON.stringify(ev.detail),
                }));

                const date = new Date().toISOString().slice(0, 10);
                const csvBody = serializeToCSV(CSV_COLUMNS, csvRows);

                const headers: Record<string, string> = {
                    'Content-Type': 'text/csv; charset=utf-8',
                    'Content-Disposition': `attachment; filename="admin-audit-${date}.csv"`,
                };
                if (truncated) {
                    headers['X-Truncated'] = 'true';
                    // Pass back as `cursor` to export the next (older) chunk.
                    headers['X-Next-Cursor'] = String(exportRows[exportRows.length - 1].id);
                }
                return new Response(csvBody, { headers });
            }

            // JSON feed branch — { items, page } envelope per contract
            const { events, nextCursor } = await listAdminAuditFeed(sql, {
                actors: actors.length > 0 ? actors : undefined,
                actions: actions.length > 0 ? actions : undefined,
                since,
                until,
                before,
                limit,
            });

            const hasMore = nextCursor !== null;
            return json(
                AdminAuditFeedResponseSchema.parse({
                    items: events,
                    page: {
                        limit,
                        hasMore,
                        ...(hasMore && nextCursor !== null
                            ? { nextCursor: String(nextCursor) }
                            : {}),
                    },
                }),
            );
        },
    },
});
