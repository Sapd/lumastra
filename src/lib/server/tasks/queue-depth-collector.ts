// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// queue-depth-collector.ts - queue depth on the web /metrics endpoint.
//
// Only the coordinator replica of the dedicated worker publishes
// lumastra_task_queue_depth. When no worker is running that gauge is empty, and
// an operator sees "no backlog" exactly when jobs pile up unprocessed. The web
// process can read the same BullMQ counts, so it refreshes the gauge at scrape
// time, at most once per CACHE_MS and only when it is not itself the worker.

import { shouldStartWorkers } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { taskQueueDepth } from './metrics.js';

const log = Logger.for('QueueDepthCollector');
const CACHE_MS = 15_000;
const TIMEOUT_MS = 2_000;

let lastRefresh = 0;
let inFlight: Promise<void> | undefined;

async function refresh(): Promise<void> {
    const { getOrchestrator } = await import('./orchestrator.js');
    const orchestrator = await getOrchestrator();
    const depths = await orchestrator.getQueueDepths();
    // Drop series for classes that vanished so a stale non-zero depth cannot persist.
    taskQueueDepth.reset();
    for (const [cls, depth] of Object.entries(depths)) {
        taskQueueDepth.set({ queue: `task:${cls}`, resource_class: cls }, depth.waiting);
    }
}

/** Never throws and never waits longer than TIMEOUT_MS; stale gauges are better than a failed scrape. */
export async function refreshQueueDepthMetrics(now: number = Date.now()): Promise<void> {
    try {
        if (shouldStartWorkers()) return;
        if (inFlight) {
            await inFlight;
            return;
        }
        if (now - lastRefresh < CACHE_MS) return;
        lastRefresh = now;
        let timer: ReturnType<typeof setTimeout> | undefined;
        inFlight = Promise.race([
            refresh(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error('queue depth timeout')), TIMEOUT_MS);
            }),
        ])
            .catch((err: unknown) => {
                log.debug('Queue depth refresh failed', { error: String(err) });
            })
            .finally(() => {
                clearTimeout(timer);
                inFlight = undefined;
            });
        await inFlight;
    } catch {
        // config mocks / not-yet-initialised runtime: the scrape must still succeed
    }
}

/** Test-only. */
export function resetQueueDepthCollector(): void {
    lastRefresh = 0;
    inFlight = undefined;
}
