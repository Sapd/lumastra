// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { isStreamLimitRequestBanned } from '$lib/server/proprietary/jellyfin-compat/stream-limit-access';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleDownloadFile } from '$lib/server/handlers/media-download-handler';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { toLibraryAccessUser } from '$lib/server/cache/library-group-permissions-cache.js';
import { checkSessionKickCooldown } from '$lib/server/services/session-kill.service';
import { validatePlayToken } from '$lib/server/proprietary/jellyfin-compat/play-token';
import { disarmSilentStart } from '$lib/server/proprietary/jellyfin-compat/silent-start';

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const username = event.locals.user?.username;
    const kickStatus = username ? await checkSessionKickCooldown(username) : null;
    if (kickStatus?.kicked) {
        return ApiResponses.kicked(kickStatus.remainingSeconds!);
    }

    let itemId = event.params.itemId;
    if (!itemId) {
        return ApiResponses.badRequest('Item ID is required');
    }

    // Streamyfin downloads `/Items/{MediaSources[0].Id}/Download`, and our
    // PlaybackInfo hands out a per-file play token as MediaSource.Id. Resolve it
    // to the item + file it names — only the caller's own token, so a token
    // cannot widen access beyond what this user's own PlaybackInfo granted.
    const fileToken = await validatePlayToken(itemId);
    if (
        event.locals.user?.userId &&
        (await isStreamLimitRequestBanned(
            event,
            event.locals.user.userId,
            fileToken?.userId === username ? fileToken : undefined,
        ))
    )
        return ApiResponses.kicked(0);
    if (fileToken?.fileId && username && fileToken.userId === username) {
        itemId = fileToken.itemId;
        (event.params as Record<string, string>).itemId = itemId;
        event.url.searchParams.set('mediaSourceId', fileToken.fileId);
    }

    const sql = getDb();
    if (sql) {
        const allowed = await checkMediaAccess(sql, itemId, event.locals.user);
        if (!allowed) {
            return ApiResponses.notFound('Media');
        }
    } else if (!toLibraryAccessUser(event.locals.user)?.isAdmin) {
        return ApiResponses.error('Unable to verify content access');
    }

    void disarmSilentStart({
        username,
        itemId,
        userId: event.locals.user?.userId ?? null,
        deviceId: event.locals.jfDevice?.deviceId ?? null,
    });
    return handleDownloadFile(event);
});
