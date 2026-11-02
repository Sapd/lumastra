// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin "Show advanced settings" toggle.
 *
 * Controls whether settings marked `uiHints.advanced` are shown on the admin
 * settings pages. Default OFF. Persisted to localStorage so the choice sticks
 * across reloads, and shared across every settings page (it's a single store) so
 * toggling on one page applies everywhere. Updates live — it's a Svelte store.
 */
import { writable } from 'svelte/store';
import { browser } from '$app/environment';

const STORAGE_KEY = 'admin:showAdvancedSettings';

function readInitial(): boolean {
    if (!browser) return false;
    try {
        return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
        // localStorage can throw in private-mode / restricted contexts — fall back to OFF.
        return false;
    }
}

// SSR and the client's first render must expose the same settings markup.
export const showAdvancedSettings = writable<boolean>(false);
let initialized = false;

/** Restore the preference after mount, once hydration has finished. */
export function initializeShowAdvancedSettings(): void {
    if (!browser || initialized) return;
    initialized = true;

    // Read before subscribing: writable subscriptions immediately receive the
    // current value, which would otherwise overwrite a saved `true` with `false`.
    showAdvancedSettings.set(readInitial());
    showAdvancedSettings.subscribe((value) => {
        try {
            localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
        } catch {
            // Ignore persistence failures — the in-memory value still drives the UI.
        }
    });
}
