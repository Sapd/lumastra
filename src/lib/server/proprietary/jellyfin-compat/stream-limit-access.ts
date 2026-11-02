// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/database';
import { getLiveJellyfinCompatSessions } from '$lib/server/database/queries/play-sessions.queries';
import { getOwnerItemForFile } from '$lib/server/database/queries/media-files.queries';
import { getEffectiveEntitlements } from '$lib/server/licensing/entitlements';
import { Logger } from '$lib/server/utils/logger';
import { isStreamLimitBanned, isPlayTokenBoundToSession, type PlayTokenData } from './play-token';
import { getParam } from './utils';

const logger = Logger.for('JellyfinCompat:StreamLimitAccess');

/**
 * The account ban is admission backoff, not an account-wide byte cutoff. During
 * backoff, an allowed live playback can keep fetching ranges. Tokens carry their
 * own playback identity: a URL parameter cannot substitute another device's id.
 * Old tokens can prove ownership through their original session index.
 * Unmapped tokens and new starts have no exemption. Authenticated clients
 * without PlaySessionId can prove ownership with their own unambiguous device.
 */
export async function isStreamLimitRequestBanned(
    event: RequestEvent,
    userId: string,
    token?: PlayTokenData,
): Promise<boolean> {
    if (!(await isStreamLimitBanned(userId))) return false;
    try {
        const sql = getDb();
        if (!sql) return true;
        const { jellyfinMaxConcurrentStreams: cap } = await getEffectiveEntitlements();
        if (cap === null) return false;
        const sessions = await getLiveJellyfinCompatSessions(sql);
        const playSessionId = token ? token.playSessionId : getParam(event.url, 'PlaySessionId');
        const deviceId = token ? token.deviceId : event.locals.jfDevice?.deviceId;
        const rawItemId = token?.itemId ?? event.params.itemId ?? '';
        const itemId = (await getOwnerItemForFile(sql, rawItemId)) ?? rawItemId;
        const allowed = sessions.slice(0, cap);
        if (token?.tokenId && !token.playSessionId) {
            for (const session of allowed) {
                if (
                    session.user_id === userId &&
                    session.media_id === itemId &&
                    session.jellyfin_play_session_id &&
                    (await isPlayTokenBoundToSession(
                        token.tokenId,
                        session.jellyfin_play_session_id,
                    ))
                )
                    return false;
            }
        }
        const matching = sessions.filter((session) => {
            if (session.user_id !== userId || session.media_id !== itemId) return false;
            if (playSessionId && session.jellyfin_play_session_id === playSessionId) return true;
            // Never let a named, different playback substitute for this one.
            return (
                (!playSessionId || session.jellyfin_play_session_id === null) &&
                !!deviceId &&
                session.device_id === deviceId
            );
        });
        return matching.length !== 1 || !allowed.some((s) => s.id === matching[0]!.id);
    } catch (err) {
        logger.warn(
            'Unable to verify allowed playback during stream-limit backoff',
            { userId },
            err as Error,
        );
        return true;
    }
}
