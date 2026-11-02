// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// orphan-sweep.ts — stuck waiting-children parent drain.
//
// Plan §10.3: for each `waiting-children` BullMQ job, read its `:dependencies`
// ZSET. If ALL dependencies are gone (children completed-and-removed or
// failed-and-removed), the parent is stuck and will never self-advance.
// Force-complete it via `moveToCompleted` with a sentinel result.
//
// BullMQ stores dependency tracking in two ZSETs per job:
//   bull:<queue>:<jobId>:dependencies   — parent→child edge keys, format:
//                                         "bull:<childQueue>:<childJobId>"
//   bull:<queue>:<jobId>:processed      — entries cleared after child resolves
//
// A parent is orphaned when EVERY key in `:dependencies` refers to a job that
// no longer exists in BullMQ (neither in active, waiting, completed, nor failed
// state). We check existence via `queue.getJob(childId)`.
//
// This replaces `stale-job-cleanup.ts` (old system).

import type { Queue } from 'bullmq';
import type postgres from 'postgres';
import type { AuthorityToken } from '../../../task-runtime/authority/store.js';
import { withTaskQueueWrite } from '../../../task-runtime/authority/queue-write.js';
import { assertTaskJobOrigin } from '../../../task-runtime/authority/queue-origin.js';
import { captureValkeyAuthority } from './lua/fenced.js';
import type { ResourceClass } from '@sapd/lumastra-plugin-sdk';
import { RESOURCE_CLASSES } from '@sapd/lumastra-plugin-sdk';
import {
    PER_TASK_QUEUE_PREFIX,
    QUEUE_PREFIX,
    perTaskQueueQualifiedName,
    taskQueueQualifiedName,
} from './queue-naming.js';
import { Logger } from '$lib/server/utils/logger.js';
import { type ValkeyLike } from './valkey-types.js';

const log = Logger.for('OrphanSweep');

// All 7 SDK resource classes — sourced from the SDK so a new class can't be
// silently skipped by the per-class sweep (external plugins may declare
// 'ingest' / 'bulk' / 'analysis').
const ALL_CLASSES: ResourceClass[] = [...RESOURCE_CLASSES];

/**
 * Wave 8.5 per-task-queue mode for OrphanSweep. When supplied, the sweep walks
 * per-task queues (`bull:task:t:<taskId>`) instead of the four physical class
 * queues, and dependency-key parsing resolves child queues by taskId. Absent =
 * legacy per-class behaviour.
 */
export interface OrphanSweepPerTask {
    /** All registered tasks whose per-task queues should be swept. */
    tasks: () => string[];
    /** Resolve a task's per-task Queue (the same handle producers enqueue on). */
    getQueueByTaskId: (taskId: string) => Queue | undefined;
}

// ── OrphanSweep ───────────────────────────────────────────────────────────────

export class OrphanSweep {
    private readonly authority: Readonly<AuthorityToken> | undefined;

    constructor(
        private readonly getQueue: (cls: ResourceClass) => Queue | undefined,
        private readonly getClient: () => Promise<ValkeyLike>,
        private readonly perTask?: OrphanSweepPerTask,
        authority?: AuthorityToken,
        private readonly getSql: () => postgres.Sql | null = () => null,
    ) {
        this.authority = captureValkeyAuthority(authority);
    }

    /**
     * Scan all queues for waiting-children parents whose dependencies are all
     * gone. Force-completes stuck parents. Walks per-task queues when the
     * per-task config is supplied, else the four physical class queues.
     */
    async run(): Promise<{ swept: number; queuesScanned: number }> {
        let swept = 0;
        let queuesScanned = 0;

        const targets: Array<{ qualifiedName: string; queue: Queue }> = [];
        if (this.perTask) {
            for (const taskId of this.perTask.tasks()) {
                const queue = this.perTask.getQueueByTaskId(taskId);
                if (queue)
                    targets.push({
                        qualifiedName: perTaskQueueQualifiedName(taskId),
                        queue,
                    });
            }
        } else {
            for (const cls of ALL_CLASSES) {
                const queue = this.getQueue(cls);
                if (queue)
                    targets.push({
                        qualifiedName: taskQueueQualifiedName(cls),
                        queue,
                    });
            }
        }

        for (const { qualifiedName, queue } of targets) {
            queuesScanned++;
            try {
                swept += await this.sweepQueue(qualifiedName, queue);
            } catch (err) {
                log.warn('OrphanSweep: queue sweep failed', {
                    queue: queue.name,
                    err: err instanceof Error ? err.message : String(err),
                });
            }
        }

        if (swept > 0) {
            log.info('OrphanSweep: completed', { swept, queuesScanned });
        }

        return { swept, queuesScanned };
    }

    // -- private ---------------------------------------------------------------

    private async sweepQueue(qualifiedName: string, queue: Queue): Promise<number> {
        let swept = 0;

        // F5.1: page through ALL waiting-children jobs, not just the first 500.
        // A single getJobs(0, 500) silently ignored everything past index 500, so
        // a queue with thousands of waiting-children parents would never drain its
        // tail.
        //
        // Review R3: COLLECT every page read-only FIRST, then sweep. Sweeping
        // (moveToCompleted) removes the parent from the waiting-children set, so
        // paginating by absolute offset WHILE sweeping would shift later jobs down
        // and skip them within the same tick. Decoupling the paged read from the
        // mutation eliminates that. We still bound the read to MAX_PAGES so the
        // per-tick Redis/CPU cost is capped; a still-full final page is warned so
        // truncation is never silent.
        const PAGE = 500;
        const MAX_PAGES = 20; // cap: 20 * 500 = 10k waiting-children jobs per tick
        const candidates: Awaited<ReturnType<Queue['getJobs']>> = [];
        let start = 0;
        let truncated = false;

        for (let page = 0; page < MAX_PAGES; page++) {
            let jobs: Awaited<ReturnType<Queue['getJobs']>>;
            try {
                jobs = await queue.getJobs(['waiting-children'], start, start + PAGE - 1);
            } catch (err) {
                log.warn('OrphanSweep: getJobs failed', {
                    queue: queue.name,
                    start,
                    err: err instanceof Error ? err.message : String(err),
                });
                break;
            }
            for (const job of jobs) {
                if (job && job.id) candidates.push(job);
            }
            // A short page is the end-of-set signal — a clean finish, no warn.
            if (jobs.length < PAGE) break;
            start += PAGE;
            // The LAST allowed page came back full → there may be more we won't
            // inspect this tick. (Only this case is genuine truncation.)
            if (page === MAX_PAGES - 1) truncated = true;
        }

        if (truncated) {
            // Hit the page cap with the last page still full → there are more
            // waiting-children than we inspect per tick. Warn so it's not a silent
            // truncation; the next tick resumes from the front (swept parents have
            // left the set by then, so the tail migrates forward over ticks).
            log.warn(
                'OrphanSweep: waiting-children page cap reached — queue has more than per-tick cap',
                {
                    queue: queue.name,
                    inspectedUpTo: start,
                    maxPerTick: MAX_PAGES * PAGE,
                },
            );
        }

        // Now sweep the collected candidates. moveToCompleted mutates the set,
        // but we are no longer paginating by offset, so a removed entry can't
        // shift another out of view.
        for (const job of candidates) {
            const jobId = job.id;
            if (!jobId) continue;
            try {
                const orphaned = await this.isOrphanedParent(qualifiedName, jobId);
                if (!orphaned) continue;

                log.info('OrphanSweep: force-completing orphaned waiting-children parent', {
                    queue: queue.name,
                    jobId,
                    jobName: job.name,
                });

                // moveToCompleted(returnValue, token, removeOnComplete)
                // We pass a sentinel returnValue; token is not required when
                // called from outside the worker context (BullMQ allows it
                // with undefined/null token for admin paths).
                assertTaskJobOrigin(this.authority, job.data?.taskAuthority, jobId);
                await withTaskQueueWrite(
                    this.getSql(),
                    this.authority,
                    { kind: 'orphan-complete', queue: qualifiedName, jobId },
                    async () => {
                        await job.moveToCompleted({ orphanSweep: true }, '', false);
                    },
                    { allowDraining: true },
                );
                swept++;
            } catch (err) {
                log.warn('OrphanSweep: failed to sweep job', {
                    queue: queue.name,
                    jobId,
                    err: err instanceof Error ? err.message : String(err),
                });
            }
        }

        return swept;
    }

    /**
     * A parent is orphaned when its `:dependencies` ZSET is non-empty but every
     * referenced child job no longer exists in BullMQ.
     *
     * Returns false when:
     *   - `:dependencies` is empty (no deps — not a waiting-children situation)
     *   - at least one child job still exists
     *
     * Returns true when:
     *   - `:dependencies` has entries AND every entry's child job is gone
     */
    private async isOrphanedParent(qualifiedName: string, jobId: string): Promise<boolean> {
        const client = await this.getClient();

        // Read the `:dependencies` SET. NB: BullMQ 5.x stores this as a SET
        // (SADD parentKey..':dependencies'), NOT a ZSET — ZRANGE on it raises
        // WRONGTYPE, which the catch below swallowed, making orphan detection a
        // permanent no-op. SMEMBERS returns the same flat member list.
        // The full Redis key is `<qualifiedName>:<jobId>:dependencies`.
        // qualifiedName is `bull:task:<cls>` (per-class) or `bull:task:t:<taskId>`
        // (per-task) — both produced by the queue-naming helpers.
        const depsKey = `${qualifiedName}:${jobId}:dependencies`;

        let depEntries: string[];
        try {
            const raw = await client.customCommand(['SMEMBERS', depsKey]);
            depEntries = parseZRangeResult(raw);
        } catch (err) {
            log.warn('OrphanSweep: SMEMBERS failed', {
                depsKey,
                err: err instanceof Error ? err.message : String(err),
            });
            return false;
        }

        if (depEntries.length === 0) {
            // No tracked dependencies — could be a different state or already
            // cleaned up. Don't force-complete; let BullMQ handle it.
            return false;
        }

        // Check each dependency. If any child still exists → not orphaned.
        for (const entry of depEntries) {
            const alive = await this.childJobExists(entry);
            if (alive) return false;
        }

        // All dependencies gone → parent is stuck.
        return true;
    }

    /**
     * Parse a dependency entry and check if the child job exists.
     *
     * Per-class entry: `bull:task:<cls>:<jobId>` → scan the 4 class prefixes.
     * Per-task entry:  `bull:task:t:<childTaskId>:<jobId>` → the first segment
     * after the `bull:task:t` prefix is the child taskId (colon-free, validated
     * at registration), the remainder is the jobId (jobIds use `~~`/`#`, never
     * `:`). We must check the per-task prefix FIRST because `bull:task:t:…` also
     * starts with `bull:task:` and would otherwise be mis-parsed as class "t".
     */
    private async childJobExists(entry: string): Promise<boolean> {
        if (this.perTask) {
            const prefix = `${PER_TASK_QUEUE_PREFIX}:`; // "bull:task:t:"
            if (entry.startsWith(prefix)) {
                const rest = entry.slice(prefix.length);
                const sep = rest.indexOf(':');
                if (sep > 0) {
                    const childTaskId = rest.slice(0, sep);
                    const childJobId = rest.slice(sep + 1);
                    if (childTaskId && childJobId) {
                        const childQueue = this.perTask.getQueueByTaskId(childTaskId);
                        if (childQueue) {
                            try {
                                const job = await childQueue.getJob(childJobId);
                                return job !== null && job !== undefined;
                            } catch {
                                return false;
                            }
                        }
                        // F5.2: well-formed entry but the child task's queue is
                        // not registered this boot (deleted/unloaded plugin).
                        // Previously this fell through to `return true` (assume
                        // alive), permanently wedging any parent waiting on a
                        // deleted-plugin child. Probe Redis ground truth instead:
                        // the dependency entry IS the child's BullMQ job-hash key
                        // (`bull:task:t:<taskId>:<jobId>`), so EXISTS on `entry`
                        // tells us whether the job genuinely still exists.
                        return await this.childKeyExistsInRedis(entry);
                    }
                }
            }
            // Truly unparseable per-task entry (no prefix / empty taskId or
            // jobId) — assume alive to avoid false positives.
            log.warn('OrphanSweep: unrecognized per-task dependency entry format', { entry });
            return true;
        }

        for (const cls of ALL_CLASSES) {
            const queuePrefix = `${QUEUE_PREFIX}:${cls}:`; // e.g. "bull:task:io:"
            if (entry.startsWith(queuePrefix)) {
                const childJobId = entry.slice(queuePrefix.length);
                if (!childJobId) continue;
                const childQueue = this.getQueue(cls);
                if (!childQueue) {
                    // F5.2: well-formed per-class entry but that class queue is
                    // not registered this boot. Same wedge as the per-task gap —
                    // probe Redis ground truth (the entry is the job-hash key)
                    // rather than blindly assuming the child is alive.
                    return await this.childKeyExistsInRedis(entry);
                }
                try {
                    const job = await childQueue.getJob(childJobId);
                    return job !== null && job !== undefined;
                } catch {
                    return false;
                }
            }
        }

        // Unknown queue format — assume alive to avoid false positives.
        log.warn('OrphanSweep: unrecognized dependency entry format', {
            entry,
        });
        return true;
    }

    /**
     * F5.2: EXISTS-probe a child job-hash key directly via the sweep's Redis
     * client (the same `getClient()` handle isOrphanedParent uses for SMEMBERS).
     *
     * A BullMQ dependency entry is the child job's hash key verbatim
     * (`bull:task:t:<taskId>:<jobId>` per-task, `bull:task:<cls>:<jobId>`
     * per-class — identical to the key hard-kill DELs). So EXISTS on the entry
     * string is ground truth for child existence, independent of whether the
     * owning plugin is registered this boot.
     *
     * Conservative: only return false (child genuinely gone) when Redis
     * positively confirms the key is absent. On any probe error, return true
     * (assume alive) and log — we never sweep a parent on an inconclusive probe.
     */
    private async childKeyExistsInRedis(jobKey: string): Promise<boolean> {
        try {
            const client = await this.getClient();
            const raw = await client.customCommand(['EXISTS', jobKey]);
            const exists = Number(raw) > 0;
            if (!exists) {
                log.info('OrphanSweep: child job key absent in Redis (unregistered child queue)', {
                    jobKey,
                });
            }
            return exists;
        } catch (err) {
            log.warn('OrphanSweep: EXISTS probe failed — assuming child alive', {
                jobKey,
                err: err instanceof Error ? err.message : String(err),
            });
            return true;
        }
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseZRangeResult(raw: unknown): string[] {
    if (!raw) return [];
    if (Array.isArray(raw)) {
        return raw.map((v) => String(v)).filter(Boolean);
    }
    return [];
}
