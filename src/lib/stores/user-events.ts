// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * user-events.ts — client SSE consumer for the per-user event stream
 * documented as `GET /api/v1/events` (`$lib/server/api/defs/events/index.ts`,
 * see `docs/architecture/user-events.md`).
 *
 * ## Which URL this actually connects to, and why
 *
 * `defs/events/index.ts` is mounted on BOTH surfaces:
 *   - `/api/v1/events`   — the Bearer-only token surface (PAT / service /
 *     device tokens). The reverse proxy does NOT inject Authentik forward-auth
 *     headers on `/api/v1/*` (see `forward-auth.ts` and the
 *     `FALLBACK_POLL_INTERVAL_MS` comment in `run-sse-bus.ts`), and a browser
 *     `EventSource` cannot attach an `Authorization` header at all. A browser
 *     tab hitting `/api/v1/events` therefore cannot authenticate, full stop.
 *   - `/api/events/user` — the cookie / forward-auth surface. This is what a
 *     browser tab CAN authenticate against, and is the mount
 *     `$lib/services/sse/watch-state-sse.ts` reaches for the signal-only
 *     subset of this same stream.
 *
 * So this module — like `runSSEBus` before it — connects to the internal
 * alias. The wire event NAMES are identical on both mounts (same handler);
 * only the URL/auth path differs. This is the load-bearing gotcha the task
 * brief pointed at in `run-sse-bus.ts`'s comments.
 *
 * ## This module owns the tab's ONE `/events/user` connection
 *
 * `watch-state-sse.ts` used to open a SECOND EventSource to the same URL, and
 * `+layout.svelte` starts both on mount — so every authenticated tab held two
 * server-side consumers, and every `watch_state_set_changed` frame cost two
 * full page-node refetches (that handler calls `invalidateWhenIdle`). It is
 * now a `subscribe()` consumer here like any other. Anything else that needs
 * per-user frames must subscribe here too rather than construct its own
 * EventSource.
 *
 * ## Design
 *
 * Singleton, refcounted connection (never one EventSource per component) with
 * exponential backoff, modeled on `watchTogether/sse-connection.ts` (reuses
 * its pure `calculateReconnectDelay`) and `run-sse-bus.ts` (refcounted
 * connect/disconnect, named-event listeners, manual-reconnect Last-Event-ID
 * cursor via a `?since=` query param — `EventSource` only sends the
 * `Last-Event-ID` HEADER on its own native retries, never on a manual
 * `new EventSource(url)` reconnect, so the cursor must be carried explicitly;
 * see `sse-replay-hub.ts`'s `streamResponse` for the `since` param it reads).
 *
 * Never connects during SSR (`browser` guard) and exposes `teardown()` for a
 * hard reset on logout.
 */

import { browser } from '$app/environment';
import { apiUrl } from '$lib/shared/api-urls.js';
import { calculateReconnectDelay } from '$lib/stores/watchTogether/sse-connection.js';
import { USER_EVENT_KIND_NAMES } from '$lib/shared/user-event-kinds.js';
import type { UserEventKind } from '$lib/shared/user-event-kinds.js';

export type { UserEventKind };

/** A single parsed frame from the per-user SSE stream. */
export interface UserEventFrame {
    /** The literal SSE `event:` field — one of `USER_EVENT_KIND_NAMES`. */
    kind: string;
    /**
     * Parsed JSON payload. Shape depends on `kind` and is NOT schema-validated
     * here — the row this may end up persisted as is read by clients compiled
     * at other versions, so every consumer must treat this defensively (see
     * `notification-inbox.ts`'s `deriveViewItem`).
     */
    data: unknown;
    /**
     * SSE frame id, when the server sent one. Only hub-originated frames
     * (the notification kinds and the device remote-control kinds
     * `device.command_status` / `device.state` and watch-state signals) carry
     * an id. Watch-state signals skip replay; reconnect catch-up uses a GET.
     * Local `admin` / `session_changed` frames do not carry an id. Typed subscriptions to the two device kinds
     * live in `device-events.ts`.
     */
    id?: string;
    /** Client receive time (`Date.now()`), for staleness/ordering needs. */
    receivedAt: number;
}

export interface UserEventsStore {
    connect(): void;
    disconnect(): void;
    /**
     * Re-attempt connection after exhausting the reconnect budget. Resets
     * the attempt counter and clears `reconnectExhausted`, then reconnects
     * immediately — mirrors `run-sse-bus.ts`'s `manualRetry()`.
     */
    manualRetry(): void;
    teardown(): void;
    subscribe(kind: string, callback: (frame: UserEventFrame) => void): () => void;
    subscribeAll(callback: (frame: UserEventFrame) => void): () => void;
    onConnectedChange(callback: (connected: boolean) => void): () => void;
    readonly connected: boolean;
    /**
     * True once the store has exhausted its reconnect budget
     * (`MAX_RECONNECT_ATTEMPTS`) and stopped retrying on its own. Before
     * this flag existed, exhaustion was silent and permanent — the module
     * went quietly deaf until a page reload. A missed notification frame is
     * recoverable by the inbox's next poll, but the connection itself stays
     * dead until something calls `manualRetry()`, so a consuming surface
     * (e.g. the notification bell) should render a "reconnect" affordance
     * while this is true rather than assume the silence means "nothing
     * new." Cleared by `manualRetry()`, by a successful reconnect, and by
     * the automatic budget-reset on a browser `online` event below.
     */
    readonly reconnectExhausted: boolean;
}

const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY_MS = 1000;
const MAX_RECONNECT_DELAY_MS = 30_000;

// See the module doc above for why this is the internal alias, not
// `/api/v1/events`.
const STREAM_URL = apiUrl('internal', '/events/user');

function parseJsonSafe(data: string): unknown {
    try {
        return JSON.parse(data);
    } catch {
        return null;
    }
}

function createUserEventsStore(): UserEventsStore {
    let eventSource: EventSource | null = null;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let manuallyDisconnected = false;
    // '0' = no cursor yet (matches sse-replay-hub.ts's default). Carried
    // across manual reconnects; reset on a hard teardown() (logout) so the
    // next connect() starts a fresh replay window rather than requesting a
    // stale/foreign cursor.
    let lastEventId = '0';
    let _connected = false;
    let _refCount = 0;
    /**
     * Refs handed out BEFORE the last `teardown()`. Teardown zeroes the
     * refcount, but its consumers do not know that: notification-inbox.ts
     * still holds `liveStarted`, notifications-desktop.ts its listener
     * handle, watch-state-sse.ts `started`. Each still calls `disconnect()`
     * on its own teardown path, and that decrement would land on a refcount
     * that by then belongs to whoever connected after the logout — closing a
     * stream its owner never released. Absorb exactly that many disconnects
     * instead.
     *
     * Counting rather than identifying refs means a POST-teardown consumer's
     * disconnect can be absorbed in a stale one's place when they interleave.
     * That is deliberate: decrements still balance increments one-for-one, so
     * the count converges on the same value and the only effect is that the
     * close can land one disconnect later. Telling them apart would need a
     * per-consumer handle, which `connect()`/`disconnect()` do not have.
     *
     * The trade, stated plainly: if a pre-teardown holder never disconnects
     * at all (asymmetric teardown), a leftover stale credit can absorb a
     * later, legitimate disconnect and leave the stream open with no holder.
     * That is the better failure — a leaked connection in a realm that is
     * already logging out, versus silently closing a live consumer's stream
     * for the rest of the session. Today every consumer is mounted and
     * unmounted together by +layout.svelte, so the drain is all-or-nothing.
     */
    let _staleRefs = 0;
    let _reconnectExhausted = false;

    const kindCallbacks = new Map<string, Set<(frame: UserEventFrame) => void>>();
    const allCallbacks = new Set<(frame: UserEventFrame) => void>();
    const connectedCallbacks = new Set<(connected: boolean) => void>();

    /**
     * `alwaysNotify` exists because `onConnectedChange` reports TRANSITIONS of
     * a boolean, and a connect attempt that fails before ever opening does not
     * move one: `_connected` starts false, so `setConnected(false)` from
     * `onerror` would early-return and tell nobody. A consumer that needs to
     * know "an attempt just failed" (watch-state-sse.ts, which bumps its
     * revision counters on the NEXT open to catch up on the missed window)
     * would then see that open as an initial connect and skip the catch-up.
     * Deliberate closes stay un-forced — a disconnect() is not a failure.
     */
    function setConnected(value: boolean, alwaysNotify = false): void {
        if (_connected === value && !alwaysNotify) return;
        _connected = value;
        for (const cb of connectedCallbacks) {
            try {
                cb(value);
            } catch (err) {
                console.error('[UserEvents] connected callback error:', err);
            }
        }
    }

    function dispatch(frame: UserEventFrame): void {
        const forKind = kindCallbacks.get(frame.kind);
        if (forKind) {
            for (const cb of forKind) {
                try {
                    cb(frame);
                } catch (err) {
                    console.error(`[UserEvents] "${frame.kind}" callback error:`, err);
                }
            }
        }
        for (const cb of allCallbacks) {
            try {
                cb(frame);
            } catch (err) {
                console.error('[UserEvents] callback error:', err);
            }
        }
    }

    function handleNamedEvent(kind: string): (event: MessageEvent<string>) => void {
        return (event) => {
            // Firefox can deliver lastEventId='' on the first message; only
            // adopt non-empty ids so the next reconnect's ?since= cursor
            // doesn't regress (same guard as run-sse-bus.ts).
            if (event.lastEventId && event.lastEventId !== '0') {
                lastEventId = event.lastEventId;
            }
            dispatch({
                kind,
                data: parseJsonSafe(event.data),
                id: event.lastEventId || undefined,
                receivedAt: Date.now(),
            });
        };
    }

    function scheduleReconnect(): void {
        reconnectAttempts++;
        if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
            console.warn(
                '[UserEvents] Max reconnect attempts reached — call manualRetry() to resume',
            );
            // Surface exhaustion so a consuming surface can offer a
            // "reconnect" affordance instead of the module quietly going
            // deaf until a reload (mirrors run-sse-bus.ts).
            _reconnectExhausted = true;
            setConnected(false);
            return;
        }
        const delay = calculateReconnectDelay(
            reconnectAttempts,
            INITIAL_RECONNECT_DELAY_MS,
            MAX_RECONNECT_DELAY_MS,
        );
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (!manuallyDisconnected) openConnection();
        }, delay);
    }

    /**
     * Re-attempt connection after exhausting the reconnect budget. Resets
     * the attempt counter and the exhausted flag, then reconnects
     * immediately.
     */
    function manualRetry(): void {
        reconnectAttempts = 0;
        _reconnectExhausted = false;
        manuallyDisconnected = false;
        openConnection();
    }

    /**
     * A laptop sleep or a dropped VPN is the normal way to burn through
     * `MAX_RECONNECT_ATTEMPTS` — the tab was simply offline while the
     * backoff schedule ran out. Treat the browser reporting connectivity
     * again as a fresh budget rather than requiring a page reload: this is
     * the automatic counterpart to `manualRetry()`, triggered by the
     * platform instead of a user click. No-op while a deliberate
     * disconnect() is in effect, or while already connected.
     */
    function handleOnline(): void {
        if (manuallyDisconnected || _connected) return;
        reconnectAttempts = 0;
        _reconnectExhausted = false;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        openConnection();
    }

    function openConnection(): void {
        if (!browser) return;

        manuallyDisconnected = false;

        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }

        const url = lastEventId !== '0' ? `${STREAM_URL}?since=${lastEventId}` : STREAM_URL;
        try {
            eventSource = new EventSource(url, { withCredentials: true });
        } catch (err) {
            // `new EventSource` can throw synchronously (a SecurityError on a
            // URL the page may not open, a missing constructor in an exotic
            // runtime). Treat it as a failed connect rather than letting it
            // escape: `connect()` has already taken a refcount by this point,
            // and every consumer calls it from a mount path (+layout.svelte's
            // onMount) where an exception would abort the rest of the mount.
            // watch-state-sse.ts relied on exactly this being non-throwing
            // back when it owned its own EventSource.
            console.error('[UserEvents] EventSource construction failed:', err);
            eventSource = null;
            setConnected(false, true);
            scheduleReconnect();
            return;
        }

        for (const kind of USER_EVENT_KIND_NAMES) {
            eventSource.addEventListener(kind, handleNamedEvent(kind));
        }

        eventSource.onopen = () => {
            reconnectAttempts = 0;
            _reconnectExhausted = false;
            setConnected(true);
        };

        eventSource.onerror = () => {
            setConnected(false, true);
            if (manuallyDisconnected) return;
            if (eventSource) {
                eventSource.close();
                eventSource = null;
            }
            scheduleReconnect();
        };
    }

    function closeConnection(): void {
        manuallyDisconnected = true;

        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }

        setConnected(false);
        reconnectAttempts = 0;
        _reconnectExhausted = false;
    }

    // ── Public refcounting wrappers — open on first consumer (0→1), close
    // only when the last leaves (→0). Mirrors run-sse-bus.ts's pattern so
    // notification-inbox.ts and notifications-desktop.ts (and any future
    // consumer) can each call connect()/disconnect() independently without
    // stomping on each other's connection lifecycle. ─────────────────────

    // Installed only while at least one consumer holds the connection open
    // (tied to the refcount, not to individual reconnect attempts) so a
    // page with no active subscriber isn't left with a dangling
    // window-level listener.
    let onlineListenerInstalled = false;

    function installOnlineListener(): void {
        if (!browser || onlineListenerInstalled) return;
        onlineListenerInstalled = true;
        window.addEventListener('online', handleOnline);
    }

    function removeOnlineListener(): void {
        if (!browser || !onlineListenerInstalled) return;
        onlineListenerInstalled = false;
        window.removeEventListener('online', handleOnline);
    }

    function connect(): void {
        if (!browser) return;
        _refCount += 1;
        if (_refCount === 1) {
            installOnlineListener();
            openConnection();
        }
    }

    function disconnect(): void {
        // A ref issued before the last teardown() — already released there.
        if (_staleRefs > 0) {
            _staleRefs -= 1;
            return;
        }
        if (_refCount === 0) return;
        _refCount -= 1;
        if (_refCount === 0) {
            removeOnlineListener();
            closeConnection();
        }
    }

    /**
     * Hard teardown — call on logout. Ignores the refcount (every consumer's
     * connection is dead the moment the session is), and drops the replay
     * cursor so the next `connect()` (a different user, or the same user
     * signing back in) doesn't request a foreign/stale `since=` window.
     */
    function teardown(): void {
        // `+=`, not `=`: a second teardown before the first batch of stale
        // holders has drained must not discard what is still outstanding.
        _staleRefs += _refCount;
        _refCount = 0;
        lastEventId = '0';
        removeOnlineListener();
        closeConnection();
    }

    /** Subscribe to frames of one specific kind. Returns an unsubscribe. */
    function subscribe(kind: string, callback: (frame: UserEventFrame) => void): () => void {
        let set = kindCallbacks.get(kind);
        if (!set) {
            set = new Set();
            kindCallbacks.set(kind, set);
        }
        const kindSet = set;
        kindSet.add(callback);
        return () => {
            kindSet.delete(callback);
        };
    }

    /** Subscribe to every frame regardless of kind. Returns an unsubscribe. */
    function subscribeAll(callback: (frame: UserEventFrame) => void): () => void {
        allCallbacks.add(callback);
        return () => {
            allCallbacks.delete(callback);
        };
    }

    /**
     * Register a callback fired on every connected/disconnected transition,
     * AND on every failed connect attempt (which is not a transition when the
     * connection had never opened — see `setConnected`). Consumers must treat
     * a repeated `false` as idempotent rather than as a new event.
     */
    function onConnectedChange(callback: (connected: boolean) => void): () => void {
        connectedCallbacks.add(callback);
        return () => {
            connectedCallbacks.delete(callback);
        };
    }

    return {
        connect,
        disconnect,
        manualRetry,
        teardown,
        subscribe,
        subscribeAll,
        onConnectedChange,
        get connected() {
            return _connected;
        },
        get reconnectExhausted() {
            return _reconnectExhausted;
        },
    };
}

/** Singleton — import this, never construct your own. */
export const userEvents: UserEventsStore = createUserEventsStore();
