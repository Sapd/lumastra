// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Backpressure — per-class queue depth cap + per-task onQueueDepthOver.
//
// Called by the orchestrator before queue.add(). Three actions:
//   drop        — return {proceed: false}, caller logs and moves on
//   fail-fast   — throw BackpressureError with retryAfterMs, HTTP caller
//                 translates to 503 + Retry-After (Task Q)
//   shed-oldest — remove waiting jobs with priority >= 7 (downstream only),
//                 then allow if headroom opened; behave as 'drop' if not

import type { Queue } from 'bullmq';
import type { ResourceClass } from '@sapd/lumastra-plugin-sdk';
import { Logger } from '$lib/server/utils/logger.js';
import {
    LUMASTRA_QUEUE_DEPTH_CAP_ANALYSIS,
    LUMASTRA_QUEUE_DEPTH_CAP_BULK,
    LUMASTRA_QUEUE_DEPTH_CAP_CPU,
    LUMASTRA_QUEUE_DEPTH_CAP_DISCOVERY,
    LUMASTRA_QUEUE_DEPTH_CAP_EMBEDDING,
    LUMASTRA_QUEUE_DEPTH_CAP_INGEST,
    LUMASTRA_QUEUE_DEPTH_CAP_IO,
    LUMASTRA_QUEUE_DEPTH_CAP_MAINTENANCE,
} from '$lib/server/config.js';
import { errMessage } from './valkey-types.js';
import { recordBackpressure } from './observability/backpressure-buffer.js';

const log = Logger.for('Backpressure');

// ── Types ─────────────────────────────────────────────────────────────────────

export type BackpressureAction = 'drop' | 'fail-fast' | 'shed-oldest';

export interface BackpressureDecision {
    proceed: boolean;
    reason?: 'backpressure-drop' | 'backpressure-fail-fast' | 'backpressure-shed-oldest';
}

// ── BackpressureError ─────────────────────────────────────────────────────────

export class BackpressureError extends Error {
    constructor(public readonly retryAfterMs: number) {
        super('queue at capacity, retry after');
        this.name = 'BackpressureError';
    }
}

// ── Backpressure ──────────────────────────────────────────────────────────────

export class Backpressure {
    // Per-class depth cache for the per-task-queue path. Summing getJobCounts
    // across N per-task queues on every startRun would be N round-trips; a short
    // TTL bounds that. The flag-off single-queue path skips the cache entirely
    // so its behaviour is byte-for-byte unchanged.
    private readonly depthCache = new Map<ResourceClass, { value: number; expiresAt: number }>();
    private static readonly DEPTH_CACHE_TTL_MS = 5_000;

    constructor(
        private readonly getQueue: (cls: ResourceClass) => Queue,
        /**
         * Wave 8.5 (FEATURE_PER_TASK_QUEUES): when supplied, queue depth is
         * summed across every per-task queue in the class instead of read from
         * the single per-class queue (which is idle under the flag). Absent =
         * legacy per-class behaviour.
         */
        private readonly getClassQueues?: (cls: ResourceClass) => Queue[],
    ) {}

    /**
     * Called before enqueue. Returns {proceed: true} to allow, {proceed: false}
     * to drop, or throws BackpressureError for fail-fast.
     *
     * @param cls         Resource class of the task.
     * @param priority    BullMQ priority of the incoming job.
     * @param bp          Per-task backpressure config from the task manifest.
     */
    async check(
        cls: ResourceClass,
        priority: number,
        bp: { onQueueDepthOver: number; action: BackpressureAction } | undefined,
    ): Promise<BackpressureDecision> {
        if (!bp) return { proceed: true };

        const classCap = classCaps()[cls];
        const depth = await this.getDepth(cls);

        const over = depth >= classCap || depth >= bp.onQueueDepthOver;
        if (!over) return { proceed: true };

        log.warn('Backpressure triggered', {
            cls,
            depth,
            classCap,
            taskLimit: bp.onQueueDepthOver,
            action: bp.action,
            priority,
        });

        // Observability (Slice 0 §4.4): Prometheus inc + Valkey INCR on the hot
        // path. NO per-event Postgres — the reconciler rolls these up into one
        // audit row per window. Best-effort; never blocks the enqueue decision.
        recordBackpressure(cls, bp.action);

        switch (bp.action) {
            case 'fail-fast':
                throw new BackpressureError(5_000);

            case 'drop':
                return { proceed: false, reason: 'backpressure-drop' };

            case 'shed-oldest': {
                const shed = await this.shedOldest(cls);
                if (shed > 0) {
                    log.info('Backpressure shed oldest', { cls, shed });
                    const newDepth = await this.getDepth(cls);
                    if (newDepth < classCap && newDepth < bp.onQueueDepthOver) {
                        return { proceed: true };
                    }
                }
                return { proceed: false, reason: 'backpressure-shed-oldest' };
            }
        }
    }

    // -- Private helpers ------------------------------------------------------

    private async getDepth(cls: ResourceClass): Promise<number> {
        // Per-task path: sum across the class's per-task queues, cached briefly.
        if (this.getClassQueues) {
            const cached = this.depthCache.get(cls);
            const now = Date.now();
            if (cached && cached.expiresAt > now) return cached.value;
            const queues = this.getClassQueues(cls);
            let total = 0;
            for (const queue of queues) {
                try {
                    const counts = await queue.getJobCounts('waiting', 'prioritized', 'delayed');
                    total +=
                        (counts.waiting ?? 0) + (counts.prioritized ?? 0) + (counts.delayed ?? 0);
                } catch {
                    // Best-effort — a transiently-unavailable queue contributes 0
                    // rather than failing the whole backpressure check.
                }
            }
            this.depthCache.set(cls, {
                value: total,
                expiresAt: now + Backpressure.DEPTH_CACHE_TTL_MS,
            });
            return total;
        }
        // Legacy per-class path — unchanged.
        const queue = this.getQueue(cls);
        const counts = await queue.getJobCounts('waiting', 'prioritized', 'delayed');
        return (counts.waiting ?? 0) + (counts.prioritized ?? 0) + (counts.delayed ?? 0);
    }

    /**
     * Remove waiting jobs with priority >= 7 (downstream, non-critical).
     * Never removes priority 1 (admin) or priority 5 (scheduler/manual).
     * Returns the number of jobs removed.
     */
    private async shedOldest(cls: ResourceClass): Promise<number> {
        // Per-task path sheds across every queue in the class; legacy path the
        // single class queue. Either way, drop the cached depth so the post-shed
        // recheck in check() reads fresh counts instead of the pre-shed value.
        this.depthCache.delete(cls);
        const queues = this.getClassQueues ? this.getClassQueues(cls) : [this.getQueue(cls)];
        let removed = 0;
        for (const queue of queues) {
            try {
                // Fetch up to 100 jobs from both 'waiting' and 'prioritized' states
                // (ascending = oldest first). BullMQ stores jobs with explicit
                // priority in 'prioritized', so 'waiting' alone misses them and the
                // shed becomes a no-op for the only jobs we're allowed to shed.
                const jobs = await queue.getJobs(['waiting', 'prioritized'], 0, 100, true);
                for (const job of jobs) {
                    // opts.priority may be undefined for default-priority jobs; treat as 5.
                    const p = job.opts?.priority ?? 5;
                    if (p >= 7) {
                        try {
                            await job.remove();
                            removed++;
                        } catch {
                            // Job may have been picked up between fetch and remove — ignore.
                        }
                    }
                }
            } catch (err) {
                log.warn('Backpressure shedOldest failed', {
                    cls,
                    err: errMessage(err),
                });
            }
        }
        return removed;
    }
}

// ── Per-class depth caps ──────────────────────────────────────────────────────

// A function, not a snapshot: the caps are live config bindings, so a saved
// change applies to the next depth check without a restart.
const classCaps = (): Record<ResourceClass, number> => ({
    cpu: LUMASTRA_QUEUE_DEPTH_CAP_CPU,
    io: LUMASTRA_QUEUE_DEPTH_CAP_IO,
    embedding: LUMASTRA_QUEUE_DEPTH_CAP_EMBEDDING,
    maintenance: LUMASTRA_QUEUE_DEPTH_CAP_MAINTENANCE,
    ingest: LUMASTRA_QUEUE_DEPTH_CAP_INGEST,
    bulk: LUMASTRA_QUEUE_DEPTH_CAP_BULK,
    analysis: LUMASTRA_QUEUE_DEPTH_CAP_ANALYSIS,
    discovery: LUMASTRA_QUEUE_DEPTH_CAP_DISCOVERY,
});
