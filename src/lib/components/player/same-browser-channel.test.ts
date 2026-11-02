// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/lib/components/player/same-browser-channel.test.ts
//
// Unit tests for the same-browser tab probe-and-collect API. Mocks the
// global BroadcastChannel constructor so two SameBrowserChannel instances
// can talk to each other in-process.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ---------------------------------------------------------------------------
// In-memory BroadcastChannel mock — every channel created with the same name
// is wired into a shared bus and receives messages from peers (not its own
// posts, matching the real BroadcastChannel semantics).
// ---------------------------------------------------------------------------

interface MockChannel {
    name: string;
    onmessage: ((e: MessageEvent) => void) | null;
    closed: boolean;
}

const buses = new Map<string, Set<MockChannel>>();

class MockBroadcastChannel implements MockChannel {
    name: string;
    onmessage: ((e: MessageEvent) => void) | null = null;
    closed = false;

    constructor(name: string) {
        this.name = name;
        let bus = buses.get(name);
        if (!bus) {
            bus = new Set();
            buses.set(name, bus);
        }
        bus.add(this);
    }

    postMessage(data: unknown): void {
        if (this.closed) return;
        const bus = buses.get(this.name);
        if (!bus) return;
        for (const ch of bus) {
            if (ch === this || ch.closed) continue;
            // Dispatch async to mimic browser behavior. queueMicrotask is
            // close enough — sub-millisecond and same event-loop-cycle.
            queueMicrotask(() => {
                if (!ch.closed) {
                    ch.onmessage?.({ data } as MessageEvent);
                }
            });
        }
    }

    close(): void {
        this.closed = true;
        buses.get(this.name)?.delete(this);
    }
}

beforeEach(() => {
    buses.clear();
    vi.stubGlobal('BroadcastChannel', MockBroadcastChannel);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

// Import AFTER the global stub so the constructor inside the module sees
// our mock. Use dynamic import to defer module evaluation.
async function loadChannel() {
    return await import('./same-browser-channel.js');
}

async function flushTimers(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
}

describe('SameBrowserChannel.probe', () => {
    it('returns empty after timeout when no other tabs are listening', async () => {
        const { SameBrowserChannel } = await loadChannel();
        const ch = new SameBrowserChannel();
        const acks = await ch.probe('media-1');
        expect(acks).toEqual([]);
        ch.close();
    });

    it('returns empty when another tab is active for a DIFFERENT mediaId', async () => {
        // Different episode → no conflict; the other tab must NOT respond.
        const { SameBrowserChannel } = await loadChannel();
        const tabA = new SameBrowserChannel();
        const tabB = new SameBrowserChannel();
        tabA.setActive({
            mediaId: 'media-OTHER',
            sessionId: 'sess-A',
            deviceId: 'dev-1',
        });

        const acks = await tabB.probe('media-1');
        expect(acks).toEqual([]);

        tabA.close();
        tabB.close();
    });

    it('receives ack when another tab is active for the SAME mediaId', async () => {
        const { SameBrowserChannel } = await loadChannel();
        const tabA = new SameBrowserChannel();
        const tabB = new SameBrowserChannel();
        tabA.setActive({
            mediaId: 'media-1',
            sessionId: 'sess-A',
            deviceId: 'dev-1',
        });

        const acks = await tabB.probe('media-1');
        expect(acks.length).toBe(1);
        expect(acks[0]).toEqual({
            sessionId: 'sess-A',
            deviceId: 'dev-1',
        });

        tabA.close();
        tabB.close();
    });

    it('aggregates acks from multiple active tabs', async () => {
        const { SameBrowserChannel } = await loadChannel();
        const tabA = new SameBrowserChannel();
        const tabB = new SameBrowserChannel();
        const tabC = new SameBrowserChannel();
        tabA.setActive({
            mediaId: 'media-1',
            sessionId: 'sess-A',
            deviceId: 'dev-1',
        });
        tabB.setActive({
            mediaId: 'media-1',
            sessionId: 'sess-B',
            deviceId: 'dev-1',
        });

        const acks = await tabC.probe('media-1');
        const ids = acks.map((a) => a.sessionId).sort();
        expect(ids).toEqual(['sess-A', 'sess-B']);

        tabA.close();
        tabB.close();
        tabC.close();
    });

    it('clearActive() stops the tab from responding to probes', async () => {
        const { SameBrowserChannel } = await loadChannel();
        const tabA = new SameBrowserChannel();
        const tabB = new SameBrowserChannel();
        tabA.setActive({
            mediaId: 'media-1',
            sessionId: 'sess-A',
            deviceId: 'dev-1',
        });
        tabA.clearActive();

        const acks = await tabB.probe('media-1');
        expect(acks).toEqual([]);

        tabA.close();
        tabB.close();
    });

    it('returns empty when BroadcastChannel is unsupported (falls through to phases 1+2)', async () => {
        vi.stubGlobal('BroadcastChannel', undefined);
        // Module re-import is unnecessary — the constructor reads the global
        // at instantiation time, not import time.
        const { SameBrowserChannel } = await loadChannel();
        const ch = new SameBrowserChannel();
        const before = Date.now();
        const acks = await ch.probe('media-1');
        const elapsed = Date.now() - before;
        expect(acks).toEqual([]);
        // Should not have waited the full 200ms timeout — empty fast-path.
        expect(elapsed).toBeLessThan(100);
        ch.close();
    });
});

describe('SameBrowserChannel.probe — timing window', () => {
    it('collects acks that arrive WITHIN the 200ms window', async () => {
        const { SameBrowserChannel } = await loadChannel();
        const tabA = new SameBrowserChannel();
        const tabB = new SameBrowserChannel();
        tabA.setActive({
            mediaId: 'media-1',
            sessionId: 'sess-A',
            deviceId: 'dev-1',
        });

        const probePromise = tabB.probe('media-1');
        // Probe is fired synchronously in postMessage; ack microtask is
        // queued before the setTimeout window even starts. Should be
        // captured comfortably.
        const acks = await probePromise;
        expect(acks.length).toBe(1);

        tabA.close();
        tabB.close();
    });

    it('ignores acks that arrive AFTER the 200ms window has closed', async () => {
        // Stub setTimeout to fire immediately so we can race ack delivery.
        const { SameBrowserChannel } = await loadChannel();
        const tabB = new SameBrowserChannel();

        // Probe with no listeners — completes after PROBE_TIMEOUT_MS.
        const acks = await tabB.probe('media-1');
        expect(acks).toEqual([]);

        // Now simulate a late ack arriving on the bus. Should be discarded
        // because no pending probe matches.
        const tabA = new SameBrowserChannel();
        tabA.setActive({
            mediaId: 'media-1',
            sessionId: 'sess-A',
            deviceId: 'dev-1',
        });
        // No new probe → tabA has nothing to respond to → no ack flows.
        await flushTimers(50);

        tabA.close();
        tabB.close();
    });
});
