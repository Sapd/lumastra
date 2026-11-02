// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';
import { leaveSessionSchema, LeaveSessionResponseSchema } from '$lib/schemas/watch-together';

export { leaveSessionSchema, LeaveSessionResponseSchema };

export const route: RouteMetadata = {
    POST: {
        tags: ['Watch Together'],
        summary: 'Leave session',
        body: leaveSessionSchema,
        responses: {
            200: {
                schema: LeaveSessionResponseSchema,
                description: 'Left session',
            },
            404: 'Session not found',
        },
    },
};
