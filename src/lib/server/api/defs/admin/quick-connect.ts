// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/quick-connect — authorize a Quick Connect code on behalf of a user.
 *
 * POST /api/admin/quick-connect
 *   Body: { code, username } — admin enters a Quick Connect code for a target user.
 *   Feature-gated: quickConnect must be enabled.
 *
 * Auth: users:admin scope OR admin session (internal surface only).
 *
 * Response contract: bare { success, username }
 * Errors: problem+json (422 for invalid/expired code, 403 feature-off).
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { features } from '$lib/server/config.js';
import { jellyfinUserService, jellyfinAuthService } from '$lib/server/jellyfin/index.js';
import { Logger } from '$lib/server/utils/logger.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';
import { adminQuickConnectBodySchema } from '$lib/schemas/admin.js';
import { json } from '@sveltejs/kit';

const logger = Logger.for('AdminQuickConnect');

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    visibility: 'internal',
    request: {
        body: adminQuickConnectBodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const adminUser =
                event.locals.principal?.username ?? event.locals.user?.username ?? 'unknown';

            if (!features.quickConnect) {
                logger.warn('Quick Connect disabled, admin attempted to use', { adminUser });
                return ApiProblem.forbidden('Quick Connect is disabled');
            }

            // Body already validated by mount(); ctx.input!.body is typed + stripped.
            const { code, username } = ctx.input!.body;

            logger.info('Admin quick connect attempt', { adminUser, targetUsername: username });

            const jellyfinUser = await jellyfinUserService.getUserByName(username);
            if (!jellyfinUser?.Id) {
                logger.info('Target user not found in Jellyfin', {
                    adminUser,
                    targetUsername: username,
                });
                return ApiProblem.notFound('User not found in Jellyfin');
            }

            const result = await jellyfinAuthService.quickConnect(code, jellyfinUser.Id);
            if (result === 0) {
                // Signs a device in AS the target user: audit it like any
                // other credential grant.
                auditLog('user.quick_connect_authorize', username, auditActor(event), {
                    jellyfinUserId: jellyfinUser.Id,
                });
                logger.info('Admin quick connect successful', {
                    adminUser,
                    targetUsername: username,
                    jellyfinUserId: jellyfinUser.Id,
                });
                return json({ username });
            }

            logger.warn('Admin quick connect failed - invalid or expired code', {
                adminUser,
                targetUsername: username,
                result,
            });
            return ApiProblem.validationFailed('Invalid or expired Quick Connect code');
        },
    },
});
