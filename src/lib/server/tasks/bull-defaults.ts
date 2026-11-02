// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// bull-defaults.ts — shared BullMQ Queue defaults.
//
// Single source of truth for retention so per-task queues
// (task-queue-registry.ts) and legacy class queues (orchestrator.ts) agree.

import type { TaskDefinition } from '@sapd/lumastra-plugin-sdk';
import type { JobsOptions } from 'bullmq';

/**
 * Postgres `task_history` is the source of truth for run history; BullMQ job
 * records are only kept for in-flight inspection and short-window admin
 * queries. Without these defaults BullMQ retains every completed and failed
 * job forever — observed 38k+ records for a single high-volume task
 * (image-sync) ballooning Valkey to 800k+ keys.
 *
 * Keep failures longer than completions: ops looks at recent failures more
 * often than recent successes, and the volume is much lower.
 */
export const BULL_DEFAULT_RETENTION: JobsOptions = {
    removeOnComplete: { count: 100, age: 86_400 },
    removeOnFail: { count: 500, age: 7 * 86_400 },
};

/** Side-effecting tasks must explicitly opt into a queue retry budget. */
export function taskRetryOptions(task: Pick<TaskDefinition, 'retry'>): {
    attempts: number;
    backoff: { type: 'fixed' | 'exponential'; delay: number } | undefined;
} {
    if (!task.retry) return { attempts: 1, backoff: undefined };
    // Preserve the existing number[] translation: its first delay is fixed.
    return {
        attempts: task.retry.attempts,
        backoff:
            task.retry.backoff === 'exponential'
                ? { type: 'exponential', delay: 1000 }
                : task.retry.backoff?.length
                  ? { type: 'fixed', delay: Math.max(0, Number(task.retry.backoff[0]) || 0) }
                  : undefined,
    };
}
