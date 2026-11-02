// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { addPlaylistItemSchema, addPlaylistItemsResponseSchema } from '$lib/schemas/playlists';

export { addPlaylistItemSchema, addPlaylistItemsResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Playlists'],
        summary: 'List playlist items',
        description:
            'Returns all items in a playlist ordered by position. Accessible to the owner, accepted members, and viewers of public playlists.',
        responses: {
            200: 'Paginated list of playlist items ({ items, page })',
            404: 'Playlist not found or access denied',
        },
    },
    POST: {
        tags: ['Playlists'],
        summary: 'Add item to playlist',
        description:
            'Adds catalog media IDs, reporting additions, duplicates and rejections per input.',
        body: addPlaylistItemSchema,
        responses: {
            200: {
                schema: addPlaylistItemsResponseSchema,
                description: 'Item added or series expanded',
            },
            404: 'Playlist not found',
        },
    },
};
