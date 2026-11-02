// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/livetv/admin/channels/renumber.ts — POST /livetv/admin/channels/renumber
 *
 * "Renumber in current order": numbers every station again in the order the
 * lineup has now (category order, then channel order): 1, 2, 3 …, or each
 * category from its "Numbers start at". Pinned numbers stay and are skipped;
 * hidden channels give their unpinned number up. Viewers' learned numbers
 * change, so the admin UI confirms first.
 * Design: docs/superpowers/specs/2026-10-16-livetv-channel-numbers-design.md.
 *
 * Auth: { kind: 'scope', anyOf: ['livetv:admin'] }
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { RenumberChannelsResponseSchema } from '$lib/schemas/livetv.js';
import { renumberChannels } from '$lib/server/services/livetv/channel-numbers.service.js';
import { invalidateLiveTvCaches } from '$lib/server/services/livetv-cache.service.js';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        POST: {
            tags: ['Live TV'],
            summary: 'Renumber the lineup in its current order',
            stability: 'experimental',
            auth: 'bearer',
            description:
                'Numbers every station again in the current lineup order (each category from ' +
                'its numberStart when set). Pinned numbers stay. Changes the numbers viewers know.',
            responses: {
                200: { schema: RenumberChannelsResponseSchema, description: 'Lineup renumbered' },
                401: 'Authentication required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['livetv:admin'] },
    visibility: 'internal',
    handlers: {
        POST: async () => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const numbered = await renumberChannels(sql);
            await invalidateLiveTvCaches();
            return json({ numbered });
        },
    },
});
