// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/episode-thumbnails/regenerate.ts
 *
 * POST /api/admin/media/[id]/episode-thumbnails/regenerate
 *
 * Queues episode thumbnail regeneration for a series, season, or episode.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { runId: string, message: string, deduped?: boolean }
 */

import {
    RegenerateBodySchema,
    RegenerateResponseSchema,
} from '$lib/schemas/admin-image-extraction.js';
export {
    RegenerateBodySchema,
    RegenerateResponseSchema,
    type RegenerateResponse,
} from '$lib/schemas/admin-image-extraction.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { getDb } from '$lib/server/database/connection.js';
import { getMediaItemForImageSync } from '$lib/server/database/queries/image-sync.queries.js';
import {
    captureExplicitEpisodeThumbnailInput,
    explicitEpisodeThumbnailReviewToken,
} from '$lib/server/services/explicit-episode-thumbnail.service.js';

// ---------------------------------------------------------------------------
// Request / response schemas
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: RegenerateBodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item');

            const { mode, scope, reviewToken } = ctx.input!.body;
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const item = await getMediaItemForImageSync(sql, internalId);
            if (!item) return ApiProblem.notFound('Media item');
            const reviewedInput =
                item.media_type === 'episode' && mode === 'execute'
                    ? await captureExplicitEpisodeThumbnailInput(sql, internalId)
                    : undefined;
            if (item.media_type === 'episode' && mode === 'execute' && !reviewedInput)
                return ApiProblem.conflict('Episode source changed. Refresh and retry.');
            if (
                reviewToken &&
                (!reviewedInput ||
                    reviewToken !== explicitEpisodeThumbnailReviewToken(reviewedInput))
            )
                return ApiProblem.conflict('Episode source or artwork changed. Refresh and retry.');

            const result = await orchestrator.startRun(
                'episode-thumbnail-extract',
                {
                    mediaItemId: internalId,
                    mode,
                    scope,
                    ...(reviewedInput ? { reviewedInput } : {}),
                },
                {
                    trigger: {
                        kind: 'manual',
                        by: event.locals.user?.username,
                        sourceRoute: `admin/media/${internalId}/episode-thumbnails/regenerate`,
                    },
                    priority: 1,
                    idempotencyKey: `episode-thumbs:${internalId}:${mode}:${reviewToken ?? ''}`,
                    subject: { type: 'mediaItem', id: internalId },
                },
            );

            return json(
                RegenerateResponseSchema.parse({
                    runId: result.runId,
                    message: 'Episode thumbnail regeneration queued',
                    deduped: result.deduped,
                }),
            );
        },
    },
});
