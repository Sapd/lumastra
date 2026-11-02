// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/fileless-duplicates.ts
 *
 * GET /api/admin/media/fileless-duplicates
 *
 * Lists unambiguous file-less duplicate pairs (real library file row with no
 * external IDs alongside a TMDB discovery row for the same title). These are
 * behind "request ready → 404". Use POST /api/admin/media/merge to resolve.
 *
 * Auth: admin.  Surface: internal-only.
 * Rate-limited (heavy — full-table scan).
 *
 * Response: { pairs: FilelessDuplicatePair[], total: number }
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { findFilelessDuplicatePairsWithTotal } from '$lib/server/database/queries/admin-media.queries.js';

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const FilelessDuplicatePairSchema = z.object({
    fileId: z.string().guid(),
    fileTitle: z.string(),
    discoveryId: z.string().guid(),
    discoveryTitle: z.string(),
    tmdbId: z.string(),
    mediaType: z.string(),
    year: z.number().nullable(),
});

export const FilelessDuplicatesResponseSchema = z.object({
    pairs: z.array(FilelessDuplicatePairSchema),
    total: z.number().int().nonnegative(),
});

export type FilelessDuplicatesResponse = z.infer<typeof FilelessDuplicatesResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (_event) => {
            // Heavy rate limit applied in the route wrapper (see +server.ts shim).
            // The def itself is mount()-clean; rate limiting is enforced by the
            // withAdminHeavyRateLimit middleware wrapping the GET export.
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { pairs, total } = await findFilelessDuplicatePairsWithTotal(sql);
            return json(FilelessDuplicatesResponseSchema.parse({ pairs, total }));
        },
    },
});
