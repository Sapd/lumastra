// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pins the re-entrancy guard on the module-level `getOrchestrator()` singleton.
 *
 * `_orchestrator` is only assigned after `TaskOrchestrator.start()` RESOLVES.
 * Without a second memo for the in-flight start, every caller arriving while a
 * start is running sees `null` and runs its own full start — duplicate BullMQ
 * connections and duplicate leader-election timers, with `_orchestrator` left
 * pointing at whichever finished last while the others keep running
 * unreferenced and unstoppable.
 *
 * It stayed latent while the callers were boot (once) and `startRun` (after
 * boot resolved). The readiness probe is what makes it reachable: it polls
 * every 15s and abandons its `await` after 2s WITHOUT cancelling the start
 * underneath, so on a node whose boot start is slow or was skipped, the next
 * probe arrives with the start still running.
 *
 * These tests assert the structural invariant (one start per in-flight window)
 * rather than any timing, so they cannot pass for the wrong reason on a fast
 * machine.
 *
 * Run: npx vitest run src/lib/server/tasks/orchestrator-singleton.test.ts
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────────────
// Same battery as orchestrator.test.ts — the module graph reaches Valkey, the
// queue connection, the DB and the Lua loader at import time.

vi.mock('$lib/server/cache/valkey.js', async () =>
    (await import('./__fixtures__/task-config-mock.js')).taskValkeyMock(),
);

vi.mock('$lib/server/queue/connection.js', () => ({
    getQueueConnectionOptions: vi.fn(() => ({ host: 'localhost', port: 6379, db: 1 })),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn(() => null),
    getTaskDb: vi.fn(() => null),
}));

vi.mock('$lib/server/config.js', async () =>
    (await import('./__fixtures__/task-config-mock.js')).taskConfigMock(),
);

vi.mock('./lua/loader.js', () => ({
    luaLoader: { load: vi.fn(async () => {}), invoke: vi.fn(async () => ({ ok: 'enqueued' })) },
}));

// The builtin autoloader pulls in the whole task catalog; irrelevant here and
// slow. getOrchestrator() already treats its failure as non-fatal.
vi.mock('./builtin/index.js', () => ({ loadBuiltins: vi.fn(async () => {}) }));

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A promise plus the handle to settle it from the test. */
function deferred<T>(): {
    promise: Promise<T>;
    resolve: (v: T) => void;
    reject: (e: Error) => void;
} {
    let resolve!: (v: T) => void;
    let reject!: (e: Error) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

/**
 * Re-import the module with a clean singleton, and hand back a spy standing in
 * for `TaskOrchestrator.start`. `vi.resetModules()` is what resets
 * `_orchestrator` — it is module-level state with no exported reset.
 */
async function freshModule() {
    vi.resetModules();
    const mod = await import('./orchestrator.js');
    const startSpy = vi.spyOn(mod.TaskOrchestrator, 'start');
    return { mod, startSpy };
}

// Warm the module graph once, in a hook with its own generous timeout.
// orchestrator.ts pulls in a very large graph and Vite spends ~30s transforming
// it on a cold run — inside the default 30s per-TEST timeout that lands as a
// mystifying "Test timed out" on whichever test happens to be first, with the
// symptom moving whenever the file is reordered. Paying it here keeps the tests
// measuring the singleton rather than the bundler.
beforeAll(async () => {
    await import('./orchestrator.js');
}, 180_000);

beforeEach(() => {
    vi.clearAllMocks();
});

describe('getOrchestrator — one start per in-flight window', () => {
    it('a caller arriving after the start resolved reuses the instance', async () => {
        const { mod, startSpy } = await freshModule();
        const instance = { id: 'the-one' };
        startSpy.mockResolvedValue(instance as never);

        const first = await mod.getOrchestrator();
        const second = await mod.getOrchestrator();

        expect(first).toBe(instance);
        expect(second).toBe(instance);
        expect(startSpy).toHaveBeenCalledTimes(1);
    });

    it('a FAILED start is not cached — the next caller retries', async () => {
        // This is the case that makes clearing the memo in `finally` (not in
        // `then`) load-bearing: a node whose Valkey is not up yet fails its
        // first start, and must not be handed the same rejected promise for the
        // rest of the process's life.
        const { mod, startSpy } = await freshModule();
        startSpy.mockRejectedValueOnce(new Error('valkey not up'));

        await expect(mod.getOrchestrator()).rejects.toThrow('valkey not up');

        const instance = { id: 'second-attempt' };
        startSpy.mockResolvedValueOnce(instance as never);

        expect(await mod.getOrchestrator()).toBe(instance);
        expect(startSpy).toHaveBeenCalledTimes(2);
    });

    // This is the concurrency case, and the one that fails on the unguarded
    // version: two callers arrive while the start is still in flight (the
    // readiness probe's "abandon after 2s, poll again at 15s" shape) and must
    // produce ONE start between them. It is written on the rejecting path
    // because that is what lets the start be held open across both calls
    // without leaving a resolved orchestrator behind for the next test.
    it('two callers racing an in-flight start share it — one start, one outcome', async () => {
        const { mod, startSpy } = await freshModule();
        const gate = deferred<unknown>();
        startSpy.mockReturnValue(gate.promise as never);

        const first = mod.getOrchestrator();
        const second = mod.getOrchestrator();
        // Attach handlers before rejecting so neither is an unhandled rejection.
        const settled = Promise.allSettled([first, second]);

        gate.reject(new Error('boom'));

        const [a, b] = await settled;
        expect(a.status).toBe('rejected');
        expect(b.status).toBe('rejected');
        // The load-bearing assertion: without the in-flight memo this is 2.
        expect(startSpy).toHaveBeenCalledTimes(1);
    });
});

describe('getOrchestrator — refuses to start after shutdown', () => {
    it('throws instead of building a fresh orchestrator once stop() has run', async () => {
        // The readiness probe polls anonymously every 15s for the whole
        // termination grace period. Without the guard, one of those probes
        // starts a new orchestrator — BullMQ queues, Valkey coordination client,
        // leader-election timers — that no shutdown path will ever stop.
        const { mod, startSpy } = await freshModule();
        const instance = {
            id: 'the-one',
            stop: vi.fn(async () => undefined),
            isShutdownCleanupComplete: () => true,
        };
        startSpy.mockResolvedValue(instance as never);

        await mod.getOrchestrator();
        await mod.orchestrator.stop();
        expect(instance.stop).toHaveBeenCalledTimes(1);

        await expect(mod.getOrchestrator()).rejects.toThrow(/shut down/i);
        expect(startSpy).toHaveBeenCalledTimes(1);
    });

    it('stop() waits out an in-flight start instead of leaving it installed', async () => {
        // stop() returned early when no instance was resolved YET. The start then
        // completed and installed a live orchestrator after teardown, with
        // nothing left to shut it down.
        const { mod, startSpy } = await freshModule();
        const gate = deferred<unknown>();
        startSpy.mockReturnValue(gate.promise as never);

        const starting = mod.getOrchestrator();
        const stopping = mod.orchestrator.stop();

        const instance = {
            id: 'late',
            stop: vi.fn(async () => undefined),
            isShutdownCleanupComplete: () => true,
        };
        gate.resolve(instance);

        await starting;
        await stopping;

        // The late arrival was stopped, not left running.
        expect(instance.stop).toHaveBeenCalledTimes(1);
    });
});
