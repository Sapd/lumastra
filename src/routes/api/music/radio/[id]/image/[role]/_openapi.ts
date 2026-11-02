// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        tags: ['Music'],
        summary: 'Radio metadata image proxy',
        description:
            'Proxies the current DJ avatar, show image, or up-next artwork for a radio station. Content is pulled from the cached metadata record (see /now-playing).',
        responses: {
            200: {
                binary: ['image/jpeg', 'image/png', 'image/webp'],
                description: 'Image binary',
            },
            404: 'No image cached for that role',
        },
    },
};
