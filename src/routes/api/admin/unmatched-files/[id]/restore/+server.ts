// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/unmatched-files/[id]/restore
 *
 * Undo for "Remove from library" (DELETE /api/admin/unmatched-files/[id]):
 * puts the item and every descendant the removal hid back into the catalogue,
 * so it shows up in browse and in the Never-matched list again.
 *
 * Auth: media:admin. Surface: internal.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { restoreDismissedMediaItemWithChildren } from '$lib/server/database/queries/unmatched-files.queries.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

const ParamsSchema = z.object({
    id: z.string().regex(UUID_RE, 'Invalid UUID'),
});

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    visibility: 'internal',
    request: {
        params: ParamsSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const { id } = ctx.input!.params;

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const count = await restoreDismissedMediaItemWithChildren(sql, id);
            if (count === 0) return ApiProblem.notFound('No removed media item with this id');

            return json({ restored: count });
        },
    },
});

export const { POST } = mount(def, { surface: 'internal' });
