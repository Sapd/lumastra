// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/user/index.ts — GET /user
 *                       POST /user  (quick-connect)
 *
 * GET  → bare object { id, name } — returns username for avatar URL resolution.
 * POST → quick-connect via Jellyfin; returns bare { authorized: boolean, message }.
 *
 * Auth: {kind:'user'} for both methods.
 * Quick-connect POST additionally gates on the quickConnect feature flag.
 * Errors: problem+json.
 */

import { getDb } from '$lib/server/database/index.js';
import { userImageSets } from '$lib/server/services/image-descriptor/avatars.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { features } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('UserIndexDef');

const QuickConnectBody = z.object({
    code: z.string().min(1),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: {
        body: QuickConnectBody,
    },
    handlers: {
        /**
         * GET /user
         *
         * Returns the authenticated user's identifier (username).
         * Consumers use this for avatar URL construction — the avatar endpoint
         * accepts usernames and handles Jellyfin UUID lookups internally.
         */
        GET: async (event, ctx) => {
            const username = event.locals.principal?.username ?? event.locals.user?.username ?? '';
            const sql = getDb();
            const userId = event.locals.user?.userId;
            const images =
                sql && userId
                    ? ((await userImageSets(sql, ctx.surface, [userId])).get(userId) ?? {})
                    : {};
            return json({ id: username, name: username, images });
        },

        /**
         * POST /user  (quick-connect)
         *
         * Authorises a pending Jellyfin Quick Connect code for the caller.
         * Gated on the `quickConnect` feature flag.
         * Returns: { authorized: boolean, message: string }
         */
        POST: async (event, ctx) => {
            if (!features.quickConnect) {
                return ApiProblem.notFound("Feature 'quickConnect' is not enabled");
            }

            const username = event.locals.principal?.username ?? event.locals.user?.username;
            if (!username) return ApiProblem.unauthorized();

            const body = ctx.input?.body as { code: string } | undefined;
            if (!body?.code) {
                return ApiProblem.validationFailed([
                    { field: 'body.code', message: 'Required string field' },
                ]);
            }
            const { code } = body;

            logger.info('Attempting quick connect', { username, code });

            // Lazy resolve — Valkey-cached so subsequent calls are sub-ms.
            const { resolveJellyfinUserId } =
                await import('$lib/server/services/jellyfin-user-id-resolver.js');
            const userId = await resolveJellyfinUserId(username);
            if (!userId) {
                logger.info('User not found in Jellyfin', { username });
                return ApiProblem.notFound('User not found in Jellyfin');
            }

            logger.info('Found Jellyfin user for quick connect', { userId, username });

            const { jellyfinAuthService } = await import('$lib/server/jellyfin/auth.service.js');
            const result = await jellyfinAuthService.quickConnect(code, userId);
            logger.info('Quick connect completed', { result });

            return json({ authorized: result === 0, message: 'Quick connect completed' });
        },
    },
});
