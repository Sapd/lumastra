// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /sync/changes: the library delta feed (design:
 * docs/superpowers/specs/2026-10-17-api-package-19-library-delta-sync-design.md, repo root).
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define';
import { ApiProblem } from '$lib/server/api/problem';
import { typedJson } from '$lib/server/utils/typed-response';
import { getDb } from '$lib/server/database/connection';
import { SyncChangesResponseSchema } from '$lib/schemas/api-sync';
import {
    isSyncCredential,
    readSyncChanges,
    SyncReadError,
    syncErrorResponse,
} from '$lib/server/services/sync-changes.service';

const QuerySchema = z
    .object({
        cursor: z
            .string()
            .optional()
            .describe('nextCursor from the previous call. Omit it on the first call.'),
        limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(1000)
            .default(500)
            .describe('Maximum entries per page.'),
    })
    .strict();

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Library sync'],
            summary: 'Changes to the library since a cursor',
            description:
                'Without a cursor: returns a starting page.nextCursor and initialLoad links. Store the cursor first, ' +
                'then load everything through initialLoad, then poll with the cursor. Every entry describes the ' +
                'current state for the caller (upsert or delete). Hydrate catalog upserts with POST /media/batch. ' +
                'Always store page.nextCursor, even on an empty terminal page; call again while page.hasMore is true. 410 means: drop the cursor and reload.',
            stability: 'stable',
            auth: 'bearer',
            query: QuerySchema,
            responses: {
                200: { schema: SyncChangesResponseSchema, description: 'One page of changes' },
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
        GET: async (event, ctx) => {
            if (!event.locals.user || !isSyncCredential(event.locals.principal?.kind, event.url)) {
                return ApiProblem.unauthorized();
            }
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not initialised');
            const parsed = QuerySchema.safeParse(Object.fromEntries(event.url.searchParams));
            if (!parsed.success)
                return ApiProblem.validationFailed('limit must be an integer from 1 to 1000');
            try {
                const result = await readSyncChanges({
                    sql,
                    user: event.locals.user,
                    ...parsed.data,
                    surface: ctx.surface,
                });
                return typedJson(SyncChangesResponseSchema, result, {
                    headers: { 'Cache-Control': 'private, no-store' },
                });
            } catch (error) {
                if (error instanceof SyncReadError) return syncErrorResponse(error);
                throw error;
            }
        },
    },
});
