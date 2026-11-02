// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { GetPartyResponseSchema } from '$lib/schemas/watch-together';

export const route: RouteMetadata = {
    GET: {
        tags: ['Watch Together'],
        summary: 'Get a watch party by join code',
        stability: 'beta',
        auth: 'bearer',
        responses: {
            200: {
                schema: GetPartyResponseSchema,
                description: 'Session details',
            },
            401: 'Authentication required',
            404: 'Session not found',
            500: 'Internal server error',
        },
    },
};
