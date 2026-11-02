// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import {
    createPlaylistSchema,
    playlistsListResponseSchema,
    playlistResponseSchema,
} from '$lib/schemas/playlists';

export { createPlaylistSchema, playlistsListResponseSchema, playlistResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Playlists'],
        summary: "List user's playlists",
        responses: {
            200: {
                schema: playlistsListResponseSchema,
                description: "User's owned and shared playlists",
            },
        },
    },
    POST: {
        tags: ['Playlists'],
        summary: 'Create a new playlist',
        body: createPlaylistSchema,
        responses: {
            201: {
                schema: playlistResponseSchema,
                description: 'Playlist created',
            },
        },
    },
};
