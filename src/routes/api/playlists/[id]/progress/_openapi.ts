// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { PlaylistProgressResponseSchema } from '$lib/schemas/playlists';

export const route: RouteMetadata = {
    GET: {
        tags: ['Playlists'],
        summary: 'Get collaborative playlist watch progress',
        description:
            'Returns per-member watch progress and per-item watcher details for collaborative playlists.',
        responses: {
            200: {
                schema: PlaylistProgressResponseSchema,
                description: 'Collaborative watch progress',
            },
            404: 'Playlist not found',
        },
    },
};
