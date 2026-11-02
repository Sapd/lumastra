// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Microbenchmark for buildPluginContext throughput.
 *
 * Context: Phase 3 review flagged that the scanner constructs a fresh
 * PluginContext per invokeProvider* call. Worst case is ~3 calls per file
 * over a 5k-file library = 15k contexts. The cost analysis below shows
 * this is sub-second on any modern CPU; the benchmark is here as a guard
 * against future regressions (e.g., if buildHttpClient grows expensive
 * setup logic, this test will surface it).
 *
 * Per-call cost breakdown:
 *   - getDb() — memoised singleton, returns a captured Sql handle.
 *   - Logger.for('Provider').child(pluginId) — Map.get + new LoggerInstance.
 *   - adaptLogger() — 5 closures + 1 object literal.
 *   - getSecretsStore(sql) — memoised by sql handle (same identity ↔ same store).
 *   - new AbortController() — 2 allocations.
 *   - registry.getProvider(pluginId) — Map.get O(1).
 *   - buildHttpClient(...) — 2 closures + 1 object.
 *   - buildNamespacedCache(...) — 3 closures + 1 object.
 *   - Return: 1 object literal with 6 fields.
 *
 * Threshold: 50µs of CPU/construction = 20k ops/CPU-second. A 15k-context scan costs
 * ~750ms of CPU purely from context overhead — negligible relative to the
 * thousands of HTTP round-trips it serves. If this test fails, the per-call
 * cost has regressed and a withPluginContext(pluginId, fn) cache may be
 * warranted. Measure process CPU time so time spent descheduled behind other
 * CI jobs does not look like a construction-cost regression. Wall throughput
 * is still logged, but is not an invariant of this synchronous function.
 */

import { describe, it, expect } from 'vitest';
import { buildPluginContext } from './plugin-context.js';

describe.skipIf(!process.env.LUMASTRA_BENCH_TEST)('buildPluginContext microbenchmark', () => {
    it('constructs >20k contexts per CPU-second on a warm process', () => {
        // Warm up V8 — first 200 ops include inlining + cache fills.
        for (let i = 0; i < 200; i++) {
            buildPluginContext('tmdb-metadata-provider');
        }

        const N = 5000;
        const start = process.hrtime.bigint();
        const cpuStart = process.cpuUsage();
        for (let i = 0; i < N; i++) {
            buildPluginContext('tmdb-metadata-provider');
        }
        const elapsedNs = Number(process.hrtime.bigint() - start);
        const cpu = process.cpuUsage(cpuStart);
        const perOpNs = ((cpu.user + cpu.system) * 1000) / N;
        const opsPerSec = (N / elapsedNs) * 1e9;

        // 50µs/op threshold — see header for sizing rationale.
        // On a 2024 mac/linux box this lands at ~5-15µs/op (60k-200k ops/sec).
        // CPU time includes allocation/GC and system work, but excludes the
        // scheduler wait that made the wall-time assertion fail under load.
        expect(perOpNs).toBeLessThan(50_000);

        // Log for human inspection.
        console.log(
            `[bench] buildPluginContext: ${perOpNs.toFixed(0)} CPU ns/op (${opsPerSec.toFixed(0)} wall ops/sec, ${N} samples)`,
        );
    });
});
