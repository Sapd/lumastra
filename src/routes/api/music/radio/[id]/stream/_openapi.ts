// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        tags: ['Music'],
        summary: 'Proxy internet radio stream',
        description:
            'Proxies an internet radio stream from external Icecast/Shoutcast URL with CORS headers. ' +
            'Returns a chunked audio stream (typically audio/mpeg).',
        responses: {
            200: {
                binary: ['audio/mpeg', 'audio/aac', 'audio/ogg'],
                description: 'Proxied radio audio stream',
            },
            404: 'Station not found',
        },
    },
};
