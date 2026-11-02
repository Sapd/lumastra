// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        tags: ['Playback'],
        auth: 'bearer',
        summary: 'Get chapter thumbnail image',
        stability: 'protocol',
        description:
            "Returns a per-chapter thumbnail cropped from the item's trickplay sprite sheet. Path params `id` (media item identifier — UUID, composite `tmdb:550:movie`, or Jellyfin UUID; resolved by middleware) and `index` (zero-based chapter index). 404s when trickplay is unavailable, local trickplay serving is disabled, or the chapter falls past the generated thumbnails — clients render a title-only chapter marker in that case. Honours fileId for both chapters and trickplay parameters. Bearer authentication or a playback grant is required. Binary image surface — shape is dictated by the player chapter protocol, not a general JSON contract.",
        params: z.object({
            // The `index` segment is a numeric chapter index — override the
            // generator's default string typing so the spec types it as an int.
            index: z.coerce.number().int().min(0),
        }),
        query: z.object({
            fileId: z.uuid().optional().describe('Selected media file; omitted resolves the default file.'),
            rev: z.string().optional().describe('Server-issued content revision carried by timeline image.href.'),
        }),
        responses: {
            200: {
                binary: ['image/webp', 'image/jpeg'],
                description: 'Chapter thumbnail cropped from the trickplay sprite sheet.',
            },
            304: 'Unchanged chapter thumbnail (ETag is its revision identity)',
            400: 'Invalid chapter index',
            404: 'Chapter thumbnail not available (no trickplay, disabled, or index out of range)',
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
