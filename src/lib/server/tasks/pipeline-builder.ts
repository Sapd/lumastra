// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// pipeline-builder.ts — FlowProducer tree construction from declarative pipeline DAG.
//
// Extracted from orchestrator.ts `enqueuePipeline` so it can be unit-tested
// independently. The orchestrator calls `buildPipelinePlan`, writes all
// task_history rows for the plan, then submits the single FlowJob tree.
//
// FlowProducer tree semantics: "children run before the parent." So if the
// pipeline topological order is [A, B, C] (A first, C last), then C is the
// FlowProducer root and A is a nested child — C waits for B which waits for A.
//
// Multi-predecessor pipelines: tasks with `pipeline.after.length > 1` are
// handled via gate-task synthesis. A synthetic gate job (`__gate__<taskId>`)
// is inserted as an intermediate parent for all predecessors. The convergent
// task then becomes a child of the gate. This keeps the FlowProducer tree
// strictly binary-parent-compatible while expressing true fan-in semantics.
//
// Conditional stages (`pipeline.when`): evaluation happens at execute time
// inside the runner. The builder includes every task in the FlowJob tree;
// the runner calls `registry.shouldSkipStage()` before invoking `execute()`.

import { taskRetryOptions } from './bull-defaults.js';
import { ulid } from 'ulid';
import type { FlowJob } from 'bullmq';
import type { TaskDefinition } from '@sapd/lumastra-plugin-sdk';
import { registry as defaultRegistry, type TaskRegistry } from './registry.js';
import { computeIdentity } from './identity.js';
import {
    PER_TASK_QUEUE_PREFIX,
    QUEUE_PREFIX,
    perTaskQueueName,
    taskQueueName,
} from './queue-naming.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface PipelineRunPlan {
    /** The run_* id assigned to the first task enqueued (the trigger task). */
    rootRunId: string;
    /** The BullMQ jobId for the root task. */
    rootJobId: string;
    /**
     * The FlowJob ready to submit via `flowProducer.add(plan.flowJob)`.
     * This is the topologically-LAST task (the FlowProducer root); all
     * upstream tasks are nested as `children`.
     *
     * When the pipeline has multiple independent roots (parallel branches),
     * `flowJob` is the first root only. Callers that need to submit all roots
     * must iterate `flowJobs` instead.
     */
    flowJob: FlowJob;
    /** All root-level FlowJobs when the pipeline has parallel entry points. */
    flowJobs: FlowJob[];
    /** runId keyed by task id — use this to INSERT task_history rows. */
    runIdsByTaskId: Map<string, string>;
}

export interface PipelinePlanOptions {
    libraryGroupId?: string;
    userId?: string;
    /** Matches StartRunOpts.priority + TaskDefinition.taskPriority. */
    priority?: 1 | 2 | 3 | 5 | 7;
    parentTrigger?: { kind: string; by?: string };
    /**
     * Wave 8.5 — when true, FlowJobs target per-task queues
     * (`bull:task:t:<taskId>`) so the per-task Workers drain them. Gate jobs
     * route to the convergent task's per-task queue (which has a Worker), so a
     * fan-in pipeline can't wedge on a gate sitting in an unpolled queue. When
     * false (default), the legacy per-class queue names are used.
     */
    perTaskQueues?: boolean;
}

// ── Builder ───────────────────────────────────────────────────────────────────

/**
 * Build a FlowJob tree for the named pipeline.
 *
 * @param pipelineName  The `pipeline.of` string (e.g. "library-ingest").
 * @param triggerTask   The specific task in the pipeline that was directly
 *                      triggered. Its runId will be the `rootRunId`; other
 *                      tasks receive freshly generated run_ IDs.
 * @param rootInput     Parsed input for the trigger task; other tasks receive {}.
 * @param options       Optional priority / scope overrides.
 * @param reg           Registry to use (defaults to the module singleton).
 *
 * @throws If `pipelineName` has no registered tasks.
 * @throws If the pipeline contains cycles (propagated from registry.resolvePipeline).
 */
export function buildPipelinePlan(
    pipelineName: string,
    triggerTask: TaskDefinition,
    rootInput: unknown,
    options: PipelinePlanOptions = {},
    reg: TaskRegistry = defaultRegistry,
): PipelineRunPlan {
    const members = reg.resolvePipeline(pipelineName);
    // members is topologically sorted: index 0 = no dependencies (leaves in
    // FlowProducer terms); last index = terminal node (FlowProducer root).

    const priority = options.priority ?? 5;
    const perTask = options.perTaskQueues ?? false;
    // Resolve a FlowJob's queueName + prefix. Per-task (flag on) routes to the
    // task's own queue (`bull:task:t:<taskId>`); per-class (flag off) to the
    // class queue (`bull:task:<cls>`). A single helper keeps members and gate
    // jobs consistent, and keeps the keys byte-identical to what the runner's
    // Workers + the orchestrator's QueueEvents derive from the same helpers.
    const queueFor = (
        taskId: string,
        cls: TaskDefinition['resourceClass'],
    ): { queueName: string; prefix: string } =>
        perTask
            ? {
                  queueName: perTaskQueueName(taskId),
                  prefix: PER_TASK_QUEUE_PREFIX,
              }
            : { queueName: taskQueueName(cls), prefix: QUEUE_PREFIX };
    const runIdsByTaskId = new Map<string, string>();
    const jobIdByTaskId = new Map<string, string>();

    // Assign run IDs and job IDs to every pipeline member.
    //
    // The jobId encodes the runId as a `#<runId>` suffix so QueueEvents
    // handlers in the orchestrator can recover the runId without a queue
    // probe — critical when BullMQ has already reaped the job
    // (removeOnComplete). Without the suffix, `runIdFromJobId` falls back to
    // `queue.getJob(jobId)` which returns null after reap, dropping the
    // terminal transition silently.
    //
    // Trigger task uses `<computeIdentity>#<runId>` so the identity-based
    // SETNX dedup still works as before. Non-trigger pipeline members have
    // no meaningful identity for dedup, so they get a synthetic
    // `<taskId>~~pipe#<runId>` jobId that still surfaces the runId via the
    // suffix splitter. `~~` is the separator (not `::`) because BullMQ 5.71+
    // rejects jobIds whose colon-split yields a count other than 3.
    for (const m of members) {
        const isTrigger = m.id === triggerTask.id;
        const runId = isTrigger
            ? `run_${ulid()}` // caller will use rootRunId for its INSERT
            : `run_${ulid()}`;
        runIdsByTaskId.set(m.id, runId);

        const baseJobId = isTrigger
            ? computeIdentity(triggerTask as TaskDefinition<unknown, unknown>, rootInput)
            : `${m.id}~~pipe`;
        jobIdByTaskId.set(m.id, `${baseJobId}#${runId}`);
    }

    // Build FlowJob nodes.
    //
    // FlowJob.queueName must be the bare resource class (BullMQ 5.69+ rejects
    // `:`); FlowJob.prefix carries the `bull:task` namespace so final Redis
    // keys land at `bull:task:<cls>:…`.
    const idToFlow = new Map<string, FlowJob>();
    for (const m of members) {
        const { queueName, prefix } = queueFor(m.id, m.resourceClass);
        const runId = runIdsByTaskId.get(m.id)!;
        const jobId = jobIdByTaskId.get(m.id);
        const isTrigger = m.id === triggerTask.id;
        const data: Record<string, unknown> = {
            runId,
            input: isTrigger ? rootInput : {},
            parentRunId: runIdsByTaskId.get(triggerTask.id)!,
        };
        const fj: FlowJob = {
            name: m.id,
            queueName,
            prefix,
            data,
            opts: {
                ...taskRetryOptions(m),
                jobId: jobId || undefined,
                priority,
                // TASK-C8: propagate child failure to the convergent parent.
                // Without this, a failed pipeline child leaves its parent
                // parked in `waiting-children` forever — BullMQ only advances
                // a parent once ALL children COMPLETE, so a single failed
                // (retry-exhausted) child wedges the whole convergent pipeline
                // permanently. With `failParentOnFailure` BullMQ lazily fails
                // the parent ("child <key> failed"), which propagates
                // recursively up the tree (member → gate → convergent → root).
                // The flag on a root member is harmless (a root has no parent).
                failParentOnFailure: true,
            },
            children: [],
        };
        idToFlow.set(m.id, fj);
    }

    // Wire dependencies.
    // `pipeline.after` = predecessors. In FlowProducer, the *successor* is the
    // parent and its predecessor is a *child* (children run first).
    //
    // Example: A → B (B runs after A). B.pipeline.after = ['A'].
    //   FlowProducer: B is parent, A is child → { name: 'B', children: [A] }
    //
    // Multi-predecessor (fan-in): when a task declares two or more predecessors,
    // a synthetic gate job is inserted between the predecessors and the convergent
    // task. The gate carries all predecessors as its children; the convergent task
    // carries the gate as its sole child.
    //
    // Example: A+B → C becomes: C → gate → [A, B]
    const flowRoots: FlowJob[] = [];
    // Track which task ids have been embedded as a child so they are not also
    // emitted as standalone FlowProducer roots.
    const embeddedAsChild = new Set<string>();

    for (const m of members) {
        const fj = idToFlow.get(m.id);
        if (!fj) continue;
        const afters = m.pipeline?.after ?? [];
        if (afters.length === 0) {
            // No predecessors → this member IS the FlowProducer leaf (no children).
            // We will embed it as a child of whoever declares it in `after`.
            // If nothing declares it in `after`, it's also a FlowProducer root
            // (parallel branch with no downstream). Track it separately below.
            continue; // skip for now; we'll collect un-parented ones as roots
        }

        if (afters.length === 1) {
            // Single predecessor — wire directly. Refuse when the predecessor
            // is already embedded under a different parent: BullMQ
            // FlowProducer expects a tree, not a DAG, so sharing the same
            // FlowJob reference under two parents enqueues the predecessor
            // twice. Until proper diamond-DAG support lands, surface the
            // limitation loudly rather than silently double-executing.
            const predId = afters[0];
            if (embeddedAsChild.has(predId)) {
                throw new Error(
                    `pipeline-builder: '${predId}' is already a child of another task — ` +
                        `diamond DAGs (one predecessor feeding multiple successors) are not yet ` +
                        `supported by FlowProducer's tree shape. Refactor '${m.id}' to depend on a ` +
                        `gate task that aggregates the shared work, or split the convergent stages.`,
                );
            }
            const predFj = idToFlow.get(predId);
            if (predFj) {
                fj.children = fj.children ?? [];
                fj.children.push(predFj);
                embeddedAsChild.add(predId);
            }
        } else {
            // Multi-predecessor — synthesise a gate job that collects all
            // predecessor FlowJobs as its children, then attach the gate as
            // the sole child of the convergent task (fj). Same tree-shape
            // limitation applies: a predecessor cannot be shared across gates.
            const gateId = `__gate__${m.id}`;
            const gateChildren: FlowJob[] = [];
            for (const predId of afters) {
                if (embeddedAsChild.has(predId)) {
                    throw new Error(
                        `pipeline-builder: '${predId}' is already a child of another task — ` +
                            `diamond DAGs are not yet supported. Refactor '${m.id}' to depend on a ` +
                            `gate task that aggregates the shared work, or split the convergent stages.`,
                    );
                }
                const predFj = idToFlow.get(predId);
                if (predFj) {
                    gateChildren.push(predFj);
                    embeddedAsChild.add(predId);
                }
            }
            const parentRunId = runIdsByTaskId.get(triggerTask.id)!;
            const gateRunId = `run_${ulid()}`;
            // Route the gate to the convergent task's queue so it lands on a
            // queue that definitely has a Worker. Per-task (flag on): the
            // convergent's own per-task queue; per-class: the convergent's class
            // queue (today's behaviour). The runner's `__gate__` early-return
            // keys off job.name, so it drains correctly from either.
            const gateQueue = queueFor(m.id, m.resourceClass);
            const gateFj: FlowJob = {
                name: gateId,
                queueName: gateQueue.queueName,
                prefix: gateQueue.prefix,
                data: {
                    runId: gateRunId,
                    input: {},
                    parentRunId,
                    isGate: true,
                },
                // Encode the gate's runId in its jobId so QueueEvents can
                // recover it without probing the queue (BullMQ may have
                // already reaped the gate by the time the event arrives).
                // TASK-C8: the gate is a child of the convergent task, so it
                // must also propagate failure upward — when a predecessor fails
                // it fails the gate (via the member flag above), and the gate in
                // turn must fail the convergent parent rather than parking it
                // in waiting-children forever.
                opts: {
                    jobId: `${gateId}#${gateRunId}`,
                    priority,
                    failParentOnFailure: true,
                },
                children: gateChildren,
            };
            // Record the gate run-id so callers (and admin UI) can map the
            // synthetic job back to a row if they ever need to. Tracking it
            // also keeps fan-ins observable via task_history if a future
            // commit decides to persist gate runs.
            runIdsByTaskId.set(gateId, gateRunId);
            fj.children = fj.children ?? [];
            fj.children.push(gateFj);
            embeddedAsChild.add(gateId);
        }
    }

    // Identify FlowProducer roots: tasks NOT embedded as a child during wiring.
    // This accounts for both single-predecessor chains and gate-synthesised fan-ins.
    for (const m of members) {
        if (!embeddedAsChild.has(m.id)) {
            // Not embedded as a child → it is a FlowProducer tree root.
            const fj = idToFlow.get(m.id);
            if (fj) flowRoots.push(fj);
        }
    }

    if (flowRoots.length === 0) {
        // Should not happen after resolvePipeline (cycle detection would catch
        // a true cycle), but guard defensively.
        throw new Error(`buildPipelinePlan: pipeline "${pipelineName}" produced no root jobs`);
    }

    const rootRunId = runIdsByTaskId.get(triggerTask.id) ?? `run_${ulid()}`;
    const rootJobId = jobIdByTaskId.get(triggerTask.id) ?? '';

    return {
        rootRunId,
        rootJobId,
        flowJob: flowRoots[0],
        flowJobs: flowRoots,
        runIdsByTaskId,
    };
}
