// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/tasks/circuits — circuit-breaker state fleet view
 * Auth scope: tasks:admin (operational surface — security review
 * 2026-09-12, C16; was tasks:read, which `read` auto-grants to every user).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { GET as adminGET } from '../../../../../routes/api/admin/task-system/circuits/+server.js';
import { CircuitFleetResponseSchema } from '$lib/schemas/task-system-failure-detection.schema';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Tasks'],
            summary: 'Get circuit-breaker fleet state',
            stability: 'stable',
            auth: 'bearer',
            responses: {
                200: {
                    schema: CircuitFleetResponseSchema,
                    description: 'Circuit-breaker fleet state',
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
