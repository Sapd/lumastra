// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Repro test for F20 — Default in-process execution with no auto-yield
 * causes heartbeat freezes.
 *
 * Finding: The runner does `await task.execute(ctx)` directly. CPU-bound
 * synchronous loops without internal `await` block the Node.js event loop.
 * `setInterval` for heartbeats and BullMQ lock renewal stall.
 * FEATURE_PLUGIN_WORKER_ISOLATION runs plugins in a Worker but is OFF by default.
 *
 * Citations: src/lib/server/tasks/runner.ts:1474-1490,
 *            src/lib/server/tasks/run-wrapper.ts:127-129,
 *            src/lib/server/tasks/runner.ts:1817
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        })),
    },
}));

describe('F20 — In-process task execution blocks the event loop by default', () => {
    it('FEATURE_PLUGIN_WORKER_ISOLATION should default to true', async () => {
        const { config } = await import('$lib/server/config.js');

        // The feature flag that would run CPU-heavy plugins in a Worker
        // thread (preventing event-loop starvation).
        const isolationEnabled = config.FEATURE_PLUGIN_WORKER_ISOLATION ?? false;

        // CORRECT behavior: Worker isolation should be enabled by default
        // so CPU-bound tasks don't block the event loop.
        // BUG: Worker isolation is disabled by default.
        expect(isolationEnabled).toBe(true);
    });

    it('runner still routes CPU-heavy tasks through the hard-killable worker-isolation path', () => {
        // The hard defense against a synchronous busy-loop wedge is running the
        // task in a node:worker_threads Worker the stall watchdog can terminate()
        // even through a blocked event loop. This asserts that machinery still
        // exists in the runner — guarding against a refactor that silently reverts
        // to a naked in-process `await task.execute()` with no hard-kill escape.
        //
        // (The previous version of this test asserted an EMPTY STRING did not
        // contain 'setImmediate' — an assertion that could never fail, giving
        // false coverage for exactly the regression it claimed to guard.)
        const runnerSource = readFileSync(new URL('./runner.ts', import.meta.url), 'utf8');

        // The isolated-execution path and its hard-kill must both be present.
        expect(runnerSource).toContain('executeIsolated');
        expect(runnerSource).toContain('.terminate(');
    });
});
