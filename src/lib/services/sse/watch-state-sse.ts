// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/services/sse/watch-state-sse.ts
import { invalidateWhenIdle } from '$lib/utils/invalidate-when-idle';
import { createMinInterval } from '$lib/utils/min-interval';
import { browser } from '$app/environment';
import { writable, type Readable } from 'svelte/store';
import { handleAdminEvent } from './admin-event-handler.js';
import { getDeviceId } from '$lib/components/player/device-id.js';
import { bumpWatchStateVersion } from '$lib/stores/watch-state-version.js';
import { userEvents } from '$lib/stores/user-events.js';

// ---------------------------------------------------------------------------
// Three SSE channels off the SHARED per-user stream.
//
// This module used to own its own `EventSource` to `/events/user`. So does
// `$lib/stores/user-events.ts`, and `+layout.svelte` starts BOTH on mount
// (`watchStateSSE.start()` at :229; `notificationInbox.init()` /
// `initDesktopNotifications()` at :243-244, which both reach
// `userEvents.connect()`). Every authenticated tab therefore held two
// server-side consumers on one endpoint — and, because the
// `watch_state_set_changed` handler below calls `invalidateWhenIdle` on every
// frame, each signal cost TWO full page-node refetches. The bytes were
// negligible; the duplicated invalidation source was not.
//
// `userEvents` is now the single owner of that connection and this module is
// one of its consumers. It already had everything needed to be the owner:
// refcounted connect/disconnect (so the inbox and this module release
// independently), a `?since=` replay cursor across manual reconnects, and a
// fan-out that try/catches EACH callback — so a throw in one consumer's
// handler cannot starve another's or tear the stream down.
//
// Backoff note, and a KNOWN GAP. `userEvents` caps reconnects at
// MAX_RECONNECT_ATTEMPTS (10) and then sets `reconnectExhausted`, where this
// module previously retried forever. The per-attempt delays are identical
// (1s doubling to 30s); only the cap is new. A browser `online` event resets
// the budget automatically (user-events.ts's `handleOnline`), which covers
// the laptop-sleep / VPN-drop case that is the normal way to burn it.
//
// It does NOT cover failures that never toggle `navigator.onLine`: the hub's
// per-user 429 / process-wide 503 ceilings (`sse-replay-hub.ts`), a proxy
// that kills SSE, a pod that keeps 502ing. In those, the budget burns in
// ~8.5 minutes and the tab goes deaf to watch-state signals until a reload.
// `reconnectExhausted` is meant to drive a reconnect affordance and
// `manualRetry()` to revive it — as of this commit NOTHING in src/ reads the
// former or calls the latter (the only such UI, RunLogStream.svelte, belongs
// to the unrelated run-sse-bus). Wiring one up is the follow-up; until then
// the cap is a real, if rare, loss of liveness rather than a fully mitigated
// trade.
//
// Both signal channels are coalesced server-side at 1 emit / sec / user, and
// both fire only on real state transitions. No heartbeat-driven traffic.
//
//   • watch_state_set_changed — CW / new-episodes / watch-status set
//     membership could have changed (mark / clear / auto-complete / sync).
//     Consumed by ForYou + browse to refetch their watching strips.
//
//   • session_changed — session lifecycle transitions for ALL sources
//     (Lumastra start/pause/resume/stop AND external Jellyfin/ABS/LiveTV/music
//     first-sighting / status flip / vanish). Consumed by ForYou (CW refetch)
//     and admin/sessions.
//
//   • admin — the perishable play-session toast (`broadcastAdminMessage()`).
//     Not to be confused with the durable `admin.broadcast` NOTIFICATION kind
//     the inbox consumes off this same stream; see user-event-kinds.ts.
// ---------------------------------------------------------------------------

const REVISION_DEBOUNCE_MS = 1500;

// A burst of watch-state frames used to fire one FULL page-node refetch each
// (SvelteKit forces private,no-store on data responses, so every one is a real
// network round trip). Only the revision store above was debounced.
const WATCH_STATE_INVALIDATE_MIN_INTERVAL_MS = 5_000;
const gateWatchStateInvalidate = createMinInterval(WATCH_STATE_INVALIDATE_MIN_INTERVAL_MS);

const _setChangedRevision = writable(0);
export const setChangedRevision: Readable<number> = _setChangedRevision;
let setChangedDebounceTimer: ReturnType<typeof setTimeout> | null = null;
function bumpSetChangedDebounced(): void {
    // Fixed coalescing window: a long import must not postpone detail/client-
    // owned rail updates forever by continually restarting the timer.
    if (setChangedDebounceTimer !== null) return;
    setChangedDebounceTimer = setTimeout(() => {
        setChangedDebounceTimer = null;
        _setChangedRevision.update((n) => n + 1);
        // Detail composables own watch/next-episode caches independently of
        // SvelteKit load data. Reconcile them on remote imports as on local marks.
        bumpWatchStateVersion();
    }, REVISION_DEBOUNCE_MS);
}

const _sessionChangedRevision = writable(0);
export const sessionChangedRevision: Readable<number> = _sessionChangedRevision;
// N1: `session_changed` was undebounced while `set_changed` was debounced —
// a flurry of lifecycle transitions (start → status flip → vanish across
// several sources) could fan out into multiple back-to-back CW refetches in
// subscribers. Coalesce it on the same window as `set_changed` so a burst of
// transitions yields a single refetch. The (re)connect bump below stays
// immediate so reconnect-driven catch-up isn't delayed.
let sessionChangedDebounceTimer: ReturnType<typeof setTimeout> | null = null;
function bumpSessionChangedDebounced(): void {
    if (sessionChangedDebounceTimer !== null) clearTimeout(sessionChangedDebounceTimer);
    sessionChangedDebounceTimer = setTimeout(() => {
        sessionChangedDebounceTimer = null;
        _sessionChangedRevision.update((n) => n + 1);
    }, REVISION_DEBOUNCE_MS);
}

// ---------------------------------------------------------------------------
// SSE consumer
// ---------------------------------------------------------------------------

class WatchStateSSE {
    /** Unsubscribers for every callback registered on the shared stream. */
    private offs: Array<() => void> = [];
    /**
     * Whether this module currently holds a ref on the shared connection.
     * Guards the refcount: `start()` must be idempotent (it was, via the
     * old `this.es` check) or a double start would leave `userEvents`'
     * refcount permanently above zero and the stream never closable.
     */
    private started = false;
    // True when the next observed open is a RECONNECT (it followed a
    // disconnect), false for the initial open after a start(). Only
    // reconnects bump the revision counters — see the onConnectedChange
    // handler below.
    private reconnecting = false;

    start(): void {
        if (!browser || this.started) return;
        this.started = true;
        // An explicit start() is an INITIAL connect (fresh page/nav with fresh
        // SSR/fetch data), never a catch-up reconnect.
        this.reconnecting = false;

        // Subscribe BEFORE connecting so nothing can be missed between the
        // two, and so a start() that attaches to an already-open shared
        // connection (another consumer got there first) is still wired up.
        //
        // Ordering caveat, currently unreachable but unenforced: `connect()`
        // only opens on the 0->1 edge, so if this ever ran while another
        // consumer already held a ref on an EXHAUSTED connection, it would
        // attach to a dead stream and nothing here would revive it (we never
        // call `manualRetry()`). +layout.svelte:229 calls start() before the
        // inbox/desktop consumers, so today this is always the 0->1 caller.
        this.offs = [
            userEvents.subscribe('watch_state_set_changed', () => {
                gateWatchStateInvalidate.run(() => invalidateWhenIdle('app:watch-state'));
                bumpSetChangedDebounced();
            }),
            userEvents.subscribe('session_changed', () => {
                bumpSessionChangedDebounced();
            }),
            userEvents.subscribe('admin', (frame) => {
                // App-wide listener: it knows the browser's device id but not
                // which play session (if any) is running, so a
                // session-targeted message reaches it only via the device
                // match. The per-session reader in play-session-reporter
                // covers the play-session match and both dedupe on the
                // frame's `id`. `frame.data` is already JSON-parsed (null on
                // malformed input) and `handleAdminEvent` validates `unknown`,
                // so a bad payload is dropped there rather than thrown here.
                handleAdminEvent(frame.data, { deviceId: getDeviceId() });
            }),
            userEvents.onConnectedChange((connected) => {
                if (!connected) {
                    // The stream dropped — whatever opens next is a reconnect
                    // and owes us the events fired during the gap.
                    this.reconnecting = true;
                    return;
                }
                // Bump both revision counters on RECONNECT so events fired
                // during the disconnect window aren't silently lost
                // (cross-pod LB reroutes, network blips). The INITIAL connect
                // after a page load does NOT bump: the page already loaded
                // with fresh SSR/initial watch data, so a bump here only
                // forces a redundant CW refetch in every subscriber. (The old
                // "baseline sentinel absorbs it" assumption fails whenever the
                // subscriber's baseline effect runs before this open lands —
                // e.g. the /browse and home Continue-Watching effects.)
                //
                // An initial open produces no false→true transition to
                // observe when the shared connection was already up, which
                // lands on the same answer: `reconnecting` is still false, so
                // nothing bumps.
                if (this.reconnecting) {
                    gateWatchStateInvalidate.run(() => invalidateWhenIdle('app:watch-state'));
                    bumpSetChangedDebounced();
                    _sessionChangedRevision.update((n) => n + 1);
                }
                this.reconnecting = false;
            }),
        ];

        userEvents.connect();
    }

    stop(): void {
        if (!this.started) return;
        this.started = false;
        this.reconnecting = false;
        for (const off of this.offs) off();
        this.offs = [];
        // This module is a singleton that survives reconnects (`stop()` is
        // called on e.g. layout teardown, not page unload) — a trailing
        // gateWatchStateInvalidate call left pending across that boundary
        // would fire invalidateWhenIdle for a consumer that has already
        // stopped listening. Cancel it so stop() actually stops.
        gateWatchStateInvalidate.cancel();
        if (setChangedDebounceTimer !== null) clearTimeout(setChangedDebounceTimer);
        setChangedDebounceTimer = null;
        if (sessionChangedDebounceTimer !== null) clearTimeout(sessionChangedDebounceTimer);
        sessionChangedDebounceTimer = null;
        // Release only OUR ref — the notification inbox and the desktop
        // notification listener hold their own, and the stream stays up until
        // the last one leaves.
        userEvents.disconnect();
    }
}

export const watchStateSSE = new WatchStateSSE();
