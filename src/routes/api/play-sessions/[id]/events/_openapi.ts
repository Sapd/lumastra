// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        tags: ['Play Sessions'],
        summary: 'Session events (SSE)',
        description:
            'Server-Sent Events stream for session lifecycle events (kill, etc.). Sends keepalive comments every 30 seconds. Initial event: {type: "connected"}.',
        responses: {
            200: {
                sse: true,
                description: 'SSE event stream for session lifecycle',
            },
            404: 'Not found',
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
