// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/play-sessions/[id]/transcode-progress.ts — GET /play-sessions/{id}/transcode-progress
 *
 * Live transcode progress for the player's info badge. The heartbeat ack
 * (PUT /play-sessions/{id}) carries the same payload, but heartbeats run every
 * 30 s — far too slow for a progress readout — so the web player polls this
 * while a transcode is running.
 *
 * Auth: {kind:'scope', anyOf:['media:read']} plus an owner check in the
 * handler. Not-owned → 404 (existence-leak convention).
 * Response: 200 `{ transcode: payload | null }`.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { getSessionById } from '$lib/server/database/queries/play-sessions.queries.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getFFmpegTranscodeService } from '$lib/server/services/ffmpeg-transcode.service.js';

const TranscodeProgressParams = z.object({ id: z.string().guid() });

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:read'] },
    request: { params: TranscodeProgressParams },
    handlers: {
        GET: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiResponses.error('Database unavailable');

            const userId = event.locals.user?.userId;
            if (!userId) return ApiResponses.unauthorized();

            const sessionId = ctx.input!.params!.id;
            const session = await getSessionById(sql, sessionId);
            if (!session || session.user_id !== userId) return ApiResponses.notFound('Session');

            if (['CRASHED', 'COMPLETED', 'KILLED'].includes(session.status)) {
                return ApiResponses.notFound('Session');
            }

            const transcode =
                session.transcode_job_id || session.play_method !== 'direct'
                    ? await getFFmpegTranscodeService().getPlayerTranscodeProgressMultiPod(
                          sessionId,
                      )
                    : undefined;
            // Same payload as the heartbeat ack's `transcode` field (built by the
            // same service call, so it shares that route's untyped body).
            const body = { transcode: transcode ?? null };
            return new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
            });
        },
    },
});
