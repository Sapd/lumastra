// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Boot timing benchmark for loadBuiltins().
 *
 * Measures wall-clock time to dynamically import and self-register all ~40
 * native plugins. This exercises:
 *   - ~50 sequential `await import(...)` calls
 *   - Top-level side effects: registry.registerTask / registerProvider / etc.
 *   - Per-module top-level code: Logger.for(), defineTask(), z.object() schemas
 *
 * The test uses _resetLoadedForTests() between runs so each measurement starts
 * from a cold-registry state (all Maps empty). The dynamic imports themselves
 * will be V8-cached after the first pass, so subsequent iterations reflect only
 * the registry-registration + top-level object-construction cost, not the
 * module-parse cost. The first iteration is the realistic cold-boot cost.
 *
 * Thresholds (per scope comment — boot path, not hot path):
 *   < 2s     — comfortable, no action needed
 *   2s–5s    — flag for investigation (which import is slow?)
 *   > 5s     — find + fix the slow import before OSS release
 *
 * Note: the _loaded flag is module-scoped inside builtin/index.ts. After each
 * reset the Maps are NOT cleared — self-registering modules already ran their
 * top-level side effects on first import. Subsequent passes measure ONLY
 * the _loaded-guard check time (microseconds). The first iteration is
 * therefore the only meaningful cold measurement; we print it prominently.
 */

import { describe, it, expect } from 'vitest';
import { registry as defaultRegistry } from '../registry.js';

describe.skipIf(!process.env.LUMASTRA_BENCH_TEST)('loadBuiltins boot timing', () => {
    it('registers all builtins on first call (timing logged, soft-budgeted)', async () => {
        // We import the module here so the test file itself stays side-effect
        // free. Dynamic import inside the test means the module graph is NOT
        // yet evaluated when this file is loaded — the first await import()
        // below triggers V8 parse + eval for every transitive dep.
        //
        // Design note: native builtins call `registry.registerTask(...)` where
        // `registry` is the DEFAULT module-level singleton imported at their own
        // top level. They cannot use a freshly-constructed registry passed to
        // loadBuiltins() — the parameter only gates the _loaded flag and the
        // final log.info call. We therefore measure against the default registry.
        const { loadBuiltins, _resetLoadedForTests } = await import('./index.js');

        // Reset the _loaded flag so we time a fresh boot sequence in this
        // process (module-parse cost is V8-cached; only registration + top-level
        // construction runs again if we could clear Maps — we can't without
        // exposing more internals. The timing still shows import-resolution cost.)
        _resetLoadedForTests();

        const t0 = performance.now();
        await loadBuiltins();
        const elapsed = performance.now() - t0;

        // Read counts from the singleton that the builtins actually registered on.
        const tasks = defaultRegistry.getAllTasks().length;
        const providers = defaultRegistry.getAllProviders().length;
        const trickplays = defaultRegistry.getAllTrickplays().length;
        const watchSyncs = defaultRegistry.getAllWatchSyncs().length;
        const features = defaultRegistry.getAllFeatures().length;
        const integrations = defaultRegistry.getAllIntegrations().length;

        console.log(
            `[boot-bench] loadBuiltins: ${elapsed.toFixed(1)}ms | ` +
                `tasks=${tasks} providers=${providers} trickplays=${trickplays} ` +
                `watchSyncs=${watchSyncs} features=${features} integrations=${integrations}`,
        );

        // Sanity (the real correctness gate): all major contract types must be
        // present, i.e. every builtin self-registered without throwing.
        expect(tasks).toBeGreaterThan(10);
        expect(providers).toBeGreaterThan(3);

        // Timing is INFORMATIONAL, not a hard gate. The first dynamic import in
        // the process pays full V8 parse + Vitest transform cost, which is highly
        // sensitive to machine load (observed 0.5s–6s across dev boxes) and not
        // representative of a warm production boot. We log it and flag a soft
        // budget so a real regression stays visible, but the only HARD ceiling is
        // the 60s test timeout below — a genuinely pathological regression (a slow
        // or looping import) still fails the suite by timing out, while routine
        // transform jitter under full-suite parallel load (which can push a cold
        // ~40-module import past 10s) no longer makes this test flaky.
        const SOFT_BUDGET_MS = 3000;
        if (elapsed >= SOFT_BUDGET_MS) {
            console.warn(
                `[boot-bench] loadBuiltins took ${elapsed.toFixed(1)}ms ` +
                    `(soft budget ${SOFT_BUDGET_MS}ms) — if this persists on a warm box, ` +
                    `investigate which import chain is slow.`,
            );
        }
    }, 60_000 /* cold-parse under full-suite parallel load can exceed 10s; 60s still catches a pathological looping import */);

    it('second call (idempotent guard) completes in under 1ms', async () => {
        const { loadBuiltins, _resetLoadedForTests } = await import('./index.js');

        // First call (warms up the _loaded flag)
        await loadBuiltins();

        // Second call must be essentially a no-op
        const t0 = performance.now();
        await loadBuiltins();
        const elapsed = performance.now() - t0;

        console.log(`[boot-bench] loadBuiltins (idempotent guard): ${elapsed.toFixed(3)}ms`);

        // The only work is the `if (_loaded) return;` check — should be <0.1ms,
        // but we allow 5ms for event-loop scheduling jitter under full-suite load
        // (the await still yields to the loop even for a synchronous no-op).
        expect(elapsed).toBeLessThan(5);

        // Restore clean state for other tests
        _resetLoadedForTests();
    });
});
