// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DELETE /api/admin/unmatched-files/[id]
 *
 * Soft-dismisses a personal media item so it no longer appears in the
 * unmatched-files list. For series items, recursively dismisses all
 * seasons and episodes too (prevents orphaned children reappearing).
 *
 * Auth: media:admin. Surface: internal.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    dismissMediaItemWithChildren,
    getMediaItemType,
} from '$lib/server/database/queries/media-items.queries.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const ParamsSchema = z.object({
    id: z.string().regex(UUID_RE, 'Invalid UUID'),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    visibility: 'internal',
    request: {
        params: ParamsSchema,
    },
    handlers: {
        DELETE: async (event, ctx) => {
            const { id } = ctx.input!.params;

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            if ((await getMediaItemType(sql, id)) === null) {
                return ApiProblem.notFound('Media item not found');
            }
            const count = await dismissMediaItemWithChildren(sql, id);
            // The item exists but was not dismissed: it has a provider match
            // (possibly identified since the list was loaded). Hiding a matched
            // item is not what this endpoint is for.
            if (count === 0) {
                return ApiProblem.conflict(
                    'This item is matched to a provider and is not an unmatched file.',
                );
            }

            return json({ dismissed: count });
        },
    },
});

export const { DELETE } = mount(def, { surface: 'internal' });
