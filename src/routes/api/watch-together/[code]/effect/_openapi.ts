// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { effectSchema } from '$lib/schemas/watch-together';
import { SuccessTrueResponseSchema } from '$lib/schemas/common';

export { effectSchema, SuccessTrueResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        summary: 'Trigger screen effect',
        body: effectSchema,
        responses: {
            200: {
                schema: SuccessTrueResponseSchema,
                description: 'Effect triggered',
            },
            404: 'Session not found',
        },
    },
};
