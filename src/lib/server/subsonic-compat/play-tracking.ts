// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    getSessionBySourceKey,
    upsertExternalSession,
    stopExternalSession,
} from '$lib/server/database/queries/play-sessions.queries.js';
import { musicInteractionManager } from '$lib/server/services/music-interaction-manager.service.js';
import { toUserContext } from './media-access.js';
import type { SubsonicAuthContext } from './types.js';

/** Close and count a Subsonic listen once, including submission-only clients. */
export async function stopSubsonicPlay(
    sql: postgres.Sql,
    auth: SubsonicAuthContext,
    trackId: string,
    stopReason: string,
    ignoreScrobble = false,
): Promise<void> {
    const sourceSessionId = `${auth.userId}:${trackId}`;
    await withTx(sql, async (tx) => {
        // Also serializes the absent-row case: a submission without a now-playing
        // notification needs a terminal row so its retries can be recognized.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`subsonic:${sourceSessionId}`}, 0))`;
        if (!(await getSessionBySourceKey(tx, 'subsonic', sourceSessionId))) {
            await upsertExternalSession(tx, {
                source: 'subsonic',
                surface: 'subsonic',
                source_session_id: sourceSessionId,
                media_id: trackId,
                user_id: auth.userId,
                device_id: `subsonic-${auth.userId}`,
                client_name: auth.clientName || 'Subsonic',
                status: 'ACTIVE',
                position_ms: 0,
                play_method: 'direct',
            });
        }
        const stopped = await stopExternalSession(tx, 'subsonic', sourceSessionId, {
            final_status: 'COMPLETED',
            stop_reason: stopReason,
        });
        if (stopped && !ignoreScrobble) {
            // Failure rolls back the stop too, leaving the next submission retryable.
            await musicInteractionManager.recordExternalPlayEnd(
                toUserId(auth.userId),
                trackId,
                toUserContext(auth),
                tx,
            );
        }
    });
}
