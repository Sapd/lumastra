// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { positionUpdateSchema, PositionCheckResponseSchema } from '$lib/schemas/watch-together';

export { positionUpdateSchema, PositionCheckResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        summary: 'Update position',
        body: positionUpdateSchema,
        responses: {
            200: {
                schema: PositionCheckResponseSchema,
                description: 'Position updated',
            },
            404: 'Session not found',
        },
    },
};
