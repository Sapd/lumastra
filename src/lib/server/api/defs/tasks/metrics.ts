// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/tasks/metrics — task-system metrics snapshot
 * Auth scope: metrics:read
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { GET as adminGET } from '../../../../../routes/api/admin/task-system/metrics/+server.js';
import { MetricsBridgeResponseSchema } from '$lib/schemas/task-system-observability.schema';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Tasks'],
            summary: 'Get task-system metrics snapshot',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: MetricsBridgeResponseSchema,
                    description: 'Task-system metrics snapshot',
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
