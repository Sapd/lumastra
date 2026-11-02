// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { DisbandSessionResponseSchema } from '$lib/schemas/watch-together';

export { DisbandSessionResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        summary: 'Disband session (host only)',
        description:
            'Permanently ends the session and removes all participants. Only the host can disband.',
        responses: {
            200: {
                schema: DisbandSessionResponseSchema,
                description: 'Session disbanded',
            },
            404: 'Session not found',
        },
    },
};
