// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { pushState, replaceState } from '$app/navigation';

/** Shallow routing changes page.state, not page.url. Keep workspace queries reactive. */
export function adminWorkspaceUrl(routeUrl: URL, state: App.PageState): URL {
    if (state.adminWorkspaceUrl) {
        const candidate = new URL(state.adminWorkspaceUrl, routeUrl);
        if (candidate.origin === routeUrl.origin && candidate.pathname === routeUrl.pathname) {
            return candidate;
        }
    }
    return routeUrl;
}

export function writeAdminWorkspaceUrl(url: URL, state: App.PageState, replace = false): void {
    const nextState = {
        ...state,
        adminWorkspaceUrl: url.href,
    };
    // The URL is cloned from the current route and already includes the base path.
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- absolute, already-resolved URL
    if (replace) replaceState(url, nextState);
    // eslint-disable-next-line svelte/no-navigation-without-resolve -- absolute, already-resolved URL
    else pushState(url, nextState);
}
