// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/library-type/[mediaType]/metadata-values.ts
 *
 * GET /api/admin/library-type/[mediaType]/metadata-values?key=<key>
 *
 * Returns distinct non-null values for a custom_metadata key across all items
 * of the given non-entertainment media type. Admin-scoped — no library group
 * or age-rating filter applied.
 *
 * Used to populate autocomplete datalists in ContentEditDrawer / BulkEditBar.
 *
 * Auth:    library:admin
 * Surface: internal
 *
 * Response: { values: string[] }
 * 422 validation_failed on unknown media type or missing key.
 * 503 dependency_unavailable on DB down.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getDistinctMetadataValues } from '$lib/server/database/queries/non-entertainment-browse.queries.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { NON_ENTERTAINMENT_LIBRARY_TYPES } from '$lib/server/utils/media-types.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    request: {
        params: z.object({ mediaType: z.string().min(1) }),
        query: z.object({ key: z.string().min(1) }),
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const mediaType = ctx.input!.params!.mediaType;
            if (!(NON_ENTERTAINMENT_LIBRARY_TYPES as readonly string[]).includes(mediaType)) {
                return ApiProblem.validationFailed('Unknown media type');
            }

            const key = ctx.input!.query!.key;

            // DELIBERATE BYPASS. This endpoint is gated by the `library:admin`
            // scope above, so it reads across every library group and age
            // rating. Declared explicitly via `unrestrictedAccess()` rather than
            // as an omitted/permissive default so the decision is greppable.
            const values = await getDistinctMetadataValues(sql, mediaType, key, {
                access: unrestrictedAccess(),
            });

            return json({ values });
        },
    },
});
