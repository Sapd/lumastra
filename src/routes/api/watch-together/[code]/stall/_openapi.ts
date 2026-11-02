// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { stallSchema } from '$lib/schemas/watch-together';
import { SuccessTrueResponseSchema } from '$lib/schemas/common';

export { stallSchema, SuccessTrueResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        summary: 'Report buffering stall',
        body: stallSchema,
        responses: {
            200: {
                schema: SuccessTrueResponseSchema,
                description: 'Stall reported',
            },
            404: 'Session not found',
        },
    },
};
