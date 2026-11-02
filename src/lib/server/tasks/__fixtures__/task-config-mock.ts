// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The ONE `$lib/server/config.js` mock for task-system test files.
 *
 * WHY THIS EXISTS. `orchestrator.ts`'s import graph destructures a long list of
 * config exports AT MODULE LOAD (backpressure.ts builds `classCaps` from seven
 * queue-depth caps, runner.ts reads the concurrency set, registry.ts reads
 * `FEATURE_PER_TASK_QUEUES`, …). Vitest module mocks are STRICT: one missing
 * export is not `undefined`, it is a hard "No X export is defined on the mock"
 * that fails the whole file at collection — before a single test runs.
 *
 * That made every task-system test file carry its own hand-maintained copy of
 * this list, and the copies drifted. `orchestrator-hard-kill.test.ts` sat
 * excluded from the runner for months (see vitest.config.ts history) and its
 * copy silently rotted: by the time it was re-enabled it was missing
 * `FEATURE_PER_TASK_QUEUES` and a dozen others, so it could not even load.
 *
 * Adding a new config export that the task import chain destructures? Add it
 * HERE, once. Do not paste a private copy into a test file — that is exactly
 * the drift this module exists to stop.
 *
 * Usage — the factory must be imported dynamically, because `vi.mock` calls are
 * hoisted above static imports:
 *
 *     vi.mock('$lib/server/config.js', async () =>
 *         (await import('./__fixtures__/task-config-mock.js')).taskConfigMock());
 *
 * Per-file overrides go in the spread that follows:
 *
 *     vi.mock('$lib/server/config.js', async () => ({
 *         ...(await import('./__fixtures__/task-config-mock.js')).taskConfigMock(),
 *         FEATURE_PER_TASK_QUEUES: true,
 *     }));
 */

import { vi } from 'vitest';

export function taskConfigMock() {
    return {
        // JELLYSEERR*: orchestrator.ts imports UserNotifier, which pulls in
        // jellyseerr.ts's module-scope `new JellyseerrClient(config.SEERRURL,
        // config.SEERRAPIKEY)`. The constructor calls `.replace()` on the URL,
        // so a missing key is a load-time TypeError for the whole suite. Empty
        // strings mirror config.ts's own defaults (= Jellyseerr not configured).
        config: { INSTANCE_ID: 'test-instance', SEERRURL: '', SEERRAPIKEY: '' },

        LUMASTRA_ORCHESTRATOR_LEADER_TTL_MS: 5_000,
        LUMASTRA_ORCHESTRATOR_LEADER_RENEW_MS: 2_000,
        LUMASTRA_TRANSITION_BATCH_WINDOW_MS: 50,
        LUMASTRA_TRANSITION_BATCH_MAX: 200,
        LUMASTRA_RUN_STATE_TTL_ACTIVE_MS: 900_000,
        LUMASTRA_RUN_STATE_TTL_TERMINAL_MS: 3_600_000,

        // backpressure.ts builds its classCaps from ALL of these at module load.
        LUMASTRA_QUEUE_DEPTH_CAP_CPU: 500,
        LUMASTRA_QUEUE_DEPTH_CAP_IO: 2_000,
        LUMASTRA_QUEUE_DEPTH_CAP_EMBEDDING: 10_000,
        LUMASTRA_QUEUE_DEPTH_CAP_MAINTENANCE: 100,
        LUMASTRA_QUEUE_DEPTH_CAP_INGEST: 2_000,
        LUMASTRA_QUEUE_DEPTH_CAP_BULK: 500,
        LUMASTRA_QUEUE_DEPTH_CAP_ANALYSIS: 100,
        LUMASTRA_QUEUE_DEPTH_CAP_DISCOVERY: 10_000,

        // runner.ts (imported for defaultConcurrencyFor) destructures these at load.
        LUMASTRA_CONCURRENCY_CPU: 2,
        LUMASTRA_CONCURRENCY_IO: 4,
        LUMASTRA_CONCURRENCY_EMBEDDING: 2,
        LUMASTRA_CONCURRENCY_MAINTENANCE: 3,
        LUMASTRA_CONCURRENCY_INGEST: 4,
        LUMASTRA_CONCURRENCY_BULK: 1,
        LUMASTRA_CONCURRENCY_ANALYSIS: 1,
        LUMASTRA_CONCURRENCY_DISCOVERY: 1,

        LUMASTRA_RUN_HEARTBEAT_INTERVAL_MS: 30_000,
        LUMASTRA_RUN_STALL_WARN_MS: 120_000,
        LUMASTRA_RUN_STALL_FAIL_MS: 600_000,
        LUMASTRA_MASTER_KEY: 'a'.repeat(64),

        LUMASTRA_CIRCUIT_FAILURE_THRESHOLD: 5,
        LUMASTRA_CIRCUIT_FAILURE_RATE_WINDOW_MS: 1_800_000,
        LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS: 86_400_000,

        // Wave 8.5 — default off so tests exercise the legacy per-class path.
        FEATURE_PER_TASK_QUEUES: false,

        // orchestrator.ts reads this at module load to cap serialized task input
        // (256 KiB default); the strict mock must export it or the import fails.
        LUMASTRA_MAX_TASK_INPUT_BYTES: 256 * 1024,

        // Leader election is gated on this — true so the orchestrator leads (and
        // wires reconciler/QueueEvents). A web replica (WORKER_MODE=disabled)
        // returns false and skips leadership (enqueue-only). A vi.fn so the
        // gating regression test can flip it.
        shouldStartWorkers: vi.fn(() => true),

        // connection.ts getQueueConnection() uses this flag to decide whether to
        // return plain options or a memoized IORedis instance. Tests default to
        // false to exercise the legacy per-connection-options path.
        FEATURE_SHARED_QUEUE_CONNECTION: false,

        dev: false,
    };
}

/**
 * The ONE `$lib/server/cache/valkey.js` mock for task-system test files.
 *
 * Same strict-mock hazard as `taskConfigMock()`, same drift history: the
 * excluded hard-kill file's private copy exported only `getValkeyClient`, so
 * once the orchestrator's import chain started reaching `publishMessage` the
 * file could not load at all. Add new valkey exports here, once.
 *
 *     vi.mock('$lib/server/cache/valkey.js', async () =>
 *         (await import('./__fixtures__/task-config-mock.js')).taskValkeyMock());
 */
export function taskValkeyMock() {
    return {
        getValkeyClient: vi.fn(() => null),
        getCoordinationClient: vi.fn(() => null),
        publishMessage: vi.fn(async () => true),
        // The unsubscribe handle must be ASYNC. The real signature is
        // `Promise<(() => Promise<void>) | null>`, and callers rely on that:
        // WebhookOutbox.stop() does `void unsub().catch(() => {})`. A sync
        // `() => {}` here returns undefined, so `.catch` throws a TypeError out
        // of stop() — a teardown failure that looks like a product bug but is
        // purely the mock disagreeing with the module it stands in for.
        subscribeToChannel: vi.fn(async () => async () => {}),
    };
}
