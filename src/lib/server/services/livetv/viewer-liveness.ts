// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Liveness for players that only fetch the playlist and its segments (VLC, Kodi, cast
 * receivers): they never call keepalive or leave. Every playlist/segment fetch counts as a
 * heartbeat for the viewer it belongs to, at most once per interval, so the proxy's viewer
 * reaper and the session TTL see a steady viewer as alive. A player that does send keepalives
 * is unaffected (a heartbeat is idempotent).
 */

import type { RequestEvent } from '@sveltejs/kit';
import { Logger } from '$lib/server/utils/logger.js';
import { peekLiveTvViewerKey } from './livetv-viewer-key.js';
import { getStreamProxyClient } from './stream-proxy-client.js';
import { getLiveTvSessionService } from './livetv-session.service.js';

const logger = Logger.for('LiveTV:Liveness');

/** At most one proxy heartbeat per viewer and feed in this window. */
export const LIVENESS_INTERVAL_MS = 10_000;
const MAX_TRACKED = 5_000;

const lastTouch = new Map<string, number>();

async function refresh(viewerKey: string, feedId: string): Promise<void> {
    const result = await getStreamProxyClient().heartbeat(feedId, viewerKey);
    if (!result?.success) return;
    const sessions = getLiveTvSessionService();
    const current = await sessions.getViewerPlaybackSession(viewerKey);
    if (current && current.state === 'active' && current.feedId === feedId) {
        await sessions.refreshPlaybackSession(current);
    } else {
        await sessions.refreshSession(viewerKey);
    }
}

/** Fire-and-forget. Never throws and never delays the media response. */
export function touchLiveTvViewer(
    event: Pick<RequestEvent, 'locals' | 'cookies' | 'url'>,
    feedId: string,
    now: number = Date.now(),
): void {
    try {
        const viewerKey = peekLiveTvViewerKey(event);
        if (!viewerKey) return;
        const key = `${viewerKey}|${feedId}`;
        if (now - (lastTouch.get(key) ?? Number.NEGATIVE_INFINITY) < LIVENESS_INTERVAL_MS) return;
        lastTouch.set(key, now);
        if (lastTouch.size > MAX_TRACKED) {
            for (const [entry, at] of lastTouch)
                if (now - at > LIVENESS_INTERVAL_MS * 6) lastTouch.delete(entry);
        }
        void refresh(viewerKey, feedId).catch((error: unknown) => {
            logger.debug('Liveness touch failed', { error: String(error) });
        });
    } catch {
        /* liveness is best effort */
    }
}

/** Test seam. */
export function resetLivenessForTests(): void {
    lastTouch.clear();
}
