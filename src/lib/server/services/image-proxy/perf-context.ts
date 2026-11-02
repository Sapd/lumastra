// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Request-scoped timing context for image-proxy diagnostics.
 *
 * Uses AsyncLocalStorage so deeply nested provider/cache calls can record
 * their elapsed time without threading a context object through every API.
 * Outside a `runPerf(...)` scope, `recordPhase`/`timePhase` degrade to
 * cheap no-ops — no allocation, no logging.
 *
 * Buckets are intentionally coarse (provider lookup, upstream fetch, sharp
 * transcode, cache read/write) so the resulting log lines stay grep-able
 * and one bucket clearly dominates when something regresses.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface ImagePerfContext {
    phases: Record<string, number>;
}

const storage = new AsyncLocalStorage<ImagePerfContext>();

export function runPerf<T>(fn: () => Promise<T>): {
    result: Promise<T>;
    context: ImagePerfContext;
} {
    const context: ImagePerfContext = { phases: {} };
    const result = storage.run(context, fn);
    return { result, context };
}

/** Add elapsed milliseconds to a named phase bucket. No-op outside a perf scope. */
export function recordPhase(name: string, ms: number): void {
    const ctx = storage.getStore();
    if (!ctx) return;
    ctx.phases[name] = (ctx.phases[name] ?? 0) + Math.max(0, Math.round(ms));
}

/** Measure how long `fn` takes and record it under `name`. */
export async function timePhase<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const ctx = storage.getStore();
    if (!ctx) return fn();
    const start = performance.now();
    try {
        return await fn();
    } finally {
        recordPhase(name, performance.now() - start);
    }
}
