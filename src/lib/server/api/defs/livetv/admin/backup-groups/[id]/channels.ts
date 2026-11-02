// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/backup-groups/[id]/channels.ts
 *
 * DELETE /livetv/admin/backup-groups/{groupId}/channels — remove a channel from the group
 * POST   /livetv/admin/backup-groups/{groupId}/channels — add a channel to the group
 *
 * Both return bare object { success: true } on success.
 *
 * Auth: scope livetv:admin (both methods)
 * Mounted on:
 *   /api/admin/livetv/backup-groups/[groupId]/channels        (internal SPA surface)
 *   /api/v1/livetv/admin/backup-groups/{groupId}/channels     (bearer surface)
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    removeChannelFromBackupGroup,
    addChannelToBackupGroup,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { RemoveFromGroupRequestSchema, AddToGroupRequestSchema } from '$lib/schemas/livetv.js';
import { LiveTvAckResponseSchema } from '$lib/schemas/livetv';

// ---------------------------------------------------------------------------
// Combined body schema
// Both operations carry a body with a single channelId UUID field.
// The union lets mount() accept either schema for any body-carrying method.
// Each handler uses the correct narrowed sub-schema.
// ---------------------------------------------------------------------------

const CombinedBodySchema = z.union([RemoveFromGroupRequestSchema, AddToGroupRequestSchema]);

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Live TV'],
            summary: 'Add a channel to a backup group',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: LiveTvAckResponseSchema,
                    description: 'Channel added to backup group',
                },
                401: 'Authentication required',
                404: 'Backup group not found',
                500: 'Internal server error',
            },
        },
        DELETE: {
            tags: ['Live TV'],
            summary: 'Remove a channel from a backup group',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: LiveTvAckResponseSchema,
                    description: 'Channel removed from backup group',
                },
                401: 'Authentication required',
                404: 'Backup group not found',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        body: CombinedBodySchema,
    },
    handlers: {
        /**
         * DELETE /livetv/admin/backup-groups/{groupId}/channels
         *
         * Removes a channel from its backup group.
         * If the removed channel was the primary, auto-promotes the
         * highest-quality remaining channel. Dissolves the group when
         * ≤1 channel remains.
         *
         * mount() has already validated ctx.input.body (channelId is a UUID).
         */
        DELETE: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const groupId = event.params.groupId;
            if (!groupId || !isUuid(groupId)) {
                return ApiProblem.validationFailed('Invalid group ID format');
            }

            const { channelId } = ctx.input!.body as { channelId: string };

            await removeChannelFromBackupGroup(sql, groupId, channelId);

            await invalidateLiveTvCaches();

            return json({ ok: true as const });
        },

        /**
         * POST /livetv/admin/backup-groups/{groupId}/channels
         *
         * Adds an ungrouped channel to the specified backup group.
         * 422 validation_failed when the channel is already in a group or not found.
         *
         * mount() has already validated ctx.input.body (channelId is a UUID).
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

            const { channelId } = ctx.input!.body as { channelId: string };

            try {
                await addChannelToBackupGroup(sql, groupId, channelId);
            } catch (err) {
                if (
                    err instanceof Error &&
                    (err.message.includes('already in a backup group') ||
                        err.message.includes('not found'))
                ) {
                    return ApiProblem.validationFailed(err.message);
                }
                throw err;
            }

            await invalidateLiveTvCaches();

            return json({ ok: true as const });
        },
    },
});
