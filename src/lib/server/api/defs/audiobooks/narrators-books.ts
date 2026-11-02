// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import {
    listCatalogBooks,
    getCatalogResource,
} from '$lib/server/database/queries/audiobook-catalog.queries.js';
import { AudiobookPageSchema } from '$lib/schemas/api-audiobook-preview.js';
import { resourceBooksQuery, resourceParams } from './catalog-input.js';
export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: { query: resourceBooksQuery, params: resourceParams },
    docs: {
        GET: {
            tags: ['Audiobooks'],
            stability: 'stable',
            summary: "List a narrator's audiobooks",
            auth: 'bearer',
            query: resourceBooksQuery,
            params: resourceParams,
            responses: {
                200: { schema: AudiobookPageSchema, description: 'Audiobook catalog result' },
                404: 'Resource not found',
            },
        },
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');
            const input = ctx.input!.query;
            const access = searchAccessBoundary(
                await buildSearchAccessContext(sql, event.locals.user),
            );
            const options = {
                ...input,
                groupId: input.libraryGroupId,
                access,
                viewerId: event.locals.user?.userId ?? null,
                surface: ctx.surface,
            };
            if (
                !(await getCatalogResource(sql, {
                    access,
                    viewerId: options.viewerId,
                    surface: ctx.surface,
                    resource: 'narrator',
                    id: ctx.input!.params.id,
                }))
            )
                return ApiProblem.notFound('Resource not found');
            const result = await listCatalogBooks(sql, {
                ...options,
                narratorId: ctx.input!.params.id,
                sort: input.sort,
                collapse: undefined,
            });
            return json(result);
        },
    },
});
