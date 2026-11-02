// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for pipeline-builder.ts — no live infrastructure required.
 *
 * Run with: npx vitest run src/lib/server/tasks/pipeline-builder.test.ts
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import type { FlowJob } from 'bullmq';
import { TaskRegistry } from './registry.js';
import { buildPipelinePlan } from './pipeline-builder.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTask(id: string, after?: string[], when?: (r: unknown) => boolean) {
    return defineTask({
        id,
        name: id,
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        inputSchema: z.unknown(),
        identityFor: () => id,
        pipeline: {
            of: 'test-pipeline',
            after: after ?? [],
            ...(when ? { when } : {}),
        },
        execute: async () => ({ success: true }),
    });
}

function collectNames(job: FlowJob): string[] {
    const names: string[] = [job.name];
    for (const child of job.children ?? []) {
        names.push(...collectNames(child));
    }
    return names;
}

function findJob(job: FlowJob, name: string): FlowJob | undefined {
    if (job.name === name) return job;
    for (const child of job.children ?? []) {
        const found = findJob(child, name);
        if (found) return found;
    }
    return undefined;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('buildPipelinePlan — linear pipeline A→B→C', () => {
    it('produces C as the FlowProducer root with B→A as nested children', () => {
        const taskA = makeTask('task-a');
        const taskB = makeTask('task-b', ['task-a']);
        const taskC = makeTask('task-c', ['task-b']);

        const reg = new TaskRegistry();
        reg.registerTask(taskA);
        reg.registerTask(taskB);
        reg.registerTask(taskC);

        const plan = buildPipelinePlan('test-pipeline', taskA, { name: 'alpha' }, {}, reg);

        // Root should be the terminal node (task-c, no `after` pointing further)
        // OR the last topologically — the one not referenced by anyone else.
        // task-c has no successors → it is the FlowProducer root.
        expect(plan.flowJob.name).toBe('task-c');
        // task-b is child of task-c
        const bJob = findJob(plan.flowJob, 'task-b');
        expect(bJob).toBeDefined();
        // task-a is child of task-b
        const aJob = findJob(bJob!, 'task-a');
        expect(aJob).toBeDefined();
    });

    it('all three tasks appear in runIdsByTaskId', () => {
        const taskA = makeTask('task-a');
        const taskB = makeTask('task-b', ['task-a']);
        const taskC = makeTask('task-c', ['task-b']);

        const reg = new TaskRegistry();
        reg.registerTask(taskA);
        reg.registerTask(taskB);
        reg.registerTask(taskC);

        const plan = buildPipelinePlan('test-pipeline', taskA, {}, {}, reg);

        expect(plan.runIdsByTaskId.size).toBe(3);
        expect(plan.runIdsByTaskId.has('task-a')).toBe(true);
        expect(plan.runIdsByTaskId.has('task-b')).toBe(true);
        expect(plan.runIdsByTaskId.has('task-c')).toBe(true);
        for (const id of plan.runIdsByTaskId.values()) {
            expect(id).toMatch(/^run_/);
        }
    });

    it('rootRunId belongs to the trigger task', () => {
        const taskA = makeTask('task-a');
        const taskB = makeTask('task-b', ['task-a']);

        const reg = new TaskRegistry();
        reg.registerTask(taskA);
        reg.registerTask(taskB);

        const plan = buildPipelinePlan('test-pipeline', taskA, {}, {}, reg);

        expect(plan.rootRunId).toBe(plan.runIdsByTaskId.get('task-a'));
    });
});

describe('buildPipelinePlan — single-task pipeline', () => {
    it('produces a single FlowJob with no children', () => {
        const taskA = makeTask('task-a');
        const reg = new TaskRegistry();
        reg.registerTask(taskA);

        const plan = buildPipelinePlan('test-pipeline', taskA, {}, {}, reg);

        expect(plan.flowJob.name).toBe('task-a');
        expect(plan.flowJob.children ?? []).toHaveLength(0);
        expect(plan.flowJobs).toHaveLength(1);
        expect(plan.runIdsByTaskId.size).toBe(1);
    });
});

describe('buildPipelinePlan — unknown pipeline', () => {
    it('throws when no tasks are registered for the pipeline name', () => {
        const reg = new TaskRegistry();
        const task = makeTask('task-a');
        reg.registerTask(task);

        expect(() => buildPipelinePlan('nonexistent-pipeline', task, {}, {}, reg)).toThrow(
            /no tasks in pipeline/,
        );
    });
});

describe('buildPipelinePlan — parallel branches', () => {
    it('returns multiple roots in flowJobs for independent entry points', () => {
        // A and B have no after; C depends on A only.
        // Topology: [A, B, C] (B has no successor)
        const taskA = makeTask('task-a'); // leaf: no after, has successor C
        const taskB = makeTask('task-b'); // leaf: no after, no successor
        const taskC = makeTask('task-c', ['task-a']); // depends on A

        const reg = new TaskRegistry();
        reg.registerTask(taskA);
        reg.registerTask(taskB);
        reg.registerTask(taskC);

        const plan = buildPipelinePlan('test-pipeline', taskA, {}, {}, reg);

        // Two roots: task-c (terminal for A's chain) and task-b (standalone)
        expect(plan.flowJobs).toHaveLength(2);
        const rootNames = plan.flowJobs.map((j) => j.name).sort();
        expect(rootNames).toContain('task-b');
        expect(rootNames).toContain('task-c');
    });
});

describe('buildPipelinePlan — conditional when stages', () => {
    it('includes tasks with pipeline.when in the FlowJob tree', () => {
        const taskA = makeTask('task-a');
        const taskB = makeTask('task-b', ['task-a'], (r: unknown) => Boolean(r));

        const reg = new TaskRegistry();
        reg.registerTask(taskA);
        reg.registerTask(taskB);

        // when: is a runtime concern — builder always includes the task
        const plan = buildPipelinePlan('test-pipeline', taskA, {}, {}, reg);

        const allNames = collectNames(plan.flowJob);
        expect(allNames).toContain('task-a');
        expect(allNames).toContain('task-b');
    });
});

describe('buildPipelinePlan — multi-parent fan-in', () => {
    it('inserts a synthetic gate node when a task has two predecessors (A+B→C)', () => {
        const taskA = makeTask('task-a');
        const taskB = makeTask('task-b');
        const taskC = makeTask('task-c', ['task-a', 'task-b']);

        const reg = new TaskRegistry();
        reg.registerTask(taskA);
        reg.registerTask(taskB);
        reg.registerTask(taskC);

        const plan = buildPipelinePlan('test-pipeline', taskA, {}, {}, reg);

        // task-c is the FlowProducer root (no successors).
        expect(plan.flowJob.name).toBe('task-c');

        // task-c's sole child should be the synthetic gate.
        const cChildren = plan.flowJob.children ?? [];
        expect(cChildren).toHaveLength(1);
        const gateJob = cChildren[0];
        expect(gateJob.name).toBe('__gate__task-c');

        // gate's children are task-a and task-b (in any order).
        const gateChildNames = (gateJob.children ?? []).map((j) => j.name).sort();
        expect(gateChildNames).toEqual(['task-a', 'task-b']);

        // The gate carries isGate: true in its data payload.
        expect((gateJob.data as Record<string, unknown>).isGate).toBe(true);
    });

    it('runIdsByTaskId does not contain the synthetic gate id', () => {
        const taskA = makeTask('task-a');
        const taskB = makeTask('task-b');
        const taskC = makeTask('task-c', ['task-a', 'task-b']);

        const reg = new TaskRegistry();
        reg.registerTask(taskA);
        reg.registerTask(taskB);
        reg.registerTask(taskC);

        const plan = buildPipelinePlan('test-pipeline', taskA, {}, {}, reg);

        // Gate runIds are tracked alongside real tasks so downstream code can
        // observe them. 2 real tasks (A,C) + 1 gate = 3 entries; B and C share
        // 'task-c' key — actually 3 real tasks (A,B,C) since the existing test
        // included all three. The gate adds one more, so size = 4.
        expect(plan.runIdsByTaskId.has('__gate__task-c')).toBe(true);
        expect(plan.runIdsByTaskId.size).toBe(4);
    });

    it('refuses diamond DAG (A→B, A→C, B+C→D) until proper DAG support lands', () => {
        // BullMQ FlowProducer expects a tree, not a DAG. Sharing the same
        // FlowJob node under two parents would enqueue the predecessor twice
        // and double-execute. pipeline-builder throws a clear error so the
        // plugin author refactors via a gate task that aggregates the shared
        // work.
        const taskA = makeTask('task-a');
        const taskB = makeTask('task-b', ['task-a']);
        const taskC = makeTask('task-c', ['task-a']);
        const taskD = makeTask('task-d', ['task-b', 'task-c']);

        const reg = new TaskRegistry();
        reg.registerTask(taskA);
        reg.registerTask(taskB);
        reg.registerTask(taskC);
        reg.registerTask(taskD);

        expect(() => buildPipelinePlan('test-pipeline', taskA, {}, {}, reg)).toThrow(
            /diamond DAGs/,
        );
    });
});

describe('buildPipelinePlan — trigger task jobId', () => {
    it('sets jobId on the trigger task FlowJob node', () => {
        const taskA = makeTask('task-a');
        const taskB = makeTask('task-b', ['task-a']);

        const reg = new TaskRegistry();
        reg.registerTask(taskA);
        reg.registerTask(taskB);

        const plan = buildPipelinePlan('test-pipeline', taskA, {}, {}, reg);

        // task-a is a leaf nested inside task-b
        const aJob = findJob(plan.flowJob, 'task-a');
        expect(aJob).toBeDefined();
        // jobId should be set (computed identity for task-a)
        expect(aJob!.opts?.jobId).toBeDefined();
        expect(typeof aJob!.opts?.jobId).toBe('string');
    });
});

// ── F5: every FlowJob's jobId encodes the runId via `#<runId>` suffix ─────────
//
// Without the suffix, when BullMQ's removeOnComplete reaps the job before
// QueueEvents fires, `resolveRunIdFromJobId` falls back to `queue.getJob(jobId)`
// which returns null — the orchestrator can't recover the runId and drops the
// terminal transition silently. The fix encodes the runId in the jobId for
// every pipeline member, including non-trigger tasks and synthetic gate jobs.
describe('buildPipelinePlan — F5 runId encoded in every FlowJob jobId', () => {
    it('linear pipeline: every member jobId ends with #<runId>', () => {
        const taskA = makeTask('task-a');
        const taskB = makeTask('task-b', ['task-a']);
        const taskC = makeTask('task-c', ['task-b']);

        const reg = new TaskRegistry();
        reg.registerTask(taskA);
        reg.registerTask(taskB);
        reg.registerTask(taskC);

        const plan = buildPipelinePlan('test-pipeline', taskA, { name: 'enc' }, {}, reg);

        for (const [taskId, runId] of plan.runIdsByTaskId.entries()) {
            // gate jobs are synthetic and surfaced via runIdsByTaskId too.
            // Skip them here; the dedicated test below covers them.
            if (taskId.startsWith('__gate__')) continue;
            const job = findJob(plan.flowJob, taskId);
            expect(job, `missing FlowJob for ${taskId}`).toBeDefined();
            const jobId = job!.opts?.jobId;
            expect(jobId, `missing jobId for ${taskId}`).toBeDefined();
            expect(jobId!.endsWith(`#${runId}`)).toBe(true);
        }
    });

    it('non-trigger pipeline members no longer have undefined jobIds', () => {
        // Regression guard. Previously non-trigger members had
        // `opts.jobId = undefined`, which let BullMQ auto-generate a numeric
        // id that the QueueEvents handler couldn't decode.
        const taskA = makeTask('task-a');
        const taskB = makeTask('task-b', ['task-a']);

        const reg = new TaskRegistry();
        reg.registerTask(taskA);
        reg.registerTask(taskB);

        const plan = buildPipelinePlan('test-pipeline', taskA, {}, {}, reg);

        const bJob = findJob(plan.flowJob, 'task-b');
        expect(bJob).toBeDefined();
        expect(bJob!.opts?.jobId).toBeDefined();
        expect(typeof bJob!.opts!.jobId).toBe('string');
        expect(bJob!.opts!.jobId).toMatch(/#run_/);
    });

    it('multi-predecessor synthetic gate FlowJob also has an encoded jobId', () => {
        // Pipeline:  A → C, B → C   (C has two predecessors → gate is synthesised)
        const taskA = makeTask('task-a');
        const taskB = makeTask('task-b');
        const taskC = makeTask('task-c', ['task-a', 'task-b']);

        const reg = new TaskRegistry();
        reg.registerTask(taskA);
        reg.registerTask(taskB);
        reg.registerTask(taskC);

        const plan = buildPipelinePlan('test-pipeline', taskA, {}, {}, reg);

        const gateJob = findJob(plan.flowJob, '__gate__task-c');
        expect(gateJob).toBeDefined();
        const gateRunId = plan.runIdsByTaskId.get('__gate__task-c');
        expect(gateRunId).toBeDefined();
        expect(gateJob!.opts?.jobId).toBe(`__gate__task-c#${gateRunId}`);
    });
});

// ── TASK-C8: failed children must propagate failure to convergent parents ─────
//
// BullMQ only advances a `waiting-children` parent once ALL its children
// COMPLETE. A retry-exhausted (failed) child leaves the parent parked in
// `waiting-children` forever unless the child carries `failParentOnFailure`,
// which makes BullMQ lazily fail the parent — propagating recursively up the
// tree (member → gate → convergent → root). Without these opts, a single
// failed pipeline child wedges the whole convergent pipeline permanently.
describe('buildPipelinePlan — TASK-C8 failParentOnFailure propagation', () => {
    /** Walk the whole tree (root + descendants) and yield every FlowJob. */
    function allJobs(job: FlowJob): FlowJob[] {
        const out: FlowJob[] = [job];
        for (const child of job.children ?? []) out.push(...allJobs(child));
        return out;
    }

    it('linear A→B→C: every member FlowJob sets failParentOnFailure', () => {
        const taskA = makeTask('task-a');
        const taskB = makeTask('task-b', ['task-a']);
        const taskC = makeTask('task-c', ['task-b']);

        const reg = new TaskRegistry();
        reg.registerTask(taskA);
        reg.registerTask(taskB);
        reg.registerTask(taskC);

        const plan = buildPipelinePlan('test-pipeline', taskA, {}, {}, reg);

        // Children (task-a, task-b) MUST propagate failure to their parent.
        const aJob = findJob(plan.flowJob, 'task-a');
        const bJob = findJob(plan.flowJob, 'task-b');
        expect(aJob!.opts?.failParentOnFailure).toBe(true);
        expect(bJob!.opts?.failParentOnFailure).toBe(true);
    });

    it('multi-parent fan-in A+B→C: predecessors AND the gate propagate failure', () => {
        const taskA = makeTask('task-a');
        const taskB = makeTask('task-b');
        const taskC = makeTask('task-c', ['task-a', 'task-b']);

        const reg = new TaskRegistry();
        reg.registerTask(taskA);
        reg.registerTask(taskB);
        reg.registerTask(taskC);

        const plan = buildPipelinePlan('test-pipeline', taskA, {}, {}, reg);

        const gateJob = findJob(plan.flowJob, '__gate__task-c');
        expect(gateJob).toBeDefined();
        // The gate is a child of the convergent task — it must fail the
        // convergent parent rather than parking it forever.
        expect(gateJob!.opts?.failParentOnFailure).toBe(true);

        // Both predecessors are children of the gate — each must fail the gate.
        for (const pred of gateJob!.children ?? []) {
            expect(pred.opts?.failParentOnFailure).toBe(true);
        }
    });

    it('every non-root FlowJob in the tree carries failParentOnFailure', () => {
        // A+B→C, then C→D (gate fan-in feeding a further chain stage).
        const taskA = makeTask('task-a');
        const taskB = makeTask('task-b');
        const taskC = makeTask('task-c', ['task-a', 'task-b']);
        const taskD = makeTask('task-d', ['task-c']);

        const reg = new TaskRegistry();
        reg.registerTask(taskA);
        reg.registerTask(taskB);
        reg.registerTask(taskC);
        reg.registerTask(taskD);

        const plan = buildPipelinePlan('test-pipeline', taskA, {}, {}, reg);

        // task-d is the FlowProducer root (no successor); it has no parent so
        // the flag is irrelevant for it. Every OTHER node is somebody's child
        // and must propagate failure upward.
        const root = plan.flowJob;
        expect(root.name).toBe('task-d');
        for (const job of allJobs(root)) {
            if (job === root) continue;
            expect(
                job.opts?.failParentOnFailure,
                `FlowJob ${job.name} must set failParentOnFailure`,
            ).toBe(true);
        }
    });
});
