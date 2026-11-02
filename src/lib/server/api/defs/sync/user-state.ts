// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /sync/user-state: initial load of the caller's own state for library sync. Same
 * projection and visibility rules as the per-user entries of GET /sync/changes.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define';
import { ApiProblem } from '$lib/server/api/problem';
import { typedJson } from '$lib/server/utils/typed-response';
import { getDb } from '$lib/server/database/connection';
import { SyncUserKindSchema, SyncUserStateResponseSchema } from '$lib/schemas/api-sync';
import {
    isSyncCredential,
    readSyncUserState,
    SyncReadError,
    syncErrorResponse,
} from '$lib/server/services/sync-changes.service';

const QuerySchema = z
    .object({
        kind: SyncUserKindSchema,
        cursor: z.string().optional().describe('page.nextCursor from the previous page.'),
        limit: z.coerce.number().int().min(1).max(500).default(500),
    })
    .strict();

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Library sync'],
            summary: 'Your current state of one kind (initial load)',
            description:
                'Keyset pages of watch state, listening counters, explicit ratings, watchlist entries or ' +
                'playlists. Follow page.nextCursor while page.hasMore is true; when it is false, the snapshot is complete. Each item sets exactly the field named after the kind.',
            stability: 'stable',
            auth: 'bearer',
            query: QuerySchema,
            responses: {
                200: { schema: SyncUserStateResponseSchema, description: 'One page of state' },
                401: 'Authentication required',
                410: 'Resync required: `reason` is cursor_expired, access_changed, log_reset or invalid_cursor. Drop the cursor and run the initial load again.',
                422: 'Invalid query parameter or malformed cursor',
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
                const result = await readSyncUserState({
                    sql,
                    user: event.locals.user,
                    ...parsed.data,
                });
                return typedJson(SyncUserStateResponseSchema, result, {
                    headers: { 'Cache-Control': 'private, no-store' },
                });
            } catch (error) {
                if (error instanceof SyncReadError) return syncErrorResponse(error);
                throw error;
            }
        },
    },
});
