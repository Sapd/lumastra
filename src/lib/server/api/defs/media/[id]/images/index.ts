// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Lists resolved artwork descriptors; `inherit=none` restricts roles to this item. */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { parseMediaId } from '$lib/server/utils/media-key-parser.js';
import { resolveExternalArtworkAccess } from '$lib/server/utils/external-artwork-access.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { ImageSetSchema } from '$lib/schemas/api-image-descriptor.js';
import { resolveImageSet } from '$lib/server/services/image-descriptor/index.js';
import { getMediaDetailsById } from '$lib/server/database/queries/media-lookup.queries.js';

const ImageListingQuery = z.object({
    externalId: z.string().optional(),
    inherit: z.enum(['chain', 'none']).optional(),
});

const ImagesListResponseSchema = z.object({
    id: z.string(),
    images: ImageSetSchema,
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Media'],
            summary: 'List available image roles for a media item',
            stability: 'stable',
            auth: 'none',
            description:
                'Returns resolved artwork descriptors for the given media item. ' +
                'Use `inherit=none` to list only its own artwork. ' +
                'Does not return raw image bytes — use `GET /api/v1/media/{id}/images/{role}` for that. ' +
                'Internal UUIDs stay anonymous. External provider handles require authentication and library/age access.',
            query: ImageListingQuery,
            responses: {
                200: {
                    schema: ImagesListResponseSchema,
                    description: 'Available image roles',
                },
                400: 'Invalid media ID',
                401: 'Authentication required for external provider handles',
                404: 'Media not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'public' },

    request: {
        query: ImageListingQuery,
    },

    handlers: {
        GET: async (event, ctx) => {
            const { params, url, locals } = event;

            const id = params.id ?? url.searchParams.get('externalId') ?? '';
            if (!id) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Media ID is required' },
                ]);
            }

            const parsed = parseMediaId(id);
            if (id.includes(':') && parsed.type === 'uuid') {
                return ApiProblem.validationFailed([
                    {
                        field: 'id',
                        message:
                            'Composite keys must include provider, id, and media type (e.g. tmdb:603:movie)',
                    },
                ]);
            }

            if (parsed.type === 'composite' && !locals.user?.username)
                return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database not available');
            }

            let resolvedId: string;

            if (parsed.type === 'uuid' && parsed.uuid) {
                resolvedId = parsed.uuid;
            } else if (parsed.type === 'composite' && parsed.provider && parsed.externalId) {
                const access = await resolveExternalArtworkAccess(event, parsed);
                if (access instanceof Response) return access;
                if (access.kind !== 'catalog') return ApiProblem.notFound('Media item not found');
                resolvedId = access.internalId;
            } else {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Invalid media ID format' },
                ]);
            }

            // Internal UUID behavior stays public; external handles were authenticated and gated above.
            if (
                parsed.type === 'uuid' &&
                locals.user &&
                !(await checkMediaAccess(sql, resolvedId, locals.user))
            ) {
                return ApiProblem.notFound('Media item not found');
            }

            const item = await getMediaDetailsById(sql, resolvedId);
            if (!item) return ApiProblem.notFound('Media item not found');
            const images = await resolveImageSet(sql, ctx.surface, resolvedId, item.media_type, {
                inherit: url.searchParams.get('inherit') === 'none' ? 'none' : 'chain',
            });

            return json(
                { id: resolvedId, images },
                parsed.type === 'composite'
                    ? { headers: { 'Cache-Control': 'private, no-store' } }
                    : undefined,
            );
        },
    },
});
