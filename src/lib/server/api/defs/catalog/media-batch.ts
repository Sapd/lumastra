// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { hydrateMediaPreviews } from '$lib/server/services/media-preview-batch.service.js';
import { MediaPreviewSchema } from '$lib/schemas/api-media-preview.js';
import { MediaDetailResponseSchema } from './media-id.js';

export const MediaBatchBodySchema = z.object({
    ids: z
        .array(
            z.string().trim().min(1).max(200),
        )
        .min(1)
        .max(100),
    include: z.enum(['preview', 'detail']).optional(),
});
export const MediaBatchResponseSchema = z.object({
    items: z.array(
        z.union([
            // Reuse the exact GET detail contract before adding the batch revision.
            ...MediaDetailResponseSchema.options.map((schema) =>
                schema.extend({ revision: z.string() }),
            ),
            MediaPreviewSchema,
        ]),
    ),
    missing: z.array(z.string()),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',
    request: { body: MediaBatchBodySchema },
    docs: {
        POST: {
            tags: ['Media'],
            summary: 'Hydrate a batch of media handles',
            description:
                'Lookup up to 100 UUIDs or provider handles. Two-part TMDB handles (tmdb:550) resolve movie first, then series. Items follow request order; duplicates collapse. Unknown, unresolvable and inaccessible handles are indistinguishable in missing. Every item has an opaque revision including image revisions. include=detail (at most 25 ids) uses the default GET /media/{id} shape; kinds not served by that endpoint are missing.',
            stability: 'beta',
            auth: 'bearer',
            body: MediaBatchBodySchema,
            responses: {
                200: {
                    schema: MediaBatchResponseSchema,
                    description: 'Hydrated items and missing handles',
                },
                401: 'Authentication required',
                422: 'Expected 1..100 non-empty IDs (at most 25 with include=detail) and preview or detail include',
                503: 'Database unavailable',
            },
        },
    },
    handlers: {
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const user = event.locals.user!;
            const access = searchAccessBoundary(await buildSearchAccessContext(sql, user));
            const body = ctx.input!.body;
            // Detail mode runs one full detail build per id; keep the per-request cost bounded.
            if (body.include === 'detail' && body.ids.length > 25) {
                return ApiProblem.validationFailed([
                    { field: 'ids', message: 'include=detail accepts at most 25 ids' },
                ]);
            }
            return json(
                await hydrateMediaPreviews(
                    { sql, user, access, surface: ctx.surface },
                    body.ids,
                    body,
                ),
            );
        },
    },
});
