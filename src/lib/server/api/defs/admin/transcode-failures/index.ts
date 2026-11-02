// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/transcode-failures/index.ts
 *
 * GET    /api/v1/admin/transcode-failures?outcome=failed|recovered
 * DELETE /api/v1/admin/transcode-failures?outcome=…&category=…&encoder=…
 *
 * Failure incidents grouped by (category, encoder), for the admin transcode
 * diagnostics page. `outcome=failed` (default) covers terminal failures;
 * `outcome=recovered` covers attempts the ladder recovered from.
 *
 * DELETE clears recorded failures: one incident group when `category` is given,
 * otherwise every row in the requested outcome bucket. Always scoped by
 * `outcome`, so clearing from one tab never discards the other tab's rows.
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
    listFailureIncidents,
    deleteFailureIncidents,
    FAILED_OUTCOMES,
    RECOVERED_OUTCOMES,
    type IncidentRow,
} from '$lib/server/database/queries/transcode-failure-events.queries.js';
import {
    TranscodeIncidentsResponseSchema,
    TranscodeClearedResponseSchema,
    type TranscodeIncident,
} from '$lib/schemas/api-transcode-failures.js';
import { Logger } from '$lib/server/utils/logger.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

const logger = Logger.for('AdminTranscodeFailuresAPI');

/** Grouped-incident rows are bounded — an admin diagnostics list, not a paged feed. */
const INCIDENTS_LIMIT = 100;

const TranscodeFailuresQuerySchema = z.object({
    outcome: z.enum(['failed', 'recovered']).optional().default('failed'),
    // DELETE-only. One shared query schema covers both methods (defineEndpoint
    // takes one per endpoint); GET simply ignores these. Absent `category` is the
    // clear-all case, so it cannot be required — which is why DELETE reads the
    // presence of `category`, not a separate "all" flag, to pick its scope.
    category: z.string().min(1).optional(),
    // An incident's encoder is NULL for software transcodes, and a query string
    // cannot carry null — the page sends the literal 'software' it already
    // renders in that column, and this maps it back. An absent `encoder`
    // alongside a `category` means that same NULL group, since encoder is half
    // of the group key and there is no "any encoder" scope on this page.
    encoder: z.string().min(1).optional(),
    // DELETE-only: clear only rows that occurred at or before this instant (the
    // newest event the page showed), so failures that arrived after the screen
    // loaded are never deleted unseen.
    before: z
        .string()
        .datetime({ offset: true })
        // PostgreSQL rounds finer fractions; accepting them could include an
        // event strictly newer than the supplied cutoff.
        .refine((value) => !/\.\d{7}/.test(value))
        .optional(),
});

/** The page renders a NULL encoder as this; DELETE has to map it back to NULL. */
const SOFTWARE_ENCODER_LABEL = 'software';

function toIncidentDto(row: IncidentRow): TranscodeIncident {
    return {
        category: row.category,
        encoder: row.encoder,
        // COUNT()::TEXT keeps bigints out of JS number range issues — convert here.
        occurrences: Number(row.occurrences),
        distinctFiles: Number(row.distinct_files),
        distinctSessions: Number(row.distinct_sessions),
        firstSeen: row.first_seen.toISOString(),
        // Keep the exact PostgreSQL cutoff through GET -> browser -> DELETE.
        lastSeen: row.last_seen,
    };
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    request: {
        query: TranscodeFailuresQuerySchema,
    },
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'List transcode failure incidents',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Failure incidents grouped by (category, encoder). `outcome=failed` (default) ' +
                'returns terminal failures; `outcome=recovered` returns attempts the ladder ' +
                'recovered from.',
            responses: {
                200: {
                    schema: TranscodeIncidentsResponseSchema,
                    description: 'Failure incidents grouped by category/encoder',
                },
                401: 'Authentication required',
                403: 'Admin access required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Admin'],
            summary: 'Clear transcode failure incidents',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Deletes recorded transcode failures. With `category` (and `encoder`) it clears ' +
                'that one incident group; without, it clears every incident in the requested ' +
                '`outcome` bucket. `before` is an inclusive timestamp cutoff; reuse the ' +
                "list response's `lastSeen` unchanged to preserve microseconds. Omitting it " +
                'clears without a time bound. Returns the number of rows removed.',
            responses: {
                200: { schema: TranscodeClearedResponseSchema, description: 'Rows removed' },
                401: 'Authentication required',
                403: 'Admin access required',
                422: '`encoder` given without `category`',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { outcome, encoder } = ctx.input!.query!;
            const outcomes = outcome === 'recovered' ? RECOVERED_OUTCOMES : FAILED_OUTCOMES;

            // `encoder` narrows the list server-side (the health-invariant deep
            // link), so every group of that encoder is listed, not only the
            // ones inside the newest-INCIDENTS_LIMIT cut.
            const { rows, totalGroups } = await listFailureIncidents(sql, {
                outcomes,
                limit: INCIDENTS_LIMIT,
                encoder:
                    encoder === undefined
                        ? undefined
                        : encoder === SOFTWARE_ENCODER_LABEL
                          ? null
                          : encoder,
            });

            return json(
                TranscodeIncidentsResponseSchema.parse({
                    incidents: rows.map(toIncidentDto),
                    truncated: totalGroups > rows.length,
                    totalGroups,
                }),
            );
        },
        DELETE: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { outcome, category, encoder, before } = ctx.input!.query!;
            // Without a category the delete is the whole bucket and `encoder`
            // would be ignored — a scoped clear must never widen to clear-all.
            if (encoder !== undefined && category === undefined) {
                return ApiProblem.validationFailed('`encoder` requires `category`');
            }
            const outcomes = outcome === 'recovered' ? RECOVERED_OUTCOMES : FAILED_OUTCOMES;

            const cleared = await deleteFailureIncidents(sql, {
                outcomes,
                category,
                encoder: encoder === SOFTWARE_ENCODER_LABEL ? null : encoder,
                before,
            });

            logger.info('Transcode failure incidents cleared', {
                outcome,
                category: category ?? '(all)',
                encoder: encoder ?? '(any)',
                cleared,
            });
            // Deleting failure evidence is an admin action: record who did it.
            auditLog('transcode_failures.clear', category ?? 'all', auditActor(event), {
                outcome,
                category: category ?? null,
                encoder: encoder ?? null,
                before: before ?? null,
                cleared,
            });

            return json(TranscodeClearedResponseSchema.parse({ cleared }));
        },
    },
});
