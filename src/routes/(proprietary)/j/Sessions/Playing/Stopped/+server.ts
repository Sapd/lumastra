// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { isPayloadTooLargeError } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { isStreamLimitNoticeReport } from '$lib/server/proprietary/jellyfin-compat/stream-limit-notice';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser';
import { parsePlaybackBody } from '$lib/server/proprietary/jellyfin-compat/playback-utils';
import { getPlaySessionLifecycleService } from '$lib/server/services/play-session-lifecycle.service';
import { findActiveSession } from '$lib/server/database/queries/play-sessions.queries';
import { getFFmpegTranscodeService } from '$lib/server/services/ffmpeg-transcode.service';
import { aiDbService } from '$lib/server/services/database.service';
import { getOwnerItemForFile } from '$lib/server/database/queries/media-files.queries';
import { moviePositionMs } from '$lib/server/proprietary/jellyfin-compat/multi-part';

import { getMediaType } from '$lib/server/database/queries/media-type-cache.queries';

const logger = Logger.for('JellyfinCompat:PlaybackStopped');

export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { request, locals } = event;

        const username = locals.user?.username;
        const userId = locals.user?.userId;
        if (!username || !userId) return ApiResponses.unauthorized();

        try {
            const {
                itemId,
                positionMs: reportedPositionMs,
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

            const session = await findActiveSession(sql, {
                userId,
                itemId: resolvedItemId,
                playSessionId,
            });

            if (session) {
                const service = getPlaySessionLifecycleService();
                await service.update(session.id, {
                    position_ms: positionMs,
                    status: 'COMPLETED',
                    stop_reason: 'jellyfin_client',
                    event_seq: Date.now(),
                });
            }

            // Stop the transcode the report names. Android TV sends the old
            // session's Stopped right as it starts a new one (audio/subtitle
            // switch); stopping by item + user could hit the wrong session, and
            // skipping the stop when no play_sessions row matched left the old
            // 4K transcode running next to the new one until the pod OOMed.
            // Item + user is only for reports WITHOUT a session id: after a
            // switch the named old job may already be gone, and guessing by
            // item + user would then stop the NEW session's transcode.
            const transcodes = getFFmpegTranscodeService();
            const stop = playSessionId
                ? transcodes.stopJobForUser(playSessionId, username, 'client_stopped')
                : session
                  ? transcodes.stopJobByItemAndUser(resolvedItemId, username, 'client_stopped')
                  : Promise.resolve(false);
            stop.then((stopped) => {
                // A client that built its own stream URL has a transcode under
                // another id; the client-gone reaper ends that one.
                if (!stopped && playSessionId) {
                    logger.info('Stopped report named no transcode of this user', {
                        playSessionId,
                        itemId: resolvedItemId,
                    });
                }
            }).catch((err) => {
                logger.warn('Stopped report: transcode stop failed', {
                    playSessionId,
                    itemId: resolvedItemId,
                    error: String(err),
                });
            });

            logger.debug('Playback stopped — progress saved', {
                username,
                itemId,
                positionMs,
            });

            return new Response(null, { status: 204 });
        } catch (err) {
            if (isPayloadTooLargeError(err)) return ApiResponses.payloadTooLarge();
            logger.error('Failed to report playback stopped', err as Error, {
                username,
            });
            return ApiResponses.error('Failed to report playback stopped');
        }
    },
    { pat: 'deny', mode: 'write' },
);
