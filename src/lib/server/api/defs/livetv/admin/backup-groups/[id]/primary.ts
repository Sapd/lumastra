// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/backup-groups/[id]/primary.ts
 *
 * PUT /livetv/admin/backup-groups/{groupId}/primary
 *   Makes a member channel the group's primary: the feed viewers get while it is
 *   visible (otherwise they get the group's best visible feed).
 *   Response: bare object { ok: true }.
 *
 * Auth: scope livetv:admin
 * Mounted on:
 *   /api/admin/livetv/backup-groups/[groupId]/primary        (internal SPA surface)
 *   /api/v1/livetv/admin/backup-groups/{groupId}/primary     (bearer surface)
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { setBackupGroupPrimary } from '$lib/server/database/queries/livetv-channels.queries.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { SetGroupPrimaryRequestSchema } from '$lib/schemas/livetv.js';
import { LiveTvAckResponseSchema } from '$lib/schemas/livetv';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        PUT: {
            tags: ['Live TV'],
            summary: "Set a backup group's primary feed",
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: LiveTvAckResponseSchema,
                    description: 'Primary updated',
                },
                401: 'Authentication required',
                404: 'Backup group not found, or the channel is not one of its feeds',
                422: 'Invalid group or channel ID',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        body: SetGroupPrimaryRequestSchema,
    },
    handlers: {
        /** mount() has already validated ctx.input.body. */
        PUT: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const groupId = event.params.groupId;
            if (!groupId || !isUuid(groupId)) {
                return ApiProblem.validationFailed('Invalid group ID format');
            }

            const { channelId } = ctx.input!.body as { channelId: string };
            const result = await setBackupGroupPrimary(sql, groupId, channelId);
            if (result === 'not-member') {
                return ApiProblem.notFound('Channel is not a feed of this backup group');
            }

            await invalidateLiveTvCaches();

            return json({ ok: true as const });
        },
    },
});
