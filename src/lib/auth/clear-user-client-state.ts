// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { browser } from '$app/environment';
import {
    PREFERENCE_JOURNAL_PREFIX,
    PREFERENCE_ACK_PREFIX,
    PREFERENCE_PERMIT_KEY,
} from '$lib/shared/playback-preference-journal';
import { suppressPlaybackPersistence } from '$lib/stores/music-playback-persistence.js';

/**
 * Curated client-side logout wipe, shared by both logout paths (security fix
 * C7, fix round 1).
 *
 * Originally lived only in the forward-auth `logout/+page.svelte`'s
 * `clearUserData()`. Extracted so `nativeSignOut()`
 * (UserMenuPopover.svelte) clears the SAME set on logout — before this fix
 * the native path touched no client storage at all, which is its own
 * staleness bug (e.g. a stale `playerPreferences` or watch-party id
 * surviving into the next signed-in user's session on a shared device).
 *
 * DELIBERATELY curated, not a blanket wipe: `Clear-Site-Data: "storage"` was
 * considered and rejected for this because it clears ALL localStorage,
 * including per-DEVICE (not per-user) keys that must survive logout on a
 * shared browser — sidebar/dock/nav-pin UI collapse state, mute/output-device
 * preference, accordion state, etc. Only the keys/prefixes below are removed.
 * Do not widen this into `localStorage.clear()`.
 */
const USER_SPECIFIC_KEYS = [
    // Auth & identity
    'dashboard_jellyfin_credentials',
    'devUser',

    // Watch Together (contains userId)
    'dashboard_watch_party',

    // Player preferences (synced per-user)
    'playerPreferences',
    'lumastra:pref-dirty',

    // AI recommendation preferences
    'onlyWatchedContent',
    'onlyWatchedBasedRecommendations',
    'showOnlyUnratedContent',
    'hideWatchedContent',
    'persistentDetailedModeRating',

    // UI preferences (might be user-specific in multi-user setups)
    'uiPreferences',

    // OS-notification opt-in (settings/display) — a personal preference,
    // not a device capability; must not carry over to the next user on a
    // shared device. The browser Notification permission itself can't be
    // cleared programmatically, but this opt-in flag can, and
    // notifications-desktop.ts's init() treats "no stored opt-in" as OFF.
    'lumastra-desktop-notifications-enabled',

    // Auth reload detection (stale after logout)
    'dashboard-last-reload',
    'dashboard-reload-loop-detected',
    'dashboard-cache',

    // Music player queue/track/history — auto-restores for the next signed-in
    // user and can resume audio (security fix C13, 2026-09-16). See
    // suppressPlaybackPersistence() below for why the key alone is not enough.
    'lumastra:music-playback',
    // Recent search terms (last 8 queries, no TTL) — security fix C13.
    'lumastra:recent-searches:v1',
    // Mixing Desk seed/avoid tracks + taste sliders — security fix C13.
    'lumastra:music-alchemy:v1',
    'lumastra:music-alchemy:v2',
    'lumastra:music-alchemy:v3',
];

// Prefix patterns for keys that include username
const USER_SPECIFIC_PREFIXES = [
    PREFERENCE_JOURNAL_PREFIX,
    PREFERENCE_ACK_PREFIX,
    'dashboard-request-notifications-', // request-notifications-{username}
    'lumastra:resume:v1:', // resume cache key
];

/**
 * Clear the curated set of user-specific localStorage keys/prefixes, all of
 * sessionStorage, and the two auth-related cookies — but NOT per-device
 * localStorage keys, which are left untouched. Call this from every logout
 * path before its redirect.
 */
export function clearUserClientState(): void {
    if (!browser) return;

    // Retire synchronously without publishing any random context outside the
    // bootstrap lock. Removal works even when quota blocks every new write.
    // Explicit initialization advances the retained generation under that lock.
    localStorage.removeItem(PREFERENCE_PERMIT_KEY);
    window.dispatchEvent(new Event('lumastra:user-client-state-cleared'));

    // Clear specific keys
    for (const key of USER_SPECIFIC_KEYS) {
        localStorage.removeItem(key);
    }

    // Clear keys matching prefixes (e.g., request-notifications-{username})
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) {
            for (const prefix of USER_SPECIFIC_PREFIXES) {
                if (key.startsWith(prefix)) {
                    keysToRemove.push(key);
                    break;
                }
            }
        }
    }
    for (const key of keysToRemove) {
        localStorage.removeItem(key);
    }

    // Clear sessionStorage entirely (player state, watch party navigation, etc.)
    sessionStorage.clear();

    // Security fix C13: prevent music-player.store.ts's module-level
    // `beforeunload` listener (which calls persistState() unconditionally on
    // every page unload, including the logout redirect) from re-writing
    // `lumastra:music-playback` right after this wipe.
    suppressPlaybackPersistence();

    // Clear application cookies
    document.cookie = 'devUser=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT';
    document.cookie = 'PARAGLIDE_LOCALE=; path=/; expires=Thu, 01 Jan 1970 00:00:01 GMT';
}
