// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/v1/tasks/audit — task audit log (cursor-paged, CSV export)
 * Auth scope: tasks:admin (operational surface — security review
 * 2026-09-12, C16; was tasks:read, which `read` auto-grants to every user).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { delegateToAdmin } from '$lib/server/api/delegate.js';
import { GET as adminGET } from '../../../../../routes/api/admin/task-system/audit/+server.js';
import { z } from 'zod';
import { AuditFeedResponseSchema } from '$lib/schemas/task-system-failure-detection.schema';

export const def = defineEndpoint({
    docs: {
        visibility: 'internal',
        GET: {
            tags: ['Tasks'],
            summary: 'Get task audit log (cursor-paged)',
            stability: 'stable',
            auth: 'bearer',
            query: z.object({
                limit: z.coerce
                    .number()
                    .int()
                    .optional()
                    .meta({ description: 'Max rows to return' }),
                cursor: z.coerce
                    .number()
                    .int()
                    .optional()
                    .meta({ description: 'Keyset cursor: return rows older than this id' }),
                severity: z
                    .enum(['info', 'warn', 'error'])
                    .optional()
                    .meta({ description: 'Filter by severity' }),
            }),
            responses: {
                200: {
                    schema: AuditFeedResponseSchema,
                    description: 'Task audit feed (newest-first, cursor-paged)',
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
