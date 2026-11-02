// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One shared pub/sub connection per process; channels are SUBSCRIBEd on it.
 *
 * Several modules subscribe at import time during boot and per-session
 * channels come and go during playback. One client per channel meant a client
 * close per idle channel, and every close of a subscribed GLIDE client logs
 * `pubsub_synchronizer - Failed to subscribe Exact channels: Internal client
 * has been dropped` at ERROR (Windows e2e 2026-09-27).
 */

import { afterEach, describe, expect, test, vi } from 'vitest';

type PubSubCallback = (msg: { channel: string; message: string }) => void;
interface FakeClient {
    close: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
    deliver: PubSubCallback;
}
const created: FakeClient[] = [];

vi.mock('@valkey/valkey-glide', () => ({
    GlideClient: {
        createClient: vi.fn(
            async (config: { pubsubSubscriptions: { callback: PubSubCallback } }) => {
                // A real handshake takes a round-trip; yield so racing callers overlap.
                await new Promise((r) => setTimeout(r, 5));
                const client: FakeClient = {
                    close: vi.fn(),
                    subscribe: vi.fn(async () => {
                        await new Promise((r) => setTimeout(r, 5));
                    }),
                    unsubscribe: vi.fn(async () => {}),
                    deliver: config.pubsubSubscriptions.callback,
                };
                created.push(client);
                return client;
            },
        ),
    },
}));

process.env.CACHE_URL = 'redis://127.0.0.1:6379';

const { subscribeToChannel, closeAllSubscriptions, resolveGlideLogLevel } =
    await import('./valkey');

describe('shared pub/sub connection', () => {
    afterEach(async () => {
        await closeAllSubscriptions();
        created.length = 0;
    });

    test('concurrent subscribers on one channel share one SUBSCRIBE and both get messages', async () => {
        const a = vi.fn();
        const b = vi.fn();

        const [unsubA, unsubB] = await Promise.all([
            subscribeToChannel('ch:race', a),
            subscribeToChannel('ch:race', b),
        ]);

        expect(unsubA).not.toBeNull();
        expect(unsubB).not.toBeNull();
        expect(created).toHaveLength(1);
        expect(created[0].subscribe).toHaveBeenCalledTimes(1);

        created[0].deliver({ channel: 'ch:race', message: 'hello' });
        expect(a).toHaveBeenCalledWith('hello');
        expect(b).toHaveBeenCalledWith('hello');
    });

    test('different channels share ONE client and messages route by channel', async () => {
        const one = vi.fn();
        const two = vi.fn();
        await Promise.all([subscribeToChannel('ch:one', one), subscribeToChannel('ch:two', two)]);

        expect(created).toHaveLength(1);
        expect(created[0].subscribe).toHaveBeenCalledTimes(2);

        created[0].deliver({ channel: 'ch:two', message: 'x' });
        expect(two).toHaveBeenCalledWith('x');
        expect(one).not.toHaveBeenCalled();
    });
});

describe('GLIDE core log level', () => {
    test('defaults to error, so routine NoScriptError WARNs stay out of the log', () => {
        expect(resolveGlideLogLevel(undefined)).toBe('error');
        expect(resolveGlideLogLevel('nonsense')).toBe('error');
    });

    test('VALKEY_GLIDE_LOG_LEVEL can raise it for debugging', () => {
        expect(resolveGlideLogLevel(' WARN ')).toBe('warn');
        expect(resolveGlideLogLevel('off')).toBe('off');
    });
});
