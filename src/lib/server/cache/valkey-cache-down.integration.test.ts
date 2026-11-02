// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dependency direction of the two Valkeys against a REAL task Valkey:
 *  - cache down (CACHE_URL points at a closed port): connect succeeds, the
 *    coordination keyspace and ALL pub/sub (cancel, config, auth bus) keep
 *    working, cache keys read as misses;
 *  - CACHE_URL unset: the same, by configuration;
 *  - task Valkey down: connect reports failure even with a healthy cache.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

type ValkeyModule = typeof import('./valkey.js');

const CLOSED_PORT_URL = 'redis://127.0.0.1:1/0';

async function load(env: { TASK_CACHE_URL: string; CACHE_URL: string }): Promise<ValkeyModule> {
    vi.resetModules();
    vi.stubEnv('TASK_CACHE_URL', env.TASK_CACHE_URL);
    vi.stubEnv('CACHE_URL', env.CACHE_URL);
    return import('./valkey.js');
}

let current: ValkeyModule | null = null;
afterEach(async () => {
    await current?.closeAllSubscriptions();
    await current?.disconnectValkey();
    current = null;
    vi.unstubAllEnvs();
});

function taskUrl(): string {
    const url = process.env.TEST_TASK_CACHE_URL;
    if (!url) throw new Error('TEST_TASK_CACHE_URL (isolated task store) is required');
    return url;
}

describe.each([
    ['cache down', CLOSED_PORT_URL],
    ['CACHE_URL unset', ''],
])('task Valkey up, %s', (_label, cacheUrl) => {
    it('connects, keeps coordination keys and pub/sub working, misses the cache', async () => {
        const valkey = (current = await load({ TASK_CACHE_URL: taskUrl(), CACHE_URL: cacheUrl }));
        expect(await valkey.connectValkey()).toBe(true);
        expect(await valkey.testValkeyConnection()).toBe(true);
        expect(valkey.getValkeyClient()).toBeNull();
        expect(valkey.isCoordinationValkeyReady()).toBe(true);

        const id = randomUUID();
        const revoked = `pat-revoked:itest-${id}`;
        expect(await valkey.cacheSet(revoked, '1', 60)).toBe(true);
        expect(await valkey.cacheGet(revoked)).toBe('1');
        await valkey.cacheDel(revoked);
        // A cache key is a miss, not an error.
        expect(await valkey.cacheSet(`image-metadata:itest-${id}`, 'x', 60)).toBe(false);
        expect(await valkey.cacheGet(`image-metadata:itest-${id}`)).toBeNull();

        // Pub/sub (task cancel, config changes, auth bus) rides the task Valkey.
        const channel = `itest:pubsub:${id}`;
        const received = Promise.withResolvers<string>();
        const unsubscribe = await valkey.subscribeToChannel(channel, (m) => received.resolve(m));
        expect(unsubscribe).not.toBeNull();
        await vi.waitFor(async () => {
            expect(await valkey.publishMessage(channel, 'hello')).toBe(true);
            await expect(
                Promise.race([
                    received.promise,
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error('no message')), 200),
                    ),
                ]),
            ).resolves.toBe('hello');
        });
        await unsubscribe?.();
    });
});

describe('task Valkey down', () => {
    it('reports not connected even when the cache is healthy', async () => {
        const cacheUrl = process.env.TEST_CACHE_URL ?? process.env.CACHE_URL ?? '';
        const valkey = (current = await load({
            TASK_CACHE_URL: CLOSED_PORT_URL,
            CACHE_URL: cacheUrl,
        }));
        expect(await valkey.connectValkey()).toBe(false);
        expect(await valkey.testValkeyConnection()).toBe(false);
        expect(valkey.getCoordinationClient()).toBeNull();
        expect(await valkey.publishMessage('itest:nowhere', 'x')).toBe(false);
    });
});
