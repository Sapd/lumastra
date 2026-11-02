// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { visibilityChangeSchema, SetVisibilityResponseSchema } from '$lib/schemas/watch-together';

export { visibilityChangeSchema, SetVisibilityResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        summary: 'Change session visibility',
        body: visibilityChangeSchema,
        responses: {
            200: {
                schema: SetVisibilityResponseSchema,
                description: 'Visibility changed',
            },
            404: 'Session not found',
        },
    },
};
