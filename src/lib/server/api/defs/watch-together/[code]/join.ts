// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/[code]/join.ts
 *
 *   POST /watch-together/{code}/join → bare { party: WatchTogetherParty }
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { toPublicParty } from '$lib/server/services/watch-together-public.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { joinSession } from '$lib/server/services/watch-together.service.js';
import { checkJoinRateLimit } from './join-rate-limit.js';
import {
    sessionCodeParamsSchema,
    joinSessionSchema,
    WatchTogetherPartySchema,
} from '$lib/schemas/watch-together.js';

const logger = Logger.for('WatchTogether');

export const JoinPartyResponseSchema = z
    .object({
        party: WatchTogetherPartySchema,
    })
    .meta({ id: 'WT_JoinPartyResponse' });

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        params: sessionCodeParamsSchema,
        body: joinSessionSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = (ctx.input?.params as { code?: string })?.code ?? event.params.code!;
            const clientId = (ctx.input?.body as { clientId?: string })?.clientId ?? '';

            try {
                const rl = await checkJoinRateLimit(code, userId, clientId);
                if (!rl.allowed) return ApiProblem.rateLimited(rl.retryAfter);

                // `event.locals.user` carries the library groups and max_age_rating
                // joinSession needs — it gates the item before disclosing it.
                // Denial is deliberately indistinguishable from "no such party".
                const session = await joinSession(
                    code,
                    userId,
                    user.username,
                    clientId,
                    event.locals.user,
                );
                if (!session) return ApiProblem.notFound('Session not found or expired');
                return json({ party: await toPublicParty(session, ctx.surface) });
            } catch (err) {
                logger.error('Join session error', err as Error, { code });
                return ApiProblem.internalError('Failed to join session');
            }
        },
    },
});
