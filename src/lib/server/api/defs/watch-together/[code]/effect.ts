// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/[code]/effect.ts
 *
 *   POST /watch-together/{code}/effect → 204 No Content
 *
 * Broadcasts a screen effect to all session participants.
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { broadcastScreenEffect } from '$lib/server/services/watch-together.service.js';
import { sessionCodeParamsSchema, effectSchema } from '$lib/schemas/watch-together.js';
import type { ScreenEffect } from '$lib/types/watch-together.js';

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        params: sessionCodeParamsSchema,
        body: effectSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = ((ctx.input?.params as { code?: string })?.code ?? event.params.code)!;
            const effect = (ctx.input?.body as { effect?: string })?.effect ?? '';

            const ok = await broadcastScreenEffect(code, userId, effect as ScreenEffect);
            if (!ok) return ApiProblem.notFound('Session not found or user not a participant');
            return new Response(null, { status: 204 });
        },
    },
});
