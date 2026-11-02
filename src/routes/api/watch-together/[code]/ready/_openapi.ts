// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { readySchema } from '$lib/schemas/watch-together';
import { SuccessTrueResponseSchema } from '$lib/schemas/common';

export { readySchema, SuccessTrueResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        summary: 'Signal ready state',
        body: readySchema,
        responses: {
            200: {
                schema: SuccessTrueResponseSchema,
                description: 'Ready state signaled',
            },
            404: 'Session not found',
        },
    },
};
