// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { hostActivitySchema } from '$lib/schemas/watch-together';
import { SuccessTrueResponseSchema } from '$lib/schemas/common';

export { hostActivitySchema, SuccessTrueResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        summary: 'Broadcast host activity',
        body: hostActivitySchema,
        responses: {
            200: {
                schema: SuccessTrueResponseSchema,
                description: 'Activity broadcast',
            },
            404: 'Session not found',
        },
    },
};
