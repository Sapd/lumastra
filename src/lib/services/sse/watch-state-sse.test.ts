// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
// Per-file override (same reason as user-events.test.ts): the shared
// `userEvents` connection installs a window-level `online` listener, which
// vitest.config.ts's default `environment: 'node'` has no `window` for.

/**
 * watch-state-sse.ts — tests for the SHARED `/events/user` subscription.
 *
 * Before this, `+layout.svelte` opened TWO EventSources to the same endpoint:
 * one here (`watchStateSSE.start()`, :229) and one via `userEvents.connect()`
 * (reached from `notificationInbox.init()` / `initDesktopNotifications()`,
 * :243-244). Two server-side consumers per tab, and — because the
 * `watch_state_set_changed` handler calls `invalidateWhenIdle` on every frame
 * — two full page-node refetches per signal.
 *
 * `watchStateSSE` is now a CONSUMER of `userEvents`, not an EventSource owner.
 * These tests assert at the seam the layout actually drives: the two startup
 * calls it makes must together open exactly one stream.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';

// ── Fake EventSource ─────────────────────────────────────────────────────
// Modeled on user-events.test.ts / run-sse-bus.test.ts.
let fakeESInstances: FakeEventSource[] = [];

class FakeEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;

    readonly url: string;
    readyState: number = FakeEventSource.CONNECTING;
    onopen: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    private _listeners = new Map<string, Array<(e: MessageEvent) => void>>();
    closed = false;

    constructor(url: string) {
        this.url = url;
        fakeESInstances.push(this);
    }

    addEventListener(type: string, listener: (e: MessageEvent) => void): void {
        if (!this._listeners.has(type)) this._listeners.set(type, []);
        this._listeners.get(type)!.push(listener);
    }

    /** Deliver a named frame exactly as the real stream would. */
    emit(type: string, data: unknown, lastEventId = ''): void {
        const event = { data: JSON.stringify(data), lastEventId } as MessageEvent<string>;
        for (const listener of this._listeners.get(type) ?? []) listener(event);
    }

    open(): void {
        this.readyState = FakeEventSource.OPEN;
        this.onopen?.(new Event('open'));
    }

    close(): void {
        this.readyState = FakeEventSource.CLOSED;
        this.closed = true;
    }
}

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/paths', () => ({ base: '' }));
vi.mock('$lib/utils/invalidate-when-idle', () => ({ invalidateWhenIdle: vi.fn() }));
vi.mock('$lib/components/player/device-id.js', () => ({ getDeviceId: () => 'device-under-test' }));
vi.mock('./admin-event-handler.js', () => ({ handleAdminEvent: vi.fn() }));

/** The one URL both consumers must share. */
const STREAM_PATH = '/api/events/user';

function streamsOpened(): FakeEventSource[] {
    return fakeESInstances.filter((es) => es.url.includes(STREAM_PATH));
}

function latest(): FakeEventSource {
    return fakeESInstances[fakeESInstances.length - 1];
}

type WatchStateModule = typeof import('./watch-state-sse.js');
type UserEventsModule = typeof import('$lib/stores/user-events.js');
type InvalidateModule = typeof import('$lib/utils/invalidate-when-idle');
type AdminHandlerModule = typeof import('./admin-event-handler.js');

interface Modules {
    watch: WatchStateModule;
    events: UserEventsModule;
    invalidate: InvalidateModule;
    adminHandler: AdminHandlerModule;
    version: typeof import('$lib/stores/watch-state-version');
}

let liveModules: Modules[] = [];

/**
 * Fresh module graph per test. `userEvents` is a module-level singleton whose
 * `online` listener outlives a test unless torn down (happy-dom's `window` is
 * per FILE, not per test) — every instance is hard-torn-down in afterEach.
 */
async function freshModules(): Promise<Modules> {
    vi.resetModules();
    const mods: Modules = {
        watch: await import('./watch-state-sse.js'),
        events: await import('$lib/stores/user-events.js'),
        invalidate: await import('$lib/utils/invalidate-when-idle'),
        adminHandler: await import('./admin-event-handler.js'),
        version: await import('$lib/stores/watch-state-version'),
    };
    liveModules.push(mods);
    return mods;
}

/**
 * What `+layout.svelte`'s `onMount` does for an authenticated visitor, in its
 * real order: `watchStateSSE.start()` (:229), then the notification inbox and
 * desktop-notification consumers, which both reach `userEvents.connect()`
 * (:243-244 → notification-inbox.ts:319, notifications-desktop.ts:190).
 * Calling `connect()` directly is the honest seam — it is exactly the call
 * both of those make, without dragging their network fetches in.
 */
function mountLayout(mods: Modules): void {
    mods.watch.watchStateSSE.start();
    mods.events.userEvents.connect(); // notificationInbox.init()
    mods.events.userEvents.connect(); // initDesktopNotifications()
}

beforeEach(() => {
    fakeESInstances = [];
    liveModules = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.useFakeTimers();
});

afterEach(() => {
    for (const mods of liveModules) {
        mods.watch.watchStateSSE.stop();
        mods.events.userEvents.teardown();
    }
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('watchStateSSE shares one /events/user stream with userEvents', () => {
    it('opens exactly ONE EventSource for /events/user on layout mount', async () => {
        const mods = await freshModules();

        mountLayout(mods);

        expect(streamsOpened()).toHaveLength(1);
        expect(fakeESInstances).toHaveLength(1);
    });

    it('delivers watch_state_set_changed to the watch-state consumer exactly once', async () => {
        const mods = await freshModules();
        mountLayout(mods);
        latest().open();

        latest().emit('watch_state_set_changed', {});

        expect(vi.mocked(mods.invalidate.invalidateWhenIdle)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(mods.invalidate.invalidateWhenIdle)).toHaveBeenCalledWith(
            'app:watch-state',
        );
    });

    it('debounces imported watch changes into the detail cache revision', async () => {
        const mods = await freshModules();
        mountLayout(mods);
        latest().open();
        const revisions: number[] = [];
        const off = mods.version.watchStateVersion.subscribe((v) => revisions.push(v));
        for (let i = 0; i < 20; i++) latest().emit('watch_state_set_changed', {});
        expect(revisions).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1500);
        expect(revisions).toHaveLength(2);
        mods.watch.watchStateSSE.stop();
        latest().emit('watch_state_set_changed', {});
        await vi.advanceTimersByTimeAsync(1500);
        expect(revisions).toHaveLength(2);
        off();
    });

    it('routes admin frames to handleAdminEvent with this browser device id', async () => {
        const mods = await freshModules();
        mountLayout(mods);
        latest().open();

        latest().emit('admin', { type: 'admin_message', message: 'hi' });

        expect(vi.mocked(mods.adminHandler.handleAdminEvent)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(mods.adminHandler.handleAdminEvent)).toHaveBeenCalledWith(
            { type: 'admin_message', message: 'hi' },
            { deviceId: 'device-under-test' },
        );
    });

    it('debounces set_changed and session_changed onto one revision bump each', async () => {
        const mods = await freshModules();
        mountLayout(mods);
        latest().open();
        const setBefore = get(mods.watch.setChangedRevision);
        const sessionBefore = get(mods.watch.sessionChangedRevision);

        latest().emit('watch_state_set_changed', {});
        latest().emit('watch_state_set_changed', {});
        latest().emit('session_changed', {});
        latest().emit('session_changed', {});
        vi.advanceTimersByTime(2000);

        expect(get(mods.watch.setChangedRevision)).toBe(setBefore + 1);
        expect(get(mods.watch.sessionChangedRevision)).toBe(sessionBefore + 1);
    });

    it('does NOT bump revisions on the INITIAL open, but DOES on a reconnect', async () => {
        const mods = await freshModules();
        mountLayout(mods);

        latest().open(); // initial open — page already has fresh SSR data
        vi.advanceTimersByTime(2000);
        expect(get(mods.watch.setChangedRevision)).toBe(0);
        expect(get(mods.watch.sessionChangedRevision)).toBe(0);

        latest().onerror?.(new Event('error')); // drop
        await vi.runOnlyPendingTimersAsync(); // backoff elapses, reconnect opens
        latest().open(); // RECONNECT — must catch up on the missed window
        vi.advanceTimersByTime(2000);

        expect(get(mods.watch.setChangedRevision)).toBe(1);
        expect(get(mods.watch.sessionChangedRevision)).toBe(1);
        expect(mods.invalidate.invalidateWhenIdle).toHaveBeenCalledWith('app:watch-state');
    });

    it('bumps after an open that followed a FAILED FIRST connect, with no prior open', async () => {
        // The regression this guards: `onConnectedChange` reports TRANSITIONS
        // of a boolean, but the invariant is "bump iff this open followed a
        // connection FAILURE". `_connected` starts false, so a first attempt
        // that errors before ever opening (the hub's per-user 429 / global 503
        // ceiling, a pod mid-restart — EventSource fires `error` on any
        // non-200) moves nothing, emits no callback, and the retry that
        // finally succeeds looks exactly like an initial open. Every
        // watch-state signal emitted across that window is then lost: the old
        // code set `reconnecting` in `onerror` unconditionally and bumped.
        const mods = await freshModules();
        mountLayout(mods);

        latest().onerror?.(new Event('error')); // first attempt never opened
        await vi.runOnlyPendingTimersAsync(); // backoff elapses, retry opens
        latest().open();
        vi.advanceTimersByTime(2000);

        expect(get(mods.watch.setChangedRevision)).toBe(1);
        expect(get(mods.watch.sessionChangedRevision)).toBe(1);
    });

    it('bumps session_changed IMMEDIATELY on reconnect, not on the debounce window', async () => {
        // The reconnect bump is deliberately undebounced (unlike the
        // frame-driven one) so catch-up isn't delayed by REVISION_DEBOUNCE_MS.
        const mods = await freshModules();
        mountLayout(mods);
        latest().open();
        latest().onerror?.(new Event('error'));
        await vi.runOnlyPendingTimersAsync();

        latest().open();

        // No timer advance at all.
        expect(get(mods.watch.sessionChangedRevision)).toBe(1);
    });

    it('wires up when it attaches to an ALREADY-OPEN shared connection', async () => {
        // Nothing enforces that watchStateSSE.start() is the 0->1 consumer;
        // +layout.svelte just happens to call it first today.
        const mods = await freshModules();
        mods.events.userEvents.connect(); // the inbox got here first
        latest().open();

        mods.watch.watchStateSSE.start();

        expect(streamsOpened()).toHaveLength(1);
        // Attaching to an open connection is an INITIAL attach, not a
        // reconnect — it must not bump...
        vi.advanceTimersByTime(2000);
        expect(get(mods.watch.setChangedRevision)).toBe(0);
        // ...but it MUST still be subscribed.
        latest().emit('watch_state_set_changed', {});
        expect(vi.mocked(mods.invalidate.invalidateWhenIdle)).toHaveBeenCalledTimes(1);
    });

    it('keeps the other consumer receiving frames when the watch-state handler throws', async () => {
        const mods = await freshModules();
        vi.mocked(mods.invalidate.invalidateWhenIdle).mockImplementation(() => {
            throw new Error('watch-state handler blew up');
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const otherConsumer = vi.fn();
        mountLayout(mods);
        mods.events.userEvents.subscribe('watch_state_set_changed', otherConsumer);
        latest().open();

        latest().emit('watch_state_set_changed', {});
        // The invalidate call is throttled (createMinInterval, 5s floor) so a
        // second frame inside the window would be deferred rather than
        // thrown synchronously — advance past the window so this frame also
        // hits the leading edge and the throw-resilience assertion below
        // still exercises two REAL invocations.
        vi.advanceTimersByTime(5_000);
        latest().emit('watch_state_set_changed', {});

        // Both consumers are on the SAME stream: the watch-state handler ran
        // (and threw) for each frame...
        expect(vi.mocked(mods.invalidate.invalidateWhenIdle)).toHaveBeenCalledTimes(2);
        // ...and its throwing neither tore the stream down nor starved the
        // other subscriber of either frame.
        expect(otherConsumer).toHaveBeenCalledTimes(2);
        expect(latest().closed).toBe(false);
        consoleError.mockRestore();
    });

    it('keeps the other consumer receiving frames when the THROTTLE-DEFERRED (trailing) invalidate call throws', async () => {
        // The leading call above runs synchronously inside userEvents'
        // dispatch(), which try/catches each callback — a throw there is
        // already contained regardless of the gate. The gate's trailing
        // call fires from a bare setTimeout with no such boundary, so it
        // needs its OWN protection. Reach that branch by emitting a second
        // frame BEFORE the 5s window elapses (so it's deferred, not run
        // immediately), then advancing time to flush the deferred call.
        const mods = await freshModules();
        vi.mocked(mods.invalidate.invalidateWhenIdle).mockImplementation(() => {
            throw new Error('watch-state handler blew up');
        });
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
        const otherConsumer = vi.fn();
        mountLayout(mods);
        mods.events.userEvents.subscribe('watch_state_set_changed', otherConsumer);
        latest().open();

        latest().emit('watch_state_set_changed', {}); // leading call — throws, contained by dispatch()
        latest().emit('watch_state_set_changed', {}); // NO time advance — gated, deferred to a trailing timer

        expect(vi.mocked(mods.invalidate.invalidateWhenIdle)).toHaveBeenCalledTimes(1);

        // Flushing the deferred call must not escape as an unhandled timer
        // exception — this is the assertion that fails without the gate's
        // own try/catch around the trailing invocation.
        expect(() => vi.advanceTimersByTime(5_000)).not.toThrow();
        expect(vi.mocked(mods.invalidate.invalidateWhenIdle)).toHaveBeenCalledTimes(2);

        // Neither the throw nor the deferred flush tore the stream down or
        // starved the other subscriber...
        expect(otherConsumer).toHaveBeenCalledTimes(2);
        expect(latest().closed).toBe(false);

        // ...and the gate itself is left in working order: a further frame
        // outside the window still reaches a (once again throwing) leading
        // call rather than being stuck forever.
        vi.advanceTimersByTime(5_000);
        latest().emit('watch_state_set_changed', {});
        expect(vi.mocked(mods.invalidate.invalidateWhenIdle)).toHaveBeenCalledTimes(3);

        consoleError.mockRestore();
    });

    it('stop() releases only its own refcount — the inbox keeps its stream', async () => {
        const mods = await freshModules();
        mountLayout(mods);
        latest().open();
        // Baseline: the shared stream DOES reach the watch-state consumer.
        latest().emit('watch_state_set_changed', {});
        expect(vi.mocked(mods.invalidate.invalidateWhenIdle)).toHaveBeenCalledTimes(1);

        mods.watch.watchStateSSE.stop();

        // The inbox still holds a ref, so the stream stays open...
        expect(latest().closed).toBe(false);
        // ...and the watch-state consumer is genuinely detached from it.
        latest().emit('watch_state_set_changed', {});
        expect(vi.mocked(mods.invalidate.invalidateWhenIdle)).toHaveBeenCalledTimes(1);
    });

    it('stop() cancels a pending trailing invalidate call — the singleton outlives reconnects', async () => {
        // watchStateSSE is a module-level singleton: stop() is called on
        // ordinary teardown (e.g. layout unmount), not page unload, so a
        // pending trailing gateWatchStateInvalidate call left armed across
        // that boundary would fire invalidateWhenIdle for a listener that
        // has already stopped caring — the exact spurious-refetch shape
        // createMinInterval exists to prevent, just reached via stop()
        // instead of unmount.
        const mods = await freshModules();
        mountLayout(mods);
        latest().open();

        latest().emit('watch_state_set_changed', {}); // leading call
        latest().emit('watch_state_set_changed', {}); // deferred — queues a trailing call
        expect(vi.mocked(mods.invalidate.invalidateWhenIdle)).toHaveBeenCalledTimes(1);

        mods.watch.watchStateSSE.stop();

        // Advance well past the window: without cancel(), the trailing timer
        // that was already armed before stop() would still fire here.
        vi.advanceTimersByTime(5_000);
        expect(vi.mocked(mods.invalidate.invalidateWhenIdle)).toHaveBeenCalledTimes(1);
    });

    it('start() after stop() re-attaches without opening a second stream', async () => {
        const mods = await freshModules();
        mountLayout(mods);
        latest().open();
        mods.watch.watchStateSSE.stop();

        mods.watch.watchStateSSE.start();

        expect(streamsOpened()).toHaveLength(1);
        latest().emit('watch_state_set_changed', {});
        expect(vi.mocked(mods.invalidate.invalidateWhenIdle)).toHaveBeenCalledTimes(1);
    });

    it('start() is idempotent — a double start does not leak a refcount', async () => {
        const mods = await freshModules();
        mountLayout(mods);

        mods.watch.watchStateSSE.start();
        mods.watch.watchStateSSE.stop();
        mods.events.userEvents.disconnect(); // notificationInbox.stopLive()
        mods.events.userEvents.disconnect(); // desktop listener teardown

        expect(streamsOpened()).toHaveLength(1);
        expect(latest().closed).toBe(true);
    });

    it('start() never throws when the EventSource constructor does', async () => {
        const mods = await freshModules();
        vi.stubGlobal(
            'EventSource',
            class {
                constructor() {
                    throw new Error('SecurityError');
                }
            },
        );

        expect(() => mods.watch.watchStateSSE.start()).not.toThrow();
    });
});
