// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/user/data-reset.ts — POST /user/data/reset
 *
 * Self-service reset of a user's music/VOD tracking, feedback, or
 * recommendation state. `action` selects the scope (see RESET_ACTIONS);
 * DESTRUCTIVE_ACTIONS (history/feedback hard-deletes) require `confirm: true`
 * to guard against accidental data loss from a mis-fired request.
 *
 * Auth: {kind:'user'} — self-scoped, no admin override.
 * Rate-limited: 5 req / 60 s per user.
 * Errors: problem+json, incl. 422 validation_failed (missing confirm),
 *   429 rate_limited, 500 internal_error.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { denyUnlessInteractiveSession } from '$lib/server/api/token-minting.js';
import { Logger } from '$lib/server/utils/logger.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { userDataResetManager } from '$lib/server/services/user-data-reset.service.js';
import {
    userDataResetBodySchema,
    UserDataResetResponseSchema,
    DESTRUCTIVE_ACTIONS,
} from '$lib/schemas/api-user-data-reset.js';

const logger = Logger.for('UserDataResetDef');

const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW_S = 60;

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    request: {
        body: userDataResetBodySchema,
    },

    handlers: {
        POST: async (event, ctx) => {
            const notInteractive = denyUnlessInteractiveSession(event);
            if (notInteractive) return notInteractive;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            const body = ctx.input!.body;

            if (DESTRUCTIVE_ACTIONS.has(body.action) && body.confirm !== true) {
                return ApiProblem.validationFailed([
                    { field: 'confirm', message: 'confirmation required for this action' },
                ]);
            }

            const rl = await checkRateLimit(
                `user-data-reset:${userId}`,
                RATE_LIMIT_MAX,
                RATE_LIMIT_WINDOW_S,
            );
            if (!rl.allowed) {
                return ApiProblem.rateLimited(Math.ceil(rl.resetAt - Date.now() / 1000));
            }

            try {
                const cleared = await userDataResetManager.run(userId, body.action);
                return json(UserDataResetResponseSchema.parse({ action: body.action, cleared }));
            } catch (error) {
                logger.error('user data reset failed', error as Error, {
                    userId,
                    action: body.action,
                });
                return ApiProblem.internalError('Failed to reset data');
            }
        },
    },
});
