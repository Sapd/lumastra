// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/ingest/scan-issues
 *
 * Returns the list of audio files that the scanner refused to ingest
 * because tag parsing failed (timeout / corrupt). Drives the "Scan issues"
 * section at the bottom of the Ingest Map page.
 *
 * Query params:
 *   ?limit=200  (default 200; max 1000 silently capped)
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { listScanIssues } from '$lib/server/database/queries/media-files.queries.js';

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

const ScanIssuesQuerySchema = z.object({
    limit: z
        .string()
        .optional()
        .transform((v) => (v !== undefined ? parseInt(v, 10) || DEFAULT_LIMIT : DEFAULT_LIMIT)),
});

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: { query: ScanIssuesQuerySchema },
    handlers: {
        GET: async (event, _ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const limitParam = event.url.searchParams.get('limit');
            const requested =
                limitParam !== null ? parseInt(limitParam, 10) || DEFAULT_LIMIT : DEFAULT_LIMIT;
            const limit = Math.min(MAX_LIMIT, Math.max(1, requested));

            const issues = await listScanIssues(sql, limit);
            return json({
                issues,
                total: issues.length,
                truncated: issues.length === limit,
            });
        },
    },
});
