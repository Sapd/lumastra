// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    worker: false,
    featureIds: ['example'],
    database: vi.fn(),
    builtins: vi.fn(),
    plugins: vi.fn(),
    rateLimits: vi.fn(),
    feature: vi.fn(),
    connect: vi.fn(),
    coordinationHealthy: vi.fn(),
    decode: vi.fn(),
    trickplay: vi.fn(),
    orchestrator: vi.fn(),
    stop: vi.fn(),
    auth: vi.fn(),
    stopAuth: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
}));
vi.mock('$lib/server/config.js', () => ({ shouldStartWorkers: () => state.worker }));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: state.info, warn: state.warn, error: vi.fn() }) },
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: state.database },
}));
vi.mock('$lib/server/tasks/builtin', () => ({ loadBuiltins: state.builtins }));
vi.mock('$lib/server/plugins', () => ({ loadAllPlugins: state.plugins }));
vi.mock('$lib/server/tasks/http-rate-limit.js', () => ({
    applyStoredRateLimits: state.rateLimits,
}));
vi.mock('$lib/server/tasks/registry.js', () => ({
    registry: {
        getAllFeatures: () =>
            state.featureIds.map((id) => ({ id, onStartup: () => state.feature(id) })),
    },
}));
vi.mock('$lib/server/tasks/plugin-context.js', () => ({ buildPluginContext: vi.fn() }));
vi.mock('$lib/server/cache/valkey', () => ({
    connectValkey: state.connect,
    isCoordinationValkeyHealthy: state.coordinationHealthy,
    guardTaskValkey: async () => undefined,
}));
vi.mock('$lib/server/cache/decode-deny-bus', () => ({ startDecodeDenySubscriber: state.decode }));
vi.mock('$lib/server/cache/trickplay-hwaccel-deny-bus', () => ({
    startTrickplayHwaccelDenySubscriber: state.trickplay,
}));
vi.mock('$lib/server/cache/auth-cache-bus', () => ({
    startAuthCacheInvalidationSubscriber: state.auth,
    stopAuthCacheInvalidationSubscriber: state.stopAuth,
}));
vi.mock('$lib/server/tasks/orchestrator', () => ({
    getOrchestrator: state.orchestrator,
    orchestrator: { stop: state.stop },
}));
// The lifecycle must not import consumer startup modules directly. Builtin
// registration is mocked above; registering a media source may load its module.
vi.mock('$lib/server/tasks/runner', () => {
    throw new Error('Web lifecycle imported task consumers');
});
vi.mock('$lib/server/tasks/scheduler.js', () => {
    throw new Error('Web lifecycle imported task scheduler');
});
vi.mock('$lib/server/tasks/builtin/native/media-sources/file-scanner.js', () => {
    throw new Error('Web lifecycle imported watcher');
});

beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useFakeTimers();
    state.worker = false;
    state.featureIds = ['example'];
    vi.stubEnv('TASK_CACHE_URL', 'redis://task-test:6379');
    vi.stubEnv('CACHE_URL', 'redis://cache-test:6379');
    state.database.mockResolvedValue({});
    state.feature.mockResolvedValue(undefined);
    state.connect.mockResolvedValue(true);
    state.coordinationHealthy.mockResolvedValue(true);
    state.decode.mockResolvedValue(true);
    state.trickplay.mockResolvedValue(true);
});
afterEach(async () => {
    const runtime = await import('./web-lifecycle.js');
    await runtime.stopWebTaskSubsystem();
    vi.useRealTimers();
    vi.unstubAllEnvs();
});

function deferred(): {
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: Error) => void;
} {
    let resolve = (): void => {};
    let reject = (_error: Error): void => {};
    const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

describe('web task initialization retry', () => {
    it('automatically recovers a transient database failure and starts auth independently', async () => {
        state.database.mockRejectedValueOnce(new Error('database unavailable'));
        const runtime = await import('./web-lifecycle.js');
        const initial = runtime.startWebTaskSubsystem();
        expect(runtime.startWebTaskSubsystem()).toBe(initial);
        await expect(initial).rejects.toThrow('database unavailable');
        expect(state.auth).toHaveBeenCalledTimes(1);
        expect(state.plugins).not.toHaveBeenCalled();
        expect(runtime.startWebTaskSubsystem()).toBe(initial);
        await vi.advanceTimersByTimeAsync(999);
        expect(state.database).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await runtime.startWebTaskSubsystem();
        expect(state.database).toHaveBeenCalledTimes(2);
        expect(state.feature).toHaveBeenCalledTimes(1);
        expect(state.orchestrator).toHaveBeenCalledTimes(1);
        expect(state.auth).toHaveBeenCalledTimes(1);
    });

    it.each(['false', 'throw'] as const)(
        'retries cache connection %s without replaying registry or feature side effects',
        async (failure) => {
            if (failure === 'false') state.connect.mockResolvedValueOnce(false);
            else state.connect.mockRejectedValueOnce(new Error('Valkey unavailable'));
            const runtime = await import('./web-lifecycle.js');
            await expect(runtime.startWebTaskSubsystem()).rejects.toThrow('Valkey');
            await vi.advanceTimersByTimeAsync(1_000);
            await runtime.startWebTaskSubsystem();
            expect(state.connect).toHaveBeenCalledTimes(2);
            expect(state.database).toHaveBeenCalledTimes(1);
            expect(state.builtins).toHaveBeenCalledTimes(1);
            expect(state.plugins).toHaveBeenCalledTimes(1);
            expect(state.rateLimits).toHaveBeenCalledTimes(1);
            expect(state.feature).toHaveBeenCalledTimes(1);
            expect(state.auth).toHaveBeenCalledTimes(1);
        },
    );

    it('retries when cache is available but task coordination is unavailable', async () => {
        state.coordinationHealthy.mockResolvedValueOnce(false);
        const runtime = await import('./web-lifecycle.js');
        await expect(runtime.startWebTaskSubsystem()).rejects.toThrow(
            'healthy coordination Valkey',
        );
        expect(state.decode).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
        await runtime.startWebTaskSubsystem();
        expect(state.connect).toHaveBeenCalledTimes(2);
        expect(state.orchestrator).toHaveBeenCalledTimes(1);
        expect(state.feature).toHaveBeenCalledTimes(1);
    });

    it('rejects invalid endpoint configuration before side effects without retrying', async () => {
        vi.stubEnv('TASK_CACHE_URL', '');
        const runtime = await import('./web-lifecycle.js');
        await expect(runtime.startWebTaskSubsystem()).rejects.toThrow('TASK_CACHE_URL');
        await vi.advanceTimersByTimeAsync(120_000);
        expect(state.auth).not.toHaveBeenCalled();
        expect(state.database).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['decode', 'trickplay'] as const)(
        'retries a failed %s subscription without replaying earlier startup work',
        async (subscriber) => {
            state[subscriber].mockResolvedValueOnce(false);
            const runtime = await import('./web-lifecycle.js');
            await expect(runtime.startWebTaskSubsystem()).rejects.toThrow('subscriber unavailable');
            expect(state.orchestrator).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1_000);
            await runtime.startWebTaskSubsystem();
            expect(state[subscriber]).toHaveBeenCalledTimes(2);
            expect(state.feature).toHaveBeenCalledTimes(1);
            expect(state.connect).toHaveBeenCalledTimes(1);
            expect(state.orchestrator).toHaveBeenCalledTimes(1);
            if (subscriber === 'trickplay') expect(state.decode).toHaveBeenCalledTimes(1);
        },
    );

    it('starts with task coordination and memory caching; deny buses ride the task Valkey', async () => {
        vi.stubEnv('CACHE_URL', '');
        const runtime = await import('./web-lifecycle.js');
        await runtime.startWebTaskSubsystem();
        expect(state.coordinationHealthy).toHaveBeenCalledTimes(1);
        expect(state.decode).toHaveBeenCalledTimes(1);
        expect(state.trickplay).toHaveBeenCalledTimes(1);
        expect(state.orchestrator).toHaveBeenCalledTimes(1);
    });

    it('resumes after a failed later step and coalesces concurrent retry callers', async () => {
        const retry = deferred();
        state.orchestrator
            .mockImplementationOnce(async () => {
                throw new Error('coordination unavailable');
            })
            .mockImplementationOnce(() => retry.promise);
        const runtime = await import('./web-lifecycle.js');
        await expect(runtime.startWebTaskSubsystem()).rejects.toThrow('coordination unavailable');
        await vi.advanceTimersByTimeAsync(1_000);
        const attempt = runtime.startWebTaskSubsystem();
        for (let i = 0; i < 10; i++) expect(runtime.startWebTaskSubsystem()).toBe(attempt);
        expect(state.orchestrator).toHaveBeenCalledTimes(2);
        retry.resolve();
        await attempt;
        expect(state.decode).toHaveBeenCalledTimes(1);
        expect(state.trickplay).toHaveBeenCalledTimes(1);
        expect(state.feature).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(120_000);
        expect(state.orchestrator).toHaveBeenCalledTimes(2);
    });

    it('caps retry backoff at thirty seconds without caller bypass or timer accumulation', async () => {
        state.connect.mockResolvedValue(false);
        const runtime = await import('./web-lifecycle.js');
        await expect(runtime.startWebTaskSubsystem()).rejects.toThrow('Valkey');
        for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]) {
            const before = state.connect.mock.calls.length;
            expect(vi.getTimerCount()).toBe(1);
            await expect(runtime.startWebTaskSubsystem()).rejects.toThrow('Valkey');
            await vi.advanceTimersByTimeAsync(delay - 1);
            expect(state.connect).toHaveBeenCalledTimes(before);
            await vi.advanceTimersByTimeAsync(1);
            expect(state.connect).toHaveBeenCalledTimes(before + 1);
        }
        expect(state.auth).toHaveBeenCalledTimes(1);
    });

    it('does not replay a timed-out feature still running when Valkey retries', async () => {
        const feature = deferred();
        state.feature.mockReturnValue(feature.promise);
        state.connect.mockResolvedValueOnce(false);
        const runtime = await import('./web-lifecycle.js');
        const starting = runtime.startWebTaskSubsystem();
        const failed = expect(starting).rejects.toThrow('Valkey');
        await vi.waitFor(() => expect(state.feature).toHaveBeenCalledTimes(1));
        await vi.advanceTimersByTimeAsync(30_000);
        await failed;
        await vi.advanceTimersByTimeAsync(1_000);
        await runtime.startWebTaskSubsystem();
        expect(state.feature).toHaveBeenCalledTimes(1);
        feature.resolve();
    });

    it('cancels scheduled retries and shares shutdown', async () => {
        state.connect.mockResolvedValue(false);
        const runtime = await import('./web-lifecycle.js');
        await expect(runtime.startWebTaskSubsystem()).rejects.toThrow('Valkey');
        const stopping = runtime.stopWebTaskSubsystem();
        expect(runtime.stopWebTaskSubsystem()).toBe(stopping);
        await stopping;
        await vi.advanceTimersByTimeAsync(120_000);
        expect(state.connect).toHaveBeenCalledTimes(1);
        expect(state.stop).toHaveBeenCalledTimes(1);
        expect(state.stopAuth).toHaveBeenCalledTimes(1);
        await expect(runtime.startWebTaskSubsystem()).rejects.toThrow('stopping');
    });

    it.each(['resolve', 'reject'] as const)(
        'waits for an active retry to %s before cleanup and prevents late stages/retries',
        async (outcome) => {
            state.connect.mockResolvedValueOnce(false);
            const active = deferred();
            const runtime = await import('./web-lifecycle.js');
            await expect(runtime.startWebTaskSubsystem()).rejects.toThrow('Valkey');
            state.connect.mockImplementationOnce(() => active.promise.then(() => true));
            await vi.advanceTimersByTimeAsync(1_000);
            const starting = runtime.startWebTaskSubsystem();
            const failure = expect(starting).rejects.toThrow();
            const stopping = runtime.stopWebTaskSubsystem();
            await Promise.resolve();
            expect(state.stop).not.toHaveBeenCalled();
            if (outcome === 'resolve') active.resolve();
            else active.reject(new Error('late connection failure'));
            await failure;
            await stopping;
            await vi.advanceTimersByTimeAsync(120_000);
            expect(state.connect).toHaveBeenCalledTimes(2);
            expect(state.decode).not.toHaveBeenCalled();
            expect(state.orchestrator).not.toHaveBeenCalled();
            expect(state.stop).toHaveBeenCalledTimes(1);
        },
    );

    it('does not start later feature hooks after shutdown interrupts the first', async () => {
        const feature = deferred();
        state.featureIds = ['first', 'second', 'third'];
        state.feature.mockReturnValue(feature.promise);
        const runtime = await import('./web-lifecycle.js');
        const starting = runtime.startWebTaskSubsystem();
        const failed = expect(starting).rejects.toThrow('stopping');
        await vi.waitFor(() => expect(state.feature).toHaveBeenCalledExactlyOnceWith('first'));
        const stopping = runtime.stopWebTaskSubsystem();
        feature.resolve();
        await failed;
        await stopping;
        expect(state.feature).toHaveBeenCalledExactlyOnceWith('first');
        expect(state.connect).not.toHaveBeenCalled();
    });

    it('aborts registry loading after an in-flight plugin load settles', async () => {
        const plugin = deferred();
        state.plugins.mockReturnValue(plugin.promise);
        const runtime = await import('./web-lifecycle.js');
        const starting = runtime.startWebTaskSubsystem();
        const failed = expect(starting).rejects.toThrow('stopping');
        await vi.waitFor(() => expect(state.plugins).toHaveBeenCalledTimes(1));
        const stopping = runtime.stopWebTaskSubsystem();
        plugin.resolve();
        await failed;
        await stopping;
        expect(state.rateLimits).not.toHaveBeenCalled();
        expect(state.feature).not.toHaveBeenCalled();
        expect(state.connect).not.toHaveBeenCalled();
    });

    it('does not start the auth supervisor from a late dynamic import after stop', async () => {
        const runtime = await import('./web-lifecycle.js');
        const starting = runtime.startWebTaskSubsystem();
        const failed = expect(starting).rejects.toThrow('stopping');
        const stopping = runtime.stopWebTaskSubsystem();
        await failed;
        await stopping;
        expect(state.auth).not.toHaveBeenCalled();
        expect(state.builtins).not.toHaveBeenCalled();
    });

    it('rejects worker role and startup after stop without scheduling retries', async () => {
        state.worker = true;
        const runtime = await import('./web-lifecycle.js');
        await expect(runtime.startWebTaskSubsystem()).rejects.toThrow('web server cannot run');
        expect(state.database).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
        await runtime.stopWebTaskSubsystem();
        await expect(runtime.startWebTaskSubsystem()).rejects.toThrow('stopping');
    });
});
