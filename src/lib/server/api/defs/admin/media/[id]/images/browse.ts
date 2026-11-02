// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/images/browse.ts
 *
 * GET /api/admin/media/[id]/images/browse
 *
 * Browse available images from TMDB for this media item.
 * Returns empty arrays when TMDB ID is missing or TMDB is unavailable.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { posters: BrowseImage[], backdrops: BrowseImage[], logos: BrowseImage[] }
 * 503 dependency_unavailable when DB is down.
 */

import { registerImageCandidate } from '$lib/server/database/queries/image-candidates.queries.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { isMovie, isSeries } from '$lib/server/utils/media-types.js';
import { tmdbApi } from '$lib/server/providers/implementations/tmdb/index.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';

const IMAGE_BASE = 'https://image.tmdb.org/t/p';

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

const BrowseImageSchema = z.object({
    filePath: z.string(),
    thumbUrl: z.string().url(),
    fullUrl: z.string().url(),
    width: z.number().int(),
    height: z.number().int(),
    language: z.string().nullable(),
    voteAverage: z.number(),
});

export const ImageBrowseResponseSchema = z.object({
    posters: z.array(BrowseImageSchema),
    backdrops: z.array(BrowseImageSchema),
    logos: z.array(BrowseImageSchema),
});

export type ImageBrowseResponse = z.infer<typeof ImageBrowseResponseSchema>;
export type BrowseImage = z.infer<typeof BrowseImageSchema>;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function mapImages(
    images: Array<{
        file_path: string;
        width: number;
        height: number;
        iso_639_1: string | null;
        vote_average: number;
    }>,
    thumbSize: string = 'w300',
): BrowseImage[] {
    return images.map((img) => ({
        filePath: img.file_path,
        thumbUrl: `${IMAGE_BASE}/${thumbSize}${img.file_path}`,
        fullUrl: `${IMAGE_BASE}/original${img.file_path}`,
        width: img.width,
        height: img.height,
        language: img.iso_639_1,
        voteAverage: img.vote_average,
    }));
}

const EMPTY_RESPONSE: ImageBrowseResponse = { posters: [], backdrops: [], logos: [] };

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item');

            const [typeRows, externalIdRows] = await Promise.all([
                sql<
                    { media_type: string }[]
                >`SELECT media_type FROM media_items WHERE id = ${internalId}`,
                sql<{ external_id: string }[]>`
                    SELECT external_id FROM external_ids
                    WHERE media_id = ${internalId} AND provider = ${getPrimaryExternalIdProvider()}
                `,
            ]);

            if (typeRows.length === 0) return ApiProblem.notFound('Media item');

            const mediaType = typeRows[0].media_type;
            const tmdbRow = externalIdRows[0];

            if (!tmdbRow) return json(ImageBrowseResponseSchema.parse(EMPTY_RESPONSE));

            const tmdbId = parseInt(tmdbRow.external_id, 10);
            if (isNaN(tmdbId)) return json(ImageBrowseResponseSchema.parse(EMPTY_RESPONSE));

            if (!tmdbApi.isAvailable())
                return json(ImageBrowseResponseSchema.parse(EMPTY_RESPONSE));

            let details;
            // An admin picking artwork wants TMDB's current image list, not
            // one the background task chain cached minutes ago.
            if (isMovie(mediaType)) {
                details = await tmdbApi.getMovieDetails(tmdbId, { fresh: true });
            } else if (isSeries(mediaType)) {
                details = await tmdbApi.getTVShowDetails(tmdbId, { fresh: true });
            } else {
                return json(ImageBrowseResponseSchema.parse(EMPTY_RESPONSE));
            }

            const images = details.images ?? {};
            await withTx(sql, async (tx) => {
                for (const [key, role] of [
                    ['posters', 'poster'],
                    ['backdrops', 'backdrop'],
                    ['logos', 'logo'],
                ] as const) {
                    for (const image of images[key] ?? []) {
                        await registerImageCandidate(tx, {
                            mediaItemId: internalId,
                            role,
                            provider: 'tmdb',
                            providerRef: image.file_path,
                            language: image.iso_639_1 ?? '',
                            width: image.width,
                            height: image.height,
                        });
                    }
                }
            });

            return json(
                ImageBrowseResponseSchema.parse({
                    posters: mapImages(images.posters ?? [], 'w300'),
                    backdrops: mapImages(images.backdrops ?? [], 'w780'),
                    logos: mapImages(images.logos ?? [], 'w300'),
                }),
            );
        },
    },
});
