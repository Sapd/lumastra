// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/library-groups-item.ts
 *
 * PATCH  /api/admin/library-groups/[id]   update a library group  (library:admin)
 * DELETE /api/admin/library-groups/[id]   delete a library group  (library:admin)
 *
 * Auth:    library:admin
 * Surface: internal
 *
 * Response (PATCH): { group }
 * Response (DELETE 204): empty
 * 404 not_found when group does not exist.
 * 503 dependency_unavailable on DB down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getLibraryGroupById,
    updateLibraryGroup,
} from '$lib/server/database/queries/library-groups.queries.js';
import { libraryGroupPatchBodySchema } from '$lib/schemas/admin.js';
import { afterLibraryGroupChanged } from '$lib/server/services/library-path-sync.service.js';
import { libraryGroupWithImages } from '$lib/server/mappers/library-group.mapper.js';
import { deleteLibraryGroupChecked } from '$lib/server/services/library-folder.service.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { z } from 'zod';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    request: {
        body: libraryGroupPatchBodySchema,
        params: z.object({ id: z.string().min(1) }),
    },
    handlers: {
        PATCH: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const id = ctx.input!.params!.id;
            if (!UUID_RE.test(id)) return ApiProblem.notFound('Library group not found');

            const oldGroup = await getLibraryGroupById(sql, id);
            if (!oldGroup) return ApiProblem.notFound('Library group not found');

            const updated = await updateLibraryGroup(sql, id, ctx.input!.body);
            if (!updated) return ApiProblem.notFound('Library group not found');

            await afterLibraryGroupChanged();

            return json({ group: await libraryGroupWithImages(sql, ctx.surface, updated) });
        },

        DELETE: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const result = await deleteLibraryGroupChecked(
                sql,
                ctx.input!.params!.id,
                event.locals.principal?.scopes,
            );
            if (!result.ok) return result.problem;
            return new Response(null, { status: 204 });
        },
    },
});
