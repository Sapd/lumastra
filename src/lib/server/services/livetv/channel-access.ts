// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which Live TV channels a caller may stream.
 *
 * The stream endpoints used to check only `hasLiveTvPermission`, so any viewer
 * could open any channel by id: a hidden feed, a channel in a hidden category,
 * one gone from the playlist. Viewers now get what the lineup shows them, plus
 * — while LIVETV_VIEWER_FEED_CHOICE is on — the other feeds of a station they
 * can see (the feed picker). Admins keep every channel (preview, testing a
 * hidden feed). Callers have already checked `hasLiveTvPermission`.
 *
 * Only the standalone provider stores channels; with any other provider there
 * is nothing to stream and the gate defers to the provider (it refuses).
 *
 * Segment and media-playlist requests use `canReadLiveTvChannelStream`, the
 * same rule behind a short per-channel cache, so a player polling every few
 * seconds does not cost a query per segment. Without it a viewer who knew a
 * channel id could read a hidden channel while someone else (an admin preview)
 * kept it running. Every uncached check (joins, metadata) refreshes that
 * cache, so a channel an admin just unhid plays as soon as a viewer joins it.
 *
 * "Admin" here includes a stream token or /j play token that an admin
 * credential minted (`user.mediaAccessIsAdmin`): those principals are never
 * admin, but the native players fetch every playlist and segment with them,
 * so without it an admin preview of a hidden feed joined and then 404'd.
 */

import { config } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/connection.js';
import { isChannelStreamableByViewer } from '$lib/server/database/queries/livetv-channels.queries.js';
import { localsIsAdmin, type AdminDecisionLocals } from '$lib/server/auth/locals-admin.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';

export type LiveTvAccessLocals = AdminDecisionLocals & {
    user?: { ownerIsAdmin?: boolean; mediaAccessIsAdmin?: boolean } | null;
};

/** Admin credential, or a stream/play token an admin credential minted. */
function seesEveryChannel(locals: LiveTvAccessLocals): boolean {
    return localsIsAdmin(locals) || locals.user?.mediaAccessIsAdmin === true;
}

/**
 * How long a viewer verdict for a channel is reused by segment requests. A
 * channel hidden in the admin UI stops serving segments to viewers within this.
 */
export const STREAM_READ_CACHE_TTL_MS = 10_000;
/** Bound on cached channels; the largest lineups have ~13k feeds. */
const STREAM_READ_CACHE_MAX = 20_000;

// For a non-admin the verdict depends on the channel and the feed-choice
// setting only, never on who asks, so one entry per channel serves everyone.
// A viewer-dependent rule in isChannelStreamableByViewer must change the key.
const streamReadCache = new Map<string, { allowed: boolean; expiresAt: number }>();
// One lookup per channel at a time: every viewer's player asks within the same
// second after an entry expires.
const streamReadInflight = new Map<string, Promise<boolean>>();

function streamReadKey(channelId: string, feedChoice: boolean): string {
    return `${channelId.toLowerCase()}:${feedChoice ? 1 : 0}`;
}

function rememberStreamRead(key: string, allowed: boolean): void {
    const now = Date.now();
    streamReadCache.delete(key);
    if (streamReadCache.size >= STREAM_READ_CACHE_MAX) {
        for (const [k, entry] of streamReadCache) {
            if (entry.expiresAt <= now) streamReadCache.delete(k);
        }
        // Still full of live entries (ids nobody streams): drop the oldest.
        if (streamReadCache.size >= STREAM_READ_CACHE_MAX) {
            const oldest = streamReadCache.keys().next().value;
            if (oldest !== undefined) streamReadCache.delete(oldest);
        }
    }
    streamReadCache.set(key, { allowed, expiresAt: now + STREAM_READ_CACHE_TTL_MS });
}

/** Whether this caller may open a stream of `channelId`. A non-UUID id is no channel. */
export async function canStreamLiveTvChannel(
    locals: LiveTvAccessLocals,
    channelId: string,
): Promise<boolean> {
    if (!isUuid(channelId)) return false;
    if (seesEveryChannel(locals)) return true;
    if (config.LIVETV_SOURCE !== 'standalone') return true;
    const sql = getDb();
    // No database: the provider cannot resolve the channel either; fail closed.
    if (!sql) return false;
    const feedChoice = config.LIVETV_VIEWER_FEED_CHOICE;
    const allowed = await isChannelStreamableByViewer(sql, channelId, feedChoice);
    rememberStreamRead(streamReadKey(channelId, feedChoice), allowed);
    return allowed;
}

/**
 * `canStreamLiveTvChannel` for segment, init and media-playlist requests:
 * the verdict is cached per channel for STREAM_READ_CACHE_TTL_MS. Joins keep
 * the uncached check. A failed lookup is not cached and rejects.
 */
export async function canReadLiveTvChannelStream(
    locals: LiveTvAccessLocals,
    channelId: string,
): Promise<boolean> {
    if (!isUuid(channelId)) return false;
    if (seesEveryChannel(locals)) return true;
    if (config.LIVETV_SOURCE !== 'standalone') return true;

    const key = streamReadKey(channelId, config.LIVETV_VIEWER_FEED_CHOICE);
    const hit = streamReadCache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.allowed;

    let pending = streamReadInflight.get(key);
    if (!pending) {
        pending = canStreamLiveTvChannel(locals, channelId).finally(() =>
            streamReadInflight.delete(key),
        );
        streamReadInflight.set(key, pending);
    }
    return pending;
}

/** Test hook: forget every cached verdict. */
export function clearLiveTvStreamReadCache(): void {
    streamReadCache.clear();
    streamReadInflight.clear();
}
