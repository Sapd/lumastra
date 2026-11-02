// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }));
vi.mock('@valkey/valkey-glide', () => ({
    GlideClient: { createClient: mocks.createClient },
    Logger: { setLoggerConfig: vi.fn() },
    TimeUnit: {},
}));

beforeEach(() => {
    vi.resetModules();
    mocks.createClient.mockReset().mockImplementation(async () => ({
        ping: vi.fn().mockResolvedValue('PONG'),
    }));
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
});

describe('Valkey client endpoint policy', () => {
    it('does not use a connected cache as coordination when task is missing', async () => {
        vi.stubEnv('CACHE_URL', 'redis://cache');
        vi.stubEnv('TASK_CACHE_URL', '');
        const valkey = await import('./valkey');
        expect(valkey.getCoordinationClient()).toBeNull();
        await expect(valkey.connectValkey()).rejects.toThrow('TASK_CACHE_URL is required');
        expect(mocks.createClient).not.toHaveBeenCalled();
    });

    it('rejects same-instance configuration before opening either client', async () => {
        vi.stubEnv('CACHE_URL', 'redis://shared/0');
        vi.stubEnv('TASK_CACHE_URL', 'redis://shared/15');
        const valkey = await import('./valkey');
        await expect(valkey.connectValkey()).rejects.toThrow('distinct Valkey instances');
        expect(mocks.createClient).not.toHaveBeenCalled();
    });

    it('connects only the task client when shared cache is disabled', async () => {
        vi.stubEnv('CACHE_URL', '');
        vi.stubEnv('TASK_CACHE_URL', 'rediss://tasks:6380');
        const valkey = await import('./valkey');
        expect(await valkey.connectValkey()).toBe(true);
        expect(valkey.getValkeyClient()).toBeNull();
        expect(valkey.getCoordinationClient()).not.toBeNull();
        expect(mocks.createClient).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                addresses: [{ host: 'tasks', port: 6380 }],
                databaseId: 0,
                useTLS: true,
            }),
        );
    });

    it('retries failed coordination while preserving the connected cache', async () => {
        vi.stubEnv('CACHE_URL', 'redis://cache');
        vi.stubEnv('TASK_CACHE_URL', 'redis://tasks');
        // Coordination connects FIRST; the cache attempt still runs when it fails.
        mocks.createClient
            .mockRejectedValueOnce(new Error('task unavailable'))
            .mockResolvedValueOnce({ ping: vi.fn().mockResolvedValue('PONG') });
        const valkey = await import('./valkey');
        expect(await valkey.connectValkey()).toBe(false);
        expect(mocks.createClient).toHaveBeenCalledTimes(2);
        expect(valkey.getValkeyClient()).not.toBeNull();
        expect(await valkey.connectValkey()).toBe(true);
        expect(mocks.createClient).toHaveBeenCalledTimes(3);
        expect(valkey.getCoordinationClient()).not.toBeNull();
        await valkey.disconnectValkey();
    });

    it('connects coordination before the cache, with the task endpoint', async () => {
        vi.stubEnv('CACHE_URL', 'redis://cache');
        vi.stubEnv('TASK_CACHE_URL', 'redis://tasks');
        const valkey = await import('./valkey');
        expect(await valkey.connectValkey()).toBe(true);
        expect(mocks.createClient.mock.calls.map(([c]) => c.addresses[0].host)).toEqual([
            'tasks',
            'cache',
        ]);
        await valkey.disconnectValkey();
    });

    it('reports ready with the cache down and reconnects the cache in the background', async () => {
        vi.useFakeTimers();
        try {
            vi.stubEnv('CACHE_URL', 'redis://cache');
            vi.stubEnv('TASK_CACHE_URL', 'redis://tasks');
            const task = { ping: vi.fn().mockResolvedValue('PONG'), close: vi.fn() };
            const cache = { ping: vi.fn().mockResolvedValue('PONG'), close: vi.fn() };
            mocks.createClient
                .mockResolvedValueOnce(task)
                .mockRejectedValueOnce(new Error('cache down'))
                .mockRejectedValueOnce(new Error('cache still down'))
                .mockResolvedValueOnce(cache);
            const valkey = await import('./valkey');
            expect(await valkey.connectValkey()).toBe(true);
            expect(valkey.getCoordinationClient()).toBe(task);
            expect(valkey.isCoordinationValkeyReady()).toBe(true);
            expect(valkey.getValkeyClient()).toBeNull();
            expect(valkey.isValkeyReady()).toBe(false);
            // Coordination keys stay usable; cache keys read as misses.
            expect(valkey.isValkeyReadyFor('pat-revoked:x')).toBe(true);
            expect(valkey.isValkeyReadyFor('trending:movies')).toBe(false);
            // A later connect does not block on the cache.
            expect(await valkey.connectValkey()).toBe(true);
            expect(mocks.createClient).toHaveBeenCalledTimes(2);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(mocks.createClient).toHaveBeenCalledTimes(3);
            expect(valkey.getValkeyClient()).toBeNull();
            await vi.advanceTimersByTimeAsync(2_000);
            expect(mocks.createClient).toHaveBeenCalledTimes(4);
            expect(valkey.getValkeyClient()).toBe(cache);
            await valkey.disconnectValkey();
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports NOT ready when only the task Valkey is down', async () => {
        vi.stubEnv('CACHE_URL', 'redis://cache');
        vi.stubEnv('TASK_CACHE_URL', 'redis://tasks');
        const cache = { ping: vi.fn().mockResolvedValue('PONG'), close: vi.fn() };
        mocks.createClient
            .mockRejectedValue(new Error('task down'))
            .mockRejectedValueOnce(new Error('task down'))
            .mockResolvedValueOnce(cache);
        const valkey = await import('./valkey');
        expect(await valkey.connectValkey()).toBe(false);
        expect(await valkey.testValkeyConnection()).toBe(false);
        expect(valkey.getValkeyClient()).toBe(cache);
        expect(valkey.getCoordinationClient()).toBeNull();
        await valkey.disconnectValkey();
    });

    it('shares the initial cache PING instead of publishing an unverified client', async () => {
        vi.stubEnv('CACHE_URL', 'redis://cache');
        vi.stubEnv('TASK_CACHE_URL', 'redis://tasks');
        const ping = Promise.withResolvers<string>();
        const cache = { ping: vi.fn(() => ping.promise), close: vi.fn() };
        const task = { ping: vi.fn().mockResolvedValue('PONG'), close: vi.fn() };
        mocks.createClient.mockResolvedValueOnce(task).mockResolvedValueOnce(cache);
        const valkey = await import('./valkey');
        let secondSettled = false;
        const first = valkey.connectValkey();
        const second = valkey.connectValkey().then((ready) => {
            secondSettled = true;
            return ready;
        });
        await vi.waitFor(() => expect(cache.ping).toHaveBeenCalledOnce());
        expect(mocks.createClient).toHaveBeenCalledTimes(2);
        expect(valkey.getValkeyClient()).toBeNull();
        expect(secondSettled).toBe(false);
        ping.resolve('PONG');
        expect(await Promise.all([first, second])).toEqual([true, true]);
        expect(valkey.getValkeyClient()).toBe(cache);
        expect(mocks.createClient).toHaveBeenCalledTimes(2);
        await valkey.disconnectValkey();
    });

    it.each(['cache', 'task'] as const)(
        'closes a %s client created after disconnect',
        async (role) => {
            vi.stubEnv('CACHE_URL', 'redis://cache');
            vi.stubEnv('TASK_CACHE_URL', 'redis://tasks');
            const cache = { ping: vi.fn().mockResolvedValue('PONG'), close: vi.fn() };
            const task = { ping: vi.fn().mockResolvedValue('PONG'), close: vi.fn() };
            const gate = Promise.withResolvers<typeof cache>();
            if (role === 'cache') mocks.createClient.mockResolvedValueOnce(task);
            mocks.createClient.mockReturnValueOnce(gate.promise);
            const valkey = await import('./valkey');
            const pending = valkey.connectValkey();
            await vi.waitFor(() =>
                expect(mocks.createClient).toHaveBeenCalledTimes(role === 'task' ? 1 : 2),
            );
            await valkey.disconnectValkey();
            const late = role === 'cache' ? cache : task;
            gate.resolve(late);
            expect(await pending).toBe(false);
            expect(late.close).toHaveBeenCalledOnce();
            expect(late.ping).not.toHaveBeenCalled();
            expect(valkey.getValkeyClient()).toBeNull();
            expect(valkey.getCoordinationClient()).toBeNull();
        },
    );

    it('does not let an obsolete attempt clear a replacement connection', async () => {
        vi.stubEnv('CACHE_URL', 'redis://cache');
        vi.stubEnv('TASK_CACHE_URL', 'redis://tasks');
        const oldClient = { ping: vi.fn().mockResolvedValue('PONG'), close: vi.fn() };
        const gate = Promise.withResolvers<typeof oldClient>();
        mocks.createClient.mockReturnValueOnce(gate.promise);
        const valkey = await import('./valkey');
        const oldAttempt = valkey.connectValkey();
        await valkey.disconnectValkey();
        const cache = { ping: vi.fn().mockResolvedValue('PONG'), close: vi.fn() };
        const task = { ping: vi.fn().mockResolvedValue('PONG'), close: vi.fn() };
        mocks.createClient.mockResolvedValueOnce(task).mockResolvedValueOnce(cache);
        expect(await valkey.connectValkey()).toBe(true);
        gate.resolve(oldClient);
        expect(await oldAttempt).toBe(false);
        expect(oldClient.close).toHaveBeenCalledOnce();
        expect(valkey.getValkeyClient()).toBe(cache);
        expect(valkey.getCoordinationClient()).toBe(task);
        await valkey.disconnectValkey();
    });
});

describe('canonical subscriber endpoint', () => {
    it('uses the same decoded host and credentials as primary clients', async () => {
        // Pub/sub runs on the task (coordination) Valkey, never the cache.
        vi.stubEnv('CACHE_URL', 'redis://cache:6379/0');
        vi.stubEnv('TASK_CACHE_URL', 'rediss://us%65r:p%40ss@tasks%2e:6380/1');
        const subscriber = { subscribe: vi.fn().mockResolvedValue(undefined), close: vi.fn() };
        mocks.createClient.mockResolvedValueOnce(subscriber);
        const valkey = await import('./valkey');
        const unsubscribe = await valkey.subscribeToChannel('test:canonical', () => undefined);
        expect(unsubscribe).not.toBeNull();
        expect(mocks.createClient).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({
                addresses: [{ host: 'tasks', port: 6380 }],
                useTLS: true,
                credentials: { username: 'user', password: 'p@ss' },
            }),
        );
        await valkey.closeAllSubscriptions();
    });
});
