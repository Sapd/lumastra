// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * DELETE /j/Videos/ActiveEncodings?DeviceId=…&PlaySessionId=…
 *
 * Jellyfin clients call this to cancel the transcode behind a play session
 * (player closed, quality switch). Only the caller's own job is stopped; one on
 * another pod is flagged in its row and the owner's reaper ends it within a
 * sweep. DeviceId alone cannot name a /j job (they all carry the fixed
 * 'jellyfin-compat' device), so a call without a PlaySessionId is a no-op and
 * the client-gone reaper bounds that job instead. Always 204, like Jellyfin.
 */

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getParam } from '$lib/server/proprietary/jellyfin-compat/utils';
import { getFFmpegTranscodeService } from '$lib/server/services/ffmpeg-transcode.service';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { isUuid } from '$lib/server/utils/media-key-parser';

const logger = Logger.for('JellyfinCompat:ActiveEncodings');

export const DELETE: RequestHandler = withJellyfinAuth(
    async ({ url, locals }) => {
        const username = locals.user?.username;
        if (!username) return ApiResponses.unauthorized();

        const playSessionId = getParam(url, 'PlaySessionId');
        if (!playSessionId || !isUuid(playSessionId)) {
            logger.debug('Active encoding delete ignored (no usable PlaySessionId)', {
                hasPlaySessionId: playSessionId !== null,
                hasDeviceId: getParam(url, 'DeviceId') !== null,
            });
            return new Response(null, { status: 204 });
        }

        try {
            const stopped = await getFFmpegTranscodeService().stopJobForUser(
                playSessionId,
                username,
                'client_stopped',
            );
            logger.debug('Active encoding delete', { playSessionId, stopped });
        } catch (err) {
            logger.warn('Failed to stop active encoding', {
                playSessionId,
                error: String(err),
            });
        }
        return new Response(null, { status: 204 });
    },
    { pat: 'deny', mode: 'write' },
);
