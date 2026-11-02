// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/diagnostics/[id]/index.ts
 *
 * GET    /api/admin/diagnostics/{id} — one diagnostic's full detail
 *        (payload + blob metadata, when a log bundle was attached).
 * DELETE /api/admin/diagnostics/{id} — clears that one row. 404 when the
 *        row is already gone, so a double-click reads as "already cleared"
 *        rather than silently succeeding twice.
 *
 * Auth: admin. Internal surface only — see ../index.ts's doc comment.
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getClientDiagnosticById,
    deleteClientDiagnosticById,
} from '$lib/server/database/queries/client-diagnostics.queries.js';
import {
    ClientDiagnosticDetailSchema,
    ClientDiagnosticClearedResponseSchema,
    type ClientDiagnosticDetail,
} from '$lib/schemas/client-diagnostics.js';
import { toSummaryDto } from '../index.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

// Bounded: a 20-digit id is an "integer" to zod and an out-of-range 500 to Postgres.
const ParamsSchema = z.object({
    id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    request: { params: ParamsSchema },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin', 'Diagnostics'],
            summary: 'Get one client diagnostic',
            stability: 'stable',
            auth: 'bearer',
            description:
                "One diagnostic's full detail, including its raw payload and blob metadata.",
            responses: {
                200: { schema: ClientDiagnosticDetailSchema, description: 'Diagnostic detail' },
                401: 'Authentication required',
                403: 'Admin access required',
                404: 'Diagnostic not found',
                503: 'Database unavailable',
            },
        },
        DELETE: {
            tags: ['Admin', 'Diagnostics'],
            summary: 'Delete one client diagnostic',
            stability: 'stable',
            auth: 'bearer',
            description: 'Deletes a single recorded diagnostic (and its blob, if any).',
            responses: {
                200: { schema: ClientDiagnosticClearedResponseSchema, description: 'Rows removed' },
                401: 'Authentication required',
                403: 'Admin access required',
                404: 'Diagnostic not found',
                503: 'Database unavailable',
            },
        },
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const { id } = ctx.input!.params!;
            const row = await getClientDiagnosticById(sql, id);
            if (!row) return ApiProblem.notFound('Diagnostic not found');

            const detail: ClientDiagnosticDetail = {
                ...toSummaryDto(row),
                appBuild: row.app_build,
                attemptId: row.attempt_id,
                payload: row.payload,
                blob: row.has_blob
                    ? {
                          contentBytes: row.blob_content_bytes!,
                          uncompressedBytes: row.blob_uncompressed_bytes!,
                          sha256: row.blob_sha256!,
                      }
                    : null,
            };
            return json(ClientDiagnosticDetailSchema.parse(detail));
        },
        DELETE: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const { id } = ctx.input!.params!;
            const cleared = await deleteClientDiagnosticById(sql, id);
            if (cleared === 0) return ApiProblem.notFound('Diagnostic not found');

            auditLog('client_diagnostics.delete', String(id), auditActor(event), { cleared });
            return json(ClientDiagnosticClearedResponseSchema.parse({ cleared }));
        },
    },
});
