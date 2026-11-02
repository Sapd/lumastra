// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { UserProfileResponseSchema } from '$lib/schemas/api-user-responses';

export const route: RouteMetadata = {
    GET: {
        tags: ['User'],
        summary: 'Get current user profile',
        responses: {
            200: {
                schema: UserProfileResponseSchema,
                description: 'Current user profile',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
