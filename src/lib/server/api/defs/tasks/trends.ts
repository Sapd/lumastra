// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/tasks/trends — task-system trends over time
 * Auth scope: metrics:read
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { GET as adminGET } from '../../../../../routes/api/admin/task-system/trends/+server.js';
import { TrendsResponseSchema } from '$lib/schemas/task-system-failure-detection.schema';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Tasks'],
            summary: 'Get task-system trends over time',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: TrendsResponseSchema,
                    description: 'Task-system metric trend snapshots',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['metrics:read'] },
    handlers: {
        GET: async (event) => {
            return delegateToAdmin(event, adminGET!);
        },
    },
});
