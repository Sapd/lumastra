// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { browser } from '$app/environment';

/**
 * Screen Wake Lock API utility
 * Prevents device screen from dimming/sleeping during video playback
 *
 * Known limitations on Linux:
 * - Firefox uses D-Bus to communicate with org.freedesktop.ScreenSaver or
 *   org.gnome.SessionManager. Some desktop environments may not support these.
 * - Firefox 144+ fixed a bug where D-Bus wake lock malfunctioned after
 *   extended Firefox sessions (Bug 1862159).
 * - If Wake Lock fails, users may need to use tools like caffeine-ng or
 *   configure their screensaver settings.
 */

let wakeLock: WakeLockSentinel | null = null;
let wakeLockFailed = false;

/**
 * Check if Wake Lock API is available and document is in a state where it can be requested
 */
function canRequestWakeLock(): boolean {
    if (!browser) return false;
    if (!('wakeLock' in navigator)) return false;
    if (document.visibilityState === 'hidden') return false;
    return true;
}

/**
 * Request a screen wake lock to prevent display from sleeping.
 * Should be called when playback starts. For best results, call during a user gesture
 * (e.g., play button click) as some browsers may require user activation.
 */
export async function requestWakeLock(): Promise<boolean> {
    if (!browser) return false;

    // If we already have an active lock, we're good
    if (wakeLock && !wakeLock.released) {
        return true;
    }

    if (!canRequestWakeLock()) {
        if (!('wakeLock' in navigator)) {
            console.debug('[WakeLock] API not supported in this browser');
        } else if (document.visibilityState === 'hidden') {
            console.debug('[WakeLock] Cannot request while document is hidden');
        }
        return false;
    }

    try {
        wakeLock = await navigator.wakeLock.request('screen');

        wakeLock.addEventListener('release', () => {
            console.debug('[WakeLock] Released by system');
            wakeLock = null;
        });

        wakeLockFailed = false;
        console.debug('[WakeLock] Acquired');
        return true;
    } catch (error) {
        wakeLockFailed = true;
        // Wake lock request can fail if:
        // - Document is not visible (NotAllowedError)
        // - Low battery mode on some devices
        // - User denied permission
        // - Linux: D-Bus communication failed with screensaver daemon
        // - Permissions-Policy blocks it
        const errorName = error instanceof Error ? error.name : 'Unknown';
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.warn(
            `[WakeLock] Failed (${errorName}): ${errorMsg}. ` +
                'On Linux, this may indicate D-Bus issues with your desktop environment. ' +
                'Consider using caffeine-ng or similar tools as a workaround.',
        );
        return false;
    }
}

/**
 * Check if wake lock acquisition has failed
 * Useful for showing user feedback about potential screensaver issues
 */
export function hasWakeLockFailed(): boolean {
    return wakeLockFailed && !isWakeLockActive();
}

/**
 * Release the screen wake lock
 * Should be called when video is paused or player is closed
 */
export async function releaseWakeLock(): Promise<void> {
    if (!wakeLock) return;

    try {
        await wakeLock.release();
        wakeLock = null;
        console.debug('[WakeLock] Released');
    } catch (error) {
        // best-effort cleanup
        console.debug('[WakeLock] Release failed:', error);
    }
}

/**
 * Check if wake lock is currently active
 */
export function isWakeLockActive(): boolean {
    return wakeLock !== null && !wakeLock.released;
}

/**
 * Re-acquire wake lock when document becomes visible again
 * Browsers automatically release wake lock when tab is hidden
 */
export function setupWakeLockReacquisition(shouldBeActive: () => boolean): () => void {
    if (!browser) {
        return () => {};
    }

    const handleVisibilityChange = () => {
        if (document.visibilityState === 'visible' && shouldBeActive()) {
            void requestWakeLock();
        }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
        document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
}

/**
 * Alias for releaseWakeLock for consistency with cleanup patterns
 */
export function destroyWakeLock(): void {
    void releaseWakeLock();
}
