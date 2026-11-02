// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/ai/watch-history-count
 *
 * Admin endpoint: returns watch-history rating statistics from the main DB.
 *
 * Response: bare object via json() + problem+json errors
 * incl. 503 dependency_unavailable when the DB is down.
 *
 * Auth: admin. Surface: internal.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database';
import { getWatchHistoryStats } from '$lib/server/database/queries/ai-admin.queries.js';

const WatchHistoryCountResponseSchema = z.object({
    count: z.number(),
    users: z.number().optional(),
    source: z.string().optional(),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is not available');
            }

            const stats = await getWatchHistoryStats(sql);

            return json(
                WatchHistoryCountResponseSchema.parse({
                    count: stats.ratingsCount,
                    users: stats.usersWithRatings,
                    source: 'user_ratings',
                }),
            );
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
