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
import { listCatalogBooks } from '$lib/server/database/queries/audiobook-catalog.queries.js';
import { AudiobookPageSchema } from '$lib/schemas/api-audiobook-preview.js';
import { bookQuery } from './catalog-input.js';
export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: { query: bookQuery },
    docs: {
        GET: {
            tags: ['Audiobooks'],
            stability: 'stable',
            summary: 'List audiobooks',
            auth: 'bearer',
            query: bookQuery,
            responses: {
                200: {
                    schema: AudiobookPageSchema,
                    description: 'Audiobook previews and pagination',
                },
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
            return json(
                await listCatalogBooks(sql, {
                    ...ctx.input!.query,
                    groupId: ctx.input!.query.libraryGroupId,
                    access,
                    viewerId: event.locals.user?.userId ?? null,
                    surface: ctx.surface,
                }),
            );
        },
    },
});
