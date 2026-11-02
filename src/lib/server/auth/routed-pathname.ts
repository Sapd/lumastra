// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { base } from '$app/paths';
import { reroutePathname } from '$lib/routing/reroute-pathname.js';

/** One computation per request URL: hooks and resolveAuth all ask. */
const cache = new WeakMap<URL, string>();

/**
 * The path SvelteKit dispatches this URL to: rerouted (Paraglide locale prefix
 * stripped, /j client quirks normalised), percent-decoded the way SvelteKit
 * decodes it (`%25` and `%2F` stay encoded), and with the base path removed.
 *
 * Auth decisions that depend on WHICH surface a request reaches must use this,
 * not `event.url.pathname`. The raw pathname of `/api/%76%31/me` or
 * `/de/api/v1/me` does not start with `/api/v1/`, yet both run the /api/v1
 * handlers — so a raw-path check sent them down the forward-auth branch, where
 * a trusted-proxy identity header is believed, on the surface whose headers the
 * edge never authenticates.
 *
 * A path SvelteKit cannot decode is matched to no route (it answers 404/400);
 * for it this returns the rerouted, still-encoded path, so a malformed escape
 * after `/de/api/v1/` is still classified as /api/v1 rather than as a page.
 */
export function routedPathname(url: URL, basePath: string = base): string {
    const cached = basePath === base ? cache.get(url) : undefined;
    if (cached !== undefined) return cached;

    let path = reroutePathname(new URL(url));
    try {
        path = path.split('%25').map(decodeURI).join('%25');
    } catch {
        // expected: malformed escape — keep the rerouted, undecoded path
    }
    if (basePath && (path === basePath || path.startsWith(`${basePath}/`))) {
        path = path.slice(basePath.length) || '/';
    }
    if (basePath === base) cache.set(url, path);
    return path;
}
