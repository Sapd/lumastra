// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/diagnostics/index.ts
 *
 * GET    /api/admin/diagnostics — filtered, paginated list of everything
 *        clients reported (crashes, hangs, JS errors, API failures, playback
 *        incidents, log bundles).
 * DELETE /api/admin/diagnostics — clears the filtered set; refuses an
 *        unscoped clear unless `all=true` is passed explicitly.
 *
 * Auth: admin. Internal surface only — the admin UI is cookie/forward-auth
 * authenticated and never talks to /api/v1.
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    listClientDiagnostics,
    deleteClientDiagnostics,
    type ClientDiagnosticRow,
    type ClientDiagnosticListFilters,
} from '$lib/server/database/queries/client-diagnostics.queries.js';
import {
    DIAGNOSTIC_KINDS,
    ClientDiagnosticListResponseSchema,
    ClientDiagnosticClearedResponseSchema,
    type ClientDiagnosticSummary,
} from '$lib/schemas/client-diagnostics.js';
import { shortIdFor } from '$lib/server/services/client-diagnostics/summary.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

/**
 * Repeated `?kind=` params arrive as a string[] (mount.ts's
 * `searchParamsToObject` collapses repeats via `getAll`); a single `?kind=`
 * arrives as a bare string. Either form may also be a comma-separated list
 * (`kind=crash,hang`) — split every entry so both forms work identically.
 */
const kindParam = z.preprocess(
    (v) => {
        if (v === undefined) return undefined;
        const arr = Array.isArray(v) ? v : [v];
        const flat = arr.flatMap((s) => String(s).split(',')).filter((s) => s.length > 0);
        return flat.length > 0 ? flat : undefined;
    },
    z.array(z.enum(DIAGNOSTIC_KINDS)).optional(),
);

/** A blank query value means "no filter" — treat it the same as omitted. */
// Whitespace-only is blank too. Otherwise "deviceId= " passed this layer as a
// filter, the query layer trimmed it to nothing, and a scoped DELETE reached
// the "refusing to delete everything" guard as an unhandled 500.
const blankToUndefined = (v: unknown): unknown =>
    typeof v === 'string' && v.trim() === '' ? undefined : v;

const QuerySchema = z.object({
    kind: kindParam,
    platform: z.preprocess(blankToUndefined, z.enum(['ios', 'tvos', 'web', 'other']).optional()),
    userId: z.preprocess(blankToUndefined, z.string().uuid().optional()),
    deviceId: z.preprocess(blankToUndefined, z.string().min(1).max(128).optional()),
    appVersion: z.preprocess(blankToUndefined, z.string().min(1).max(32).optional()),
    fingerprint: z.preprocess(blankToUndefined, z.string().min(1).max(64).optional()),
    resolved: z.enum(['true', 'false']).optional(),
    from: z.preprocess(blankToUndefined, z.coerce.date().optional()),
    to: z.preprocess(blankToUndefined, z.coerce.date().optional()),
    q: z.preprocess(blankToUndefined, z.string().min(1).max(200).optional()),
    all: z.enum(['true']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(50),
    offset: z.coerce.number().int().min(0).optional().default(0),
});

export function toSummaryDto(row: ClientDiagnosticRow): ClientDiagnosticSummary {
    return {
        id: row.id,
        eventId: row.event_id,
        shortId: shortIdFor(row.event_id),
        kind: row.kind,
        platform: row.platform,
        userId: row.user_id,
        username: row.username,
        deviceId: row.device_id,
        deviceName: row.device_name,
        appVersion: row.app_version,
        osVersion: row.os_version,
        deviceModel: row.device_model,
        playSessionId: row.play_session_id,
        mediaId: row.media_id,
        mediaTitle: row.media_title,
        occurredAt: row.occurred_at.toISOString(),
        receivedAt: row.received_at.toISOString(),
        fingerprint: row.fingerprint,
        occurrences: row.occurrences,
        summary: row.summary,
        resolvedAt: row.resolved_at?.toISOString() ?? null,
        hasBlob: row.has_blob,
    };
}

function filtersFrom(
    q: z.infer<typeof QuerySchema>,
): Omit<ClientDiagnosticListFilters, 'limit' | 'offset' | 'q'> {
    return {
        kinds: q.kind,
        platform: q.platform,
        userId: q.userId,
        deviceId: q.deviceId,
        appVersion: q.appVersion,
        fingerprint: q.fingerprint,
        resolved: q.resolved === undefined ? undefined : q.resolved === 'true',
        from: q.from,
        to: q.to,
    };
}

/** True when every filter field is unset — an unscoped clear needs `all=true`. */
function isUnscoped(filters: Omit<ClientDiagnosticListFilters, 'limit' | 'offset' | 'q'>): boolean {
    return Object.values(filters).every(
        (v) => v === undefined || (Array.isArray(v) && v.length === 0),
    );
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    request: { query: QuerySchema },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin', 'Diagnostics'],
            summary: 'List client diagnostics',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Filtered, paginated list of everything clients reported. `q` matches a short ' +
                'id (7F3A-91C2), a web error reference, or summary text.',
            responses: {
                200: {
                    schema: ClientDiagnosticListResponseSchema,
                    description: 'Diagnostics list',
                },
                401: 'Authentication required',
                403: 'Admin access required',
                503: 'Database unavailable',
            },
        },
        DELETE: {
            tags: ['Admin', 'Diagnostics'],
            summary: 'Clear client diagnostics',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Deletes the filtered set. Without any filter, `all=true` is required. ' +
                '`q` is rejected — a search-scoped clear is not supported.',
            responses: {
                200: { schema: ClientDiagnosticClearedResponseSchema, description: 'Rows removed' },
                401: 'Authentication required',
                403: 'Admin access required',
                422: 'Unscoped clear without all=true, or q was supplied',
                503: 'Database unavailable',
            },
        },
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const q = ctx.input!.query!;
            const { rows, total } = await listClientDiagnostics(sql, {
                ...filtersFrom(q),
                q: q.q,
                limit: q.limit,
                offset: q.offset,
            });
            return json(
                ClientDiagnosticListResponseSchema.parse(
                    paginate(rows.map(toSummaryDto), {
                        limit: q.limit,
                        offset: q.offset,
                        hasMore: q.offset + rows.length < total,
                        total,
                    }),
                ),
            );
        },
        DELETE: async (event, ctx) => {
            const q = ctx.input!.query!;
            if (q.q !== undefined) {
                return ApiProblem.validationFailed('search-scoped clear is not supported');
            }
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const filters = filtersFrom(q);
            const allowAll = q.all === 'true';
            if (isUnscoped(filters) && !allowAll) {
                return ApiProblem.validationFailed(
                    'Refusing to clear every diagnostic without all=true',
                );
            }
            const cleared = await deleteClientDiagnostics(sql, filters, { allowAll });
            auditLog('client_diagnostics.clear', 'client_diagnostics', auditActor(event), {
                filters,
                allowAll,
                cleared,
            });
            return json(ClientDiagnosticClearedResponseSchema.parse({ cleared }));
        },
    },
});
