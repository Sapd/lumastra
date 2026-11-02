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
import { listCatalogResources } from '$lib/server/database/queries/audiobook-catalog.queries.js';
import { ContributorPageSchema } from '$lib/schemas/api-audiobook.js';
import { resourceQuery } from './catalog-input.js';
export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: { query: resourceQuery },
    docs: {
        GET: {
            tags: ['Audiobooks'],
            stability: 'stable',
            summary: 'List audiobook narrators',
            auth: 'bearer',
            query: resourceQuery,
            responses: {
                200: { schema: ContributorPageSchema, description: 'Audiobook catalog result' },
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
                sort: undefined,
                access,
                viewerId: event.locals.user?.userId ?? null,
                surface: ctx.surface,
            };
            const result = await listCatalogResources(sql, {
                ...options,
                resource: 'narrator',
                resourceSort: input.sort,
            });
            return json(result);
        },
    },
});
