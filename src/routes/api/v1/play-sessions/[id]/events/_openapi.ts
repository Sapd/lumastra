// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        tags: ['Play Sessions'],
        summary: 'List the events of a playback session',
        stability: 'stable',
        auth: 'bearer',
        responses: {
            200: { sse: true, description: 'Server-Sent Events stream of playback session events' },
            401: 'Authentication required',
            404: 'Session not found',
            500: 'Internal server error',
        },
    },
};
