// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        tags: ['Music'],
        summary: 'Stream an internet radio station',
        stability: 'protocol',
        auth: 'bearer',
        responses: {
            200: { binary: ['audio/mpeg'], description: 'Radio station audio stream' },
            401: 'Authentication required',
            404: 'Station not found',
            500: 'Internal server error',
        },
    },
};
