// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Player Navigation Store
 *
 * Manages the "back" navigation for the video player with a simple, predictable flow:
 *
 * 1. When navigating TO the player → store where we came from
 * 2. When pressing back IN the player → return to where we came from
 * 3. For deep links (no origin) → use sensible defaults
 *
 * Storage strategy:
 * - sessionStorage: Stores the return path for the current session
 * - localStorage: Remembers the last browse page across sessions (for deep links)
 */

import { browser } from '$app/environment';
import { base } from '$app/paths';
import { writable } from 'svelte/store';

// Storage keys
const RETURN_PATH_KEY = 'player:returnPath';
const LAST_BROWSE_KEY = 'player:lastBrowsePage';

// Watch path prefix (accounts for base path in subfolder deployments)
const WATCH_PREFIX = base ? `${base}/watch` : '/watch';
const HOME_PATH = base || '/';
const BROWSE_PATH = base ? `${base}/browse` : '/browse';

/**
 * Safe sessionStorage access with error handling
 */
function safeSessionStorage() {
    return {
        get(key: string): string | null {
            if (!browser) return null;
            try {
                return sessionStorage.getItem(key);
            } catch {
                /* expected: sessionStorage may be blocked (private browsing) */
                return null;
            }
        },
        set(key: string, value: string): void {
            if (!browser) return;
            try {
                sessionStorage.setItem(key, value);
            } catch (e) {
                console.warn('[PlayerNav] sessionStorage.set failed:', e);
            }
        },
        remove(key: string): void {
            if (!browser) return;
            try {
                sessionStorage.removeItem(key);
            } catch {
                /* expected: sessionStorage may be blocked (private browsing) */
            }
        },
    };
}

/**
 * Safe localStorage access with error handling
 */
function safeLocalStorage() {
    return {
        get(key: string): string | null {
            if (!browser) return null;
            try {
                return localStorage.getItem(key);
            } catch {
                /* expected: localStorage may be blocked (private browsing) */
                return null;
            }
        },
        set(key: string, value: string): void {
            if (!browser) return;
            try {
                localStorage.setItem(key, value);
            } catch (e) {
                console.warn('[PlayerNav] localStorage.set failed:', e);
            }
        },
    };
}

const session = safeSessionStorage();
const local = safeLocalStorage();

/**
 * Check if a path is a watch/player page
 */
function isWatchPage(path: string): boolean {
    const pathname = path.split(/[?#]/)[0];
    return pathname === WATCH_PREFIX || pathname.startsWith(WATCH_PREFIX + '/');
}

/**
 * Check if a path is a browseable page (home or browse)
 */
function isBrowsePage(path: string): boolean {
    const pathname = path.split(/[?#]/)[0];
    return pathname === HOME_PATH || pathname === `${base}/` || pathname === BROWSE_PATH;
}

/**
 * Get smart default return path based on media type
 */
function getDefaultPath(mediaType?: string): string {
    if (mediaType?.toLowerCase() === 'tvchannel') {
        return '/livetv';
    }
    return '/';
}

/** Convert a stored browser path to an app-relative route for resolve(). */
function normalizeReturnPath(path: string): string | null {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return null;
    const pathname = path.split(/[?#]/)[0];
    if (base && pathname !== base && !pathname.startsWith(base + '/')) return null;
    if (isWatchPage(path)) return null;
    const route = base ? path.slice(base.length) : path;
    return route.startsWith('/') ? route : '/' + route;
}

/** Capture a full-page referrer only when no explicit player origin was saved. */
export function saveReturnPathFromReferrer(referrer: string): void {
    if (!browser || !referrer) return;
    const existing = session.get(RETURN_PATH_KEY);
    if (existing && normalizeReturnPath(existing) !== null) return;
    try {
        const referrerUrl = new URL(referrer);
        if (referrerUrl.origin !== window.location.origin) return;
        const path = referrerUrl.pathname + referrerUrl.search + referrerUrl.hash;
        if (isBrowsePage(path)) saveReturnPath(path);
    } catch {
        // An invalid referrer has no useful return destination.
    }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Store to track if we have a pending return path
 * (useful for UI indicators if needed)
 */
export const hasReturnPath = writable(false);

/**
 * Call this BEFORE navigating to the player.
 * Stores the current path so we can return to it later.
 *
 * @param path - Optional specific path to store (defaults to current location)
 */
export function saveReturnPath(path?: string): void {
    if (!browser) return;

    const currentPath =
        path ?? window.location.pathname + window.location.search + window.location.hash;

    // Don't store if already on a watch page (preserves original destination)
    if (normalizeReturnPath(currentPath) === null || isWatchPage(currentPath)) {
        return;
    }

    session.set(RETURN_PATH_KEY, currentPath);
    hasReturnPath.set(true);
}

/**
 * Call this when navigating to any browse page (/, /browse).
 * Updates the "last browse page" for deep link fallback.
 *
 * Should be called from the layout's afterNavigate hook.
 *
 * @param path - The full path including search params
 */
export function updateLastBrowsePage(path: string): void {
    if (isBrowsePage(path)) {
        local.set(LAST_BROWSE_KEY, path);
    }
}

/**
 * Call this when the player's back button is pressed.
 * Returns the appropriate path and clears the stored return path.
 *
 * Priority:
 * 1. Stored return path (from when user navigated to player)
 * 2. Last browse page (from localStorage, for deep links)
 * 3. Smart default based on media type
 *
 * @param mediaType - Optional media type for smart defaults (e.g., 'TvChannel')
 * @returns The path to navigate to
 */
export function getReturnPath(mediaType?: string): string {
    // Priority 1: Stored return path from this session
    const storedPath = session.get(RETURN_PATH_KEY);
    if (storedPath) {
        session.remove(RETURN_PATH_KEY);
        hasReturnPath.set(false);
        const route = normalizeReturnPath(storedPath);
        if (route !== null) return route;
    }

    // Priority 2: Last browse page (persists across sessions)
    const lastBrowse = local.get(LAST_BROWSE_KEY);
    if (lastBrowse) {
        const route = normalizeReturnPath(lastBrowse);
        if (route !== null && isBrowsePage(lastBrowse)) return route;
    }

    // Priority 3: Smart default
    return getDefaultPath(mediaType);
}

/**
 * Clear the stored return path without navigating.
 * Useful if the player is closed in a non-standard way.
 */
export function clearReturnPath(): void {
    session.remove(RETURN_PATH_KEY);
    hasReturnPath.set(false);
}

/**
 * Flag indicating a player navigation is in progress.
 * Set to true when the user clicks Play/Watch in a modal; reset when the
 * watch route is reached (or after a safety timeout).  Used to suppress the
 * search-reopen $effect in Search.svelte so the overlay doesn't come back
 * while the two competing gotos (modal-close strip and player navigate) race.
 */
export const isNavigatingToPlayer = writable(false);

let _navigatingToPlayerTimeout: ReturnType<typeof setTimeout> | null = null;

/**
 * Call this immediately before navigating to the player.
 * Automatically falls back after 5 s if clearNavigatingToPlayer is never
 * called (e.g. navigation was cancelled).
 */
export function setNavigatingToPlayer(): void {
    isNavigatingToPlayer.set(true);
    if (_navigatingToPlayerTimeout !== null) {
        clearTimeout(_navigatingToPlayerTimeout);
    }
    _navigatingToPlayerTimeout = setTimeout(() => {
        isNavigatingToPlayer.set(false);
        _navigatingToPlayerTimeout = null;
    }, 5000);
}

/**
 * Call this once the watch route has been reached (afterNavigate) to clear
 * the navigation guard immediately.
 */
export function clearNavigatingToPlayer(): void {
    isNavigatingToPlayer.set(false);
    if (_navigatingToPlayerTimeout !== null) {
        clearTimeout(_navigatingToPlayerTimeout);
        _navigatingToPlayerTimeout = null;
    }
}
