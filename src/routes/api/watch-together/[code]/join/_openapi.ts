// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { joinSessionSchema, JoinPartyResponseSchema } from '$lib/schemas/watch-together';

export { joinSessionSchema, JoinPartyResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        summary: 'Join session',
        body: joinSessionSchema,
        responses: {
            200: {
                schema: JoinPartyResponseSchema,
                description: 'Joined session',
            },
            404: 'Session not found',
        },
    },
};
