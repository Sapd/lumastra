// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { LogoutResponseSchema } from '$lib/schemas/api-user-responses';

export const route: RouteMetadata = {
    POST: {
        tags: ['Auth'],
        summary: 'Logout current session',
        description: 'Invalidates the current user session and clears authentication state.',
        responses: {
            200: {
                schema: LogoutResponseSchema,
                description: 'Successfully logged out',
            },
            401: 'Authentication required',
            500: 'Internal server error',
        },
    },
};
