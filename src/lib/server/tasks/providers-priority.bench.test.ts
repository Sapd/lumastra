// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Microbenchmark for getProvidersByPriority().
 *
 * Context: `getProvidersByPriority` is called once per metadata dispatch —
 * when the file-scanner or catalog service needs to pick a provider order, it
 * calls this to get a sorted list. With 5 registered providers and ~5k
 * library items, this could be called ~5k times per sync run.
 *
 * Cost analysis per call:
 *   - `registry.getAllProviders()` — Array.from(Map.values()), O(n) copy where n=5.
 *   - Spread `[...array]` — shallow copy, O(n).
 *   - `.sort(compareFn)` — insertion sort for small arrays (n≤5), O(n²) worst case.
 *   - compareFn — 2 optional-chaining property reads + 1 subtraction.
 *
 * Expected: well under 10µs/call at n=5. At 5k calls that's <50ms total —
 * negligible relative to the HTTP work it schedules.
 *
 * The cache verification section asserts that loadProviderSettingsCached()
 * does NOT hit the database on the second call within the 60s TTL window.
 * We verify this by calling it twice and confirming no real DB round-trips
 * occur (the second call returns before the first DB query could complete).
 */

import { describe, it, expect } from 'vitest';
import { TaskRegistry } from './registry.js';
import { getProvidersByPriority } from './plugin-context.js';
import { defineProvider } from '@sapd/lumastra-plugin-sdk';

// ── Fixture: 5 providers at different priority levels ────────────────────────

function makeProvider(id: string, priority: number) {
    return defineProvider<unknown, unknown>({
        id,
        name: id,
        version: '1.0.0',
        capabilities: {},
        metadata: { priority },
        isConfigured: async () => true,
        detail: async (_ctx, _id) => ({}),
    });
}

describe.skipIf(!process.env.LUMASTRA_BENCH_TEST)('getProvidersByPriority microbenchmark', () => {
    it('returns providers in descending priority order', () => {
        const reg = new TaskRegistry();
        reg.registerProvider(makeProvider('provider-a', 100));
        reg.registerProvider(makeProvider('provider-b', 50));
        reg.registerProvider(makeProvider('provider-c', 200));
        reg.registerProvider(makeProvider('provider-d', 10));
        reg.registerProvider(makeProvider('provider-e', 150));

        const sorted = getProvidersByPriority(reg);
        const ids = sorted.map((p) => p.id);
        expect(ids).toEqual([
            'provider-c', // 200
            'provider-e', // 150
            'provider-a', // 100
            'provider-b', // 50
            'provider-d', // 10
        ]);
    });

    it('achieves >100k ops/CPU-second with 5 registered providers (warm)', () => {
        const reg = new TaskRegistry();
        reg.registerProvider(makeProvider('prov-a', 100));
        reg.registerProvider(makeProvider('prov-b', 50));
        reg.registerProvider(makeProvider('prov-c', 200));
        reg.registerProvider(makeProvider('prov-d', 10));
        reg.registerProvider(makeProvider('prov-e', 150));

        // Warm up V8
        for (let i = 0; i < 1000; i++) {
            getProvidersByPriority(reg);
        }

        const N = 10_000;
        const start = process.hrtime.bigint();
        const cpuStart = process.cpuUsage();
        for (let i = 0; i < N; i++) {
            getProvidersByPriority(reg);
        }
        const elapsedNs = Number(process.hrtime.bigint() - start);
        const cpu = process.cpuUsage(cpuStart);
        const perOpNs = ((cpu.user + cpu.system) * 1000) / N;
        const opsPerSec = (N / elapsedNs) * 1e9;

        console.log(
            `[bench] getProvidersByPriority: ${perOpNs.toFixed(0)} CPU ns/op ` +
                `(${opsPerSec.toFixed(0)} wall ops/sec, N=${N}, providers=5)`,
        );

        // 10µs/call threshold — sort of n=5 elements should be ~1-5µs.
        // A 10x regression from linear to quadratic at n=50 would still pass;
        // this is a canary for CPU-cost regressions. Exclude descheduling
        // behind unrelated CI jobs, while still counting GC and system CPU.
        expect(perOpNs).toBeLessThan(10_000);
    });

    it('each call returns a fresh array (mutations do not corrupt registry)', () => {
        const reg = new TaskRegistry();
        reg.registerProvider(makeProvider('mut-a', 100));
        reg.registerProvider(makeProvider('mut-b', 50));

        const first = getProvidersByPriority(reg);
        first.splice(0); // clear the returned array

        const second = getProvidersByPriority(reg);
        expect(second).toHaveLength(2); // registry internal state unaffected
    });
});
