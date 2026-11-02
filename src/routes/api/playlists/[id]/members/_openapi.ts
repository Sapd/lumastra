// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { membersListResponseSchema } from '$lib/schemas/playlists';

export { membersListResponseSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['Playlists'],
        summary: 'List members',
        responses: {
            200: {
                schema: membersListResponseSchema,
                description: 'Playlist members',
            },
            404: 'Playlist not found',
        },
    },
};
