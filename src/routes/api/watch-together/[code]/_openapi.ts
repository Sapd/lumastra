// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { GetPartyResponseSchema } from '$lib/schemas/watch-together';

export const route: RouteMetadata = {
    GET: {
        tags: ['Watch Together'],
        summary: 'Get session details',
        responses: {
            200: {
                schema: GetPartyResponseSchema,
                description: 'Session details',
            },
            404: 'Session not found',
        },
    },
};
