// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /Sessions/Playing/Ping?playSessionId=…
 *
 * Jellyfin (PlaystateController.PingPlaybackSession): no body, always 204; its
 * only effect is resetting the transcode job's kill timer. Clients ping while
 * paused or between progress reports, so without this a paused stream looked
 * abandoned to the reaper's client-gone arm.
 *
 * A ping carries no play state, so it refreshes the job as PAUSED: that keeps
 * the job alive without claiming it is actively playing (ACTIVE would also
 * refresh `lastActiveProgressAt` and protect the job from eviction). The
 * username binds the ping to the caller's own job. An unknown playSessionId is
 * still a 204 (nothing to keep alive); a missing one is a plain 400, as
 * Jellyfin's `[Required]` model validation answers (ApiResponses.badRequest
 * would be a 422).
 */

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getParam } from '$lib/server/proprietary/jellyfin-compat/utils';
import { getFFmpegTranscodeService } from '$lib/server/services/ffmpeg-transcode.service';
import { ApiResponses } from '$lib/server/utils/api-responses';

export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const username = event.locals.user?.username;
        if (!username) return ApiResponses.unauthorized();

        const playSessionId = getParam(event.url, 'PlaySessionId')?.trim();
        if (!playSessionId) {
            return new Response(JSON.stringify({ error: 'playSessionId is required' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' },
            });
        }
        getFFmpegTranscodeService().recordProgressHeartbeat(playSessionId, 'PAUSED', username);
        return new Response(null, { status: 204 });
    },
    { pat: 'deny', mode: 'write' },
);
