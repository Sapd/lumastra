// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { playbackPreferencesSchema } from '$lib/schemas/user';
import { PlaybackPreferencesResponseSchema } from '$lib/schemas/api-user-responses';

export { playbackPreferencesSchema };

export const route: RouteMetadata = {
    GET: {
        tags: ['User'],
        summary: 'Get playback preferences',
        responses: {
            200: {
                schema: PlaybackPreferencesResponseSchema,
                description: 'Playback preferences',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
    PATCH: {
        tags: ['User'],
        summary: 'Update playback preferences',
        body: playbackPreferencesSchema,
        responses: {
            200: {
                schema: PlaybackPreferencesResponseSchema,
                description: 'Updated playback preferences',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
