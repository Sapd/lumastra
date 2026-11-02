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
import {
    parsePlaybackBody,
    findOrCreateJellyfinSession,
    enforceFreemiumStreamLimit,
    isPolicyError,
} from '$lib/server/proprietary/jellyfin-compat/playback-utils';
import { getPlaySessionLifecycleService } from '$lib/server/services/play-session-lifecycle.service';
import { disarmSilentStart } from '$lib/server/proprietary/jellyfin-compat/silent-start';
import { aiDbService } from '$lib/server/services/database.service';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip';
import { checkSessionKickCooldown } from '$lib/server/services/session-kill.service';
import { getOwnerItemForFile } from '$lib/server/database/queries/media-files.queries';
import { moviePositionMs } from '$lib/server/proprietary/jellyfin-compat/multi-part';

import { getMediaType } from '$lib/server/database/queries/media-type-cache.queries';

const logger = Logger.for('JellyfinCompat:PlaybackStarted');

export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { request, locals } = event;

        const username = locals.user?.username;
        const userId = locals.user?.userId;
        if (!username || !userId) return ApiResponses.unauthorized();

        const kickStatus = await checkSessionKickCooldown(username);
        if (kickStatus.kicked) {
            return ApiResponses.kicked(kickStatus.remainingSeconds!);
        }

        try {
            const {
                itemId,
                positionMs: reportedPositionMs,
                playSessionId,
                mediaSourceId,
            } = await parsePlaybackBody(request);
            // The free-tier "stream limit reached" clip is not a stream: no
            // session row, no progress on the real item, no slot in the cap.
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

            // The client reports it is playing: stand the silent-start detector down.
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
                    itemId,
                    policy: result.kind,
                });
                return ApiResponses.forbidden(`Stream policy: ${result.kind}`);
            }

            // Freemium concurrency: while a recent kick still bans the user, an
            // extra stream is torn down immediately (zero grace) even at start.
            if (
                await enforceFreemiumStreamLimit(sql, userId, result.id, positionMs, playSessionId)
            ) {
                return ApiResponses.kicked(0);
            }

            const service = getPlaySessionLifecycleService();
            // Jellyfin compat clients have no event_seq concept; use wall-clock ms
            // so successive calls within the same session are strictly increasing.
            await service.update(result.id, {
                position_ms: positionMs,
                status: 'ACTIVE',
                event_seq: Date.now(),
            });

            logger.debug('Playback started', {
                username,
                itemId,
                positionMs,
            });

            return new Response(null, { status: 204 });
        } catch (err) {
            if (isPayloadTooLargeError(err)) return ApiResponses.payloadTooLarge();
            logger.error('Failed to report playback start', err as Error, {
                username,
            });
            return ApiResponses.error('Failed to report playback start');
        }
    },
    { pat: 'deny', mode: 'write' },
);
