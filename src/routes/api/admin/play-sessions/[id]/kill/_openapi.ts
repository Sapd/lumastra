// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    POST: {
        tags: ['Admin', 'Play Sessions'],
        summary: 'Kill a play session',
        description:
            'Forcefully terminates a play session. Sends SSE kill event to connected clients. Requires admin privileges.',
        responses: {
            204: 'Session killed',
            404: 'Not found',
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
