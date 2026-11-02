// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A channel stays subscribed for a grace period after its last callback, and
 * going idle UNSUBSCRIBEs it on the shared connection — it never closes a
 * client.
 *
 * Closing a GLIDE client that holds a subscription always makes its Rust core
 * log `pubsub_synchronizer - Failed to subscribe Exact channels: Internal
 * client has been dropped` at ERROR. With one client per channel that fired on
 * every idle per-session channel during playback (Windows e2e 2026-09-27).
 */

import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

interface FakeClient {
    close: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
}
const created: FakeClient[] = [];

vi.mock('@valkey/valkey-glide', () => ({
    GlideClient: {
        createClient: vi.fn(async () => {
            const client: FakeClient = {
                close: vi.fn(),
                subscribe: vi.fn(async () => {}),
                unsubscribe: vi.fn(async () => {}),
            };
            created.push(client);
            return client;
        }),
    },
}));

// The module reads process.env at import time, so this has to be set before it.
process.env.CACHE_URL = 'redis://127.0.0.1:6379';

const { subscribeToChannel, closeAllSubscriptions } = await import('./valkey');

function subscribedChannels(client: FakeClient): string[] {
    return client.subscribe.mock.calls.map(([set]) => [...(set as Set<string>)][0]);
}

describe('subscription grace period', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(async () => {
        await closeAllSubscriptions();
        created.length = 0;
        vi.useRealTimers();
    });

    test('the last unsubscribe does not UNSUBSCRIBE immediately', async () => {
        const unsub = await subscribeToChannel('ch:grace', () => {});
        expect(unsub).not.toBeNull();
        expect(created).toHaveLength(1);

        await unsub!();

        expect(created[0].unsubscribe).not.toHaveBeenCalled();
    });

    test('after the grace period the channel is UNSUBSCRIBEd and the client stays open', async () => {
        const unsub = await subscribeToChannel('ch:idle', () => {});
        await unsub!();

        await vi.advanceTimersByTimeAsync(30_000);

        expect(created[0].unsubscribe).toHaveBeenCalledTimes(1);
        expect([...(created[0].unsubscribe.mock.calls[0][0] as Set<string>)]).toEqual(['ch:idle']);
        // The fix: no close — closing is what made GLIDE log the ERROR.
        expect(created[0].close).not.toHaveBeenCalled();
    });

    test('a subscriber inside the window reuses the subscription, which is never dropped', async () => {
        const unsub = await subscribeToChannel('ch:reuse', () => {});
        await unsub!();

        await vi.advanceTimersByTimeAsync(10_000);
        const unsub2 = await subscribeToChannel('ch:reuse', () => {});

        expect(subscribedChannels(created[0])).toEqual(['ch:reuse']);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(created[0].unsubscribe).not.toHaveBeenCalled();

        await unsub2!();
    });

    test('subscribing again after the channel was dropped issues a new SUBSCRIBE', async () => {
        const unsub = await subscribeToChannel('ch:again', () => {});
        await unsub!();
        await vi.advanceTimersByTimeAsync(30_000);

        await subscribeToChannel('ch:again', () => {});

        expect(created).toHaveLength(1);
        expect(subscribedChannels(created[0])).toEqual(['ch:again', 'ch:again']);
    });

    test('shutdown UNSUBSCRIBEs everything before closing, and leaves no timer behind', async () => {
        const unsub = await subscribeToChannel('ch:shutdown', () => {});
        await unsub!();

        await closeAllSubscriptions();
        expect(created[0].unsubscribe).toHaveBeenCalledWith(null, expect.any(Number));
        expect(created[0].close).toHaveBeenCalledTimes(1);
        const unsubOrder = created[0].unsubscribe.mock.invocationCallOrder[0];
        const closeOrder = created[0].close.mock.invocationCallOrder[0];
        expect(unsubOrder).toBeLessThan(closeOrder);

        // A surviving timer would fire against an already-closed client.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(created[0].unsubscribe).toHaveBeenCalledTimes(1);
    });
});
