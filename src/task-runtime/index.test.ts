// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
    subscription: undefined as Promise<void> | undefined,
    subscribed: false,
    providerDatabase: 0,
    providersLoaded: 0,
    term: undefined as (() => void) | undefined,
    exited: false,
    guardError: undefined as Error | undefined,
    uncaught: undefined as ((err: Error) => void) | undefined,
}));
vi.mock('$app/paths', () => ({ base: '' }));
vi.mock('$lib/server/config.js', () => ({
    config: { DATABASE_URL: 'test-only', CACHE_URL: 'test-only', TASK_CACHE_URL: 'test-only' },
    features: { jellyfinSync: false },
    LUMASTRA_METRICS_PUBLIC: false,
    LUMASTRA_METRICS_BEARER_TOKEN: '',
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('./health-server.js', () => ({
    startTaskHealthServer: async () => ({ drain: () => {}, close: async () => {} }),
}));
vi.mock('./lifecycle.js', () => ({
    startTaskSubsystem: vi.fn(),
    stopTaskSubsystem: vi.fn(),
    markTaskProcessExiting: vi.fn(),
}));
vi.mock('./process-lifecycle.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./process-lifecycle.js')>();
    return {
        ...actual,
        createTaskProcessLifecycle: (
            options: Parameters<typeof actual.createTaskProcessLifecycle>[0],
        ) =>
            actual.createTaskProcessLifecycle({
                ...options,
                // Cleanup has its own failure-seam tests. This test isolates the
                // entry's startup sequence while retaining its real abort signal.
                cleanup: async () => {},
                exit: () => {
                    state.exited = true;
                },
            }),
    };
});
vi.mock('$lib/server/tasks/metrics.js', () => ({
    tasksRegistry: { contentType: 'text/plain', metrics: async () => '' },
}));
vi.mock('$lib/server/runtime-optimizations.js', () => ({ applyRuntimeOptimizations: () => {} }));
vi.mock('$lib/server/database/migrate-schema.js', () => ({ migrateSchema: async () => {} }));
vi.mock('$lib/server/database/connection.js', () => ({
    testDbConnection: async () => true,
    getDb: () => ({}),
}));
vi.mock('$lib/server/cache/valkey.js', () => ({
    connectValkey: async () => true,
    guardTaskValkey: async () => {
        if (state.guardError) throw state.guardError;
    },
}));
vi.mock('$lib/server/config/config.service.js', () => ({
    startConfigChangeSubscriber: async () => {
        state.subscribed = true;
        await state.subscription;
    },
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: {
        getSql: async () => {
            state.providerDatabase++;
            return {};
        },
    },
}));
vi.mock('$lib/server/providers/provider-config-loader.js', () => ({
    loadProviderConfigFromDb: async () => {
        state.providersLoaded++;
    },
}));

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

it('stops after a config subscription settles when TERM arrived during that startup stage', async () => {
    vi.stubEnv('WORKER_MODE', 'enabled');
    vi.stubEnv('DEDICATED_WORKER', 'true');
    let release: () => void = () => {};
    state.subscription = new Promise<void>((resolve) => {
        release = resolve;
    });
    const on = process.on;
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
        if (event === 'SIGTERM') {
            state.term = () => {
                listener();
            };
            return process;
        }
        if (event === 'uncaughtException') {
            state.uncaught = listener as (err: Error) => void;
            return process;
        }
        if (['SIGINT', 'unhandledRejection'].includes(String(event))) return process;
        return on.call(process, event, listener);
    });
    try {
        await import('./index.js');
        await vi.waitFor(() => {
            expect(state.subscribed).toBe(true);
        });
        expect(state.term).toBeTypeOf('function');
        state.term?.();
        release();
        await vi.waitFor(() => {
            expect(state.exited).toBe(true);
        });
        expect(state.providerDatabase).toBe(0);
        expect(state.providersLoaded).toBe(0);
    } finally {
        release();
    }
});

it('counts uncaught exceptions and keeps the count in the runtime state', async () => {
    const { getWorkerRuntimeState } = await import('./runtime-state.js');
    expect(state.uncaught).toBeTypeOf('function');
    const before = getWorkerRuntimeState().uncaughtExceptions;
    state.uncaught?.(new Error('first'));
    state.uncaught?.(new Error('second'));
    expect(getWorkerRuntimeState().uncaughtExceptions).toBe(before + 2);
});

// Runs last: it resets modules and re-imports the entry with a failing guard.
it('refuses to start when the task Valkey guard rejects, before any task state is touched', async () => {
    vi.resetModules();
    vi.stubEnv('WORKER_MODE', 'enabled');
    vi.stubEnv('DEDICATED_WORKER', 'true');
    state.subscribed = false;
    state.exited = false;
    state.providerDatabase = 0;
    state.guardError = new Error('task Valkey evicts');
    const on = process.on;
    vi.spyOn(process, 'on').mockImplementation((event, listener) => {
        if (
            ['SIGTERM', 'SIGINT', 'unhandledRejection', 'uncaughtException'].includes(String(event))
        )
            return process;
        return on.call(process, event, listener);
    });
    try {
        await import('./index.js');
        await vi.waitFor(() => {
            expect(state.exited).toBe(true);
        });
        expect(state.subscribed).toBe(false);
        expect(state.providerDatabase).toBe(0);
    } finally {
        state.guardError = undefined;
    }
});
