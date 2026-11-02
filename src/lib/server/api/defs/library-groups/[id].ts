// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * library-groups/{id} — per-library-group management.
 *
 * GET    /library-groups/{id}   read one library group     (library:admin)
 * PATCH  /library-groups/{id}   update a library group     (library:admin)
 * DELETE /library-groups/{id}   delete a library group     (library:admin)
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import {
    getLibraryGroupById,
    updateLibraryGroup,
    type UpdateLibraryGroupParams,
} from '$lib/server/database/queries/library-groups.queries.js';
import { libraryGroupWithImages } from '$lib/server/mappers/library-group.mapper.js';
import { LibraryGroupMutationResponseSchema } from '$lib/schemas/api-admin-library-responses.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { deleteLibraryGroupChecked } from '$lib/server/services/library-folder.service.js';

// GET/PATCH return { group: LibraryGroupData } via libraryGroupWithImages; the
// previous local schema declared a numeric id + displayName the raw row never
// emitted. Reuse the canonical mutation-response schema.
const LibraryGroupResponseSchema = LibraryGroupMutationResponseSchema;

/**
 * Single body schema — used for both the OpenAPI docs and runtime validation so
 * the documented contract can never drift from what mount() actually parses.
 * All fields optional (partial update); the handler maps camelCase → the
 * snake_case UpdateLibraryGroupParams. `name`/`displayName` share the 128-char
 * cap enforced by the `library_groups` columns.
 */
const PatchLibraryGroupBodySchema = z.object({
    name: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .meta({ description: 'Internal library group name' }),
    displayName: z.string().min(1).max(128).optional().meta({ description: 'Human-facing label' }),
    sortOrder: z
        .number()
        .int()
        .optional()
        .meta({ description: 'Ordering weight among library groups' }),
});

// UUID lookup validation stays in the handlers: mount schema failures are 422,
// while a malformed resource identifier must preserve the documented 404.
const LibraryGroupIdParams = z.object({
    id: z.string().min(1, 'Library group ID is required'),
});

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'Get a library group',
            stability: 'stable',
            auth: 'bearer',
            description: 'Returns a library group by ID. Requires `library:admin` scope.',
            responses: {
                200: { schema: LibraryGroupResponseSchema, description: 'Library group' },
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Library group not found',
                500: 'Internal server error',
            },
        },
        PATCH: {
            tags: ['Admin'],
            summary: 'Update a library group',
            stability: 'stable',
            auth: 'bearer',
            description: 'Updates a library group. Requires `library:admin` scope.',
            body: PatchLibraryGroupBodySchema,
            responses: {
                200: { schema: LibraryGroupResponseSchema, description: 'Updated library group' },
                422: 'Validation failed',
                409: 'Library group conflicts with an existing group',
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Library group not found',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Admin'],
            summary: 'Delete a library group',
            stability: 'stable',
            auth: 'bearer',
            description: 'Deletes a library group. Requires `library:admin` scope.',
            responses: {
                204: 'Library group deleted',
                401: 'Authentication required',
                403: 'Insufficient scope',
                404: 'Library group not found',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['library:admin'] },
    request: {
        params: LibraryGroupIdParams,
        body: PatchLibraryGroupBodySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            const id = event.params.id ?? '';
            if (!UUID_RE.test(id)) return ApiProblem.notFound('Library group not found');

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');
            const group = await getLibraryGroupById(db, id);
            if (!group) return ApiProblem.notFound('Library group not found');

            return json({ group: await libraryGroupWithImages(db, ctx.surface, group) });
        },

        PATCH: async (event, ctx) => {
            const id = event.params.id ?? '';
            if (!UUID_RE.test(id)) return ApiProblem.notFound('Library group not found');

            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            // Body already validated by mount(); ctx.input!.body is typed + stripped.
            // Map the camelCase wire body onto the snake_case query params. Absent
            // fields stay undefined so the partial-update query preserves them.
            const body = ctx.input!.body;
            const params: UpdateLibraryGroupParams = {
                name: body.name,
                display_name: body.displayName,
                sort_order: body.sortOrder,
            };
            const updated = await updateLibraryGroup(db, id, params);
            if (!updated) return ApiProblem.notFound('Library group not found');

            return json({ group: await libraryGroupWithImages(db, ctx.surface, updated) });
        },

        DELETE: async (event, _ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            // Same rules as the admin surface: 409 while it has folders, and
            // access:admin for a restricted library (its permission row goes).
            const id = event.params.id ?? '';
            const result = await deleteLibraryGroupChecked(db, id, event.locals.principal?.scopes);
            if (!result.ok) return result.problem;

            return new Response(null, { status: 204 });
        },
    },
});
