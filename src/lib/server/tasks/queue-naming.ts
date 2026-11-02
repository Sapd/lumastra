// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// queue-naming.ts — Centralised BullMQ queue-name / Redis-prefix helpers.
//
// Why this exists:
//   BullMQ 5.69+ rejects `:` inside queue names. The previous shape was
//   `new Queue('task:io', …)` which now throws `Error: Queue name cannot
//   contain :` at QueueBase construction — blocking every Worker /
//   QueueEvents / FlowProducer instantiation.
//
// What we do:
//   Split "what is this queue" (bare resource class `io` / `cpu` /
//   `embedding` / `maintenance`) from "where does it live" (Redis key
//   prefix `bull:task`). BullMQ accepts `:` in `prefix` (it is opaque
//   key-space) but not in the queue name.
//
// Final Redis keys remain byte-identical to the pre-refactor layout:
//   `bull:task:<cls>:<jobId>:…` — so the hard-kill Lua bypass, orphan-sweep
//   fixtures, and any other code that scans these keys keep working.

import type { ResourceClass } from '@sapd/lumastra-plugin-sdk';

/**
 * Redis namespace for the task system's BullMQ queues. Replaces BullMQ's
 * default `bull:` namespace so task-system keys can be searched, monitored,
 * and operated on without colliding with any other BullMQ user in the same
 * Valkey instance.
 *
 * Final qualified queue name = `${QUEUE_PREFIX}:${taskQueueName(cls)}`
 * e.g. `bull:task:io`. Final job keys = `bull:task:io:<jobId>:…`.
 */
export const QUEUE_PREFIX = 'bull:task';

/**
 * Map a resource class to its BullMQ queue name (bare class, no colons).
 *
 * The returned string is what gets passed as the first argument to
 * `new Queue(…)`, `new Worker(…)`, `new QueueEvents(…)`, or as
 * `FlowJob.queueName`. Pair it with `{ prefix: QUEUE_PREFIX }` (or set
 * `FlowJob.prefix = QUEUE_PREFIX`) so the final Redis keys remain
 * `bull:task:<cls>:…`.
 */
export function taskQueueName(cls: ResourceClass): string {
    return cls;
}

/**
 * Fully-qualified Redis key prefix for a given resource class's queue
 * (`${QUEUE_PREFIX}:${cls}`), e.g. `bull:task:io`. Use when constructing
 * Redis keys directly (e.g. hard-kill Lua bypass, orphan-sweep dependency
 * key parsing) instead of hand-concatenating.
 */
export function taskQueueQualifiedName(cls: ResourceClass): string {
    return `${QUEUE_PREFIX}:${cls}`;
}

// ── Per-task queues (Wave 8.5, FEATURE_PER_TASK_QUEUES) ─────────────────────────
//
// When the per-task-queue flag is on, each registered task gets its own BullMQ
// queue instead of sharing a per-class one. The queue NAME is the bare taskId
// (BullMQ 5.69+ rejects `:` in names — taskIds are kebab-case and colon-free,
// validated at registration); the `:t` segment is carried in the Redis PREFIX
// so the final keys are `bull:task:t:<taskId>:…`. The `:t` discriminator keeps
// per-task keys from colliding with the legacy per-class `bull:task:<cls>:…`
// keyspace during the transition.
//
// Both the producer side (orchestrator.startRun / TaskQueueRegistry / pipeline
// FlowJobs) and the consumer side (runner Workers) MUST derive name + prefix
// from these helpers so a split web/worker deployment can't drift — a mismatch
// would silently route jobs to a queue nobody is polling. This is the same
// lesson the per-class header above already records.

/** Redis key prefix for per-task queues. Final keys: `bull:task:t:<taskId>:…`. */
export const PER_TASK_QUEUE_PREFIX = `${QUEUE_PREFIX}:t`;

/**
 * BullMQ queue NAME for a per-task queue — the bare taskId. Pair with
 * `{ prefix: PER_TASK_QUEUE_PREFIX }` on Queue/Worker/QueueEvents and with
 * `FlowJob.prefix = PER_TASK_QUEUE_PREFIX` so final Redis keys are
 * `bull:task:t:<taskId>:…`.
 *
 * Throws on a colon-bearing taskId rather than silently producing a name
 * BullMQ will reject at construction — surfacing the bad id at the call site
 * is far easier to debug than a deep BullMQ throw.
 */
export function perTaskQueueName(taskId: string): string {
    if (taskId.includes(':')) {
        throw new Error(
            `perTaskQueueName: taskId "${taskId}" contains ':' which BullMQ rejects in queue names`,
        );
    }
    return taskId;
}

/**
 * Fully-qualified Redis key prefix for a per-task queue
 * (`${PER_TASK_QUEUE_PREFIX}:${taskId}`), e.g. `bull:task:t:music-analysis`.
 * Use when constructing Redis keys directly (hard-kill Lua bypass,
 * orphan-sweep dependency-key parsing) instead of hand-concatenating.
 */
export function perTaskQueueQualifiedName(taskId: string): string {
    return `${PER_TASK_QUEUE_PREFIX}:${taskId}`;
}
