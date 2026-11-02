// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/library-groups.ts
 *
 * GET  /api/admin/library-groups   list library groups   (library:admin)
 * POST /api/admin/library-groups   create a library group (library:admin)
 *
 * Auth:    library:admin
 * Surface: internal
 *
 * Response (GET): { items, page }  — full set (no server-side paging)
 * Response (POST 201): { group }
 * 503 dependency_unavailable on DB down.
 *
 * The sibling item route ([id]) lives in defs/admin/library-groups-item.ts.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getAllLibraryGroups,
    getLibraryGroupsWithCounts,
    createLibraryGroup,
} from '$lib/server/database/queries/library-groups.queries.js';
import { libraryGroupCreateBodySchema } from '$lib/schemas/admin.js';
import { afterLibraryGroupChanged } from '$lib/server/services/library-path-sync.service.js';
import { libraryGroupWithImages } from '$lib/server/mappers/library-group.mapper.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    request: {
        body: libraryGroupCreateBodySchema,
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            // The LIST comes from getAllLibraryGroups; counts are merged in by
            // id. getLibraryGroupsWithCounts alone is not a list of libraries:
            // its HAVING drops every group without items, so a library created a
            // minute ago (or whose folders are all empty) vanished from the
            // admin page that is supposed to manage it. Admin-scoped: no
            // denied-group / age-rating filter.
            const [rows, counted] = await Promise.all([
                getAllLibraryGroups(sql),
                getLibraryGroupsWithCounts(sql),
            ]);
            const countById = new Map(counted.map((c) => [c.id, c.item_count]));
            const items = await Promise.all(
                rows.map((row) =>
                    libraryGroupWithImages(sql, ctx.surface, row, countById.get(row.id) ?? 0),
                ),
            );
            return json(
                paginate(items, {
                    limit: items.length,
                    offset: 0,
                    hasMore: false,
                    total: items.length,
                }),
            );
        },

        POST: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const created = await createLibraryGroup(sql, ctx.input!.body);
            await afterLibraryGroupChanged();

            return json(
                { group: await libraryGroupWithImages(sql, ctx.surface, created) },
                { status: 201 },
            );
        },
    },
});
