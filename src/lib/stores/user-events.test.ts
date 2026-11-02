// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
// Per-file override: user-events.ts's `online`-listener fix needs a real
// `window` (see vitest.config.ts's default `environment: 'node'`, which has
// none). happy-dom is already a project devDependency (used by
// vitest.config.components.ts) — this file doesn't import Svelte components,
// so it doesn't need that config's browser-resolve-conditions plugin, just
// the DOM globals.

/**
 * Unit tests for user-events.ts:
 *  - reconnect-exhaustion is exposed (not silent/permanent) and manualRetry()
 *    clears it
 *  - a browser `online` event resets the reconnect budget so a laptop-sleep/
 *    VPN-drop doesn't require a page reload
 *
 * Modeled on run-sse-bus.test.ts's FakeEventSource + fake-timer approach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Fake EventSource ─────────────────────────────────────────────────────
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
    private _listeners: Map<string, Array<(e: MessageEvent) => void>> = new Map();
    closed = false;

    constructor(url: string) {
        this.url = url;
        fakeESInstances.push(this);
    }

    addEventListener(type: string, listener: (e: MessageEvent) => void): void {
        if (!this._listeners.has(type)) this._listeners.set(type, []);
        this._listeners.get(type)!.push(listener);
    }

    close(): void {
        this.readyState = FakeEventSource.CLOSED;
        this.closed = true;
    }
}

vi.mock('$app/environment', () => ({ browser: true }));

// `window` is shared across every test in this file (happy-dom's environment
// is recreated per FILE, not per test) — a `userEvents` instance whose
// `online` listener is never torn down would keep firing into later tests
// and inflate their EventSource counts. Track every instance created via
// freshStore() and hard-teardown() all of them in afterEach.
let liveStores: Array<typeof import('./user-events.js')> = [];

async function freshStore(): Promise<typeof import('./user-events.js')> {
    vi.resetModules();
    // `$app/environment` is mocked at the top of this file; repeating it here
    // registered nothing extra (vi.mock is hoisted to module scope wherever it
    // is written) and vitest 5 rejects the nested form.
    const mod = await import('./user-events.js');
    liveStores.push(mod);
    return mod;
}

/** Fail the most recently opened FakeEventSource, as its real onerror would. */
function failLatest(): void {
    const es = fakeESInstances[fakeESInstances.length - 1];
    es.onerror?.(new Event('error'));
}

beforeEach(() => {
    fakeESInstances = [];
    liveStores = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.useFakeTimers();
});

afterEach(() => {
    for (const mod of liveStores) mod.userEvents.teardown();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('userEvents teardown vs the refcount', () => {
    /**
     * `teardown()` zeroes `_refCount` while its consumers still believe they
     * hold a ref: notification-inbox.ts keeps `liveStarted`, notifications-
     * desktop.ts its own listener handle, watch-state-sse.ts `started`. Each
     * will still call `disconnect()` on its own teardown path. If anything
     * connected in between, that decrement lands on a refcount that now
     * belongs to somebody else and closes a stream its owner never released.
     *
     * Latent today only because /logout ends in a hard `window.location.href`
     * — but `teardownLiveState()` runs BEFORE an awaited `clearUserData()`,
     * and that file's docstring says it is wired up precisely so a future SPA
     * `goto()` doesn't regress. That switch is what arms this.
     */
    it('a pre-teardown consumer disconnecting must not close a NEW consumer stream', async () => {
        const { userEvents } = await freshStore();
        userEvents.connect(); // notificationInbox.init()
        userEvents.connect(); // initDesktopNotifications()
        userEvents.connect(); // watchStateSSE.start()
        const original = fakeESInstances[fakeESInstances.length - 1];

        userEvents.teardown(); // logout
        expect(original.closed).toBe(true);

        // Something reconnects while the three originals still hold refs.
        userEvents.connect();
        const fresh = fakeESInstances[fakeESInstances.length - 1];
        expect(fresh).not.toBe(original);
        expect(fresh.closed).toBe(false);

        // The three pre-teardown holders now run their own teardown paths.
        userEvents.disconnect();
        userEvents.disconnect();
        userEvents.disconnect();

        expect(fresh.closed).toBe(false);
    });

    it('still closes once the post-teardown consumer itself disconnects', async () => {
        // The guard above must absorb stale refs WITHOUT making the stream
        // unclosable — over-absorbing would leak a connection per logout.
        const { userEvents } = await freshStore();
        userEvents.connect();
        userEvents.connect();

        userEvents.teardown();
        userEvents.connect();
        const fresh = fakeESInstances[fakeESInstances.length - 1];
        userEvents.disconnect(); // stale
        userEvents.disconnect(); // stale
        expect(fresh.closed).toBe(false);

        userEvents.disconnect(); // the real, post-teardown holder

        expect(fresh.closed).toBe(true);
    });
});

describe('userEvents reconnect exhaustion', () => {
    it('is silent+recoverable while under budget, then exposes reconnectExhausted once attempts run out', async () => {
        const { userEvents } = await freshStore();
        userEvents.connect();
        expect(fakeESInstances).toHaveLength(1);
        expect(userEvents.reconnectExhausted).toBe(false);

        // Fail repeatedly, advancing the fake clock past each backoff delay
        // so the next reconnect attempt actually fires. MAX_RECONNECT_ATTEMPTS
        // is 10 — the 10th failure must exhaust the budget without opening an
        // 11th EventSource.
        for (let i = 0; i < 9; i++) {
            failLatest();
            expect(userEvents.reconnectExhausted).toBe(false); // still retrying
            await vi.runOnlyPendingTimersAsync();
        }
        const instancesBeforeFinalFailure = fakeESInstances.length;
        failLatest(); // 10th failure — exhausts the budget

        expect(userEvents.reconnectExhausted).toBe(true);
        expect(userEvents.connected).toBe(false);

        // No further reconnect gets scheduled once exhausted.
        await vi.runOnlyPendingTimersAsync();
        expect(fakeESInstances).toHaveLength(instancesBeforeFinalFailure);
    });

    it('manualRetry() clears reconnectExhausted and opens a fresh connection', async () => {
        const { userEvents } = await freshStore();
        userEvents.connect();
        for (let i = 0; i < 10; i++) {
            failLatest();
            if (i < 9) await vi.runOnlyPendingTimersAsync();
        }
        expect(userEvents.reconnectExhausted).toBe(true);
        const instancesBeforeRetry = fakeESInstances.length;

        userEvents.manualRetry();

        expect(userEvents.reconnectExhausted).toBe(false);
        expect(fakeESInstances).toHaveLength(instancesBeforeRetry + 1);
    });

    it('a browser online event resets the attempt budget and reconnects even after exhaustion, with no page reload required', async () => {
        const { userEvents } = await freshStore();
        userEvents.connect();
        for (let i = 0; i < 10; i++) {
            failLatest();
            if (i < 9) await vi.runOnlyPendingTimersAsync();
        }
        expect(userEvents.reconnectExhausted).toBe(true);
        const instancesBeforeOnline = fakeESInstances.length;

        window.dispatchEvent(new Event('online'));

        expect(userEvents.reconnectExhausted).toBe(false);
        expect(fakeESInstances).toHaveLength(instancesBeforeOnline + 1);
    });

    it('online listener is torn down when the last consumer disconnects — no reconnect after full disconnect', async () => {
        const { userEvents } = await freshStore();
        userEvents.connect();
        userEvents.disconnect();

        const instancesBeforeOnline = fakeESInstances.length;
        window.dispatchEvent(new Event('online'));
        // No consumer holds the connection anymore — online must not reopen it.
        expect(fakeESInstances).toHaveLength(instancesBeforeOnline);
    });
});
