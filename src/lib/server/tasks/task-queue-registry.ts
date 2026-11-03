// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// task-queue-registry.ts — per-task BullMQ Queue cache for Wave 8.5 Phase 1.
//
// Today (pre-Wave-8.5): one BullMQ Queue per resource class. All tasks
// sharing a class compete head-of-line in strict-priority FIFO. Long-
// running tasks starve short-running ones; "fix" has been adding new
// classes (4→7 in two months, no stopping condition).
//
// After Wave 8.5: one BullMQ Queue per registered task. Class becomes a
// budget tag (see budget-semaphore.ts) — workers acquire a class token
// before processing. Fairness is automatic because each task has its own
// pop loop and gets at least its share of the budget.
//
// This module is the foundation for that model: lazy queue creation,
// stable naming, clean shutdown. It does NOT change current routing —
// `orchestrator.startRun` still uses the class-keyed queue map until
// the `FEATURE_PER_TASK_QUEUES` flag flips in Phase 1 Step 4.
//
// Queue naming: `task:t:<taskId>` — the `:t:` discriminator distinguishes
// per-task queues from legacy `task:<class>` queues during the transition.
// Once Wave 8.5 lands and class queues are removed, the discriminator
// becomes redundant but stays for backwards compat.

import { logQueueConnectionErrors } from './queue-outage.js';
import { Queue, type ConnectionOptions } from 'bullmq';
import type { TaskDefinition } from '@sapd/lumastra-plugin-sdk';
import { Logger } from '$lib/server/utils/logger.js';
import { BULL_DEFAULT_RETENTION } from './bull-defaults.js';
import { PER_TASK_QUEUE_PREFIX, perTaskQueueName } from './queue-naming.js';

const log = Logger.for('TaskQueueRegistry');

export interface TaskQueueRegistryOpts {
    connection: ConnectionOptions;
    /**
     * Optional callback fired the first time a task's queue is materialised.
     * Lets the runner attach a Worker + QueueEvents in the same boot path
     * without the registry needing to know about either subsystem.
     */
    onQueueCreated?: (taskId: string, queue: Queue) => void;
}

export class TaskQueueRegistry {
    private readonly queues = new Map<string, Queue>();
    private readonly opts: TaskQueueRegistryOpts;

    constructor(opts: TaskQueueRegistryOpts) {
        this.opts = opts;
    }

    /**
     * Lazy-create or return the cached Queue for a task. Idempotent.
     *
     * `this.opts.connection` is whatever the caller resolved via
     * getQueueConnection() (connection.ts) — plain options by default (each
     * Queue then opens its own ioredis connection, same as every other
     * per-task queue) or, when FEATURE_SHARED_QUEUE_CONNECTION is on, one
     * shared IORedis instance that BullMQ reuses for every Queue built from
     * it. The instance-vs-options distinction is what actually determines
     * connection count — passing the identical options object reference to
     * every getQueue() call does NOT by itself multiplex onto one socket
     * (verified against bullmq's isRedisInstance() check, which requires a
     * live client, not a options object, before marking a connection
     * shared).
     */
    getQueue(taskId: string): Queue {
        const existing = this.queues.get(taskId);
        if (existing) return existing;

        // Queue NAME is the bare taskId; the `bull:task:t` namespace is carried
        // in the prefix. BullMQ 5.69+ rejects `:` inside the name, so baking
        // the full `bull:task:t:<taskId>` into the name (as the original draft
        // did) throws at construction. See queue-naming.ts for the contract
        // both producer and consumer sides must share.
        const queueName = perTaskQueueName(taskId);
        const queue = new Queue(queueName, {
            connection: this.opts.connection,
            prefix: PER_TASK_QUEUE_PREFIX,
            // Postgres `task_history` is the source of truth for run history;
            // BullMQ job records are only kept for in-flight inspection. Without
            // these defaults BullMQ retains every completed/failed job forever
            // (observed 38k+ image-sync hashes consuming Valkey memory).
            // Per-job overrides on the producer side still win.
            defaultJobOptions: BULL_DEFAULT_RETENTION,
        });
        logQueueConnectionErrors(queue, 'task-queue');
        this.queues.set(taskId, queue);
        log.debug('task queue created', {
            taskId,
            queueName,
            prefix: PER_TASK_QUEUE_PREFIX,
        });
        this.opts.onQueueCreated?.(taskId, queue);
        return queue;
    }

    /**
     * Eagerly materialise queues for every registered task. Used at boot
     * once the registry is populated so worker startup can iterate without
     * a lazy-creation race.
     */
    materializeAll(tasks: readonly TaskDefinition<unknown, unknown>[]): void {
        for (const task of tasks) {
            this.getQueue(task.id);
        }
    }

    /** All currently-materialised queues. Order is creation order. */
    allQueues(): readonly Queue[] {
        return Array.from(this.queues.values());
    }

    /** Has the queue for this task been created yet? */
    has(taskId: string): boolean {
        return this.queues.has(taskId);
    }

    /**
     * Close all queues. Each `queue.close()` shuts down its connection
     * gracefully if BullMQ owns it — when a shared connection is passed
     * in (our case), close is a no-op on the underlying socket.
     */
    async closeAll(options: { strict?: boolean } = {}): Promise<void> {
        const errors: unknown[] = [];
        for (const [taskId, queue] of this.queues) {
            try {
                await queue.close();
                if (options.strict) this.queues.delete(taskId);
            } catch (err) {
                errors.push({ taskId, err });
            }
        }
        if (!options.strict) this.queues.clear();
        if (errors.length > 0) {
            log.warn('queue close errors', { count: errors.length });
            if (options.strict)
                throw new AggregateError(errors, 'Per-task queue shutdown is incomplete');
        }
    }
}
