// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/library-paths-item.ts
 *
 * PATCH  /api/admin/library-paths/[id]   update a library path  (library:admin)
 * DELETE /api/admin/library-paths/[id]   delete a library path  (library:admin)
 *
 * Both handlers delegate to services/library-folder.service.ts, shared with
 * the v1 surface: PATCH validates the folder path, group consistency and the
 * access scope, and re-stamps files on a move; DELETE refuses a busy folder
 * (409, `?force=1` cancels its scans/uploads) and retires the folder's files.
 *
 * Auth:    library:admin
 * Surface: internal
 *
 * Response (PATCH): { path }
 * Response (DELETE 200): { filesToDetach, detachRunId?, scansCancelled, uploadsAborted }
 * 404 not_found when path does not exist.
 * 422 validation_failed on group-consistency errors.
 * 503 dependency_unavailable on DB down.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { libraryPathPatchBodySchema } from '$lib/schemas/admin.js';
import { mapLibraryPathToApi } from '$lib/server/mappers/library-path.mapper.js';
import {
    deleteLibraryFolder,
    updateLibraryFolder,
} from '$lib/server/services/library-folder.service.js';
import { z } from 'zod';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    request: {
        body: libraryPathPatchBodySchema,
        params: z.object({ id: z.string().min(1) }),
        query: z.object({
            force: z
                .enum(['1', 'true'])
                .optional()
                .describe('DELETE: cancel running scans/uploads of the folder instead of 409'),
        }),
    },
    handlers: {
        PATCH: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const result = await updateLibraryFolder(
                sql,
                ctx.input!.params!.id,
                ctx.input!.body,
                event.locals.principal?.scopes,
            );
            if (!result.ok) return result.problem;
            return json({ path: mapLibraryPathToApi(result.value) });
        },

        DELETE: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const result = await deleteLibraryFolder(sql, ctx.input!.params!.id, {
                force: ctx.input!.query?.force !== undefined,
                scopes: event.locals.principal?.scopes,
                actor: event.locals.user?.username ?? event.locals.principal?.username,
            });
            if (!result.ok) return result.problem;
            return json(result.value);
        },
    },
});
