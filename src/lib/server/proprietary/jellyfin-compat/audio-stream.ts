// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Compat: direct audio file streaming, shared by
 * `GET /Audio/{itemId}/stream` and the direct branch of
 * `GET /Audio/{itemId}/stream.{container}`.
 *
 * Serves the original file with byte-range support. Accepts a play token in
 * the URL (MediaSource.Id, the item id itself, or the legacy play_token param)
 * — {@link serveAudioPlayToken} — or a session: the route files wrap
 * {@link serveAuthenticatedAudioStream} in withJellyfinAuth themselves, so the
 * authenticator is visible where the route is declared (route-policy test).
 */

import type { RequestEvent } from '@sveltejs/kit';
import { disarmSilentStart } from './silent-start';
import { getParam } from './utils';
import { handleStreamFile } from './stream-file-handler';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { toLibraryAccessUser } from '$lib/server/cache/library-group-permissions-cache.js';
import { checkSessionKickCooldown } from '$lib/server/services/session-kill.service';
import { validatePlayToken, renewPlayTokenBySession, type PlayTokenData } from './play-token';
import { applyPlayTokenIdentity, buildPlayTokenUserContext } from './play-token-user';
import type { UserContext } from '$lib/server/types';

// The play-token paths below bypass withJellyfinAuth (clients can't send auth
// headers, so the token rides in the URL), which also skips the access check.
// A play token is issued at PlaybackInfo time (access-checked then) and is
// renewable, so re-check at serve time — otherwise a user whose library/age
// access was revoked after issuance keeps streaming. 404 on denial. Cached.
async function enforceTokenMediaAccess(
    itemId: string,
    user: UserContext,
): Promise<Response | null> {
    const sql = getDb();
    if (sql) {
        if (!(await checkMediaAccess(sql, itemId, user, { fileBacked: true })))
            return ApiResponses.notFound('Media');
    } else if (!toLibraryAccessUser(user)?.isAdmin) {
        return ApiResponses.error('Unable to verify content access');
    }
    return null;
}

/**
 * A user inside a kick cooldown gets no new stream (as /Videos/{id}/stream and
 * /Audio/{id}/universal). Token paths pass the token's username: the play
 * token outlives the kick, so it must not be a way around it.
 */
export async function kickedResponse(
    username: string | null | undefined,
): Promise<Response | null> {
    if (!username) return null;
    const kick = await checkSessionKickCooldown(username);
    return kick.kicked ? ApiResponses.kicked(kick.remainingSeconds!) : null;
}

/**
 * The session path: access re-check, kick cooldown, silent-start disarm, then
 * the file. Callers wrap it in `withJellyfinAuth(…, { pat: 'deny' })`.
 */
export async function serveAuthenticatedAudioStream(event: RequestEvent): Promise<Response> {
    const itemId = event.params.itemId;
    if (itemId) {
        const sql = getDb();
        if (sql) {
            const allowed = await checkMediaAccess(sql, itemId, event.locals.user, {
                fileBacked: true,
            });
            if (!allowed) {
                return ApiResponses.notFound('Media');
            }
        } else if (!toLibraryAccessUser(event.locals.user)?.isAdmin) {
            return ApiResponses.error('Unable to verify content access');
        }
    }
    const kicked = await kickedResponse(event.locals.user?.username);
    if (kicked) return kicked;
    void disarmSilentStart({
        playSessionId: getParam(event.url, 'PlaySessionId'),
        username: event.locals.user?.username ?? null,
        itemId: event.params.itemId,
        userId: event.locals.user?.userId ?? null,
        deviceId: event.locals.jfDevice?.deviceId ?? null,
    });
    return handleStreamFile(event);
}

/**
 * The play-token paths (no session: media elements cannot send auth headers).
 * Returns null when the request carries no valid play token for this item;
 * the caller then falls back to its withJellyfinAuth-wrapped session handler.
 */
export async function serveAudioPlayToken(event: RequestEvent): Promise<Response | null> {
    // Direct stream path: client puts MediaSource.Id (file token) in mediaSourceId param.
    const mediaSourceIdParam = event.url.searchParams.get('mediaSourceId');
    if (mediaSourceIdParam) {
        const tokenData = await validatePlayToken(mediaSourceIdParam);
        if (tokenData?.fileId && tokenData.itemId === event.params.itemId) {
            const user = await buildPlayTokenUserContext(tokenData.userId, {
                mintedByAdmin: tokenData.mintedByAdmin === true,
            });
            if (!user) return ApiResponses.notFound('Media');
            const denied = await enforceTokenMediaAccess(tokenData.itemId, user);
            if (denied) return denied;
            const kicked = await kickedResponse(tokenData.userId);
            if (kicked) return kicked;
            applyPlayTokenIdentity(event, user);
            void disarmSilentStart({
                playSessionId: getParam(event.url, 'PlaySessionId'),
                username: tokenData.userId,
                itemId: tokenData.itemId,
            });
            event.url.searchParams.set('mediaSourceId', tokenData.fileId);
            const playSessionId = event.url.searchParams.get('playSessionId') ?? undefined;
            if (playSessionId)
                renewPlayTokenBySession(playSessionId, { token: mediaSourceIdParam }).catch(
                    () => undefined,
                );
            return handleStreamFile(event);
        }
    }

    // True direct play path: params.itemId itself is a file token.
    const fileTokenData = await validatePlayToken(event.params.itemId ?? '');
    if (fileTokenData?.fileId) {
        const user = await buildPlayTokenUserContext(fileTokenData.userId, {
            mintedByAdmin: fileTokenData.mintedByAdmin === true,
        });
        if (!user) return ApiResponses.notFound('Media');
        const denied = await enforceTokenMediaAccess(fileTokenData.itemId, user);
        if (denied) return denied;
        const kicked = await kickedResponse(fileTokenData.userId);
        if (kicked) return kicked;
        applyPlayTokenIdentity(event, user);
        void disarmSilentStart({
            playSessionId: getParam(event.url, 'PlaySessionId'),
            username: fileTokenData.userId,
            itemId: fileTokenData.itemId,
        });
        (event.params as Record<string, string>).itemId = fileTokenData.itemId;
        event.url.searchParams.set('mediaSourceId', fileTokenData.fileId);
        return handleStreamFile(event);
    }

    // Legacy play_token query param path
    const playToken = event.url.searchParams.get('play_token');
    if (playToken) {
        const tokenData = await validatePlayToken(playToken);
        if (tokenData && tokenData.itemId === event.params.itemId) {
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
            const kicked = await kickedResponse(tokenData.userId);
            if (kicked) return kicked;
            applyPlayTokenIdentity(event, user);
            void disarmSilentStart({
                playSessionId: getParam(event.url, 'PlaySessionId'),
                username: tokenData.userId,
                itemId: tokenData.itemId,
            });
            return handleStreamFile(event);
        }
    }

    return null;
}
