// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { toasts } from '$lib/stores/toast.store';
import { z } from 'zod';
import { apiPost } from '$lib/api/client.js';
import { clearUserClientState } from '$lib/auth/clear-user-client-state.js';
import { clearServiceWorkerCaches } from '$lib/pwa.js';
import { musicPlayerStore } from '$lib/stores/music-player.store.js';

/**
 * Which logout affordance the slimmed user-menu popup should render.
 *
 * - `session`  → native built-in login: POST /api/auth/native/logout then
 *                redirect to /login (mirrors Footer.svelte:975-989).
 * - `forward`  → forward-auth deployment with PUBLIC_LOGOUTURL set: anchor to
 *                the /logout route (mirrors Footer.svelte:946-954).
 * - `fallback` → neither of the above; still render a Logout row hrefing
 *                /logout so the guaranteed floor (Settings + Logout) always holds.
 */
export type LogoutMode = 'session' | 'forward' | 'fallback';

export function resolveLogoutMode(
    authMethod: string | undefined,
    logoutUrl: string | undefined | null,
): LogoutMode {
    if (authMethod === 'session') return 'session';
    if (logoutUrl) return 'forward';
    return 'fallback';
}

/**
 * The native (built-in session auth) sign-out flow, extracted out of
 * UserMenuPopover.svelte so it is directly importable — both by the
 * component's own `nativeSignOut()` handler and by e2e coverage that needs
 * to exercise the REAL sign-out path rather than hand-calling the wipe
 * helpers it happens to use (security fix C19, 2026-09-16: the prior
 * `logout-cache-wipe.ui.spec.ts` native-path test called
 * `clearUserClientState()` + `clearServiceWorkerCaches()` directly, so
 * deleting either call from this function would not have turned it red).
 *
 * 1. Revokes the server-side session (`POST /api/auth/native/logout`)
 * 2. Stops music playback and suppresses persistence (security fix C13)
 * 3. Runs the curated client-state wipe shared with the forward-auth path
 * 4. Wipes the service-worker CacheStorage
 * 5. Redirects to /login only after logout is confirmed; otherwise offers retry.
 */
export async function performNativeSignOut(): Promise<void> {
    let complete = false;
    try {
        const result = await apiPost(
            '/api/auth/native/logout',
            z.object({}).passthrough(),
            undefined,
        );
        if (result.error || result.status < 200 || result.status >= 300) {
            toasts.error(
                'Could not finish signing out. Please retry sign out when the server is available.',
            );
        } else {
            complete = true;
        }
    } finally {
        // Stop playback and wipe the persisted queue/track/history before the
        // curated wipe below — security fix C13 (2026-09-16).
        musicPlayerStore.stop(true);

        // Curated user-specific localStorage/sessionStorage/cookie wipe —
        // shared with clearUserData() (logout/+page.svelte). Fix round 1:
        // this path used to touch no client storage at all, leaving a stale
        // playerPreferences/watch-party id etc. for the next signed-in user
        // on a shared device. See $lib/auth/clear-user-client-state.ts for
        // the exact key list.
        clearUserClientState();

        // Wipe CacheStorage (SW app-shell cache) — belt on top of the
        // server's Clear-Site-Data header, before this user's slot on a
        // shared device can replay this page's cached SSR HTML to the next
        // user. See pwa.ts:clearServiceWorkerCaches (C7).
        await clearServiceWorkerCaches();
        if (complete) window.location.assign('/login');
    }
}
