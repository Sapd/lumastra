// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { isPayloadTooLargeError } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { isStreamLimitNoticeReport } from '$lib/server/jellyfin-compat/stream-limit-notice';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser';
import {
    parsePlaybackBody,
    findOrCreateJellyfinSession,
    isPolicyError,
} from '$lib/server/jellyfin-compat/playback-utils';
import { getPlaySessionLifecycleService } from '$lib/server/services/play-session-lifecycle.service';
import { getFFmpegTranscodeService } from '$lib/server/services/ffmpeg-transcode.service';
import { aiDbService } from '$lib/server/services/database.service';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip';
import { renewPlayTokenBySession } from '$lib/server/jellyfin-compat/play-token';
import { getOwnerItemForFile } from '$lib/server/database/queries/media-files.queries';
import { moviePositionMs } from '$lib/server/jellyfin-compat/multi-part';
import { disarmSilentStart } from '$lib/server/jellyfin-compat/silent-start';

import { getMediaType } from '$lib/server/database/queries/media-type-cache.queries';

const logger = Logger.for('JellyfinCompat:PlaybackProgress');

export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        // Capture arrival order before body parsing, access checks and session
        // lookup can finish out of order for overlapping reports.
        const eventSeq = Date.now();
        const { request, locals } = event;

        const username = locals.user?.username;
        const userId = locals.user?.userId;
        if (!username || !userId) return ApiResponses.unauthorized();

        try {
            const {
                itemId,
                positionMs: reportedPositionMs,
                isPaused,
                playSessionId,
                mediaSourceId,
            } = await parsePlaybackBody(request);
            // The Live TV "stream limit reached" clip is not a stream: no
            // session row, no progress on the real item.
            if (await isStreamLimitNoticeReport({ playSessionId, mediaSourceId })) {
                return new Response(null, { status: 204 });
            }
            if (!itemId || !isUuid(itemId)) {
                return new Response(null, { status: 204 });
            }

            const sql = await aiDbService.getSql();
            if (!sql) return new Response(null, { status: 204 });

            // Channels have media_items UUIDs, but Live TV owns their sessions.
            if ((await getMediaType(sql, itemId)) === 'tvchannel') {
                return new Response(null, { status: 204 });
            }

            // Version picker sends a file UUID as ItemId — resolve to the owning media item
            const ownerItemId = await getOwnerItemForFile(sql, itemId);
            const resolvedItemId = ownerItemId ?? itemId;
            // Part 2..N of a multi-part movie reports a position inside the part.
            const positionMs = await moviePositionMs(sql, itemId, ownerItemId, reportedPositionMs);

            if (!(await checkMediaAccess(sql, resolvedItemId, locals.user))) {
                return ApiResponses.notFound();
            }

            // Renew the stream's play token only for an item the caller may
            // still play: a revoked library/age grant must not keep it alive.
            if (playSessionId) {
                renewPlayTokenBySession(playSessionId, {
                    userId: username,
                    itemId: resolvedItemId,
                }).catch(() => undefined);
            }

            // Progress means it is playing (some clients never send Sessions/Playing):
            // stand the silent-start detector down.
            void disarmSilentStart({
                playSessionId,
                username,
                itemId: resolvedItemId,
                userId,
                deviceId: locals.jfDevice?.deviceId ?? null,
            });

            // Security fix C15/P5 interaction (fix round 1, 2026-09-16): P5 made
            // this session resolve the caller's own per-user user_stream_policies
            // row (including require_single_ip) — the strict resolver is required
            // here for the same reason C15 required it at /api/play-sessions,
            // or a forged X-Forwarded-For could defeat that policy on /j too.
            const ip = getClientIpStrict(event);
            const result = await findOrCreateJellyfinSession(sql, {
                userId,
                // Security fix P5 (2026-09-16): thread the username through
                // so the enforceStreamPolicy lookup (keyed on username, an
                // intentional TEXT exception) can actually find an
                // admin-set per-user user_stream_policies row instead of
                // silently falling to the __default__ policy.
                username,
                itemId: resolvedItemId,
                playSessionId,
                positionMs,
                ipAddress: ip,
                device: locals.jfDevice,
            });

            if (isPolicyError(result)) {
                return ApiResponses.forbidden(`Stream policy: ${result.kind}`);
            }

            const service = getPlaySessionLifecycleService();
            await service.update(result.id, {
                position_ms: positionMs,
                status: isPaused ? 'PAUSED' : 'ACTIVE',
                event_seq: eventSeq,
            });
            // The /j play_sessions row has its own id, so the update above never
            // reaches the transcode job (keyed by the client's PlaySessionId). A
            // paused Jellyfin client fetches no segments; this keeps the reaper's
            // client-gone arm from taking it for an abandoned stream.
            if (playSessionId) {
                getFFmpegTranscodeService().recordProgressHeartbeat(
                    playSessionId,
                    isPaused ? 'PAUSED' : 'ACTIVE',
                    username,
                );
            }

            return new Response(null, { status: 204 });
        } catch (err) {
            if (isPayloadTooLargeError(err)) return ApiResponses.payloadTooLarge();
            logger.error('Failed to report playback progress', err as Error, {
                username,
            });
            return ApiResponses.error('Failed to report playback progress');
        }
    },
    { pat: 'deny', mode: 'write' },
);
