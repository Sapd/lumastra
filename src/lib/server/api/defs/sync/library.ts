// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /sync/library: initial load of a local library cache. Returns the ids of one catalog
 * kind that are in the library and visible to the caller; the client hydrates them with
 * POST /media/batch, exactly like the upserts of GET /sync/changes.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define';
import { ApiProblem } from '$lib/server/api/problem';
import { typedJson } from '$lib/server/utils/typed-response';
import { getDb } from '$lib/server/database/connection';
import { SyncCatalogKindSchema, SyncLibraryResponseSchema } from '$lib/schemas/api-sync';
import {
    isSyncCredential,
    readSyncLibrary,
    SyncReadError,
    syncErrorResponse,
} from '$lib/server/services/sync-changes.service';

const QuerySchema = z
    .object({
        kind: SyncCatalogKindSchema,
        cursor: z.string().optional().describe('page.nextCursor from the previous page.'),
        limit: z.coerce.number().int().min(1).max(1000).default(1000),
    })
    .strict();

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Library sync'],
            summary: 'Library ids of one kind (initial load)',
            description:
                'Keyset pages of the ids in your library for one kind, in id order. Follow page.nextCursor while page.hasMore is true; when it is false, the snapshot is complete. ' +
                'Then hydrate the ids with POST /media/batch (100 per call). Uses the same visibility rules ' +
                'as GET /sync/changes, so the full load and the delta agree.',
            stability: 'stable',
            auth: 'bearer',
            query: QuerySchema,
            responses: {
                200: { schema: SyncLibraryResponseSchema, description: 'One page of ids' },
                401: 'Authentication required',
                422: 'Invalid query parameter',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },
    auth: { kind: 'user' },
    handlers: {
        GET: async (event) => {
            if (!event.locals.user || !isSyncCredential(event.locals.principal?.kind, event.url)) {
                return ApiProblem.unauthorized();
            }
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not initialised');
            const parsed = QuerySchema.safeParse(Object.fromEntries(event.url.searchParams));
            if (!parsed.success)
                return ApiProblem.validationFailed('kind, cursor or limit is invalid');
            try {
                const result = await readSyncLibrary({
                    sql,
                    user: event.locals.user,
                    ...parsed.data,
                });
                return typedJson(SyncLibraryResponseSchema, result, {
                    headers: { 'Cache-Control': 'private, no-store' },
                });
            } catch (error) {
                if (error instanceof SyncReadError) return syncErrorResponse(error);
                throw error;
            }
        },
    },
});
