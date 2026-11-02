// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { AsyncLocalStorage } from 'node:async_hooks';

/** The delivery grant a timeline href must carry (playback package 8). */
export interface TimelineHrefGrant {
    token: string;
    playbackSessionId?: string | null;
}

const requestScope = new AsyncLocalStorage<{ grant?: TimelineHrefGrant }>();

/** Opened once per request (hooks.server.ts) so auth can record a grant for later hrefs. */
export function runWithTimelineGrantScope<T>(fn: () => T): T {
    return requestScope.run({}, fn);
}

/**
 * Called by forward-auth when the request itself was authenticated by a grant
 * (an external player reading the timeline or the trickplay manifest): the sheet
 * and subtitle hrefs in that response then carry the same grant and work
 * without headers too.
 */
export function setRequestTimelineGrant(grant: TimelineHrefGrant): void {
    const scope = requestScope.getStore();
    if (scope) scope.grant = grant;
}

/** Single URL seam for timeline delivery. */
export function buildTimelineHref(
    path: string,
    query: Record<string, string | number | undefined>,
): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, String(value));
    }
    const grant = requestScope.getStore()?.grant;
    if (grant) {
        params.set('grant', grant.token);
        if (grant.playbackSessionId) params.set('PlaySessionId', grant.playbackSessionId);
    }
    const suffix = params.toString();
    return suffix ? `${path}?${suffix}` : path;
}
