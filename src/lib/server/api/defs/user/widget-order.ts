// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/user/widget-order.ts — GET /user/widget-order
 *                              POST /user/widget-order
 *
 * Replaces the bespoke legacy route.
 * Returns a bare object: { widgetOrder: string[] | null, hiddenWidgets: string[] }.
 * Auth: {kind:'user'} — self-scoped.
 * Errors: problem+json.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getWidgetOrder,
    upsertWidgetOrderFull,
    upsertWidgetOrderOnly,
    upsertHiddenWidgetsOnly,
} from '$lib/server/database/queries/index.js';

const WidgetOrderBody = z.object({
    widgetOrder: z.array(z.string()).optional(),
    hiddenWidgets: z.array(z.string()).optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: {
        body: WidgetOrderBody,
    },
    handlers: {
        /**
         * GET /user/widget-order
         * Returns the authenticated user's widget order and hidden widgets.
         */
        GET: async (event, _ctx) => {
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            const username = event.locals.principal?.username ?? event.locals.user?.username;
            if (!userId || !username) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');

            const result = await getWidgetOrder.one(sql, { userId });

            return json(
                {
                    username,
                    widgetOrder: result?.widget_order ?? null,
                    hiddenWidgets: result?.hidden_widgets ?? [],
                },
                { headers: { 'Cache-Control': 'private, max-age=300' } },
            );
        },

        /**
         * POST /user/widget-order
         * Updates the authenticated user's widget order and/or hidden widgets.
         */
        POST: async (event, ctx) => {
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            const username = event.locals.principal?.username ?? event.locals.user?.username;
            if (!userId || !username) return ApiProblem.unauthorized();

            const body = ctx.input?.body as
                { widgetOrder?: string[]; hiddenWidgets?: string[] } | undefined;

            const { widgetOrder, hiddenWidgets } = body ?? {};

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');

            if (widgetOrder !== undefined && hiddenWidgets !== undefined) {
                await upsertWidgetOrderFull.execute(sql, { userId, widgetOrder, hiddenWidgets });
            } else if (widgetOrder !== undefined) {
                await upsertWidgetOrderOnly.execute(sql, { userId, widgetOrder });
            } else if (hiddenWidgets !== undefined) {
                await upsertHiddenWidgetsOnly.execute(sql, { userId, hiddenWidgets });
            }

            return json(
                {
                    username,
                    widgetOrder: widgetOrder ?? null,
                    hiddenWidgets: hiddenWidgets ?? [],
                },
                { headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } },
            );
        },
    },
});
