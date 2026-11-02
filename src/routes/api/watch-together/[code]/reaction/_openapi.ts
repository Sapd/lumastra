// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { reactionSchema } from '$lib/schemas/watch-together';
import { SuccessTrueResponseSchema } from '$lib/schemas/common';

export { reactionSchema, SuccessTrueResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        summary: 'Send reaction emoji',
        body: reactionSchema,
        responses: {
            200: {
                schema: SuccessTrueResponseSchema,
                description: 'Reaction sent',
            },
            404: 'Session not found',
        },
    },
};
