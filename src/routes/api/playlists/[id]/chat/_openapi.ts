// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import {
    chatMessageSchema,
    chatQuerySchema,
    chatMessagesResponseSchema,
    chatMessageCreatedResponseSchema,
} from '$lib/schemas/playlists';

export {
    chatMessageSchema,
    chatQuerySchema,
    chatMessagesResponseSchema,
    chatMessageCreatedResponseSchema,
};

export const route: RouteMetadata = {
    GET: {
        tags: ['Playlists'],
        summary: 'Get chat messages',
        query: chatQuerySchema,
        responses: {
            200: {
                schema: chatMessagesResponseSchema,
                description: 'Chat messages',
            },
            404: 'Playlist not found',
        },
    },
    POST: {
        tags: ['Playlists'],
        summary: 'Send chat message',
        body: chatMessageSchema,
        responses: {
            201: {
                schema: chatMessageCreatedResponseSchema,
                description: 'Message sent',
            },
            404: 'Playlist not found',
        },
    },
};
