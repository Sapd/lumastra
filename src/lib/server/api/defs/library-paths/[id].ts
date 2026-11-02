// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * library-paths/{id} — per-library-path management.
 *
 * GET    /library-paths/{id}   read one library path     (library:admin)
 * PATCH  /library-paths/{id}   update a library path     (library:admin)
 * DELETE /library-paths/{id}   delete a library path     (library:admin)
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import {
    getLibraryPathById,
    type UpdateLibraryPathParams,
} from '$lib/server/database/queries/library-paths.queries.js';
import {
    deleteLibraryFolder,
    updateLibraryFolder,
} from '$lib/server/services/library-folder.service.js';
import { mapLibraryPathToApi } from '$lib/server/mappers/library-path.mapper.js';
import {
    LibraryPathSchema,
    LibraryPathMutationResponseSchema,
} from '$lib/schemas/api-admin-library-responses.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';

// GET/PATCH return { path: LibraryPath } via mapLibraryPathToApi; the previous
// local schema declared a numeric id and dropped most mapped fields.
const LibraryPathResponseSchema = LibraryPathMutationResponseSchema;

/**
 * Single body schema — used for both the OpenAPI docs and runtime validation so
 * the documented contract can never drift from what mount() actually parses.
 * The v1 surface speaks camelCase; the handler maps to the snake_case
 * UpdateLibraryPathParams the query module requires. `libraryGroupId` reassigns
 * the path to a different library group (a real, FK-backed capability), and
 * `mediaType` reuses the canonical LibraryPathMediaType enum.
 */
const PatchLibraryPathBodySchema = z.object({
    path: z.string().min(1).optional().meta({ description: 'Absolute filesystem path' }),
    enabled: z.boolean().optional().meta({ description: 'Whether the path is enabled' }),
    mediaType: LibraryPathSchema.shape.mediaType
        .optional()
        .meta({ description: 'Media type of the path' }),
    libraryGroupId: z
        .string()
        .guid()
        .optional()
        .meta({ description: 'UUID of the library group to reassign this path to' }),
});

const LibraryPathIdParams = z.object({
    id: z.string().min(1, 'Library path ID is required'),
});

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'Get a library path',
            stability: 'stable',
            auth: 'bearer',
            description: 'Returns a library path by ID. Requires `library:admin` scope.',
            responses: {
                200: { schema: LibraryPathResponseSchema, description: 'Library path' },
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Library path not found',
                500: 'Internal server error',
            },
        },
        PATCH: {
            tags: ['Admin'],
            summary: 'Update a library path',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Updates a library path (enable/disable, reassign group, change folder). The same ' +
                'rules as the admin surface apply: the folder must be an existing absolute path ' +
                'that does not overlap another library folder, the library must stay consistent, ' +
                'and moving a folder out of or into a restricted library also needs `access:admin`. ' +
                'Requires `library:admin` scope.',
            body: PatchLibraryPathBodySchema,
            responses: {
                200: { schema: LibraryPathResponseSchema, description: 'Updated library path' },
                409: 'The folder overlaps or duplicates another library folder',
                422: 'Invalid folder, unknown library group, or library rules not met',
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Library path not found',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Admin'],
            summary: 'Delete a library path',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Removes a library path. The files scanned under it are retired in the background ' +
                '(as if they had been deleted from disk). Refused with 409 while a scan of the ' +
                'folder or an upload into it runs, unless `force=1`, which cancels them first. ' +
                'Requires `library:admin` scope (and `access:admin` for a restricted library).',
            responses: {
                204: 'Library path removed',
                409: 'A scan or upload of the folder is running (retry with force=1)',
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Library path not found',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['library:admin'] },
    request: {
        params: LibraryPathIdParams,
        body: PatchLibraryPathBodySchema,
        query: z.object({
            force: z
                .enum(['1', 'true'])
                .optional()
                .describe('DELETE: cancel running scans/uploads of the folder instead of 409'),
        }),
    },
    handlers: {
        GET: async (event, _ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const id = event.params.id ?? '';
            const path = await getLibraryPathById(db, id);
            if (!path) return ApiProblem.notFound('Library path not found');

            return json({ path: mapLibraryPathToApi(path) });
        },

        PATCH: async (event, ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const id = event.params.id ?? '';

            // Body already validated by mount(); ctx.input!.body is typed + stripped.
            // Map the camelCase wire body onto the snake_case query params. Absent
            // fields stay undefined so the partial-update query preserves them.
            const body = ctx.input!.body;
            const params: UpdateLibraryPathParams = {
                path: body.path,
                enabled: body.enabled,
                media_type: body.mediaType,
                library_group_id: body.libraryGroupId,
            };
            // Same rules and side effects as the admin surface (it used to write
            // the row directly: no group checks, no file re-stamp, no cache clear).
            const result = await updateLibraryFolder(
                db,
                id,
                params,
                event.locals.principal?.scopes,
            );
            if (!result.ok) return result.problem;

            return json({ path: mapLibraryPathToApi(result.value) });
        },

        DELETE: async (event, ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const id = event.params.id ?? '';
            const result = await deleteLibraryFolder(db, id, {
                force: ctx.input!.query?.force !== undefined,
                scopes: event.locals.principal?.scopes,
                actor: event.locals.user?.username ?? event.locals.principal?.username,
            });
            if (!result.ok) return result.problem;

            return new Response(null, { status: 204 });
        },
    },
});
