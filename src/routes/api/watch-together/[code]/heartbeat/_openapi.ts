// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { heartbeatSchema } from '$lib/schemas/watch-together';
import { SuccessTrueResponseSchema } from '$lib/schemas/common';

export { heartbeatSchema, SuccessTrueResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        summary: 'Send heartbeat',
        body: heartbeatSchema,
        responses: {
            200: {
                schema: SuccessTrueResponseSchema,
                description: 'Heartbeat acknowledged',
            },
            404: 'Session not found',
        },
    },
};
