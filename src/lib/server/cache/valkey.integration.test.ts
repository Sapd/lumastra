// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Real routing against two explicitly supplied, isolated Valkey servers.
 * Per-run keys are removed without FLUSHDB or fixed global DB overrides.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

type ValkeyModule = typeof import('./valkey.js');

const testId = randomUUID();
let valkey: ValkeyModule;
const ownedKeys = [
    'lock:test:routing',
    'image-metadata:test:routing',
    'lock:test:acquire',
    'task:run:active:itest',
    'task:run:active:reqclient-itest',
    'image-metadata:mixed-del',
    'lock:mixed-del',
].map((key) => `${key}:${testId}`);

beforeAll(async () => {
    expect(
        process.env.TEST_TASK_CACHE_URL,
        'A separate isolated task store is required',
    ).toBeTruthy();
    expect(process.env.TEST_CACHE_URL, 'An isolated cache store is required').toBeTruthy();
    vi.resetModules();
    valkey = await import('./valkey.js');
    expect(await valkey.connectValkey()).toBe(true);
    expect(valkey.getCoordinationClient()).toBeTruthy();
});

afterAll(async () => {
    if (!valkey) return;
    try {
        await valkey.del(ownedKeys);
    } finally {
        await valkey.disconnectValkey();
    }
});

describe('Valkey two-instance routing (two real servers)', () => {
    it('opens two distinct connections when TASK_CACHE_URL differs from CACHE_URL', () => {
        const cacheClient = valkey.getValkeyClient();
        const taskClient = valkey.getCoordinationClient();
        expect(cacheClient).toBeTruthy();
        expect(taskClient).toBeTruthy();
        expect(taskClient).not.toBe(cacheClient);
    });

    it('routes a coordination key to the task DB and a cache key to the cache DB', async () => {
        // Both written through the SAME public wrapper — pickClient() routes by key.
        await valkey.cacheSet(`lock:test:routing:${testId}`, 'L');
        await valkey.cacheSet(`image-metadata:test:routing:${testId}`, 'C');

        const cacheClient = valkey.getValkeyClient()!;
        const taskClient = valkey.getCoordinationClient()!;

        // Coordination key lives ONLY on the task DB (the noeviction side).
        expect(await taskClient.exists([`lock:test:routing:${testId}`])).toBe(1);
        expect(await cacheClient.exists([`lock:test:routing:${testId}`])).toBe(0);

        // Cache key lives ONLY on the cache DB (the evictable side).
        expect(await cacheClient.exists([`image-metadata:test:routing:${testId}`])).toBe(1);
        expect(await taskClient.exists([`image-metadata:test:routing:${testId}`])).toBe(0);
    });

    it('acquireLock writes the lock to the task DB, not the cache DB', async () => {
        const token = await valkey.acquireLock(`lock:test:acquire:${testId}`, 30);
        expect(token).toBeTruthy();

        expect(await valkey.getCoordinationClient()!.exists([`lock:test:acquire:${testId}`])).toBe(
            1,
        );
        expect(await valkey.getValkeyClient()!.exists([`lock:test:acquire:${testId}`])).toBe(0);

        await valkey.releaseLock(`lock:test:acquire:${testId}`, token!);
        expect(await valkey.getCoordinationClient()!.exists([`lock:test:acquire:${testId}`])).toBe(
            0,
        );
    });

    it('a task hash write (run-state shape) lands on the task DB', async () => {
        await valkey.hSet(`task:run:active:itest:${testId}`, 'stage:main:processed', '7');
        const fromTask = await valkey
            .getCoordinationClient()!
            .customCommand(['HGET', `task:run:active:itest:${testId}`, 'stage:main:processed']);
        expect(String(fromTask)).toBe('7');
        // Not on the cache DB.
        expect(await valkey.getValkeyClient()!.exists([`task:run:active:itest:${testId}`])).toBe(0);
    });

    it('requireClient (orchestrator/state-machine/runner path) resolves to the task DB', async () => {
        // requireClient is the default client for the orchestrator, state machine
        // and runner — the authoritative run-state writers. It must resolve to the
        // coordination (noeviction) instance, not the evictable cache.
        const { requireClient } = await import('../tasks/valkey-types.js');
        const client = requireClient();
        await client.customCommand(['SET', `task:run:active:reqclient-itest:${testId}`, '1']);

        expect(
            await valkey
                .getCoordinationClient()!
                .exists([`task:run:active:reqclient-itest:${testId}`]),
        ).toBe(1);
        expect(
            await valkey.getValkeyClient()!.exists([`task:run:active:reqclient-itest:${testId}`]),
        ).toBe(0);
    });

    it('del() across a mixed-keyspace array deletes from BOTH instances', async () => {
        await valkey.cacheSet(`image-metadata:mixed-del:${testId}`, 'C'); // cache DB
        await valkey.cacheSet(`lock:mixed-del:${testId}`, 'L'); // task DB

        const deleted = await valkey.del([
            `image-metadata:mixed-del:${testId}`,
            `lock:mixed-del:${testId}`,
        ]);
        expect(deleted).toBe(2);
        expect(await valkey.getValkeyClient()!.exists([`image-metadata:mixed-del:${testId}`])).toBe(
            0,
        );
        expect(await valkey.getCoordinationClient()!.exists([`lock:mixed-del:${testId}`])).toBe(0);
    });

    it('pub/sub round-trips on the cache client (eviction-immune path)', async () => {
        const received: string[] = [];
        const unsub = await valkey.subscribeToChannel(`itest:pubsub:${testId}`, (m) =>
            received.push(m),
        );
        // Give the dedicated subscription client a moment to establish.
        await new Promise((r) => setTimeout(r, 150));
        await valkey.publishMessage(`itest:pubsub:${testId}`, 'hello');
        await new Promise((r) => setTimeout(r, 250));
        expect(received).toContain('hello');
        if (typeof unsub === 'function') unsub();
    });
});
