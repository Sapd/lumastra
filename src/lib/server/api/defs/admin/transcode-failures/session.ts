// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/transcode-failures/session.ts
 *
 * GET /api/v1/admin/transcode-failures/session/:playSessionId
 *
 * The full failure/attempt chain for one play session, oldest first — drills
 * into a single incident from the admin transcode diagnostics page. Chained
 * on play_session_id (not job_id) so a seek's new job object doesn't hide the
 * pre-seek attempts that usually explain the incident.
 *
 * Auth: admin.
 * Surface: internal-only (human-dashboard diagnostics, no automation value).
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    listSessionChain,
    type FailureEventRow,
} from '$lib/server/database/queries/transcode-failure-events.queries.js';
import {
    TranscodeFailureSessionResponseSchema,
    type TranscodeFailureAttempt,
} from '$lib/schemas/api-transcode-failures.js';

function toAttemptDto(row: FailureEventRow): TranscodeFailureAttempt {
    return {
        id: String(row.id),
        jobId: row.job_id,
        attempt: row.attempt,
        occurredAt: row.occurred_at.toISOString(),
        outcome: row.outcome,
        exitCode: row.exit_code,
        signal: row.signal,
        category: row.category,
        summary: row.summary,
        argv: row.argv,
        stderrTail: row.stderr_tail,
        encoder: row.encoder,
        hwaccel: row.hwaccel,
        mediaId: row.media_id,
        fileId: row.file_id,
        source: row.source,
        decision: row.decision,
        env: row.env,
        transcodeSpeed: row.transcode_speed,
        probeDump: row.probe_dump,
    };
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    request: {
        params: z.object({ playSessionId: z.string().min(1) }),
    },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'Get the transcode failure attempt chain for a play session',
            stability: 'stable',
            auth: 'bearer',
            description:
                'The full failure/attempt chain for one play session, oldest first. The last ' +
                'row may be non-terminal (a `retried` with nothing after it) — callers must ' +
                'not assume a terminal row.',
            responses: {
                200: {
                    schema: TranscodeFailureSessionResponseSchema,
                    description: 'Attempt chain for the session, oldest first',
                },
                401: 'Authentication required',
                403: 'Admin access required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { playSessionId } = ctx.input!.params!;
            const rows = await listSessionChain(sql, playSessionId);

            return json(
                TranscodeFailureSessionResponseSchema.parse({
                    attempts: rows.map(toAttemptDto),
                }),
            );
        },
    },
});
