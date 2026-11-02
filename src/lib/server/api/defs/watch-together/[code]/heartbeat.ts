// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/[code]/heartbeat.ts
 *
 *   POST /watch-together/{code}/heartbeat → 204 No Content
 *
 * Updates the host's current position in-place without broadcasting to other
 * participants. Used to keep session state fresh for new joiners.
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { updateSessionPosition } from '$lib/server/services/watch-together.service.js';
import { sessionCodeParamsSchema, heartbeatSchema } from '$lib/schemas/watch-together.js';

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        params: sessionCodeParamsSchema,
        body: heartbeatSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = ((ctx.input?.params as { code?: string })?.code ?? event.params.code)!;
            const body = ctx.input?.body as
                | {
                      currentTime: number;
                      clientId: string;
                      isPlaying?: boolean;
                      itemId?: string;
                      expectedTimelineId?: string;
                  }
                | undefined;
            const currentTime = body?.currentTime ?? 0;
            const clientId = body?.clientId ?? '';

            const ok = await updateSessionPosition(
                code,
                userId,
                currentTime,
                clientId,
                body?.isPlaying,
                body?.itemId,
                body?.expectedTimelineId,
            );
            if (!ok) return ApiProblem.notFound('Session not found or not a participant');
            return new Response(null, { status: 204 });
        },
    },
});
