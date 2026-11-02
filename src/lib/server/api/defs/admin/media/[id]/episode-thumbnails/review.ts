// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type postgres from 'postgres';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { parsePagination } from '$lib/server/utils/pagination.js';
import { getMediaItemForImageSync } from '$lib/server/database/queries/image-sync.queries.js';
import { listSharedEpisodeThumbReview } from '$lib/server/database/queries/media-artwork.queries.js';
import { SharedEpisodeThumbReviewSchema } from '$lib/schemas/admin-image-extraction.js';
import {
    captureExplicitEpisodeThumbnailInput,
    explicitEpisodeThumbnailReviewToken,
} from '$lib/server/services/explicit-episode-thumbnail.service.js';

/** Selected shared paths are a review signal, not an owner attribution. */
export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const id = adminMediaId(event);
            if (!id) return ApiProblem.notFound('Media item');
            const item = await getMediaItemForImageSync(sql, id);
            if (!item || !['tv', 'season'].includes(item.media_type))
                return ApiProblem.notFound('Series or season');
            const { limit, offset } = parsePagination(event.url, {
                defaultLimit: 12,
                maxLimit: 50,
            });
            const result = await sql.begin(
                'isolation level repeatable read read only',
                async (rawTx) => {
                    const tx = rawTx as unknown as postgres.Sql;
                    const projection = await listSharedEpisodeThumbReview(tx, id, limit, offset);
                    const rows = [];
                    for (const row of projection.rows) {
                        const input = await captureExplicitEpisodeThumbnailInput(tx, row.episodeId);
                        const current =
                            input &&
                            input.selectedCandidateId === row.selectedCandidateId &&
                            input.fileId === row.sourceFileId &&
                            input.videoPath === row.sourcePath;
                        rows.push({
                            ...row,
                            reviewToken: current
                                ? explicitEpisodeThumbnailReviewToken(input)
                                : null,
                        });
                    }
                    return { ...projection, rows, limit, offset };
                },
            );
            return json(SharedEpisodeThumbReviewSchema.parse(result));
        },
    },
});
