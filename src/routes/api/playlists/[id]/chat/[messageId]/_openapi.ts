// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { messageResponseSchema } from '$lib/schemas/playlists';

export { messageResponseSchema };

export const route: RouteMetadata = {
    DELETE: {
        tags: ['Playlists'],
        summary: 'Delete chat message',
        responses: {
            200: {
                schema: messageResponseSchema,
                description: 'Message deleted',
            },
            404: 'Playlist or message not found',
        },
    },
};
