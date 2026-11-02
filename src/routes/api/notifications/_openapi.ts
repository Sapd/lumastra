// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import type { RouteMetadata } from '$lib/server/openapi';
import { InboxNotificationsResponseSchema } from '$lib/schemas/notifications-types';

export const route: RouteMetadata = {
    visibility: 'internal',
    GET: {
        tags: ['Notifications'],
        summary: 'List notifications (inbox)',
        description:
            'Returns the paginated notification inbox for the authenticated user. ' +
            '?unread=true filters to unread notifications only. ' +
            '?limit=<n> sets the max rows (1-100, default 50). ' +
            '?before=<ISO> is a cursor for pagination (created_at < before).',
        query: z.object({
            unread: z
                .enum(['true', 'false'])
                .optional()
                .meta({ description: 'Return only unread notifications' }),
            limit: z.coerce
                .number()
                .min(1)
                .max(100)
                .optional()
                .meta({ description: 'Max rows (default 50)' }),
            before: z.string().optional().meta({ description: 'ISO cursor for pagination' }),
        }),
        responses: {
            200: {
                schema: InboxNotificationsResponseSchema,
                description: 'Notification inbox',
            },
            401: 'Authentication required',
            503: 'Database unavailable',
        },
    },
};
