// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AGPL-core registry for an optional observer of /j (Jellyfin-compat) responses.
 * The core never imports the proprietary jellyfin-compat tree (license boundary,
 * enforced by `scripts/check-license-boundary.mjs`); the proprietary licensing
 * init registers its implementation here instead. Without one registered the
 * handle is a pass-through.
 *
 * The observer must never throw and must not delay the response.
 */
import type { Handle, RequestEvent } from '@sveltejs/kit';

export type JellyfinResponseObserver = (event: RequestEvent, response: Response) => void;

let observer: JellyfinResponseObserver | null = null;

export function registerJellyfinResponseObserver(fn: JellyfinResponseObserver): void {
    observer = fn;
}

export function __resetJellyfinResponseObserverForTests(): void {
    observer = null;
}

export const jellyfinResponseObserverHandle: Handle = async ({ event, resolve }) => {
    const response = await resolve(event);
    const obs = observer;
    if (obs && (event.url.pathname === '/j' || event.url.pathname.startsWith('/j/'))) {
        try {
            obs(event, response);
        } catch {
            // never affect the response
        }
    }
    return response;
};
