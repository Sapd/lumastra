// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/watch-together/[code]/sync.ts
 *
 *   POST /watch-together/{code}/sync → 204 No Content
 *
 * Updates the authoritative playback state for the session.
 * Host-only in practice (enforced by service).
 *
 * Auth: feature(FEATURE_WATCH_TOGETHER) → user
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { updatePlaybackState } from '$lib/server/services/watch-together.service.js';
import { sessionCodeParamsSchema, syncStateSchema } from '$lib/schemas/watch-together.js';
import type { WatchTogetherState } from '$lib/types/watch-together.js';

const logger = Logger.for('WatchTogether');

export const def = defineEndpoint({
    auth: {
        kind: 'feature',
        flag: 'FEATURE_WATCH_TOGETHER',
        then: { kind: 'user' },
    },
    request: {
        params: sessionCodeParamsSchema,
        body: syncStateSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            if (!user?.username || !userId) return ApiProblem.unauthorized();

            const code = (ctx.input?.params as { code?: string })?.code ?? event.params.code!;
            const body = ctx.input?.body as
                | {
                      currentTime: number;
                      isPlaying: boolean;
                      playbackRate?: number;
                      clientId: string;
                      itemId?: string;
                      expectedTimelineId?: string;
                      syncId?: string;
                  }
                | undefined;

            const currentTime = body?.currentTime ?? 0;
            const isPlaying = body?.isPlaying ?? false;
            const playbackRate = body?.playbackRate ?? 1;
            const clientId = body?.clientId ?? '';

            try {
                const state: WatchTogetherState = {
                    currentTime,
                    isPlaying,
                    playbackRate,
                    timestamp: Date.now(),
                };
                const ok = await updatePlaybackState(
                    code,
                    userId,
                    state,
                    clientId,
                    body?.itemId,
                    body?.expectedTimelineId,
                    body?.syncId,
                );
                if (!ok) {
                    return ApiProblem.forbidden('Not a participant or session not found');
                }
                return new Response(null, { status: 204 });
            } catch (err) {
                logger.error('Sync playback state error', err as Error, { code });
                return ApiProblem.internalError('Failed to sync playback state');
            }
        },
    },
});
