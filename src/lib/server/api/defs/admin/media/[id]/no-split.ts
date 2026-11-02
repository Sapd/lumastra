// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/no-split.ts
 *
 * PATCH /api/admin/media/[id]/no-split  — set/clear the "single act, do not
 *                                          split" flag on an artist row.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Body:     { noSplit: boolean }
 * Response: { id, noSplit }
 * 404 when the id is not an active artist; 503 when the DB is down.
 *
 * The flag lives at `media_items.custom_metadata.no_split` and is honored by the
 * scanner's collaboration-merge pass (`findCollaborationArtists` excludes flagged
 * rows). It is the operator escape hatch for names where "&"/"und" is part of a
 * single act's identity ("Above & Lanterns") rather than a real collaboration.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { setArtistNoSplit } from '$lib/server/database/queries/artist-merge.queries.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

export const NoSplitResponseSchema = z.object({
    id: z.string().guid(),
    noSplit: z.boolean(),
});

export type NoSplitResponse = z.infer<typeof NoSplitResponseSchema>;

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: z.object({
            noSplit: z.boolean(),
        }),
    },
    handlers: {
        PATCH: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId || !UUID_RE.test(internalId)) {
                return ApiProblem.notFound('Artist not found');
            }

            const noSplit = ctx.input!.body.noSplit;
            const updated = await setArtistNoSplit(sql, internalId, noSplit);
            if (!updated) return ApiProblem.notFound('Artist not found');

            return json(NoSplitResponseSchema.parse({ id: internalId, noSplit }));
        },
    },
});
