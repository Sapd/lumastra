// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { navigateSchema, NavigateResponseSchema } from '$lib/schemas/watch-together';

export { navigateSchema, NavigateResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        summary: 'Navigate to new media',
        body: navigateSchema,
        responses: {
            200: {
                schema: NavigateResponseSchema,
                description: 'Navigated to new media',
            },
            404: 'Session not found',
        },
    },
};
