// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import type { RequestHandler } from './$types';
import { disarmSilentStart } from '$lib/server/proprietary/jellyfin-compat/silent-start';
import { getParam } from '$lib/server/proprietary/jellyfin-compat/utils';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleStreamFile } from '$lib/server/proprietary/jellyfin-compat/stream-file-handler';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { toLibraryAccessUser } from '$lib/server/cache/library-group-permissions-cache.js';
import { checkSessionKickCooldown } from '$lib/server/services/session-kill.service';
import {
    validatePlayToken,
    renewPlayTokenBySession,
} from '$lib/server/proprietary/jellyfin-compat/play-token';
import {
    applyPlayTokenIdentity,
    buildPlayTokenUserContext,
} from '$lib/server/proprietary/jellyfin-compat/play-token-user';
import { getOwnerItemForFile } from '$lib/server/database/queries/media-files.queries';
import type { UserContext } from '$lib/server/types';
import { serveStreamLimitClipFile } from '$lib/server/proprietary/jellyfin-compat/stream-limit-notice';

// The play-token paths below bypass withJellyfinAuth (ExoPlayer / AVPlayer can't
// send auth headers, so the token rides in the URL) — which also skips the
// library + age access check that the authenticated handler performs. A play
// token is issued at PlaybackInfo time (access-checked then) and is renewable,
// so without re-checking here a user whose library/age access was revoked AFTER
// issuance would keep streaming the item. Re-check at serve time (404 on denial,
// matching the convention). Cached, so the cost is negligible.
async function enforceTokenMediaAccess(
    itemId: string,
    user: UserContext,
): Promise<Response | null> {
    const sql = getDb();
    if (sql) {
        if (!(await checkMediaAccess(sql, itemId, user))) return ApiResponses.notFound('Media');
    } else if (!toLibraryAccessUser(user)?.isAdmin) {
        return ApiResponses.error('Unable to verify content access');
    }
    return null;
}

const authenticatedHandler = withJellyfinAuth(
    async (event) => {
        const username = event.locals.user?.username;
        const userId = event.locals.user?.userId;
        const kickStatus = username ? await checkSessionKickCooldown(username) : null;
        if (kickStatus?.kicked) {
            return ApiResponses.kicked(kickStatus.remainingSeconds!);
        }

        const itemId = event.params.itemId;
        if (itemId) {
            const sql = getDb();
            if (sql) {
                const allowed = await checkMediaAccess(sql, itemId, event.locals.user);
                if (!allowed) {
                    return ApiResponses.notFound('Media');
                }
            } else if (!toLibraryAccessUser(event.locals.user)?.isAdmin) {
                return ApiResponses.error('Unable to verify content access');
            }
        }
        void disarmSilentStart({
            playSessionId: getParam(event.url, 'PlaySessionId'),
            username: event.locals.user?.username ?? null,
            itemId: event.params.itemId,
            userId: event.locals.user?.userId ?? null,
            deviceId: event.locals.jfDevice?.deviceId ?? null,
        });
        return handleStreamFile(event, { progressiveTranscode: true });
    },
    { pat: 'deny' },
);

export const GET: RequestHandler = withErrorHandler(async (event) => {
    // Free-tier "stream limit reached" clip. Its notice id is the MediaSource.Id,
    // so it arrives as the path id (ExoPlayer) or as mediaSourceId (Android TV,
    // which keeps the real item id in the path). Only 32-hex ids are looked up,
    // so real UUID item ids and file tokens never cost a Valkey round trip.
    const noticeClip =
        (await serveStreamLimitClipFile(
            event.url.searchParams.get('mediaSourceId'),
            'clip.mp4',
            event.request,
        )) ?? (await serveStreamLimitClipFile(event.params.itemId, 'clip.mp4', event.request));
    if (noticeClip) return noticeClip;

    // Direct stream path: Android TV puts MediaSource.Id (our file token) in the
    // mediaSourceId query param while keeping the real item ID in the path.
    // When the version picker is active, the path item ID is a file UUID (not the
    // media item UUID), so we resolve it before comparing to tokenData.itemId.
    const mediaSourceIdParam = event.url.searchParams.get('mediaSourceId');
    if (mediaSourceIdParam) {
        const tokenData = await validatePlayToken(mediaSourceIdParam);
        if (tokenData?.fileId) {
            const pathItemId = event.params.itemId ?? '';
            let resolvedPathItemId = pathItemId;
            if (tokenData.itemId !== pathItemId) {
                const sql = getDb();
                if (sql) {
                    resolvedPathItemId = (await getOwnerItemForFile(sql, pathItemId)) ?? pathItemId;
                }
            }
            if (tokenData.itemId === resolvedPathItemId) {
                const kickStatus = await checkSessionKickCooldown(tokenData.userId);
                if (kickStatus?.kicked) {
                    return ApiResponses.kicked(kickStatus.remainingSeconds!);
                }
                const user = await buildPlayTokenUserContext(tokenData.userId, {
                    mintedByAdmin: tokenData.mintedByAdmin === true,
                });
                if (!user) return ApiResponses.notFound('Media');
                const denied = await enforceTokenMediaAccess(tokenData.itemId, user);
                if (denied) return denied;
                applyPlayTokenIdentity(event, user);
                void disarmSilentStart({
                    playSessionId: getParam(event.url, 'PlaySessionId'),
                    username: tokenData.userId,
                    itemId: tokenData.itemId,
                });
                // Rewrite path to the real media item UUID so handleStreamFile resolves correctly
                (event.params as Record<string, string>).itemId = tokenData.itemId;
                event.url.searchParams.set('mediaSourceId', tokenData.fileId);
                const playSessionId = event.url.searchParams.get('playSessionId') ?? undefined;
                if (playSessionId)
                    renewPlayTokenBySession(playSessionId, { token: mediaSourceIdParam }).catch(
                        () => undefined,
                    );
                return handleStreamFile(event, { progressiveTranscode: true });
            }
        }
    }

    // True direct play path: params.itemId itself is a file token (ExoPlayer uses
    // MediaSource.Id as the path segment). Rewrite to real itemId + fileId.
    const fileTokenData = await validatePlayToken(event.params.itemId ?? '');
    if (fileTokenData?.fileId) {
        const kickStatus = await checkSessionKickCooldown(fileTokenData.userId);
        if (kickStatus?.kicked) {
            return ApiResponses.kicked(kickStatus.remainingSeconds!);
        }
        const user = await buildPlayTokenUserContext(fileTokenData.userId, {
            mintedByAdmin: fileTokenData.mintedByAdmin === true,
        });
        if (!user) return ApiResponses.notFound('Media');
        const denied = await enforceTokenMediaAccess(fileTokenData.itemId, user);
        if (denied) return denied;
        applyPlayTokenIdentity(event, user);
        void disarmSilentStart({
            playSessionId: getParam(event.url, 'PlaySessionId'),
            username: fileTokenData.userId,
            itemId: fileTokenData.itemId,
        });
        (event.params as Record<string, string>).itemId = fileTokenData.itemId;
        event.url.searchParams.set('mediaSourceId', fileTokenData.fileId);
        return handleStreamFile(event, { progressiveTranscode: true });
    }

    // Legacy play_token query param path (direct stream URL carries the token)
    const playToken = event.url.searchParams.get('play_token');
    if (playToken) {
        const tokenData = await validatePlayToken(playToken);
        if (tokenData && tokenData.itemId === event.params.itemId) {
            const kickStatus = await checkSessionKickCooldown(tokenData.userId);
            if (kickStatus?.kicked) {
                return ApiResponses.kicked(kickStatus.remainingSeconds!);
            }

            const playSessionId = event.url.searchParams.get('playSessionId') ?? undefined;
            if (playSessionId) {
                renewPlayTokenBySession(playSessionId, { token: playToken }).catch(() => undefined);
            }

            const user = await buildPlayTokenUserContext(tokenData.userId, {
                mintedByAdmin: tokenData.mintedByAdmin === true,
            });
            if (!user) return ApiResponses.notFound('Media');
            const denied = await enforceTokenMediaAccess(tokenData.itemId, user);
            if (denied) return denied;
            applyPlayTokenIdentity(event, user);
            void disarmSilentStart({
                playSessionId: getParam(event.url, 'PlaySessionId'),
                username: tokenData.userId,
                itemId: tokenData.itemId,
            });
            return handleStreamFile(event, { progressiveTranscode: true });
        }
    }

    return authenticatedHandler(event);
});
