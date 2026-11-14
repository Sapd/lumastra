// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { isPayloadTooLargeError } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser';
import {
    parsePlaybackReport,
    findOrCreateJellyfinSession,
    isPolicyError,
} from '$lib/server/jellyfin-compat/playback-utils';
import { getPlaySessionLifecycleService } from '$lib/server/services/play-session-lifecycle.service';
import { findActiveSession } from '$lib/server/database/queries/play-sessions.queries';
import { aiDbService } from '$lib/server/services/database.service';
import { getFFmpegTranscodeService } from '$lib/server/services/ffmpeg-transcode.service';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip';
import { disarmSilentStart } from '$lib/server/jellyfin-compat/silent-start';

import { getOwnerItemForFile } from '$lib/server/database/queries/media-files.queries';
import { moviePositionMs } from '$lib/server/jellyfin-compat/multi-part';
import { getMediaType } from '$lib/server/database/queries/media-type-cache.queries';

const logger = Logger.for('JellyfinCompat:PlayingItems');

// Jellyfin's legacy playstate routes (PlaystateController: OnPlaybackStart /
// OnPlaybackStopped, and OnPlaybackProgress in ./Progress). Also mounted at the
// userless /PlayingItems/{itemId}. Jellyfin binds every value from the QUERY
// (positionTicks, isPaused, playSessionId, mediaSourceId, …) — see
// parsePlaybackReport; a JSON body is still read for what the query leaves out.

// POST /j/Users/{userId}/PlayingItems/{itemId}
// Symfonium: playback started
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { request, locals, params } = event;

        const username = locals.user?.username;
        const userId = locals.user?.userId;
        if (!username || !userId) return ApiResponses.unauthorized();

        const itemId = params.itemId ?? '';
        if (!itemId || !isUuid(itemId)) {
            return new Response(null, { status: 204 });
        }

        try {
            const { positionMs: reportedPositionMs, playSessionId } = await parsePlaybackReport(
                event.url,
                request,
            );

            const sql = await aiDbService.getSql();
            if (!sql) return new Response(null, { status: 204 });

            // Channels have media_items UUIDs, but Live TV owns their sessions.
            if ((await getMediaType(sql, itemId)) === 'tvchannel') {
                return new Response(null, { status: 204 });
            }

            const ownerItemId = await getOwnerItemForFile(sql, itemId);
            const resolvedItemId = ownerItemId ?? itemId;
            const positionMs = await moviePositionMs(sql, itemId, ownerItemId, reportedPositionMs);

            if (!(await checkMediaAccess(sql, resolvedItemId, locals.user))) {
                return ApiResponses.notFound();
            }

            // The client reports it is playing: stand the silent-start detector
            // down, as /Sessions/Playing does.
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
                logger.info('Stream policy blocked session', {
                    username,
                    itemId: resolvedItemId,
                    policy: result.kind,
                });
                return ApiResponses.forbidden(`Stream policy: ${result.kind}`);
            }

            const service = getPlaySessionLifecycleService();
            // Jellyfin compat clients have no event_seq concept; use wall-clock ms
            // so successive calls within the same session are strictly increasing.
            await service.update(result.id, {
                position_ms: positionMs,
                status: 'ACTIVE',
                event_seq: Date.now(),
            });

            logger.debug('Playback started (PlayingItems)', {
                username,
                itemId: resolvedItemId,
                playSessionId,
                positionMs,
            });

            return new Response(null, { status: 204 });
        } catch (err) {
            if (isPayloadTooLargeError(err)) return ApiResponses.payloadTooLarge();
            logger.error('Failed to report playback start (PlayingItems)', err as Error, {
                username,
                itemId: params.itemId,
            });
            return ApiResponses.error('Failed to report playback start');
        }
    },
    { pat: 'deny', mode: 'write' },
);

// DELETE /j/Users/{userId}/PlayingItems/{itemId}
// Symfonium: playback stopped
export const DELETE: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { request, locals, params } = event;

        const username = locals.user?.username;
        const userId = locals.user?.userId;
        if (!username || !userId) return ApiResponses.unauthorized();

        const itemId = params.itemId ?? '';
        if (!itemId || !isUuid(itemId)) {
            return new Response(null, { status: 204 });
        }

        try {
            // Jellyfin clients send the stop position as ?positionTicks= — a
            // body-only read saved 0 here and wiped the resume point.
            const { positionMs: reportedPositionMs, playSessionId } = await parsePlaybackReport(
                event.url,
                request,
            );

            const sql = await aiDbService.getSql();
            if (!sql) return new Response(null, { status: 204 });

            // Channels have media_items UUIDs, but Live TV owns their sessions.
            if ((await getMediaType(sql, itemId)) === 'tvchannel') {
                return new Response(null, { status: 204 });
            }

            const ownerItemId = await getOwnerItemForFile(sql, itemId);
            const resolvedItemId = ownerItemId ?? itemId;
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

            // Jellyfin kills the transcode the report names. stopJobForUser only
            // stops a job of THIS user, so a client-supplied id cannot end someone
            // else's transcode. Without an id, fall back to item + user — but only
            // when a session of this user proves the item was playing (as
            // /Sessions/Playing/Stopped does).
            const transcodes = getFFmpegTranscodeService();
            const stop = playSessionId
                ? transcodes.stopJobForUser(playSessionId, username, 'client_stopped')
                : session
                  ? transcodes.stopJobByItemAndUser(resolvedItemId, username, 'client_stopped')
                  : Promise.resolve(false);
            stop.catch(() => {});

            logger.debug('Playback stopped (PlayingItems)', {
                username,
                itemId: resolvedItemId,
                playSessionId,
                positionMs,
            });

            return new Response(null, { status: 204 });
        } catch (err) {
            if (isPayloadTooLargeError(err)) return ApiResponses.payloadTooLarge();
            logger.error('Failed to report playback stopped (PlayingItems)', err as Error, {
                username,
                itemId: params.itemId,
            });
            return ApiResponses.error('Failed to report playback stopped');
        }
    },
    { pat: 'deny', mode: 'write' },
);
