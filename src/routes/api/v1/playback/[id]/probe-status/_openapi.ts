// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { ProbeStatusResponseSchema } from '$lib/schemas/api-playback-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['Playback'],
        summary: 'Get keyframe probe status for a media item',
        stability: 'beta',
        auth: 'bearer',
        description:
            'Reports whether the server is currently probing keyframes for an item. ' +
            'Poll during initial loading to detect when the media analysis overlay can be cleared.',
        responses: {
            200: {
                schema: ProbeStatusResponseSchema,
                description: 'Probe status (not-probing, probing, or error variant)',
            },
            401: 'Authentication required',
            404: 'Item not found',
            500: 'Internal server error',
        },
    },
};
