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
import { getCatalogResource } from '$lib/server/database/queries/audiobook-catalog.queries.js';
import { ContributorDetailSchema } from '$lib/schemas/api-audiobook.js';
import { resourceDetailQuery, resourceParams } from './catalog-input.js';
export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: { query: resourceDetailQuery, params: resourceParams },
    docs: {
        GET: {
            tags: ['Audiobooks'],
            stability: 'stable',
            summary: 'Get an audiobook narrator',
            auth: 'bearer',
            query: resourceDetailQuery,
            params: resourceParams,
            responses: {
                200: { schema: ContributorDetailSchema, description: 'Audiobook catalog result' },
                404: 'Resource not found',
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
            const options = {
                access,
                viewerId: event.locals.user?.userId ?? null,
                surface: ctx.surface,
            };
            const result = await getCatalogResource(sql, {
                ...options,
                resource: 'narrator',
                id: ctx.input!.params.id,
            });
            if (!result) return ApiProblem.notFound('Resource not found');
            return json(result);
        },
    },
});
