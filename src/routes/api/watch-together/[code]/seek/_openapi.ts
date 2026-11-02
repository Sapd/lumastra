// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { seekSchema, SeekResponseSchema } from '$lib/schemas/watch-together';

export { seekSchema, SeekResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        summary: 'Seek to position',
        body: seekSchema,
        responses: {
            200: {
                schema: SeekResponseSchema,
                description: 'Seeked to position',
            },
            404: 'Session not found',
        },
    },
};
