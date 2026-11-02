// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * music/progress — kick-cooldown heartbeat.
 *
 * POST music/progress
 *   Validates that the requesting user has not had their session terminated by
 *   an admin. Performs no database writes — playback progress is recorded via
 *   POST music/progress/start (play start) and POST music/progress/end (play end).
 *   Returns 403 when the user is in a kick-cooldown window.
 *
 * Auth: {kind:'user'} — any authenticated session.
 * Visibility: internal (dashboard-only; no automation value).
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { MusicProgressRequestSchema } from '$lib/schemas/music.js';
import { checkSessionKickCooldown } from '$lib/server/services/session-kill.service.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('MusicProgressAPI');

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: {
        body: MusicProgressRequestSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const kickStatus = await checkSessionKickCooldown(user.username);
            if (kickStatus.kicked) {
                return problem('forbidden', {
                    error: `Session terminated by admin. Try again in ${kickStatus.remainingSeconds}s.`,
                });
            }

            // ctx.input.body is pre-validated by mount() — no re-parse needed.
            // Fall back to manual parse for legacy callers that bypass mount().
            let body: { trackId: string; positionMs: number };
            if (ctx.input?.body) {
                body = ctx.input.body;
            } else {
                try {
                    const raw = await event.request.json();
                    body = MusicProgressRequestSchema.parse(raw);
                } catch {
                    return problem('validation_failed', {
                        error: 'Request body must include trackId (string) and positionMs (int)',
                    });
                }
            }

            // NOTE: This endpoint is a kick-cooldown check + log only.
            // DB writes happen via the play-start/play-end endpoints;
            // the live "Now Streaming" feed is sourced from play_sessions
            // via SessionReadModel, not from a per-pod cache.
            logger.debug('Music progress check', {
                username: user.username,
                trackId: body.trackId,
                positionMs: body.positionMs,
            });

            return json({ ok: true });
        },
    },
});
