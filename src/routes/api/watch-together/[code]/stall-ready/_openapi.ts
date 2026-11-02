// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { stallReadySchema } from '$lib/schemas/watch-together';
import { SuccessTrueResponseSchema } from '$lib/schemas/common';

export { stallReadySchema, SuccessTrueResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        summary: 'Report stall recovered',
        body: stallReadySchema,
        responses: {
            200: {
                schema: SuccessTrueResponseSchema,
                description: 'Stall recovery reported',
            },
            404: 'Session not found',
        },
    },
};
