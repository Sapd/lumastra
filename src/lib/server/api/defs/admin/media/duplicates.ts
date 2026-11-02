// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/duplicates.ts
 *
 * GET /api/admin/media/duplicates
 *
 * Returns groups of media items sharing the same TMDB external ID and
 * media type. Up to 50 groups ordered by duplicate count descending.
 *
 * Auth: admin.  Surface: internal-only.
 * Rate-limited (heavy — grouped full-table scan).
 *
 * Response: { duplicates: DuplicateMediaRow[] }
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { findDuplicateMediaItems } from '$lib/server/database/queries/admin-media.queries.js';

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const DuplicateMediaItemSchema = z.object({
    id: z.string().guid(),
    title: z.string(),
    year: z.number().nullable(),
    created_at: z.string(),
});

const DuplicateMediaRowSchema = z.object({
    tmdb_id: z.string(),
    media_type: z.string(),
    items: z.array(DuplicateMediaItemSchema),
});

export const DuplicatesResponseSchema = z.object({
    duplicates: z.array(DuplicateMediaRowSchema),
});

export type DuplicatesResponse = z.infer<typeof DuplicatesResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const duplicates = await findDuplicateMediaItems(sql);
            return json(DuplicatesResponseSchema.parse({ duplicates }));
        },
    },
});
