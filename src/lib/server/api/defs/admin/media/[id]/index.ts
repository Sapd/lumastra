// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/index.ts
 *
 * DELETE /api/admin/media/[id]?cascade=true|false
 *
 * Hard-delete a media item. Without `cascade=true`, refuses (409) when the
 * item has children — callers must delete children first or opt into a
 * recursive cascade. With `cascade=true`, deletes the whole subtree via
 * MediaDeletionService (capped by LUMASTRA_CASCADE_DELETE_MAX).
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { deleted: boolean }
 * Error 409 conflict when child rows exist (no cascade) — `details` is a
 *   JSON string `{ "childCount": N }`, or when the descendant count exceeds
 *   LUMASTRA_CASCADE_DELETE_MAX (cascade requested).
 * Error 404 not_found when the item does not exist.
 * Error 503 dependency_unavailable when the DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    MediaDeletionService,
    CascadeLimitExceededError,
} from '$lib/server/services/media-deletion.service.js';
import { LUMASTRA_CASCADE_DELETE_MAX } from '$lib/server/config.js';

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

export const AdminMediaDeleteResponseSchema = z.object({
    deleted: z.boolean(),
});

export type AdminMediaDeleteResponse = z.infer<typeof AdminMediaDeleteResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: z.object({ cascade: z.enum(['true', 'false']).optional() }),
    },
    handlers: {
        DELETE: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const cascade = ctx.input?.query?.cascade === 'true';

            // Children guard — request-level policy stays in the route.
            const childCount = await MediaDeletionService.countDescendants(sql, internalId);
            if (!cascade) {
                if (childCount > 0) {
                    return ApiProblem.conflict(
                        'Cannot delete media item with children. Delete children first, or retry with cascade.',
                        { details: JSON.stringify({ childCount }) },
                    );
                }
            } else if (childCount > LUMASTRA_CASCADE_DELETE_MAX) {
                return ApiProblem.conflict(
                    `Cascade delete would remove ${childCount} descendants, exceeding the configured limit of ${LUMASTRA_CASCADE_DELETE_MAX}.`,
                    { details: JSON.stringify({ childCount }) },
                );
            }

            // Pass maxDescendants as the in-tx backstop for the cap: the
            // pre-check above races a concurrent child insert, so the delete
            // itself re-enforces the limit and rolls back if exceeded.
            try {
                const result = await MediaDeletionService.hardDelete(sql, internalId, {
                    cascade,
                    maxDescendants: cascade ? LUMASTRA_CASCADE_DELETE_MAX : undefined,
                });
                return json(AdminMediaDeleteResponseSchema.parse({ deleted: result.deleted }));
            } catch (err) {
                if (err instanceof CascadeLimitExceededError) {
                    return ApiProblem.conflict(
                        `Cascade delete would remove ${err.childCount} descendants, exceeding the configured limit of ${LUMASTRA_CASCADE_DELETE_MAX}.`,
                        { details: JSON.stringify({ childCount: err.childCount }) },
                    );
                }
                throw err;
            }
        },
    },
});
