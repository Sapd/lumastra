// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/jellyfin-connect/quick-connect/authorize
 *
 * Authenticated user approves a Quick Connect code displayed on a TV/client device.
 * Returns a bare empty object on success (no {success:true} wrapper).
 *
 * Note: The route file wraps this def with withValkeyRateLimit (10/min per user)
 * before mounting — the def itself only handles auth and business logic.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Database } from '$lib/server/database/connection.js';
import { getUserByUsername } from '$lib/server/database/queries/users.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { authorizeQuickConnectCode } from '$lib/server/proprietary/jellyfin-compat/quick-connect-authorize.js';

const logger = Logger.for('JellyfinCompat:QuickConnect');

export const jellyfinQuickConnectAuthorizeDef = defineEndpoint({
    auth: { kind: 'feature', flag: 'jellyfinCompat', then: { kind: 'user' } },
    visibility: 'internal',
    request: {
        body: z.object({
            code: z.string().regex(/^\d{6}$/, 'A valid 6-digit code is required'),
        }),
    },
    handlers: {
        POST: async (event, ctx) => {
            const { code } = ctx.input!.body as { code: string };

            // Resolve the authenticated user's DB identity
            const db = new Database();
            const sql = db.getSql();
            const userRow = await getUserByUsername(sql, event.locals.user!.username);

            if (!userRow) {
                return ApiProblem.notFound('User not found');
            }

            // Update the Quick Connect session with user identity
            const result = await authorizeQuickConnectCode(code, {
                userId: userRow.id,
                username: userRow.username,
                isAdmin: event.locals.principal?.isAdmin === true,
                groups: event.locals.user!.userGroups ?? [],
                displayName: userRow.display_name ?? null,
            });
            if (result === 'not_found') {
                return ApiProblem.notFound('Quick Connect code not found or expired');
            }
            if (result === 'already_authorized') {
                return ApiProblem.conflict('This code has already been authorized');
            }

            logger.info('Quick Connect code authorized', {
                username: userRow.username,
            });

            return json({});
        },
    },
});
