// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * notifications-desktop.ts — OS notifications via the SERVICE WORKER, while a
 * tab is open.
 *
 * This is the Notifications API (`registration.showNotification()`), NOT the
 * Push API: no VAPID keys, no subscription table, no server-side delivery
 * path, no new failure mode. It only fires while at least one tab has this
 * module's live listener running — see docs/architecture/user-events.md,
 * "Build — OS notifications from the service worker, while a tab is open".
 *
 * Fires ONLY for the two notification-class kinds off `$lib/stores/
 * user-events.ts` (`library.new_episode`, `request.available`) — never for
 * signal frames.
 *
 * The banner is HYDRATED from the server (`GET /notifications/{id}`, keyed on
 * the frame's `notificationId`) rather than rendered from the frame's payload,
 * so a desktop notification's title/body/icon are byte-identical to the inbox
 * row and to the iOS push banner — all three now come from one server-side
 * renderer instead of three client reimplementations that were free to drift.
 *
 * A frame with no `notificationId` has no durable row (a signal kind, or an
 * insert that failed while Postgres was down) and is skipped: an OS notification
 * is a best-effort nudge on top of the durable row, and the inbox itself
 * reconciles on the next focus.
 *
 * `registration.showNotification()`'s click is handled by `static/sw.js`'s
 * `notificationclick` listener (focuses an existing client, or opens the
 * deep link carried in `data.url`).
 *
 * ## Permission discipline
 *
 * `enable()` is the ONLY thing here that may call `Notification.
 * requestPermission()`, and it must only ever be invoked from an explicit
 * user gesture (a toggle) — never on page load. `init()` (safe to call on
 * app start) only RESUMES listening when the browser already remembers a
 * prior grant; it never prompts.
 */

import { browser } from '$app/environment';
import { writable, type Readable } from 'svelte/store';
import { userEvents, type UserEventFrame } from '$lib/stores/user-events.js';
import { hrefFromLink } from '$lib/stores/notification-inbox.js';
import { getNotification } from '$lib/api/notifications.js';
import { isRecord } from '$lib/utils/data-extraction.js';
import { NOTIFICATION_EVENT_KIND_NAMES } from '$lib/shared/user-event-kinds.js';
import { serviceWorkerAllowed } from '$lib/pwa.js';

const STORAGE_KEY = 'lumastra-desktop-notifications-enabled';

// The DOM's `NotificationPermission` is spelled out rather than referenced.
// It is a TYPE-ONLY lib alias with no runtime binding, so it is absent from
// eslint's `globals.browser` (which lists real constructors — `Notification`
// and `ServiceWorkerRegistration` are there) and `no-undef` rejects it. The
// union is fixed by the Notifications API spec, and `Notification.permission`
// below still type-checks against the real DOM type, so a divergence would
// fail typecheck rather than pass silently.
export type DesktopNotificationPermission = 'default' | 'denied' | 'granted' | 'unsupported';

export interface DesktopNotificationsState {
    /** User's persisted opt-in. Default OFF. */
    enabled: boolean;
    /** Live `Notification.permission`, or 'unsupported' with no SW/Notification API/SSR. */
    permission: DesktopNotificationPermission;
    /**
     * `enable()` got a 'granted' permission but could not confirm the service
     * worker registration within `REGISTRATION_TIMEOUT_MS` (or the promise
     * rejected). `enabled` stays false in this case — see `enable()`'s doc.
     * The UI should render this rather than an unexplained "off".
     */
    registrationFailed: boolean;
}

const initialState: DesktopNotificationsState = {
    enabled: false,
    permission: 'unsupported',
    registrationFailed: false,
};

/**
 * How long `enable()` waits for `navigator.serviceWorker.ready` before
 * treating the registration as failed. `ready` never rejects on its own — if
 * `register()` failed elsewhere, it simply never resolves — so a bare `await`
 * would latch the toggle "on" forever with notifications silently never
 * firing (the bug this guards against). See `showFromFrame()`'s own
 * `serviceWorker.ready` await, which relies on this having already confirmed
 * registration before `startListening()` runs.
 */
const REGISTRATION_TIMEOUT_MS = 5000;

/** Resolves true once the SW registration is confirmed ready, false on timeout or rejection. */
async function confirmServiceWorkerRegistration(): Promise<boolean> {
    try {
        const timeout = new Promise<'timeout'>((resolve) => {
            setTimeout(() => resolve('timeout'), REGISTRATION_TIMEOUT_MS);
        });
        const result = await Promise.race([navigator.serviceWorker.ready, timeout]);
        return result !== 'timeout';
    } catch {
        // expected: registration can reject in some embedded/strict contexts
        return false;
    }
}

const _state = writable<DesktopNotificationsState>(initialState);

/** Reactive state for a settings toggle to bind to. */
export const desktopNotifications: Readable<DesktopNotificationsState> = _state;

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isSupported(): boolean {
    // Notifications are shown through the service worker, which the diagnostic
    // switch can turn off (see serviceWorkerAllowed in pwa.ts).
    return (
        browser &&
        'serviceWorker' in navigator &&
        'Notification' in window &&
        serviceWorkerAllowed()
    );
}

function readPermission(): DesktopNotificationPermission {
    return isSupported() ? Notification.permission : 'unsupported';
}

function loadEnabledPref(): boolean {
    if (!browser) return false;
    try {
        return localStorage.getItem(STORAGE_KEY) === 'true';
    } catch {
        // expected: localStorage may be unavailable (private browsing, etc.)
        return false;
    }
}

function saveEnabledPref(value: boolean): void {
    if (!browser) return;
    try {
        localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
    } catch {
        /* expected: localStorage may be unavailable or full */
    }
}

// ---------------------------------------------------------------------------
// Live listener
// ---------------------------------------------------------------------------

let unsubscribers: Array<() => void> = [];
let listening = false;

/**
 * The durable row's id, when the frame has one. `publishUserEvent` sets it iff
 * the insert succeeded, so its presence is exactly "this frame is in the inbox".
 */
function frameNotificationId(frame: UserEventFrame): string | null {
    if (!isRecord(frame.data)) return null;
    const id = frame.data.notificationId;
    return typeof id === 'string' && id.length > 0 ? id : null;
}

async function showFromFrame(frame: UserEventFrame): Promise<void> {
    // Re-check at fire time, not just at subscribe time — permission can be
    // revoked mid-session (browser settings), and the SW can be unregistered.
    if (!isSupported() || Notification.permission !== 'granted') return;

    const notificationId = frameNotificationId(frame);
    if (!notificationId) return;

    const { data: item } = await getNotification(notificationId);
    if (!item) return;

    try {
        const registration = await navigator.serviceWorker.ready;
        await registration.showNotification(item.display.title, {
            body: item.display.body,
            // An OS notification takes ONE icon URL and silently shows nothing
            // if it 404s — it cannot retry the way an <img> in the drawer can.
            // `display.imageUrl` is the server's single best pick for exactly
            // that reason.
            icon: item.display.imageUrl,
            tag: `lumastra-${item.kind}-${item.id}`,
            data: { url: hrefFromLink(item.link) ?? '/' },
        });
    } catch (err) {
        console.warn('[DesktopNotifications] showNotification failed:', err);
    }
}

function startListening(): void {
    if (listening || !browser) return;
    listening = true;
    userEvents.connect();
    unsubscribers = NOTIFICATION_EVENT_KIND_NAMES.map((kind) =>
        userEvents.subscribe(kind, (frame) => {
            void showFromFrame(frame);
        }),
    );
}

function stopListening(): void {
    if (!listening) return;
    listening = false;
    for (const off of unsubscribers) off();
    unsubscribers = [];
    userEvents.disconnect();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Request permission and opt in. MUST be called from an explicit user
 * gesture — calling `Notification.requestPermission()` outside one is either
 * silently ignored or throws in strict/embedded contexts, and prompting on
 * page load trains users to dismiss it. Returns whether notifications ended
 * up enabled.
 *
 * A 'granted' permission alone isn't enough to latch "on" — the service
 * worker registration itself may have failed, in which case
 * `showFromFrame()`'s `await navigator.serviceWorker.ready` would never
 * resolve and notifications would silently never appear. So this also
 * confirms the registration (bounded by `REGISTRATION_TIMEOUT_MS`) before
 * committing to `enabled: true`; a failed confirmation surfaces via
 * `registrationFailed` instead of an optimistic "on".
 */
export async function enable(): Promise<boolean> {
    if (!isSupported()) {
        _state.set({ enabled: false, permission: 'unsupported', registrationFailed: false });
        return false;
    }

    let permission = Notification.permission;
    if (permission === 'default') {
        permission = await Notification.requestPermission();
    }

    if (permission !== 'granted') {
        saveEnabledPref(false);
        _state.set({ enabled: false, permission, registrationFailed: false });
        return false;
    }

    const registered = await confirmServiceWorkerRegistration();
    if (!registered) {
        saveEnabledPref(false);
        _state.set({ enabled: false, permission, registrationFailed: true });
        return false;
    }

    saveEnabledPref(true);
    _state.set({ enabled: true, permission, registrationFailed: false });
    startListening();
    return true;
}

/** Opt out. Never touches permission — safe to call any time, no gesture required. */
export function disable(): void {
    saveEnabledPref(false);
    _state.update((s) => ({ ...s, enabled: false, registrationFailed: false }));
    stopListening();
}

/**
 * Call on app start (NOT a user gesture). Loads the persisted opt-in and, if
 * the browser already remembers a prior grant, resumes listening WITHOUT
 * prompting (only `enable()` ever calls `requestPermission()`). Returns a
 * teardown; also call this (or `teardown()`) on logout.
 */
export function init(): () => void {
    if (!browser) return () => {};

    const permission = readPermission();
    const enabledPref = loadEnabledPref();
    const enabled = enabledPref && permission === 'granted';
    _state.set({ enabled, permission, registrationFailed: false });

    if (enabled) startListening();

    return () => stopListening();
}

/** Hard teardown — call on logout. Stops the live listener; leaves the browser-level permission alone. */
export function teardown(): void {
    stopListening();
}

/**
 * Re-read the live `Notification.permission` and reconcile state against it.
 * A browser never fires an event when the user revokes permission from its
 * own settings UI, so callers must poll this at a sensible moment — e.g. the
 * settings page's `visibilitychange`/`focus` handlers — rather than trusting
 * the snapshot taken at `init()`/`enable()` time to still be current.
 *
 * If the permission was revoked out from under an `enabled` session, this
 * also stops the live listener and clears the persisted opt-in — leaving it
 * on would keep `userEvents`/the inbox subscription alive for a feature that
 * can no longer fire, and would re-show as "enabled" on the next load.
 */
export function refreshPermission(): void {
    if (!isSupported()) return;
    const permission = Notification.permission;
    _state.update((s) => {
        if (s.permission === permission) return s;
        if (permission !== 'granted' && s.enabled) {
            stopListening();
            saveEnabledPref(false);
            return { enabled: false, permission, registrationFailed: false };
        }
        return { ...s, permission };
    });
}
