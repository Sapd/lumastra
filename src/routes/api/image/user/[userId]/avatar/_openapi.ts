// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    GET: {
        tags: ['Images'],
        summary: 'Get user avatar',
        stability: 'protocol',
        description:
            'Auth-bypass/binary image proxy for a user avatar (resolved by user id or username). Delegates to ImageProxyService and returns a cached image binary.',
        query: z.object({
            quality: z.coerce.number().optional().meta({ description: 'Output quality (1-100)' }),
        }),
        responses: {
            200: {
                binary: ['image/webp', 'image/jpeg', 'image/png'],
                description: 'User avatar image',
            },
            400: 'User ID required',
            401: 'Authentication required',
            404: 'Not found',
            500: 'Internal server error',
        },
    },
};
