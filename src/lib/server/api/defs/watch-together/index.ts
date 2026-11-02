// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/index.ts
 *
 *   GET  /watch-together           → bare { party: WatchTogetherParty | null }
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { toPublicParty } from '$lib/server/services/watch-together-public.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getUserActiveSession, getSession } from '$lib/server/services/watch-together.service.js';
import { isWidgetDisabled } from '$lib/server/utils/widget-guard.js';
import { WatchTogetherPartySchema } from '$lib/schemas/watch-together.js';

const logger = Logger.for('WatchTogether');

// ---------------------------------------------------------------------------
// Response schemas — bare objects, no success: boolean wrapper
// ---------------------------------------------------------------------------

export const GetActivePartyResponseSchema = z
    .object({
        party: WatchTogetherPartySchema.nullable(),
    })
    .meta({ id: 'WT_GetActivePartyResponse' });

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    handlers: {
        /**
         * GET /watch-together
         * Returns the authenticated user's current active session, or null.
         */
        GET: async (event, ctx) => {
            if (isWidgetDisabled('watch-parties')) {
                return json({ party: null });
            }

            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            try {
                const sessionCode = await getUserActiveSession(userId);
                if (!sessionCode) {
                    return json({ party: null });
                }
                const session = await getSession(sessionCode);
                return json({ party: session ? await toPublicParty(session, ctx.surface) : null });
            } catch (err) {
                logger.error('Get active session error', err as Error);
                return ApiProblem.internalError('Failed to get active session');
            }
        },
    },
});
