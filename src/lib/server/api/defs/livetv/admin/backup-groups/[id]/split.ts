// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/backup-groups/[id]/split.ts
 *
 * POST /livetv/admin/backup-groups/{groupId}/split
 *   Moves the selected channels out of the existing group into a new backup group.
 *   Response: bare object { success: true }.
 *
 * Auth: scope livetv:admin
 * Mounted on:
 *   /api/admin/livetv/backup-groups/[groupId]/split        (internal SPA surface)
 *   /api/v1/livetv/admin/backup-groups/{groupId}/split     (bearer surface)
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { splitBackupGroup } from '$lib/server/database/queries/livetv-channels.queries.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { SplitGroupRequestSchema } from '$lib/schemas/livetv.js';
import { LiveTvAckResponseSchema } from '$lib/schemas/livetv';

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Live TV'],
            summary: 'Split a backup group by extracting selected channels',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: LiveTvAckResponseSchema,
                    description: 'Backup group split successfully',
                },
                401: 'Authentication required',
                404: 'Backup group not found',
                422: 'At least one channelId required',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        body: SplitGroupRequestSchema,
    },
    handlers: {
        /**
         * POST /livetv/admin/backup-groups/{groupId}/split
         *
         * Splits the specified channels out of groupId into a new backup group.
         * At least one channelId must be provided (enforced by SplitGroupRequestSchema).
         *
         * mount() has already validated ctx.input.body.
         */
        POST: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const groupId = event.params.groupId;
            if (!groupId || !isUuid(groupId)) {
                return ApiProblem.validationFailed('Invalid group ID format');
            }

            const { channelIds } = ctx.input!.body as { channelIds: string[] };

            await splitBackupGroup(sql, groupId, channelIds);

            await invalidateLiveTvCaches();

            return json({ ok: true as const });
        },
    },
});
