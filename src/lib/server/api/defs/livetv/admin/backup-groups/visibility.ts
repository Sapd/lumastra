// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/backup-groups/visibility.ts
 *
 * PUT /livetv/admin/backup-groups/visibility
 *   Takes whole stations (backup groups) off air — every feed hidden — or puts
 *   them on air: one feed per group shown (the primary, or the best feed when the
 *   primary is degraded or gone from the playlist), the rest hidden. Since viewers
 *   fall back to the next visible feed, hiding one feed no longer removes a
 *   station; this is the one action per station. One statement for all groups.
 *   Response: { ok: true, groups }.
 *
 * Auth: scope livetv:admin
 * Mounted on:
 *   /api/admin/livetv/backup-groups/visibility        (internal SPA surface)
 *   /api/v1/livetv/admin/backup-groups/visibility     (bearer surface)
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { setBackupGroupsOnAir } from '$lib/server/database/queries/livetv-channels.queries.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { SetGroupsOnAirRequestSchema } from '$lib/schemas/livetv.js';
import { SetGroupsOnAirResponseSchema } from '$lib/schemas/livetv';

const logger = Logger.for('BackupGroupVisibility');

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        PUT: {
            tags: ['Live TV'],
            summary: 'Take backup groups (stations) off air or put them on air',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: SetGroupsOnAirResponseSchema,
                    description: 'Groups updated',
                },
                401: 'Authentication required',
                422: 'groupIds must hold 1–10,000 group UUIDs',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    request: {
        body: SetGroupsOnAirRequestSchema,
    },
    handlers: {
        /** mount() has already validated ctx.input.body. */
        PUT: async (_event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const { groupIds, onAir } = ctx.input!.body as { groupIds: string[]; onAir: boolean };
            const groups = await setBackupGroupsOnAir(sql, groupIds, onAir);
            if (onAir && groups < groupIds.length) {
                // Unknown groups, or groups whose feeds are all in a hidden
                // category or gone from the playlist: left as they were.
                logger.warn('Some backup groups could not go on air', {
                    requested: groupIds.length,
                    onAir: groups,
                });
            }

            await invalidateLiveTvCaches();

            return json({ ok: true as const, groups });
        },
    },
});
