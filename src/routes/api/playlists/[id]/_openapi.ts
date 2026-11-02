// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import {
    updatePlaylistSchema,
    getPlaylistResponseSchema,
    playlistItemWithMetadataResponseSchema,
    messageResponseSchema,
} from '$lib/schemas/playlists';

export {
    updatePlaylistSchema,
    getPlaylistResponseSchema,
    playlistItemWithMetadataResponseSchema,
    messageResponseSchema,
};

export const route: RouteMetadata = {
    GET: {
        tags: ['Playlists'],
        stability: 'stable',
        summary: 'Get playlist details',
        responses: {
            200: {
                schema: getPlaylistResponseSchema,
                description: 'Playlist metadata',
            },
            404: 'Playlist not found',
        },
    },
    PATCH: {
        tags: ['Playlists'],
        stability: 'stable',
        summary: 'Update playlist',
        body: updatePlaylistSchema,
        responses: {
            200: {
                schema: playlistItemWithMetadataResponseSchema,
                description: 'Updated playlist',
            },
            404: 'Playlist not found',
        },
    },
    DELETE: {
        tags: ['Playlists'],
        stability: 'stable',
        summary: 'Delete playlist',
        responses: {
            200: {
                schema: messageResponseSchema,
                description: 'Playlist deleted',
            },
            404: 'Playlist not found',
        },
    },
};
