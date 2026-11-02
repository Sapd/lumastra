// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/playback/session.ts — GET /playback/session?itemId=...
 *
 * Returns debug information about the current active playback session for a
 * specific item owned by the authenticated user.
 *
 * Auth: {kind:'user'} — any authenticated user; ownership checked inside handler.
 *
 * Response: bare object { found, ...sessionFields } (PlaybackSessionDebugResponse).
 * Errors:
 *   503 dependency_unavailable — DB unavailable.
 *   400 validation_failed      — missing itemId query param.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getDb } from '$lib/server/database/connection.js';
import { findActiveSession } from '$lib/server/database/queries/play-sessions.queries.js';

const logger = Logger.for('PlaybackSessionDef');

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const PlaybackSessionQuery = z.object({
    itemId: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Delivery flags
// ---------------------------------------------------------------------------

export interface SessionDeliveryFlags {
    playMethod: 'DirectPlay' | 'DirectStream' | 'Transcode';
    isTranscoding: boolean;
    isVideoDirect: boolean;
    isAudioDirect: boolean;
}

/**
 * Map a stored `play_sessions.play_method` onto the coarse Jellyfin-style
 * delivery flags this debug endpoint reports.
 *
 * ONE decision point per method, so the four fields can never contradict each
 * other. The if-chain this replaced derived `isTranscoding` from an explicit
 * list that omitted `'audio_only'`, while `playMethod` came from a separate
 * ternary whose fallthrough *did* cover it — so an audio-only session was
 * reported as `playMethod: 'Transcode'` with `isVideoDirect: true` and
 * `isAudioDirect: true` at the same time.
 *
 * `audio_only` drops video entirely (`-vn`) and re-encodes audio to AAC, so
 * neither stream is direct; the coarse vocabulary has no rung for it and
 * reports `'Transcode'`, matching play-sessions.service.ts.
 *
 * `audio_transcode`, `full_transcode`, the legacy `transcode`, and anything a
 * future migration widens the CHECK to all land in the default (fully
 * transcoding, nothing direct) — the safe bucket for an unrecognised method.
 */
export function deriveSessionDeliveryFlags(playMethod: string): SessionDeliveryFlags {
    switch (playMethod) {
        case 'direct':
            return {
                playMethod: 'DirectPlay',
                isTranscoding: false,
                isVideoDirect: true,
                isAudioDirect: true,
            };
        case 'remux':
            return {
                playMethod: 'DirectStream',
                isTranscoding: false,
                isVideoDirect: true,
                isAudioDirect: true,
            };
        case 'audio_only':
            return {
                playMethod: 'Transcode',
                isTranscoding: true,
                isVideoDirect: false,
                isAudioDirect: false,
            };
        default:
            return {
                playMethod: 'Transcode',
                isTranscoding: true,
                isVideoDirect: false,
                isAudioDirect: false,
            };
    }
}

// ---------------------------------------------------------------------------
// Def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    request: {
        query: PlaybackSessionQuery,
    },

    handlers: {
        /**
         * GET /api/playback/session?itemId=...
         *
         * Returns current playback session debug info for the authenticated user
         * and the given itemId.
         */
        GET: async (event, ctx) => {
            const itemId = ctx.input?.query?.itemId;
            if (!itemId) {
                return ApiProblem.validationFailed([
                    { field: 'query.itemId', message: 'Missing itemId parameter' },
                ]);
            }

            const username = event.locals.user?.username;
            const userId = event.locals.user?.userId;
            if (!username || !userId) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            try {
                const session = await findActiveSession(sql, { userId, itemId });

                if (!session) {
                    return json({
                        found: false,
                        message: 'Session not found',
                        lookingFor: { itemId, username },
                        availableSessions: [],
                    });
                }

                const delivery = deriveSessionDeliveryFlags(session.play_method);

                return json({
                    found: true,
                    playMethod: delivery.playMethod,
                    isPaused: session.status === 'PAUSED',
                    positionTicks: Number(session.position_ms) * 10000,
                    isTranscoding: delivery.isTranscoding,
                    isVideoDirect: delivery.isVideoDirect,
                    isAudioDirect: delivery.isAudioDirect,
                    videoCodec: session.video_codec ?? undefined,
                    audioCodec: session.audio_codec ?? undefined,
                    transcodeReasons: [],
                    bitrate: session.bitrate_kbps ? session.bitrate_kbps * 1000 : undefined,
                    itemId: session.media_id,
                    transcodeInfo: undefined,
                });
            } catch (error) {
                logger.error('Failed to get playback session', error as Error);
                return ApiProblem.internalError('Failed to get playback session');
            }
        },
    },
});
