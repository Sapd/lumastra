// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * library-paths/ — library-path management collection.
 *
 * GET  /library-paths   list all library paths   (library:admin)
 * POST /library-paths   add a library path        (library:admin)
 */

import { resolveLibraryLanguage } from '$lib/server/services/library-language.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import {
    getAllLibraryPaths,
    createLibraryPath,
    validateGroupConsistency,
    validateGroupProviderConsistency,
} from '$lib/server/database/queries/library-paths.queries.js';
import { getLibraryGroupById } from '$lib/server/database/queries/library-groups.queries.js';
import { afterLibraryPathChanged } from '$lib/server/services/library-path-sync.service.js';
import { mapLibraryPathToApi } from '$lib/server/mappers/library-path.mapper.js';
import {
    LibraryPathSchema,
    LibraryPathsResponseSchema,
    LibraryPathMutationResponseSchema,
} from '$lib/schemas/api-admin-library-responses.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { checkLibraryRootForApi } from '$lib/server/services/library-root-validation.js';

/**
 * Single body schema — used both for OpenAPI docs and runtime validation so
 * the documented contract can never drift from what mount() actually parses.
 * The v1 surface speaks camelCase; the handler maps to the snake_case
 * CreateLibraryPathParams the query module requires.
 */
const CreateLibraryPathBodySchema = z.object({
    path: z.string().min(1).meta({ description: 'Absolute filesystem path' }),
    libraryGroupId: z
        .string()
        .guid()
        .meta({ description: 'UUID of the library group this path belongs to' }),
    // Reuse the canonical media-type enum from the response schema so the
    // accepted values stay in lockstep with LibraryPathMediaType.
    mediaType: LibraryPathSchema.shape.mediaType.meta({
        description: 'Media type of the path — must match the other paths in the group',
    }),
    enabled: z
        .boolean()
        .optional()
        .meta({ description: 'Whether the path starts enabled. Default: true' }),
});

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Admin'],
            summary: 'List library paths',
            // Disambiguate from the public GET /library/paths — both camelCase to
            // getLibraryPaths in the combined type-gen doc. This internal route takes
            // the suffixed id; the public one keeps getLibraryPaths for clients.
            operationId: 'getLibraryPathsInternal',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns all configured library media paths. Requires `library:admin` scope.',
            responses: {
                200: { schema: LibraryPathsResponseSchema, description: 'Library paths' },
                401: 'Authentication required',
                403: 'Insufficient scope',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Admin'],
            summary: 'Add a library path',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Adds a new filesystem path to the library. Requires `library:admin` scope.',
            body: CreateLibraryPathBodySchema,
            responses: {
                201: {
                    schema: LibraryPathMutationResponseSchema,
                    description: 'Library path added',
                },
                422: 'Validation error — malformed body, unknown library group, or mixed media types in group',
                401: 'Authentication required',
                403: 'Insufficient scope',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['library:admin'] },
    request: {
        body: CreateLibraryPathBodySchema,
    },
    handlers: {
        GET: async (_event, _ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            const paths = await getAllLibraryPaths(db);
            const items = paths.map(mapLibraryPathToApi);
            return json(paginate(items, { limit: items.length, offset: 0, hasMore: false }));
        },

        POST: async (_event, ctx) => {
            const db = getDb();
            if (!db) return ApiProblem.dependencyUnavailable('Database not available');

            // Body already validated by mount(); ctx.input!.body is typed + stripped.
            const body = ctx.input!.body;

            // Same semantic checks as the admin surface (defs/admin/library-paths.ts):
            // the group must exist and must not end up mixing media types.
            const group = await getLibraryGroupById(db, body.libraryGroupId);
            if (!group) return ApiProblem.validationFailed('Library group not found');

            const groupError = await validateGroupConsistency(
                db,
                body.libraryGroupId,
                body.mediaType,
            );
            if (groupError) return ApiProblem.validationFailed(groupError);

            // This surface has no `provider`/`fallbackProviders` field on its wire
            // body — every path created through it ends up 'tmdb' with no
            // fallbacks (createLibraryPath's own defaults) — so the consistency
            // check runs against those same fixed values rather than the group's
            // existing folders.
            const providerError = await validateGroupProviderConsistency(
                db,
                body.libraryGroupId,
                'tmdb',
                [],
            );
            if (providerError) return ApiProblem.validationFailed(providerError);

            const checked = await checkLibraryRootForApi(db, body.path);
            if ('problem' in checked) return checked.problem;

            // Map the camelCase wire body onto the snake_case query params.
            const created = await createLibraryPath(db, {
                path: checked.path,
                media_type: body.mediaType,
                language: resolveLibraryLanguage(undefined),
                library_group_id: body.libraryGroupId,
                enabled: body.enabled,
            });

            await afterLibraryPathChanged(db);

            return json({ path: mapLibraryPathToApi(created) }, { status: 201 });
        },
    },
});
