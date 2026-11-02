// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for cancel-channel.ts.
 * Mocks valkey entirely — no live infrastructure required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    CANCEL_CHANNEL,
    publishCancel,
    subscribeToCancel,
    __resetCancelChannelForTests,
} from './cancel-channel.js';

vi.mock('$lib/server/cache/valkey.js', () => ({
    getCoordinationClient: vi.fn(() => null),
    subscribeToChannel: vi.fn(async () => null),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

// All cancels now multiplex over one shared channel; the singleton state must
// be reset between tests so each test binds its own injected subscribe.
beforeEach(() => {
    __resetCancelChannelForTests();
});

// ── CANCEL_CHANNEL ─────────────────────────────────────────────────────────────

describe('CANCEL_CHANNEL', () => {
    it('is a single shared channel (runId travels in the payload)', () => {
        expect(CANCEL_CHANNEL).toBe('task:cancel');
    });
});

// ── publishCancel ─────────────────────────────────────────────────────────────

describe('publishCancel', () => {
    it('issues PUBLISH to the shared channel with runId + reason in payload', async () => {
        const customCommand = vi.fn(async (_cmd: string[]) => 1);
        await publishCancel('run_xyz', 'user-clicked-stop', { customCommand });
        expect(customCommand).toHaveBeenCalledWith([
            'PUBLISH',
            'task:cancel',
            JSON.stringify({ runId: 'run_xyz', reason: 'user-clicked-stop' }),
        ]);
    });

    it('defaults reason to "user" when omitted', async () => {
        const customCommand = vi.fn(async (_cmd: string[]) => 1);
        await publishCancel('run_abc', undefined, { customCommand });
        const call = customCommand.mock.calls[0][0];
        const payload = JSON.parse(call[2]) as { reason: string };
        expect(payload.reason).toBe('user');
    });

    it('does not throw when client is null', async () => {
        await expect(publishCancel('run_missing')).resolves.toBeUndefined();
    });
});

// ── subscribeToCancel ─────────────────────────────────────────────────────────

describe('subscribeToCancel', () => {
    let callbacks: Map<string, Set<(msg: string) => void>>;

    beforeEach(() => {
        callbacks = new Map();
    });

    function makeSubscribe() {
        return vi.fn(async (channel: string, cb: (msg: string) => void) => {
            let set = callbacks.get(channel);
            if (!set) {
                set = new Set();
                callbacks.set(channel, set);
            }
            set.add(cb);
            return async () => {
                callbacks.get(channel)?.delete(cb);
            };
        });
    }

    // Cancels are published to the shared channel; the dispatcher routes by the
    // runId in the payload. Emitting always targets CANCEL_CHANNEL.
    function emit(payload: string): void {
        for (const cb of callbacks.get(CANCEL_CHANNEL) ?? []) cb(payload);
    }

    it('receives cancel signal with reason', async () => {
        const subscribe = makeSubscribe();
        const received: Array<string | null> = [];
        await subscribeToCancel('run_1', (r) => received.push(r), subscribe);

        emit(JSON.stringify({ runId: 'run_1', reason: 'timeout' }));
        expect(received).toEqual(['timeout']);
    });

    it('only routes to the matching runId', async () => {
        const subscribe = makeSubscribe();
        const received: Array<string | null> = [];
        await subscribeToCancel('run_1', (r) => received.push(r), subscribe);

        // A cancel for a different run must not trip run_1's callback.
        emit(JSON.stringify({ runId: 'run_other', reason: 'x' }));
        expect(received).toEqual([]);
        emit(JSON.stringify({ runId: 'run_1', reason: 'y' }));
        expect(received).toEqual(['y']);
    });

    it('passes null when reason is missing from payload', async () => {
        const subscribe = makeSubscribe();
        const received: Array<string | null> = [];
        await subscribeToCancel('run_2', (r) => received.push(r), subscribe);

        emit(JSON.stringify({ runId: 'run_2' }));
        expect(received).toEqual([null]);
    });

    it('ignores malformed JSON (no callback fired)', async () => {
        const subscribe = makeSubscribe();
        const received: Array<string | null> = [];
        await subscribeToCancel('run_3', (r) => received.push(r), subscribe);

        emit('not-json');
        expect(received).toEqual([]);
    });

    it('establishes the shared subscription exactly once across runs', async () => {
        const subscribe = makeSubscribe();
        await subscribeToCancel('run_a', () => {}, subscribe);
        await subscribeToCancel('run_b', () => {}, subscribe);
        await subscribeToCancel('run_c', () => {}, subscribe);
        // One Valkey subscription serves every run — no per-run connection.
        expect(subscribe).toHaveBeenCalledTimes(1);
        expect(subscribe).toHaveBeenCalledWith(CANCEL_CHANNEL, expect.any(Function));
    });

    it('unsubscribe stops receiving messages', async () => {
        const subscribe = makeSubscribe();
        const received: Array<string | null> = [];
        const unsub = await subscribeToCancel('run_4', (r) => received.push(r), subscribe);

        emit(JSON.stringify({ runId: 'run_4', reason: 'a' }));
        expect(received).toHaveLength(1);

        await unsub();
        emit(JSON.stringify({ runId: 'run_4', reason: 'b' }));
        expect(received).toHaveLength(1); // no new messages after unsub
    });

    it('multiple subscribers on same run all receive', async () => {
        const subscribe = makeSubscribe();
        const r1: Array<string | null> = [];
        const r2: Array<string | null> = [];

        await subscribeToCancel('run_5', (r) => r1.push(r), subscribe);
        await subscribeToCancel('run_5', (r) => r2.push(r), subscribe);

        emit(JSON.stringify({ runId: 'run_5', reason: 'x' }));
        expect(r1).toEqual(['x']);
        expect(r2).toEqual(['x']);
    });

    it('a callback deregistering a not-yet-visited sibling does not skip it', async () => {
        const subscribe = makeSubscribe();
        const order: string[] = [];
        // The first callback synchronously deregisters the second (a sibling
        // not yet visited). Without snapshotting the set, iteration would skip
        // 'b'; with the snapshot it still fires.
        let unsubB: (() => Promise<void>) | null = null;
        await subscribeToCancel(
            'run_7',
            () => {
                order.push('a');
                void unsubB?.();
            },
            subscribe,
        );
        unsubB = await subscribeToCancel('run_7', () => order.push('b'), subscribe);

        emit(JSON.stringify({ runId: 'run_7', reason: 'x' }));
        expect(order).toEqual(['a', 'b']);
    });

    it('returns a no-op unsub when subscribe returns null', async () => {
        const subscribe = vi.fn(async () => null);
        const unsub = await subscribeToCancel('run_6', () => {}, subscribe);
        await expect(unsub()).resolves.toBeUndefined();
    });
});
