// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { playbackContextQuerySchema, playbackContextResponseSchema } from '$lib/schemas/playlists';

export { playbackContextQuerySchema, playbackContextResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Playlists'],
        summary: 'Get playback context for playlist',
        description:
            'Returns the selected entry and its adjacent entries. The sidebar loads paginated items.',
        query: playbackContextQuerySchema,
        responses: {
            200: {
                schema: playbackContextResponseSchema,
                description: 'Playback context with navigation',
            },
            404: 'Playlist not found',
        },
    },
};
