// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/[code]/index.ts
 *
 *   GET    /watch-together/{code} → bare { party: WatchTogetherParty }
 *   DELETE /watch-together/{code} → 204 No Content
 *
 * GET: returns the session if the caller is a participant.
 * DELETE: host-only; ends the session gracefully.
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { toPublicParty } from '$lib/server/services/watch-together-public.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    getSession,
    getSessionWithParticipant,
    endSession,
} from '$lib/server/services/watch-together.service.js';
import { sessionCodeParamsSchema, WatchTogetherPartySchema } from '$lib/schemas/watch-together.js';
import { z } from 'zod';

const logger = Logger.for('WatchTogether');

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

export const GetPartyResponseSchema = z
    .object({
        party: WatchTogetherPartySchema,
    })
    .meta({ id: 'WT_GetPartyResponse' });

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        params: sessionCodeParamsSchema,
    },
    handlers: {
        /**
         * GET /watch-together/{code}
         * Returns the session if the authenticated user is a participant.
         */
        GET: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = ((ctx.input?.params as { code?: string })?.code ?? event.params.code)!;

            try {
                const result = await getSessionWithParticipant(code, userId);
                if (!result) {
                    const session = await getSession(code);
                    if (!session) return ApiProblem.notFound('Session not found');
                    return ApiProblem.forbidden('Not a participant in this session');
                }
                return json({ party: await toPublicParty(result.session, ctx.surface) });
            } catch (err) {
                logger.error('Get session error', err as Error, { code });
                return ApiProblem.internalError('Failed to get session');
            }
        },

        /**
         * DELETE /watch-together/{code}
         * Host ends the session. Returns 204.
         */
        DELETE: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = ((ctx.input?.params as { code?: string })?.code ?? event.params.code)!;

            try {
                const success = await endSession(code, userId);
                if (!success) {
                    return ApiProblem.forbidden(
                        'Cannot end session (not host or session not found)',
                    );
                }
                return new Response(null, { status: 204 });
            } catch (err) {
                logger.error('End session error', err as Error, { code });
                return ApiProblem.internalError('Failed to end session');
            }
        },
    },
});
