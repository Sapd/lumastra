// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * me/notification-forwarding — the caller's consent to have their
 * notifications forwarded to admin-configured integrations (admin webhooks
 * subscribed to `org.lumastra.user.notification`, e.g. a Telegram bot).
 *
 * Self-scoped like every self resource under `/me`: no user id in the path, and the
 * handler only ever reads or writes the caller's own row. Hook URLs are never
 * exposed — only the labels the admin gave them, so the user can see WHERE the
 * notifications would go before switching it on.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { UserNotificationForwardingSchema } from '$lib/schemas/api-user-responses.js';
import {
    getNotificationForwarding,
    listUserNotificationForwardingHooks,
    setNotificationForwarding,
} from '$lib/server/database/queries/notification-forwarding.queries.js';

const NotificationForwardingBody = z.object({
    enabled: z.boolean().describe('Forward my notifications'),
});

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['User'],
            summary: "Get the caller's notification forwarding setting",
            stability: 'beta',
            auth: 'bearer',
            description:
                "Whether the caller's new-episode and request-available notifications are " +
                'forwarded to integrations the administrator set up, and the names of those ' +
                'integrations. Off by default. `targets` is empty when no integration is set ' +
                'up; the setting can still be stored and takes effect once one is.',
            responses: {
                200: { schema: UserNotificationForwardingSchema, description: 'The setting' },
                401: 'Authentication required',
                404: 'User not found',
                503: 'Database unavailable',
            },
        },
        PUT: {
            tags: ['User'],
            summary: "Turn the caller's notification forwarding on or off",
            stability: 'beta',
            auth: 'bearer',
            description:
                'Stores the setting. Turning it off stops new notifications from being ' +
                'forwarded; deliveries already queued still go out.',
            responses: {
                200: { schema: UserNotificationForwardingSchema, description: 'Stored' },
                401: 'Authentication required',
                404: 'User not found',
                422: 'Missing or invalid `enabled`',
                503: 'Database unavailable',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        body: NotificationForwardingBody,
    },
    handlers: {
        GET: async (event, _ctx) => {
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');

            const [enabled, hooks] = await Promise.all([
                getNotificationForwarding(sql, userId),
                listUserNotificationForwardingHooks(sql),
            ]);
            if (enabled === null) return ApiProblem.notFound('User not found');

            return json({ enabled, targets: hooks.map((h) => h.label ?? '') });
        },

        PUT: async (event, ctx) => {
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const body = ctx.input?.body as { enabled: boolean } | undefined;
            if (!body) return ApiProblem.validationFailed('`enabled` is required');

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');

            const enabled = await setNotificationForwarding(sql, userId, body.enabled);
            if (enabled === null) return ApiProblem.notFound('User not found');
            const hooks = await listUserNotificationForwardingHooks(sql);

            return json({ enabled, targets: hooks.map((h) => h.label ?? '') });
        },
    },
});
