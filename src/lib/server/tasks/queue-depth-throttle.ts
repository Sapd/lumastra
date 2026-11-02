// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared queue-depth throttle thresholds + the "which classes are over depth"
 * derivation. Both the periodic `stage-sweep` enqueue loop AND the eager-enqueue
 * fast path (`StageStateService.eagerEnqueueForStages`) consult this, so the
 * eager path can't bypass the voluntary back-off the sweep enforces — a burst of
 * invalidations (each eager-enqueueing ~15 stages) would otherwise flood a class
 * queue straight past the sweep's throttle.
 *
 * A skipped enqueue is never lost work: the coverage row is already `pending`, so
 * the next sweep tick picks it up once the class queue drains below threshold.
 */

/**
 * Per-resource-class queue-depth thresholds. When the BullMQ waiting + delayed
 * count for a class is at or above its threshold, callers skip enqueueing more
 * work for that class and let the workers drain what's already queued. The
 * thresholds sit BELOW the per-task backpressure caps in config.ts
 * (LUMASTRA_QUEUE_DEPTH_CAP_*) so backpressure stays a hard ceiling and these
 * callers voluntarily back off well before it.
 *
 * NOTE: kept as `Record<string, number>` rather than a `ResourceClass`-keyed
 * type — existing callers (e.g. `stage-sweep.ts`) index this map with a plain
 * `string` (BullMQ class names surfaced at runtime, not the SDK union type),
 * so tightening the type here would force unrelated churn there. The
 * exhaustiveness guarantee a keyed type would give is instead enforced by
 * `queue-depth-throttle.test.ts`, which asserts every `RESOURCE_CLASSES`
 * member has an entry.
 */
export const QUEUE_DEPTH_SKIP_THRESHOLD: Record<string, number> = {
    cpu: 300, // cap is 500
    io: 1500, // cap is 2000
    embedding: 5000, // cap is 10000
    maintenance: 60, // cap is 100
    // analysis/ingest/bulk/discovery are slow-consuming or bursty classes that
    // stage-sweep can flood well past a sensible steady-state depth. Without a
    // skip threshold here their queues grow unbounded during a bulk
    // stage-state migration. Each sits ~60% of its LUMASTRA_QUEUE_DEPTH_CAP_*
    // hard cap so callers voluntarily back off well before backpressure.
    ingest: 30000, // cap is 50000 (fresh-scan fast path enqueues tens of thousands)
    bulk: 1500, // cap is 2000 (API-bound enrichment, hours per pass)
    analysis: 300, // cap is 500 (ffmpeg/chromaprint, ~16 items/hour)
    discovery: 6000, // cap is 10000 (fresh-install discovery-embeddings flood)
};

/** Minimal shape of one class's depth counts (subset of `getQueueDepths`). */
export interface QueueDepthCounts {
    waiting?: number;
    delayed?: number;
    [key: string]: number | boolean | undefined;
}

/**
 * Resource classes whose queued depth (waiting + delayed) is at or above the
 * voluntary skip threshold. A class with no threshold entry is never reported
 * (proceed normally). An empty input map (orchestrator not initialized in this
 * process) yields an empty set — i.e. "no depth info, don't throttle".
 */
export function classesOverDepthThreshold(
    queueDepths: Record<string, QueueDepthCounts>,
): Set<string> {
    const over = new Set<string>();
    for (const [cls, counts] of Object.entries(queueDepths)) {
        const threshold = QUEUE_DEPTH_SKIP_THRESHOLD[cls];
        if (typeof threshold !== 'number') continue;
        const depth = (counts.waiting ?? 0) + (counts.delayed ?? 0);
        if (depth >= threshold) over.add(cls);
    }
    return over;
}
