// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/library/scanner-runs.ts
 *
 * GET /api/admin/library/scanner-runs
 *
 * Returns file scanner run summaries. Two views over the same rows:
 *   view=latest   — the newest run per library path, one stable row each.
 *   view=history  — recent runs newest-first (the default, unchanged shape).
 *
 * Query params:
 *   view             — 'latest' | 'history' (default 'history')
 *   limit            — max rows (default 20, max 100); ignored by view=latest,
 *                      which is bounded by the number of library paths
 *   library_path_id  — a uuid, or the literal 'global' for runs of scope='all'
 *                      scans (`library_path_id IS NULL`). history view only.
 *   library_group_id — a uuid; narrows either view to runs whose folder
 *                       belongs to that library group (the per-library page's
 *                       scan-history section). A global scan never belongs to
 *                       a group and is excluded once this is set.
 *
 * Auth:    library:admin
 * Surface: internal
 *
 * Response: { items, page }  (paginated by limit/offset)
 * 503 dependency_unavailable on DB down.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getRecentScannerRuns,
    getLatestScannerRunPerLibrary,
    deriveScannerRunStatus,
    type ScannerRunWithPathRow,
} from '$lib/server/database/queries/file-scanner-runs.queries.js';
import { SCANNER_RUN_GLOBAL_SCOPE } from '$lib/schemas/api-admin-responses.js';

/**
 * One row → one wire object.
 *
 * `status` and `durationMs` are derived HERE rather than shipped as raw
 * timestamps for the client to interpret. The 2h staleness rule that turns an
 * open run into "abandoned" is the same threshold the writer uses to stamp
 * one; re-implementing it in a `.svelte` file would put the authoritative
 * copy somewhere tsgo does not typecheck, free to drift unnoticed.
 *
 * `added` is derived for the same reason: `matched` is written as
 * `added + updated` by `file-scanner.ts`, which is not a fact any client
 * should have to know to render a change count. Clamped at zero — the
 * subtraction is only meaningful for a run that actually completed, and an
 * abandoned row's counters are not real numbers from a real pass.
 */
function toScannerRun(r: ScannerRunWithPathRow, now: Date) {
    return {
        id: r.id,
        libraryPathId: r.library_path_id,
        libraryPath: r.library_path,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        totalFiles: r.total_files,
        matched: r.matched,
        updated: r.updated,
        added: Math.max(0, r.matched - r.updated),
        unmatched: r.unmatched,
        errors: r.errors,
        errorSamples: r.error_samples ?? [],
        status: deriveScannerRunStatus(r, now),
        durationMs: r.completed_at
            ? r.completed_at.getTime() - new Date(r.started_at).getTime()
            : null,
        matchRate: parseFloat(r.match_rate),
        createdAt: r.created_at,
    };
}

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    request: {
        query: z.object({
            view: z.enum(['history', 'latest']).default('history'),
            limit: z.coerce.number().int().min(1).max(100).default(20),
            // A uuid or the 'global' sentinel, nothing else. The column is
            // `uuid`, so an arbitrary string used to reach Postgres and come
            // back as a 22P02 invalid-input-syntax 500; this turns that into
            // an ordinary 400.
            library_path_id: z
                .union([z.string().uuid(), z.literal(SCANNER_RUN_GLOBAL_SCOPE)])
                .optional(),
            library_group_id: z.string().uuid().optional(),
        }),
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { view, limit, library_path_id, library_group_id } = ctx.input!.query!;

            // One clock for the whole page, so two rows of the same response
            // can never disagree about whether the grace window has elapsed.
            const now = new Date();

            if (view === 'latest') {
                const runs = await getLatestScannerRunPerLibrary(sql, library_group_id);
                return json(
                    paginate(
                        runs.map((r) => toScannerRun(r, now)),
                        { limit: runs.length, offset: 0, hasMore: false },
                    ),
                );
            }

            // 'global' means `library_path_id IS NULL`, which the query layer
            // spells as `null`. `undefined` stays "every library".
            const scope = library_path_id === SCANNER_RUN_GLOBAL_SCOPE ? null : library_path_id;
            const runs = await getRecentScannerRuns(sql, limit, scope, library_group_id);

            return json(
                paginate(
                    runs.map((r) => toScannerRun(r, now)),
                    { limit, offset: 0, hasMore: false },
                ),
            );
        },
    },
});
