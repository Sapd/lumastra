// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { MediaNodeSchema } from '$lib/schemas/media-detail';

export const route: RouteMetadata = {
    GET: {
        tags: ['Media'],
        summary: 'Get media {id}',
        description:
            'Canonical polymorphic media detail — resolves an internal UUID, composite external ID, or Jellyfin ID to a movie or series detail.',
        query: z.object({
            include: z
                .string()
                .optional()
                .meta({
                    description:
                        'CSV of optional expansions: `user`, `playback`, `details`. `details` adds ' +
                        'rich fields (cast/genres/ratings/trailer/runtime) — movie/series only.',
                }),
            externalId: z.string().optional().meta({
                description: 'Composite external ID form: provider:id:type (e.g. tmdb:550:movie)',
            }),
        }),
        responses: {
            200: {
                schema: MediaNodeSchema,
                description:
                    'Media traversal node (discriminated union of movie, series, episode, season, and audiobook)',
            },
            401: 'Authentication required',
            404: 'Media item not found, or its type is not served by this endpoint (music items are served by the music endpoints)',
        },
    },
    DELETE: {
        tags: ['Media'],
        summary: 'Delete media {id}',
        description: 'Admin delete of a media item.',
        responses: {
            204: 'Success',
            401: 'Authentication required',
            404: 'Media not found',
        },
    },
};
