<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onMount } from 'svelte';
    import { browser } from '$app/environment';
    import { env } from '$env/dynamic/public';
    import { userEvents } from '$lib/stores/user-events.js';
    import { notificationInbox } from '$lib/stores/notification-inbox.js';
    import { teardown as teardownDesktopNotifications } from '$lib/notifications-desktop.js';
    import { clearServiceWorkerCaches } from '$lib/pwa.js';
    import { clearUserClientState } from '$lib/auth/clear-user-client-state.js';
    import { musicPlayerStore } from '$lib/stores/music-player.store.js';

    /**
     * Logout page for forward auth (Authentik) setups
     *
     * 1. Revokes server-side tokens (Jellyfin, refresh tokens)
     * 2. Clears all user-specific client-side state
     * 3. Redirects to the Authentik logout endpoint
     */

    /**
     * Tear down live, in-memory user state — the EventSource connection, the
     * inbox's replay cursor, and the desktop-notification listener. This
     * page currently finishes with a hard `window.location.href` redirect,
     * which destroys the JS realm anyway, so today this call is inert. It's
     * still wired up (rather than left as a dangling "call on logout"
     * docstring) so a future switch to an SPA `goto()` redirect here doesn't
     * silently carry a live EventSource, replay cursor, and unread badge
     * into the next signed-in user's session on a shared device.
     */
    function teardownLiveState(): void {
        if (!browser) return;
        userEvents.teardown();
        notificationInbox.teardown();
        teardownDesktopNotifications();
    }

    async function clearUserData(): Promise<void> {
        if (!browser) return;

        // Stop playback and wipe the persisted queue/track/history before the
        // curated wipe below — security fix C13 (2026-09-16): otherwise this
        // user's audio keeps playing through the redirect and, without the
        // persistence suppression in clearUserClientState(), the next
        // signed-in user on a shared device could auto-resume it.
        musicPlayerStore.stop(true);

        // Curated user-specific localStorage/sessionStorage/cookie wipe —
        // shared with nativeSignOut() (UserMenuPopover.svelte). See
        // $lib/auth/clear-user-client-state.ts for the exact key list and why
        // it deliberately excludes per-device keys.
        clearUserClientState();

        // Wipe CacheStorage (SW app-shell cache) — belt on top of the server's
        // Clear-Site-Data header, before this user's slot on a shared device
        // can replay this page's cached SSR HTML to the next user. See
        // pwa.ts:clearServiceWorkerCaches for the full rationale (C7).
        await clearServiceWorkerCaches();
    }

    async function revokeServerTokens(): Promise<void> {
        try {
            // Call server to revoke Jellyfin tokens and refresh tokens
            await fetch('/logout', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
        } catch {
            // Ignore errors - we still want to complete logout
            console.warn('Failed to revoke server tokens');
        }
    }

    function redirectToLogout(): void {
        if (env.PUBLIC_LOGOUTURL) {
            window.location.href = env.PUBLIC_LOGOUTURL;
        } else {
            // No logout URL configured - just go home
            // The user will need to manually log out via Authentik
            window.location.href = '/';
        }
    }

    onMount(async () => {
        // 1. Revoke server-side tokens (Jellyfin, refresh tokens)
        await revokeServerTokens();

        // 2. Tear down live in-memory state, then clear all client-side user data
        teardownLiveState();
        await clearUserData();

        // 3. Redirect to Authentik logout
        redirectToLogout();
    });
</script>

<div class="center min-h-screen">
    <div class="text-center">
        <span class="loading-spinner loading-spinner-lg loading-spinner-primary mx-auto mb-4"
        ></span>
        <p class="text-surface-400">Logging out...</p>
    </div>
</div>
