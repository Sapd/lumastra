// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { UserResponseSchema } from '$lib/schemas/api-user-responses';

export const route: RouteMetadata = {
    visibility: 'internal',
    GET: {
        tags: ['User'],
        summary: "Get current user's identity",
        description:
            "Returns the authenticated user's identifier (username), used for avatar URL construction.",
        responses: {
            200: { schema: UserResponseSchema, description: 'User profile response' },
            401: 'Authentication required',
        },
    },
};
