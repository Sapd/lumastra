// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/images/extract.ts
 *
 * POST /api/admin/media/[id]/images/extract
 *
 * Extract a poster/backdrop/thumb frame from the media item's video file.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { extracted: boolean, filePath?: string, reason?: string }
 * 503 dependency_unavailable when DB is down.
 */

import { ExtractBodySchema, ExtractResponseSchema } from '$lib/schemas/admin-image-extraction.js';
export {
    ExtractBodySchema,
    ExtractResponseSchema,
    type ExtractResponse,
} from '$lib/schemas/admin-image-extraction.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { extractPosterForItem } from '$lib/server/services/video-frame-extractor.service.js';

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
        body: ExtractBodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item');

            const { artworkType } = ctx.input!.body;

            const result = await extractPosterForItem(sql, {
                mediaItemId: internalId,
                artworkType,
                force: true,
                selectAsAdmin: true,
            });

            return json(ExtractResponseSchema.parse({ ...result, extracted: result.extracted }));
        },
    },
});
