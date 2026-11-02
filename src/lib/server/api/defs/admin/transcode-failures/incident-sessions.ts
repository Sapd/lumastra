// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/transcode-failures/incident-sessions.ts
 *
 * GET /api/v1/admin/transcode-failures/incident-sessions?category=&encoder=&outcome=failed|recovered
 *
 * Per-session breakdown of ONE incident group (category, encoder) — the
 * level-2 drill-down the admin page's incident table expands into.
 * `../index.ts`'s incident list is aggregate-only by design, so this is what
 * actually lets an operator get from "12 failures in decode_error/h264_nvenc"
 * to one session's attempt chain.
 *
 * Never returns a filesystem path: `mediaTitle` (when resolvable) or a bare
 * `fileId` are the only file-identifying fields — this page is the one place
 * paths are deliberately kept out of the default view (see
 * $lib/shared/transcode-failure-report.ts).
 *
 * Auth: admin.
 * Surface: mounted on BOTH v1 and internal — see ../index.ts's mirror route
 * for why the internal mount exists (the browser admin UI cannot
 * authenticate against /api/v1 at all).
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    listIncidentSessions,
    FAILED_OUTCOMES,
    RECOVERED_OUTCOMES,
    type IncidentSessionRow,
} from '$lib/server/database/queries/transcode-failure-events.queries.js';
import {
    TranscodeIncidentSessionsResponseSchema,
    type TranscodeIncidentSession,
} from '$lib/schemas/api-transcode-failures.js';

/** Bounded — a per-incident drill-down, not a paged feed. */
const SESSIONS_LIMIT = 200;

const IncidentSessionsQuerySchema = z.object({
    category: z.string().min(1),
    // Absent = software (NULL encoder) — matches how the incident row itself
    // represents a software incident (`encoder: null`).
    encoder: z.string().min(1).optional(),
    outcome: z.enum(['failed', 'recovered']).optional().default('failed'),
});

function toSessionDto(row: IncidentSessionRow): TranscodeIncidentSession {
    return {
        playSessionId: row.play_session_id,
        mediaId: row.media_id,
        fileId: row.file_id,
        mediaTitle: row.media_title,
        attemptCount: Number(row.attempt_count),
        firstSeen: row.first_seen.toISOString(),
        lastSeen: row.last_seen.toISOString(),
        terminalOutcome: row.terminal_outcome,
    };
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    request: {
        query: IncidentSessionsQuerySchema,
    },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'List the sessions behind one transcode-failure incident group',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Per-session breakdown of one (category, encoder) incident group. ' +
                '`terminalOutcome` is null when the session’s full chain ends on a ' +
                'non-terminal `retried` row.',
            responses: {
                200: {
                    schema: TranscodeIncidentSessionsResponseSchema,
                    description: 'Sessions within the incident group',
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

            const { category, encoder, outcome } = ctx.input!.query!;
            const outcomes = outcome === 'recovered' ? RECOVERED_OUTCOMES : FAILED_OUTCOMES;

            const rows = await listIncidentSessions(sql, {
                category,
                encoder: encoder ?? null,
                outcomes,
                limit: SESSIONS_LIMIT,
            });

            return json(
                TranscodeIncidentSessionsResponseSchema.parse({
                    sessions: rows.map(toSessionDto),
                }),
            );
        },
    },
});
