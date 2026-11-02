// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * library-groups/ — library-group management collection.
 *
 * GET  /library-groups   list all library groups   (library:admin)
 * POST /library-groups   create a library group    (library:admin)
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import {
    getAllLibraryGroups,
    createLibraryGroup,
    type CreateLibraryGroupParams,
} from '$lib/server/database/queries/library-groups.queries.js';
import { libraryGroupWithImages } from '$lib/server/mappers/library-group.mapper.js';
import {
    LibraryGroupsResponseSchema,
    LibraryGroupMutationResponseSchema,
} from '$lib/schemas/api-admin-library-responses.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';

/**
 * Single body schema — used for both the OpenAPI docs and runtime validation so
 * the documented contract can never drift from what mount() actually parses.
 * The v1 surface speaks camelCase; the handler maps to the snake_case
 * CreateLibraryGroupParams the query module requires. `name` and `displayName`
 * share the 128-char cap enforced by the `library_groups` columns; `displayName`
 * is optional and defaults to `name` server-side when omitted.
 */
const CreateLibraryGroupBodySchema = z.object({
    name: z.string().min(1).max(128).meta({ description: 'Internal library group name' }),
    displayName: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .meta({ description: 'Human-facing label. Defaults to `name` when omitted.' }),
    sortOrder: z
        .number()
        .int()
        .optional()
        .meta({ description: 'Ordering weight among library groups. Default: 0' }),
});

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'List library groups',
            stability: 'stable',
            auth: 'bearer',
            description: 'Returns all library groups. Requires `library:admin` scope.',
            responses: {
                200: { schema: LibraryGroupsResponseSchema, description: 'Library groups' },
                401: 'Authentication required',
                403: 'Insufficient scope',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Admin'],
            summary: 'Create a library group',
            stability: 'stable',
            auth: 'bearer',
            description: 'Creates a new library group. Requires `library:admin` scope.',
            body: CreateLibraryGroupBodySchema,
            responses: {
                201: {
                    schema: LibraryGroupMutationResponseSchema,
                    description: 'Library group created',
                },
                400: 'Validation error or name conflict',
                401: 'Authentication required',
                403: 'Insufficient scope',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['library:admin'] },
    request: {
        body: CreateLibraryGroupBodySchema,
    },
    handlers: {
        GET: async (_event, ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const groups = await getAllLibraryGroups(db);
            const items = await Promise.all(
                groups.map((row) => libraryGroupWithImages(db, ctx.surface, row)),
            );
            return json(paginate(items, { limit: items.length, offset: 0, hasMore: false }));
        },

        POST: async (_event, ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            // Body already validated by mount(); ctx.input!.body is typed + stripped.
            // Map the camelCase wire body onto the snake_case query params.
            const body = ctx.input!.body;
            const params: CreateLibraryGroupParams = {
                name: body.name,
                display_name: body.displayName,
                sort_order: body.sortOrder,
            };
            const group = await createLibraryGroup(db, params);
            if (!group) return ApiProblem.conflict('Library group could not be created');

            return json(
                { group: await libraryGroupWithImages(db, ctx.surface, group) },
                { status: 201 },
            );
        },
    },
});
