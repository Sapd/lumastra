// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { catalogFacets } from '$lib/server/database/queries/audiobook-catalog.queries.js';
import { facetQuery } from './catalog-input.js';
const response = z.object({
    shelves: z.array(z.object({ id: z.string(), name: z.string(), bookCount: z.number().int() })),
    languages: z.array(z.object({ language: z.string(), bookCount: z.number().int() })),
    letterCounts: z.array(z.object({ letter: z.string(), count: z.number().int() })),
});
export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: { query: facetQuery },
    docs: {
        GET: {
            tags: ['Audiobooks'],
            stability: 'beta',
            summary: 'List audiobook filter facets',
            auth: 'bearer',
            query: facetQuery,
            responses: {
                200: { schema: response, description: 'Shelves, languages and letters' },
                401: 'Unauthorized',
            },
        },
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');
            const access = searchAccessBoundary(
                await buildSearchAccessContext(sql, event.locals.user),
            );
            const input = ctx.input!.query;
            return json(
                await catalogFacets(sql, {
                    ...input,
                    groupId: input.libraryGroupId,
                    access,
                    limit: 60,
                    offset: 0,
                    viewerId: event.locals.user?.userId ?? null,
                    surface: ctx.surface,
                }),
            );
        },
    },
});
