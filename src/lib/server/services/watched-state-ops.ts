// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared watched-state operations — the single, music-aware, access-gated
 * implementation of "is this watched?", "mark watched", and "mark unwatched".
 *
 * Both the legacy cookie route (`/api/watched/[itemId]`) and the canonical v1
 * endpoint (`/api/v1/watch-state/[id]`) delegate here so the behaviour is
 * defined exactly once. Each route keeps its own response/error shape; this
 * module returns a small discriminated result the routes map to HTTP.
 *
 * Behaviour folded in (previously only in `/api/watched/[itemId]`):
 *  - Music tracks route through MusicInteractionManager / music-tracking
 *    queries instead of watchManager (which is a no-op for music by design).
 *  - Library/age access gating via checkMediaAccess (existence-leak rule:
 *    inaccessible media reports `denied`, which routes surface as 404).
 *  - MediaAccessDeniedError thrown by downstream services maps to `denied`.
 */

import type { UserContext } from '$lib/server/types.js';
import type { UserId } from '$lib/shared/user-id.js';
import { watchManager } from '$lib/server/services/watch-manager.service.js';
import { isEffectivelyWatched } from '$lib/server/utils/watch-constants.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { MediaAccessDeniedError } from '$lib/server/utils/resolve-and-gate.js';
import { aiDbService } from '$lib/server/services/database.service.js';

/**
 * Result of a watched-state op.
 *  - `ok`     — succeeded; `watched` is the resulting watched boolean.
 *  - `denied` — caller cannot access this media (404 to the client, never 403,
 *               to avoid leaking existence of restricted UUIDs).
 */
export type WatchedOpResult = { kind: 'ok'; watched: boolean } | { kind: 'denied' };

/** Detect whether a media UUID is a music track. */
async function isMusicTrack(mediaId: string): Promise<boolean> {
    const { getMediaType, isMusicMediaType } =
        await import('$lib/server/database/queries/media-type-cache.queries.js');
    const sql = await aiDbService.getSql();
    if (!sql) return false;
    const mediaType = await getMediaType(sql, mediaId);
    return isMusicMediaType(mediaType);
}

/**
 * Library/age access gate. Returns true when the caller may touch this media.
 * DB-unavailable is treated as "allow" (the underlying op will fail loudly if
 * it genuinely needs the DB), matching the legacy route's prior behaviour.
 */
async function hasAccess(mediaId: string, user: UserContext | undefined): Promise<boolean> {
    const sql = await aiDbService.getSql();
    if (!sql) return true;
    return checkMediaAccess(sql, mediaId, user);
}

/**
 * Read watched status for a single media item (music-aware, access-gated).
 */
export async function readWatchedStatus(
    userId: UserId,
    mediaId: string,
    user: UserContext | undefined,
): Promise<WatchedOpResult> {
    if (!(await hasAccess(mediaId, user))) return { kind: 'denied' };

    if (await isMusicTrack(mediaId)) {
        const sql = await aiDbService.getSql();
        if (!sql) return { kind: 'ok', watched: false };
        const { isMusicTrackCompleted } =
            await import('$lib/server/database/queries/music-tracking.queries.js');
        const completed = await isMusicTrackCompleted(sql, userId, mediaId);
        return { kind: 'ok', watched: completed };
    }

    const state = await watchManager.getWatchState(userId, mediaId);
    return { kind: 'ok', watched: state ? isEffectivelyWatched(state) : false };
}

/**
 * Mark a media item watched (music-aware, access-gated). Series/seasons fan
 * out via watchManager.markWatched; music completes via MusicInteractionManager.
 */
export async function markWatchedOp(
    userId: UserId,
    mediaId: string,
    user: UserContext | undefined,
): Promise<WatchedOpResult> {
    if (!(await hasAccess(mediaId, user))) return { kind: 'denied' };

    try {
        if (await isMusicTrack(mediaId)) {
            const { musicInteractionManager } =
                await import('$lib/server/services/music-interaction-manager.service.js');
            await musicInteractionManager.complete(userId, mediaId, user);
        } else {
            await watchManager.markWatched({ userId, mediaId });
        }
    } catch (err) {
        if (err instanceof MediaAccessDeniedError) return { kind: 'denied' };
        throw err;
    }

    return { kind: 'ok', watched: true };
}

/**
 * Mark a media item unwatched (music-aware, access-gated).
 */
export async function markUnwatchedOp(
    userId: UserId,
    mediaId: string,
    user: UserContext | undefined,
): Promise<WatchedOpResult> {
    if (!(await hasAccess(mediaId, user))) return { kind: 'denied' };

    try {
        if (await isMusicTrack(mediaId)) {
            const sql = await aiDbService.getSql();
            if (sql) {
                const { resetMusicTrackState } =
                    await import('$lib/server/database/queries/music-tracking.queries.js');
                await resetMusicTrackState(sql, userId, mediaId);
            }
        } else {
            await watchManager.markUnwatched({ userId, mediaId });
        }
    } catch (err) {
        if (err instanceof MediaAccessDeniedError) return { kind: 'denied' };
        throw err;
    }

    return { kind: 'ok', watched: false };
}
