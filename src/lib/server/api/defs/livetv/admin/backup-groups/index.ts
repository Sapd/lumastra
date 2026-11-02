// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/backup-groups/index.ts
 *
 * GET  /livetv/admin/backup-groups — list all backup groups + ungrouped channels (bare object)
 * POST /livetv/admin/backup-groups — create a new backup group (bare object)
 *
 * Auth: scope livetv:admin (both methods)
 * Mounted on:
 *   /api/admin/livetv/backup-groups          (internal SPA surface)
 *   /api/v1/livetv/admin/backup-groups       (bearer surface)
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    getBackupGroupsForAdmin,
    createBackupGroup,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import { withHealth } from '$lib/server/services/livetv/channel-health.service.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import { CreateBackupGroupRequestSchema } from '$lib/schemas/livetv.js';
import { BackupGroupsAdminResponseSchema, LiveTvAckResponseSchema } from '$lib/schemas/livetv';

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Live TV'],
            summary: 'List backup groups with member channels',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: BackupGroupsAdminResponseSchema,
                    description: 'All backup groups and ungrouped channels',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
        POST: {
            tags: ['Live TV'],
            summary: 'Create a new backup group',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                201: { schema: LiveTvAckResponseSchema, description: 'Backup group created' },
                401: 'Authentication required',
                422: 'Channel already in a backup group',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        // body is declared so mount() validates it for POST;
        // GET never reads a body so the schema is not applied there.
        body: CreateBackupGroupRequestSchema,
    },
    handlers: {
        /**
         * GET /livetv/admin/backup-groups
         *
         * Returns all backup groups with their member channels, plus the list of
         * channels not yet assigned to any backup group.
         * Response: bare object { groups, ungroupedChannels }.
         *
         * 503 dependency_unavailable when the database is not reachable.
         */
        GET: async (_event, _ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const result = await getBackupGroupsForAdmin(sql);

            // Every member carries its feed health; the groups are re-assembled around it.
            const members = await withHealth(sql, [
                ...result.groups.flatMap((g) => g.channels),
                ...result.ungroupedChannels,
            ]);
            const byId = new Map(members.map((m) => [m.id, m]));
            // Bare object: { groups, ungroupedChannels }
            return json({
                groups: result.groups.map((g) => ({
                    ...g,
                    channels: g.channels.map((c) => byId.get(c.id) ?? c),
                })),
                ungroupedChannels: result.ungroupedChannels.map((c) => byId.get(c.id) ?? c),
            });
        },

        /**
         * POST /livetv/admin/backup-groups
         *
         * Creates a new backup group from a set of ungrouped channels (minimum 2).
         * Response: bare object { success: true }.
         *
         * 422 validation_failed when a channel is already in a backup group.
         * 503 dependency_unavailable when the database is not reachable.
         *
         * mount() has already validated ctx.input.body via CreateBackupGroupRequestSchema.
         */
        POST: async (_event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const { channelIds } = ctx.input!.body as { channelIds: string[] };

            try {
                await createBackupGroup(sql, channelIds);
            } catch (err) {
                if (err instanceof Error && err.message.includes('already in a backup group')) {
                    return ApiProblem.validationFailed(err.message);
                }
                throw err;
            }

            await invalidateLiveTvCaches();

            return json({ ok: true as const }, { status: 201 });
        },
    },
});
