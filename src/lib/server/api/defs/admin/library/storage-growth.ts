// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/library/storage-growth.ts
 *
 * GET /api/admin/library/storage-growth
 *
 * The library size curve (≤ 120 points, up to two years; the part before the
 * first daily snapshot is reconstructed from current files and flagged
 * approximate) and, per filesystem holding libraries, when it fills at the
 * current pace. Feeds the growth sparkline in the admin home library card.
 *
 * Auth:    admin (route policy `admin`; no token scope reaches it)
 * Surface: internal
 *
 * Response: LibraryStorageGrowth. Cached 15 min across replicas.
 * 503 dependency_unavailable on DB down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { getLibraryStorageGrowth } from '$lib/server/services/library-storage/library-storage-growth.service.js';
import { LibraryStorageGrowthSchema } from '$lib/schemas/admin-library-storage-growth.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            const sql = getAdminDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const growth = await getLibraryStorageGrowth(sql);
            return json(LibraryStorageGrowthSchema.parse(growth), {
                headers: { 'Cache-Control': 'private, no-store' },
            });
        },
    },
});
