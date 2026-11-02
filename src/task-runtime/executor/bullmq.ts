// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    Job,
    Queue,
    WaitingChildrenError,
    DelayedError,
    UnrecoverableError,
    type ConnectionOptions,
} from 'bullmq';
import { TaskRunner, type RunnerJob } from '$lib/server/tasks/runner.js';
import { registry as defaultRegistry, type TaskRegistry } from '$lib/server/tasks/registry.js';
import { getQueueConnectionOptions } from '$lib/server/tasks/connection.js';
import { PER_TASK_QUEUE_PREFIX } from '$lib/server/tasks/queue-naming.js';
import { AuthorityError, type AuthorityToken } from '../authority/store.js';
import type { ExecutionBackend, ExecutionCommand, ExecutionOutcome } from './protocol.js';

/** Queue-control exceptions preserve their meaning without exposing plugin error text.
 * This translation alone does not qualify cross-language dependency/flow behavior. */
export function executionFailureOutcome(error: unknown, aborted: boolean): ExecutionOutcome {
    if (
        aborted ||
        error instanceof AuthorityError ||
        (error instanceof Error && /TASK_AUTHORITY_/.test(error.message))
    )
        return { status: 'unknown' };
    if (error instanceof WaitingChildrenError) return { status: 'waiting_children' };
    if (error instanceof DelayedError) return { status: 'delayed' };
    if (error instanceof UnrecoverableError) return { status: 'unrecoverable' };
    return { status: 'failed' };
}

/** No queue consumer or BullMQ terminal transition is created here. The caller
 * owns the native claim/renew/finalize loop. Only coherent per-task queues are
 * accepted; all real SDK context construction stays in the existing runner. */
export function createBullMqExecutor(
    options: {
        eligibleTaskIds?: readonly string[];
        authority?: AuthorityToken;
        runner?: TaskRunner;
        registry?: TaskRegistry;
        connection?: ConnectionOptions;
        prefix?: string;
    } = {},
): ExecutionBackend {
    const eligible = new Set(options.eligibleTaskIds ?? []);
    const registry = options.registry ?? defaultRegistry;
    const runner =
        options.runner ??
        TaskRunner.createExecutor({ registry, perTaskQueues: true, authority: options.authority });
    if (!runner.isExecutorOnly()) throw new Error('Executor requires a consumer-free runner');
    const queues = new Map<string, Queue>();
    const activeRuns = new Set<string>();
    let closed = false;
    return {
        async execute(command: ExecutionCommand, signal: AbortSignal): Promise<ExecutionOutcome> {
            if (
                !Number.isSafeInteger(command.lockDurationMs) ||
                command.lockDurationMs < 100 ||
                command.lockDurationMs > 300_000
            )
                throw new Error('Invalid executor lock duration');
            if (closed || signal.aborted || activeRuns.has(command.runId))
                throw new Error('Executor unavailable');
            const task = registry.getTask(command.taskId);
            if (!eligible.has(command.taskId))
                throw new Error('Executor task eligibility not approved');
            if (!task || command.queueName !== task.id)
                throw new Error('Executor task/queue mismatch');
            activeRuns.add(command.runId);
            try {
                let queue = queues.get(command.queueName);
                if (!queue) {
                    const connection = options.connection ?? getQueueConnectionOptions();
                    if (!connection) throw new Error('Executor queue connection unavailable');
                    queue = new Queue(command.queueName, {
                        connection,
                        prefix: options.prefix ?? PER_TASK_QUEUE_PREFIX,
                    });
                    queues.set(command.queueName, queue);
                }
                const job = await Job.fromId<RunnerJob['data']>(queue, command.jobId);
                if (!job || job.name !== command.taskId || job.data.runId !== command.runId)
                    throw new Error('Executor job identity mismatch');
                if (signal.aborted || (await job.getState()) !== 'active')
                    throw new Error('Executor job not active');
                // Supported BullMQ Lua API atomically proves token ownership.
                // A zero reply means the lock expired or belongs to another worker.
                if (
                    (await job.extendLock(command.lockToken, command.lockDurationMs)) !== 1 ||
                    signal.aborted
                )
                    throw new Error('Executor job lock lost');
                try {
                    const result = await runner.processJob(job, command.lockToken, signal);
                    return signal.aborted
                        ? { status: 'unknown' }
                        : result === undefined
                          ? { status: 'completed' }
                          : { status: 'completed', result };
                } catch (error) {
                    return executionFailureOutcome(error, signal.aborted);
                }
            } finally {
                activeRuns.delete(command.runId);
            }
        },
        cancel(runId) {
            runner.cancelExecution(runId);
        },
        isQuiescent() {
            return activeRuns.size === 0 && runner.isExecutionQuiescent();
        },
        isRunQuiescent(runId) {
            return !activeRuns.has(runId) && runner.isRunQuiescent(runId);
        },
        async close() {
            closed = true;
            if (activeRuns.size !== 0 || !runner.isExecutionQuiescent())
                throw new Error('Executor is not quiescent');
            await runner.stop();
            await Promise.all([...queues.values()].map((queue) => queue.close()));
        },
    };
}
