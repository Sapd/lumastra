// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { trickplayQuerySchema } from '$lib/schemas/playback';

export const route: RouteMetadata = {
    GET: {
        tags: ['Playback'],
        auth: 'bearer',
        summary: 'Get trickplay tile image',
        stability: 'protocol',
        description:
            'Returns a single trickplay sprite-sheet tile (a grid of scrubbing thumbnails) for seek preview. Path params `itemId` (media item identifier — UUID, composite `tmdb:550:movie`, or Jellyfin UUID; resolved by middleware) and `width` (thumbnail width in px, positive integer). Local trickplay (WebP) is served when available, otherwise a Jellyfin-format tile from disk (typically JPEG). A strong ETag identifies the selected file, width, sheet index and stored revision; If-None-Match returns 304. CORS-enabled (`Access-Control-Allow-Origin: *`); cached for 24h. Binary image surface — shape is dictated by the player/trickplay client protocol, not a general JSON contract.',
        params: z.object({
            // The `width` segment is a numeric thumbnail width — override the
            // generator's default string typing so the spec types it as an int.
            width: z.coerce.number().int().positive(),
        }),
        query: trickplayQuerySchema,
        responses: {
            200: {
                binary: ['image/webp', 'image/jpeg'],
                description:
                    'Trickplay sprite-sheet tile image (WebP for local storage, JPEG for Jellyfin-disk fallback). The selected sheet is chosen by the `index` query parameter.',

            },
            304: 'Unchanged sprite sheet',
            404: 'Trickplay not available for the item or selected version',
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
