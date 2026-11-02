// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { browser } from '$app/environment';
import { base } from '$app/paths';

let swRegistration: ServiceWorkerRegistration | null = null;
let refreshing = false;

// Track if page was controlled by a SW at script load time
// This is checked before any async operations to accurately detect updates vs first install
const wasControlledAtLoad =
    browser && 'serviceWorker' in navigator && !!navigator.serviceWorker.controller;

// Track if an update is pending (deferred because user was watching content)
let updatePending = false;

type ServiceWorkerMessage = {
    type: string;
    version?: string;
};

function isServiceWorkerMessage(data: unknown): data is ServiceWorkerMessage {
    if (!data || typeof data !== 'object') return false;
    return 'type' in data && typeof (data as Record<string, unknown>).type === 'string';
}

/**
 * Check if user is on the watch page (should not interrupt with reload)
 * Accounts for base path in subfolder deployments
 */
function isOnWatchPage(): boolean {
    if (!browser) return false;
    const pathname = window.location.pathname;
    // Account for base path - the watch route would be at {base}/watch/...
    const watchPath = base ? `${base}/watch` : '/watch';
    return pathname.startsWith(watchPath);
}

/**
 * Check if there's a pending update that was deferred
 */
export function hasPendingUpdate(): boolean {
    return updatePending;
}

/**
 * Apply a pending update by reloading the page.
 * Call this when navigating away from watch routes.
 */
export function applyPendingUpdate(): void {
    if (!browser || !updatePending || refreshing) return;

    // Double-check we're not on watch page anymore
    if (isOnWatchPage()) {
        console.log('[PWA] Still on watch page, deferring update');
        return;
    }

    refreshing = true;
    updatePending = false;
    console.log('[PWA] Applying deferred update, reloading page');
    window.location.reload();
}

/**
 * Diagnostic switch: localStorage `lumastra:disable-sw` = '1' runs the page
 * without a service worker (and removes a registered one), on any platform.
 *
 * iOS was briefly excluded on 2026-10-15 while chasing the iOS Safari
 * first-segment playback loop; the loop also happened with no worker
 * registered, so the worker runs on iOS again.
 */
export const SERVICE_WORKER_DISABLED_KEY = 'lumastra:disable-sw';

export function isServiceWorkerDisabled(): boolean {
    try {
        return localStorage.getItem(SERVICE_WORKER_DISABLED_KEY) === '1';
    } catch {
        return false;
    }
}

/** Whether this page may run the service worker (see above). */
export function serviceWorkerAllowed(): boolean {
    return !isServiceWorkerDisabled();
}

export async function unregisterAllServiceWorkers(): Promise<number> {
    if (!browser || !('serviceWorker' in navigator) || !navigator.serviceWorker) return 0;
    try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((registration) => registration.unregister()));
        return registrations.length;
    } catch {
        return 0;
    }
}

export function registerServiceWorker() {
    if (!browser) return;

    if (!serviceWorkerAllowed()) {
        void unregisterAllServiceWorkers().then((count) => {
            console.log(
                `[PWA] No service worker (${SERVICE_WORKER_DISABLED_KEY}); unregistered ${count}`,
            );
        });
        return;
    }

    if ('serviceWorker' in navigator) {
        // Set up controller change listener IMMEDIATELY (before load event)
        // This ensures we catch the event even if SW activates quickly
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            console.log('[PWA] Controller changed');
            // Only reload if we had a previous controller (i.e., this is an update, not first install)
            // and we haven't already triggered a refresh
            if (wasControlledAtLoad && !refreshing) {
                // Check if user is watching content - don't interrupt!
                if (isOnWatchPage()) {
                    console.log(
                        '[PWA] New SW took control, but user is watching. Deferring reload.',
                    );
                    updatePending = true;
                    // Dispatch event so UI can show a notification if desired
                    window.dispatchEvent(new CustomEvent('pwa-update-deferred'));
                    return;
                }

                refreshing = true;
                console.log('[PWA] New SW took control, reloading to apply updates');
                window.location.reload();
            }
        });

        // Listen for messages from SW (backup notification mechanism)
        navigator.serviceWorker.addEventListener('message', (event) => {
            const message: unknown = event.data;
            if (isServiceWorkerMessage(message) && message.type === 'SW_ACTIVATED') {
                console.log('[PWA] Received SW_ACTIVATED message:', message.version);
                // controllerchange should have already triggered reload, but log for debugging
            }
        });

        const registerOnLoad = async () => {
            try {
                // Register the service worker with base path for subfolder support
                const swPath = base ? `${base}/sw.js` : '/sw.js';
                const scope = base || '/';
                const registration = await navigator.serviceWorker.register(swPath, {
                    scope: scope,
                    updateViaCache: 'none', // Always check for updates
                });

                swRegistration = registration;
                console.log('[PWA] Service worker registered:', registration.scope);

                // Check for updates on registration
                registration.addEventListener('updatefound', () => {
                    const newWorker = registration.installing;
                    if (newWorker) {
                        console.log('[PWA] New service worker installing...');

                        newWorker.addEventListener('statechange', () => {
                            if (
                                newWorker.state === 'installed' &&
                                navigator.serviceWorker.controller
                            ) {
                                // New version available
                                console.log(
                                    '[PWA] New version available, will activate on next reload',
                                );
                                // Optionally notify the user
                                dispatchUpdateEvent();
                            }
                        });
                    }
                });
            } catch (error) {
                console.error('[PWA] Service worker registration failed:', error);
            }
        };

        window.addEventListener('load', () => {
            void registerOnLoad();
        });
    }
}

/**
 * Wipe every CacheStorage cache for this origin, and tell the active service
 * worker to do the same. Belt-and-suspenders companion to the server's
 * `Clear-Site-Data` header (security fix C7): the SW app-shell cache used to
 * keep one user's personalized SSR HTML across logout, so a second user on a
 * shared device/browser could see it on a slow or offline navigation. Call
 * this from every logout path — `clearUserData()` (logout/+page.svelte) and
 * `nativeSignOut()` (UserMenuPopover.svelte) — before the redirect fires.
 *
 * Both steps are wrapped in their own try/catch: CacheStorage and
 * `navigator.serviceWorker` can be unavailable (older browsers, private
 * browsing, SW not registered), and a failure here must never block logout.
 */
export async function clearServiceWorkerCaches(): Promise<void> {
    if (!browser) return;

    try {
        if ('caches' in window) {
            const cacheNames = await caches.keys();
            await Promise.all(cacheNames.map((name) => caches.delete(name)));
        }
    } catch (error) {
        console.warn('[PWA] Failed to clear CacheStorage on logout:', error);
    }

    try {
        navigator.serviceWorker?.controller?.postMessage({ type: 'clearCache' });
    } catch (error) {
        console.warn('[PWA] Failed to notify service worker to clear cache:', error);
    }
}

export function checkForUpdates() {
    if (!browser || !('serviceWorker' in navigator)) return;

    if (swRegistration) {
        swRegistration.update().catch((err) => {
            console.warn('[PWA] Update check failed:', err);
        });
    }
}

export function getServiceWorkerVersion(): Promise<string | null> {
    if (!browser || !swRegistration?.active) {
        return Promise.resolve(null);
    }

    const activeWorker = swRegistration.active;

    return new Promise((resolve) => {
        const messageChannel = new MessageChannel();
        messageChannel.port1.onmessage = (event) => {
            const message: unknown = event.data;
            if (isServiceWorkerMessage(message)) {
                resolve(message.version || null);
                return;
            }
            resolve(null);
        };

        activeWorker.postMessage('getVersion', [messageChannel.port2]);

        // Timeout after 1 second
        setTimeout(() => resolve(null), 1000);
    });
}

export function skipWaiting() {
    if (!browser || !swRegistration?.waiting) return;

    swRegistration.waiting.postMessage('skipWaiting');
}

// Dispatch custom event when update is available
function dispatchUpdateEvent() {
    if (browser) {
        window.dispatchEvent(new CustomEvent('pwa-update-available'));
    }
}

// PWA install prompt
let deferredPrompt: BeforeInstallPromptEvent | null = null;

interface BeforeInstallPromptEvent extends Event {
    prompt(): Promise<void>;
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function setupPWAInstall() {
    if (!browser) return;

    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        deferredPrompt = e as BeforeInstallPromptEvent;
        console.log('[PWA] Install prompt available');
        window.dispatchEvent(new CustomEvent('pwa-install-available'));
    });

    window.addEventListener('appinstalled', () => {
        console.log('[PWA] App was installed');
        deferredPrompt = null;
        window.dispatchEvent(new CustomEvent('pwa-installed'));
    });
}

export async function promptPWAInstall(): Promise<boolean> {
    if (!deferredPrompt) {
        console.log('[PWA] No install prompt available');
        return false;
    }

    try {
        await deferredPrompt.prompt();
        const choiceResult = await deferredPrompt.userChoice;

        if (choiceResult.outcome === 'accepted') {
            console.log('[PWA] User accepted the install prompt');
            deferredPrompt = null;
            return true;
        } else {
            console.log('[PWA] User dismissed the install prompt');
            return false;
        }
    } catch (error) {
        console.error('[PWA] Install prompt failed:', error);
        return false;
    }
}

export function canInstall(): boolean {
    return deferredPrompt !== null;
}

export function isPWAInstalled(): boolean {
    if (!browser) return false;

    // Check display-mode
    if (window.matchMedia('(display-mode: standalone)').matches) {
        return true;
    }

    // Check iOS standalone mode
    if ((window.navigator as Navigator & { standalone?: boolean }).standalone === true) {
        return true;
    }

    // Check if running in TWA (Trusted Web Activity)
    if (document.referrer.includes('android-app://')) {
        return true;
    }

    return false;
}

export function isIOSDevice(): boolean {
    if (!browser) return false;

    return (
        /iPad|iPhone|iPod/.test(navigator.userAgent) ||
        (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
}

// iOS doesn't support beforeinstallprompt, so we need to show manual instructions
export function needsManualInstall(): boolean {
    return isIOSDevice() && !isPWAInstalled();
}
