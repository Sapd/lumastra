// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { isPayloadTooLargeError } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser';
import {
    parsePlaybackReport,
    findOrCreateJellyfinSession,
    isPolicyError,
} from '$lib/server/proprietary/jellyfin-compat/playback-utils';
import { getPlaySessionLifecycleService } from '$lib/server/services/play-session-lifecycle.service';
import { aiDbService } from '$lib/server/services/database.service';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip';
import { getFFmpegTranscodeService } from '$lib/server/services/ffmpeg-transcode.service';
import { renewPlayTokenBySession } from '$lib/server/proprietary/jellyfin-compat/play-token';
import { disarmSilentStart } from '$lib/server/proprietary/jellyfin-compat/silent-start';

import { getOwnerItemForFile } from '$lib/server/database/queries/media-files.queries';
import { moviePositionMs } from '$lib/server/proprietary/jellyfin-compat/multi-part';
import { getMediaType } from '$lib/server/database/queries/media-type-cache.queries';

const logger = Logger.for('JellyfinCompat:PlayingItemsProgress');

// POST /j/Users/{userId}/PlayingItems/{itemId}/Progress (also /PlayingItems/{itemId}/Progress)
// Symfonium: periodic progress update. Jellyfin sends positionTicks / isPaused /
// playSessionId as QUERY params here (PlaystateController.OnPlaybackProgress).
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
            const {
                positionMs: reportedPositionMs,
                isPaused,
                playSessionId,
            } = await parsePlaybackReport(event.url, request);
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

            // Only after the access check: a revoked grant must not keep the
            // stream's play token alive.
            if (playSessionId) {
                renewPlayTokenBySession(playSessionId, {
                    userId: username,
                    itemId: resolvedItemId,
                }).catch(() => undefined);
            }

            // Progress means it is playing (some clients never report a start):
            // stand the silent-start detector down, as /Sessions/Playing/Progress does.
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
                event_seq: Date.now(),
            });
            // Keep the client's transcode alive (Jellyfin pings the job on every
            // progress report). Same call as /Sessions/Playing/Progress: the /j
            // play_sessions row has its own id, so the update above never reaches
            // the job keyed by the client's PlaySessionId.
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
            logger.error('Failed to report playback progress (PlayingItems)', err as Error, {
                username,
                itemId: params.itemId,
            });
            return ApiResponses.error('Failed to report playback progress');
        }
    },
    { pat: 'deny', mode: 'write' },
);
