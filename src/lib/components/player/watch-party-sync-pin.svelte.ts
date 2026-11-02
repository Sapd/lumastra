// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Persisted "pin the watch-party sync status" preference.
 *
 * When pinned, a guest's drift/sync indicator stays visible in the player even
 * when the watch-party panel is closed and the controls are hidden — for people
 * who like to keep an eye on the catch-up status. Off by default; the value
 * survives reloads via localStorage.
 */

import { browser } from '$app/environment';

const STORAGE_KEY = 'watchPartySyncPinned';

function load(): boolean {
    if (!browser) return false;
    try {
        return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
        return false;
    }
}

class WatchPartySyncPinState {
    pinned = $state(load());

    toggle(): void {
        this.pinned = !this.pinned;
        if (!browser) return;
        try {
            localStorage.setItem(STORAGE_KEY, this.pinned ? 'true' : 'false');
        } catch {
            // Ignore storage failures (private mode / quota) — the in-memory
            // state still drives the UI for this session.
        }
    }
}

export const watchPartySyncPin = new WatchPartySyncPinState();
