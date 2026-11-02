// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/tasks/observability — combined task-system observability dashboard data
 * Auth scope: tasks:admin (operational surface — security review
 * 2026-09-12, C16; was tasks:read, which `read` auto-grants to every user).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { GET as adminGET } from '../../../../../routes/api/admin/task-system/observability/+server.js';
import { ObservabilityResponseSchema } from '$lib/schemas/task-system-observability.schema';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Tasks'],
            summary: 'Get combined task-system observability dashboard data',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: ObservabilityResponseSchema,
                    description: 'Task-system observability snapshot',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    handlers: {
        GET: async (event) => {
            return delegateToAdmin(event, adminGET!);
        },
    },
});
