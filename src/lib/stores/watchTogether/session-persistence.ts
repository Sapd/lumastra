// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together Session Persistence
 *
 * Handles localStorage/sessionStorage persistence for watch party sessions.
 * Extracted from watchTogether.ts for better modularity.
 */

import { browser } from '$app/environment';

/** Storage key for watch party session data */
export const STORAGE_KEY = 'dashboard_watch_party';

/** Storage key for unique client ID */
export const CLIENT_ID_KEY = 'dashboard_watch_party_client_id';

/** Session storage key for navigation flag (survives page reload during navigation) */
export const NAVIGATING_KEY = 'dashboard_watch_party_navigating';

/**
 * Stored session data structure
 */
export interface StoredSession {
    code: string;
    userId: string;
}

/**
 * Generate or retrieve a unique client ID for this browser instance.
 * Uses sessionStorage so ID survives page refresh but not browser close.
 * This is critical for multi-device scenarios where the same user has
 * multiple browser tabs/devices in the same watch party.
 */
export function getOrCreateClientId(): string {
    if (!browser) return '';

    let clientId = sessionStorage.getItem(CLIENT_ID_KEY);
    if (!clientId) {
        // Generate a random client ID (survives page refresh but not browser close)
        clientId = generateClientId();
        sessionStorage.setItem(CLIENT_ID_KEY, clientId);
    }
    return clientId;
}

function generateClientId(): string {
    return `client_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
}

/**
 * Claim a clientId that is guaranteed unique among the browser's open tabs.
 *
 * sessionStorage is COPIED into tabs created via tab-duplication or
 * window.open, so two tabs can silently share one clientId — which breaks
 * echo suppression, host detection, and the server's per-client SSE registry
 * (the "guest" tab stops receiving/propagating events entirely).
 *
 * Each tab holds a Web Lock named after its clientId for its lifetime; if the
 * lock is already held (another tab has this id), a fresh id is minted for
 * this tab. Falls back to the raw sessionStorage id when Web Locks is
 * unavailable.
 */
export async function claimClientId(): Promise<string> {
    if (!browser) return '';

    let clientId = getOrCreateClientId();

    if (typeof navigator === 'undefined' || !('locks' in navigator)) {
        return clientId;
    }

    try {
        // Two attempts: original id, then a freshly minted one (a fresh random
        // id colliding with a held lock is practically impossible).
        for (let attempt = 0; attempt < 2; attempt++) {
            const acquired = await new Promise<boolean>((resolve) => {
                // Failsafe: a hung Locks Manager must not block joining a
                // session forever — accept the current id after 2s
                const timeout = setTimeout(() => resolve(true), 2000);
                const settle = (value: boolean) => {
                    clearTimeout(timeout);
                    resolve(value);
                };
                navigator.locks
                    .request(`wt-client-${clientId}`, { ifAvailable: true }, (lock) => {
                        if (!lock) {
                            settle(false);
                            return;
                        }
                        settle(true);
                        // Hold the lock for the lifetime of this tab
                        return new Promise<void>(() => {});
                    })
                    .catch(() => settle(true)); // lock API failure → accept current id
            });
            if (acquired) break;
            clientId = generateClientId();
            sessionStorage.setItem(CLIENT_ID_KEY, clientId);
        }
    } catch {
        // Web Locks unavailable — best effort, keep the sessionStorage id
    }

    return clientId;
}

/**
 * Persist session code and userId to localStorage.
 * This allows rejoining a session after page navigation.
 */
export function saveToStorage(code: string, userId: string): void {
    if (!browser) return;
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ code, userId }));
    } catch (e) {
        console.error('[WatchTogether] Failed to save to storage:', e);
    }
}

/**
 * Load session from localStorage.
 * Returns null if no session is stored or on parse error.
 */
export function loadFromStorage(): StoredSession | null {
    if (!browser) return null;
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            return JSON.parse(stored) as StoredSession;
        }
    } catch (e) {
        console.error('[WatchTogether] Failed to load from storage:', e);
    }
    return null;
}

/**
 * Clear session from localStorage.
 * Called when leaving a session or on session end.
 */
export function clearStorage(): void {
    if (!browser) return;
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch (e) {
        console.error('[WatchTogether] Failed to clear storage:', e);
    }
}

/**
 * Check if we're navigating within a session.
 * Uses sessionStorage so the flag survives page reload during navigation.
 */
export function isNavigatingWithinSession(): boolean {
    if (!browser) return false;
    return sessionStorage.getItem(NAVIGATING_KEY) === 'true';
}

/**
 * Set the navigation flag.
 * Should be set before navigation and cleared after reconnection.
 */
export function setNavigatingWithinSessionFlag(value: boolean): void {
    if (!browser) return;
    if (value) {
        sessionStorage.setItem(NAVIGATING_KEY, 'true');
    } else {
        sessionStorage.removeItem(NAVIGATING_KEY);
    }
}

/**
 * Get the current client ID without creating a new one.
 * Returns empty string if no client ID exists or in SSR.
 */
export function getCurrentClientId(): string {
    if (!browser) return '';
    return sessionStorage.getItem(CLIENT_ID_KEY) || '';
}

/**
 * Check if a stored session exists.
 * Useful for quick checks without loading full session data.
 */
export function hasStoredSession(): boolean {
    if (!browser) return false;
    return localStorage.getItem(STORAGE_KEY) !== null;
}
