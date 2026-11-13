// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /QuickConnect/Authorize?code= (Jellyfin QuickConnectController) — a
 * signed-in app approves the Quick Connect code another device shows, so that
 * device signs in as this user. Answers `true` like Jellyfin.
 *
 * - Missing `code`: 400. Unknown or expired code: 404.
 * - A code that is already approved: 400 (Jellyfin throws; nothing changes).
 * - `userId` for anyone but the caller: 403. Jellyfin lets an admin approve a
 *   code for another user; Lumastra does not mint sessions for other accounts
 *   from /j, so admins are refused too.
 * - Session tokens only (`pat: 'deny'`): an API key must not be able to mint
 *   a full session for a new device. Rate limited per user in the SAME bucket
 *   as the web app's approve endpoint (10/min across both routes).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { withValkeyRateLimit } from '$lib/server/middleware/valkey-rate-limit';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getDb } from '$lib/server/database';
import { getUserByUsername } from '$lib/server/database/queries/users.queries';
import { getParam } from '$lib/server/proprietary/jellyfin-compat/utils';
import {
    authorizeQuickConnectCode,
    quickConnectAuthorizeRateLimitKey,
} from '$lib/server/proprietary/jellyfin-compat/quick-connect-authorize';
import { isOtherUser } from '$lib/server/proprietary/jellyfin-compat/self-user';
import { jellyfinBadRequest } from '$lib/server/proprietary/jellyfin-compat/bad-request';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('JellyfinCompat:QuickConnect');

export const POST: RequestHandler = withJellyfinAuth(
    withValkeyRateLimit(10, 60, quickConnectAuthorizeRateLimitKey, { strict: true })(
        async (event) => {
            const user = event.locals.user;
            const code = (getParam(event.url, 'Code') ?? '').trim();
            if (!code) return jellyfinBadRequest('code is required');
            if (isOtherUser(getParam(event.url, 'UserId'), user.userId)) {
                return ApiResponses.forbidden('User is not allowed to authorize this request');
            }

            const sql = getDb();
            if (!sql) return ApiResponses.error('Database unavailable');
            const row = await getUserByUsername(sql, user.username);
            if (!row) return ApiResponses.notFound('User not found');

            const approvingToken = (event.locals as unknown as Record<string, unknown>).jfToken;
            if (typeof approvingToken !== 'string')
                return ApiResponses.notFound('Quick Connect code');
            const result = await authorizeQuickConnectCode(
                code,
                {
                    userId: row.id,
                    username: row.username,
                    isAdmin: localsIsAdmin(event.locals),
                    groups: user.userGroups ?? [],
                    displayName: row.display_name ?? null,
                },
                approvingToken,
            );
            if (result === 'not_found') return ApiResponses.notFound('Quick Connect code');
            if (result === 'already_authorized') {
                return jellyfinBadRequest('This code has already been authorized');
            }
            logger.info('Quick Connect code authorized from an app', { username: row.username });
            return json(true);
        },
    ),
    { pat: 'deny', mode: 'write' },
);
