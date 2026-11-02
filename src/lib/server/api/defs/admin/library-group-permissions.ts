// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/library-group-permissions.ts
 *
 * GET /api/admin/library-group-permissions   list all permissions  (access:admin)
 * PUT /api/admin/library-group-permissions   upsert permission     (access:admin)
 *
 * PUT with allowed_groups=[] removes the permission row entirely.
 *
 * Auth:    access:admin
 * Surface: internal
 *
 * Response (GET): { permissions: [{ libraryGroupId, allowedGroups }] }
 * Response (PUT): 204 empty
 * 503 dependency_unavailable on DB down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getAllLibraryGroupPermissions,
    upsertLibraryGroupPermission,
    deleteLibraryGroupPermission,
} from '$lib/server/database/queries/library-group-permissions.queries.js';
import { getLibraryGroupById } from '$lib/server/database/queries/library-groups.queries.js';
import { broadcastPermissionsInvalidation } from '$lib/server/cache/library-group-permissions-cache.js';
import { libraryGroupPermissionBodySchema } from '$lib/schemas/admin.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['access:admin'] },
    visibility: 'internal',
    request: {
        body: libraryGroupPermissionBodySchema,
    },
    handlers: {
        GET: async (_event, _ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const rows = await getAllLibraryGroupPermissions(sql);
            const permissions = rows.map((r) => ({
                libraryGroupId: r.library_group_id,
                allowedGroups: r.allowed_groups,
            }));
            return json({ permissions });
        },

        PUT: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { library_group_id } = ctx.input!.body;
            // Trim, drop blanks and case-insensitive duplicates (the cache
            // compares lowercased): `[" "]` used to store a restriction no
            // group can satisfy, and `Kids`/`kids` were kept as two entries.
            const seen = new Set<string>();
            const allowed_groups = ctx
                .input!.body.allowed_groups.map((g) => g.trim())
                .filter((g) => {
                    const key = g.toLowerCase();
                    if (!g || seen.has(key)) return false;
                    seen.add(key);
                    return true;
                });

            // An unknown group id used to surface as a 500 (FK violation) on
            // save, or as a silent 204 when clearing.
            if (!(await getLibraryGroupById(sql, library_group_id))) {
                return ApiProblem.notFound('Library group not found');
            }

            if (allowed_groups.length === 0) {
                await deleteLibraryGroupPermission(sql, library_group_id);
            } else {
                await upsertLibraryGroupPermission(sql, {
                    libraryGroupId: library_group_id,
                    allowedGroups: allowed_groups,
                });
            }

            broadcastPermissionsInvalidation();
            auditLog(
                'library_group.update_permissions',
                String(library_group_id),
                auditActor(event),
                {
                    libraryGroupId: library_group_id,
                    allowedGroups: allowed_groups,
                },
            );

            return new Response(null, { status: 204 });
        },
    },
});
