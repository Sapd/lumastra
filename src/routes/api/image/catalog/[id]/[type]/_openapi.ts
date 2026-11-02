// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        tags: ['Images'],
        summary: 'Get catalog image by ID and type',
        stability: 'protocol',
        description:
            'Image proxy endpoint. Delegates to ImageProxyService and returns a cached image binary.',
        responses: {
            200: {
                binary: ['image/webp', 'image/jpeg', 'image/png'],
                description: 'Media image',
            },
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
};
