// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';

/**
 * Owner-stop of one play session; also stops its FFmpeg job and, being a
 * self-cancel, sets no kick cooldown. Sent same-origin, as a browser sends it:
 * a bodyless POST with no Origin is refused 403 by the CSRF guard before the
 * route runs. A 404 (no such session) is fine — the caller is cleaning up.
 */
export function cancelPlaySession(
    request: APIRequestContext,
    baseURL: string | undefined,
    id: string,
): Promise<unknown> {
    return request
        .delete(`/api/play-sessions/${id}`, {
            headers: { Origin: new URL(baseURL ?? '').origin },
        })
        .catch(() => undefined);
}

/**
 * Ends the play sessions a spec opens through `/api/playback/{id}/hls`.
 *
 * Every manifest request on that route that succeeds starts a play session
 * (status ACTIVE, device `lumastra-player`). Without a `PlaySessionId` the
 * route mints a fresh random one per request, so the spec cannot end what it
 * started — and nothing else does while the dev server runs: those rows hold
 * the test user's stream slots for the rest of the run. A later spec that caps
 * the user at one stream (playback-stream-limit.ui) then meets
 * `stream_limit_exceeded active:18 limit:1`.
 *
 * `url()` pins a known id onto a manifest URL; `endAll()` (call it from
 * `afterAll`) cancels every one of them.
 */
export function playSessionTracker() {
    const ids = new Set<string>();
    return {
        url(path: string): string {
            const id = randomUUID();
            ids.add(id);
            return `${path}${path.includes('?') ? '&' : '?'}PlaySessionId=${id}`;
        },
        async endAll(request: APIRequestContext, baseURL: string | undefined): Promise<void> {
            await Promise.all([...ids].map((id) => cancelPlaySession(request, baseURL, id)));
            ids.clear();
        },
    };
}
