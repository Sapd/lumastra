// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { playlistMessageResponseSchema } from '$lib/schemas/playlists';

export const route: RouteMetadata = {
    DELETE: {
        tags: ['Playlists'],
        summary: 'Remove item from playlist',
        responses: {
            200: {
                schema: playlistMessageResponseSchema,
                description: 'Item removed',
            },
            404: 'Playlist or item not found',
        },
    },
};
