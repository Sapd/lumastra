// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';

const ForwardAuthHeadersResponseSchema = z
    .object({
        received: z
            .array(z.string())
            .describe(
                'Names (lowercased) of forward-auth headers present on the inbound request — values are never returned',
            ),
    })
    .meta({
        id: 'ForwardAuthHeadersResponse',
        description: 'Forward-auth header name reflection (diagnostic endpoint)',
    });

export const route: RouteMetadata = {
    visibility: 'internal',
    GET: {
        tags: ['Admin'],
        summary: 'Reflect forward-auth header names (diagnostic)',
        stability: 'experimental',
        auth: 'bearer',
        responses: {
            200: {
                schema: ForwardAuthHeadersResponseSchema,
                description:
                    'Names of forward-auth headers present on the inbound request (values never returned)',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
