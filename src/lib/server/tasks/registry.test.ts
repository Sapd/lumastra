// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach } from 'vitest';
import { z } from 'zod';
import {
    defineTask,
    defineProvider,
    defineTrickplayProvider,
    defineWatchSync,
    defineFeature,
    defineIntegration,
} from '@sapd/lumastra-plugin-sdk';
import type { TaskDefinition, ProviderDefinition } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from './registry.js';

// Helpers: bypass defineTask/defineProvider compile-time validation to inject
// a bad id into the registry. Uses unknown cast to avoid no-explicit-any rule.
function injectBadTask(reg: TaskRegistry, task: TaskDefinition<unknown, unknown>): void {
    (
        reg as unknown as {
            tasks: Map<string, TaskDefinition<unknown, unknown>>;
        }
    ).tasks.set(task.id, task);
}

function injectBadProvider(reg: TaskRegistry, p: ProviderDefinition<unknown, unknown>): void {
    (
        reg as unknown as {
            providers: Map<string, ProviderDefinition<unknown, unknown>>;
        }
    ).providers.set(p.id, p);
}

// ---------------------------------------------------------------------------
// Minimal fixture builders
// ---------------------------------------------------------------------------

function makeTask(id: string, overrides: Record<string, unknown> = {}) {
    return defineTask({
        id,
        name: `Task ${id}`,
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        inputSchema: z.object({ id: z.string().optional() }),
        identityFor: () => 'global',
        async execute() {
            return { success: true };
        },
        ...overrides,
    });
}

/**
 * A task that BYPASSES `defineTask`.
 *
 * `defineTask` now rejects a bad `processingVersion` itself, so these values can
 * no longer be built through it. The registry's own sweep is still worth
 * testing — it is the backstop for a definition that reached the registry by
 * some other path — so the fixture is constructed directly.
 */
function makeUnvalidatedTask(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        name: `Task ${id}`,
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        inputSchema: z.object({ id: z.string().optional() }),
        identityFor: () => 'global',
        async execute() {
            return { success: true };
        },
        ...overrides,
    } as unknown as ReturnType<typeof makeTask>;
}

function makeProvider(id: string) {
    return defineProvider({
        id,
        name: `Provider ${id}`,
        version: '1.0.0',
        capabilities: {},
        async isConfigured() {
            return true;
        },
        async search() {
            return [];
        },
        async detail() {
            return {};
        },
    });
}

function makeTrickplay(id: string) {
    return defineTrickplayProvider({
        id,
        capabilities: {},
        async fetchParams() {
            return null;
        },
    });
}

function makeWatchSync(id: string) {
    return defineWatchSync({
        id,
        name: id,
        version: '1.0.0',
        providerName: id,
        capabilities: {},
        async isAvailable() {
            return true;
        },
        async resolveIds() {
            return [];
        },
        async pushWatchState() {
            return {
                succeeded: 0,
                failed: 0,
                skipped: 0,
                staleIds: [],
                errors: [],
                successful: [],
                drainedAsSkipped: [],
            };
        },
    });
}

function makeFeature(id: string) {
    // defineFeature requires at least one route — the empty-routes fixture
    // was valid against the older SDK contract but rejects now. Use a
    // minimal noop route so the registry test exercises registration, not
    // SDK validation.
    return defineFeature({
        id,
        routes: [
            {
                path: `/__test__/${id}`,
                method: 'GET' as const,
                handler: async () => new Response('ok'),
            },
        ],
    });
}

function makeIntegration(id: string) {
    return defineIntegration({
        id,
        capabilities: {},
        async handleWebhook() {
            return {};
        },
    });
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('TaskRegistry', () => {
    let reg: TaskRegistry;

    beforeEach(() => {
        reg = new TaskRegistry();
    });

    // -------------------------------------------------------------------------
    // 1. Register and lookup each of the 6 contract types
    // -------------------------------------------------------------------------

    describe('register and lookup', () => {
        it('registers and retrieves a task', () => {
            const task = makeTask('my-task');
            reg.registerTask(task);
            expect(reg.getTask('my-task')).toBe(task);
            expect(reg.getAllTasks()).toHaveLength(1);
        });

        it('registers and retrieves a provider', () => {
            const p = makeProvider('tmdb');
            reg.registerProvider(p);
            expect(reg.getProvider('tmdb')).toBe(p);
            expect(reg.getAllProviders()).toHaveLength(1);
        });

        it('registers and retrieves a trickplay provider', () => {
            const p = makeTrickplay('local-trickplay');
            reg.registerTrickplay(p);
            expect(reg.getTrickplay('local-trickplay')).toBe(p);
            expect(reg.getAllTrickplays()).toHaveLength(1);
        });

        it('registers and retrieves a watch-sync', () => {
            const p = makeWatchSync('jellyfin-sync');
            reg.registerWatchSync(p);
            expect(reg.getWatchSync('jellyfin-sync')).toBe(p);
            expect(reg.getAllWatchSyncs()).toHaveLength(1);
        });

        it('registers and retrieves a feature', () => {
            const f = makeFeature('holiday-recs');
            reg.registerFeature(f);
            expect(reg.getFeature('holiday-recs')).toBe(f);
            expect(reg.getAllFeatures()).toHaveLength(1);
        });

        it('registers and retrieves an integration', () => {
            const i = makeIntegration('sonarr');
            reg.registerIntegration(i);
            expect(reg.getIntegration('sonarr')).toBe(i);
            expect(reg.getAllIntegrations()).toHaveLength(1);
        });

        it('returns undefined for unknown ids', () => {
            expect(reg.getTask('missing')).toBeUndefined();
            expect(reg.getProvider('missing')).toBeUndefined();
            expect(reg.getTrickplay('missing')).toBeUndefined();
            expect(reg.getWatchSync('missing')).toBeUndefined();
            expect(reg.getFeature('missing')).toBeUndefined();
            expect(reg.getIntegration('missing')).toBeUndefined();
        });
    });

    // -------------------------------------------------------------------------
    // 2. Duplicate registration throws
    // -------------------------------------------------------------------------

    describe('duplicate registration', () => {
        it('throws on duplicate task id', () => {
            reg.registerTask(makeTask('dup-task'));
            expect(() => reg.registerTask(makeTask('dup-task'))).toThrow(/duplicate task id/);
        });

        it('throws on duplicate provider id', () => {
            reg.registerProvider(makeProvider('dup-prov'));
            expect(() => reg.registerProvider(makeProvider('dup-prov'))).toThrow(
                /duplicate provider id/,
            );
        });

        it('throws on duplicate trickplay id', () => {
            reg.registerTrickplay(makeTrickplay('dup-tp'));
            expect(() => reg.registerTrickplay(makeTrickplay('dup-tp'))).toThrow(
                /duplicate trickplay provider id/,
            );
        });

        it('throws on duplicate watch-sync id', () => {
            reg.registerWatchSync(makeWatchSync('dup-ws'));
            expect(() => reg.registerWatchSync(makeWatchSync('dup-ws'))).toThrow(
                /duplicate watch-sync id/,
            );
        });

        it('throws on duplicate feature id', () => {
            reg.registerFeature(makeFeature('dup-feat'));
            expect(() => reg.registerFeature(makeFeature('dup-feat'))).toThrow(
                /duplicate feature id/,
            );
        });

        it('throws on duplicate integration id', () => {
            reg.registerIntegration(makeIntegration('dup-int'));
            expect(() => reg.registerIntegration(makeIntegration('dup-int'))).toThrow(
                /duplicate integration id/,
            );
        });
    });

    // -------------------------------------------------------------------------
    // 2b. Cross-contract id collision throws
    // -------------------------------------------------------------------------

    describe('cross-contract id collision', () => {
        it('throws when a provider reuses an id already taken by a task', () => {
            reg.registerTask(makeTask('shared-id'));
            expect(() => reg.registerProvider(makeProvider('shared-id'))).toThrow(
                /shared-id.*task.*provider|shared-id.*provider.*task/,
            );
        });

        it('throws when a trickplay reuses an id already taken by a task', () => {
            // Use the trickplay fixture (no fixture-side validation issues) to
            // exercise a non-self-pair of contract types.
            reg.registerTask(makeTask('shared-id-2'));
            expect(() => reg.registerTrickplay(makeTrickplay('shared-id-2'))).toThrow(
                /shared-id-2/,
            );
        });

        it('error message mentions both existing and new contract types', () => {
            reg.registerTask(makeTask('collide-id'));
            let caught: unknown;
            try {
                reg.registerProvider(makeProvider('collide-id'));
            } catch (e) {
                caught = e;
            }
            expect(caught).toBeInstanceOf(Error);
            const msg = (caught as Error).message;
            expect(msg).toContain('task');
            expect(msg).toContain('provider');
            expect(msg).toContain('collide-id');
        });
    });

    // -------------------------------------------------------------------------
    // 3. Invalid ID format throws on validateAt
    // -------------------------------------------------------------------------

    describe('validateAt — id format', () => {
        it('throws for task id with uppercase (injected via internal map)', () => {
            // defineTask validates IDs at registration, so we inject directly into
            // the backing map to test registry-level cross-task validation independently.
            const bad = {
                ...makeTask('good-id'),
                id: 'BadTask',
            } as TaskDefinition<unknown, unknown>;
            injectBadTask(reg, bad);
            expect(() => reg.validateAt('startup')).toThrow(/invalid task id/);
        });

        it('throws for task id starting with digit', () => {
            const bad = {
                ...makeTask('good-id'),
                id: '1bad',
            } as TaskDefinition<unknown, unknown>;
            injectBadTask(reg, bad);
            expect(() => reg.validateAt('startup')).toThrow(/invalid task id/);
        });

        it('throws for provider id with space', () => {
            const bad = {
                ...makeProvider('good'),
                id: 'bad id',
            } as ProviderDefinition<unknown, unknown>;
            injectBadProvider(reg, bad);
            expect(() => reg.validateAt('startup')).toThrow(/invalid provider id/);
        });

        it('passes for valid kebab-case ids', () => {
            reg.registerTask(makeTask('file-system-scan'));
            reg.registerProvider(makeProvider('tmdb'));
            expect(() => reg.validateAt('startup')).not.toThrow();
        });
    });

    // -------------------------------------------------------------------------
    // 4. processingVersion = 0 throws on validateAt
    // -------------------------------------------------------------------------

    describe('validateAt — processingVersion', () => {
        it('throws when processingVersion is 0', () => {
            reg.registerTask(makeUnvalidatedTask('pv-zero', { processingVersion: 0 }));
            expect(() => reg.validateAt('startup')).toThrow(
                /processingVersion must be a positive integer/,
            );
        });

        it('throws when processingVersion is negative', () => {
            reg.registerTask(makeUnvalidatedTask('pv-neg', { processingVersion: -1 }));
            expect(() => reg.validateAt('startup')).toThrow(/processingVersion/);
        });

        it('throws when processingVersion is non-integer', () => {
            reg.registerTask(makeUnvalidatedTask('pv-float', { processingVersion: 1.5 }));
            expect(() => reg.validateAt('startup')).toThrow(/processingVersion/);
        });

        it('passes for processingVersion = 1', () => {
            reg.registerTask(makeTask('pv-one', { processingVersion: 1 }));
            expect(() => reg.validateAt('startup')).not.toThrow();
        });

        it('passes for processingVersion = 42', () => {
            reg.registerTask(makeTask('pv-large', { processingVersion: 42 }));
            expect(() => reg.validateAt('startup')).not.toThrow();
        });
    });

    // -------------------------------------------------------------------------
    // 5. Pipeline with valid linear DAG → topological order correct
    // -------------------------------------------------------------------------

    describe('resolvePipeline — linear DAG', () => {
        it('returns tasks in dependency order for A → B → C', () => {
            const a = makeTask('scan', {
                pipeline: { of: 'ingest', after: [] },
            });
            const b = makeTask('enrich', {
                pipeline: { of: 'ingest', after: ['scan'] },
            });
            const c = makeTask('embed', {
                pipeline: { of: 'ingest', after: ['enrich'] },
            });

            reg.registerTask(a);
            reg.registerTask(b);
            reg.registerTask(c);

            const ordered = reg.resolvePipeline('ingest');
            const ids = ordered.map((t) => t.id);

            expect(ids.indexOf('scan')).toBeLessThan(ids.indexOf('enrich'));
            expect(ids.indexOf('enrich')).toBeLessThan(ids.indexOf('embed'));
        });
    });

    // -------------------------------------------------------------------------
    // 6. Pipeline with diamond DAG → topological order respects all dependencies
    // -------------------------------------------------------------------------

    describe('resolvePipeline — diamond DAG', () => {
        it('resolves diamond A → B, A → C, B+C → D', () => {
            const a = makeTask('step-a', { pipeline: { of: 'diamond' } });
            const b = makeTask('step-b', {
                pipeline: { of: 'diamond', after: ['step-a'] },
            });
            const c = makeTask('step-c', {
                pipeline: { of: 'diamond', after: ['step-a'] },
            });
            const d = makeTask('step-d', {
                pipeline: { of: 'diamond', after: ['step-b', 'step-c'] },
            });

            reg.registerTask(a);
            reg.registerTask(b);
            reg.registerTask(c);
            reg.registerTask(d);

            const ordered = reg.resolvePipeline('diamond');
            const idx = (id: string) => ordered.findIndex((t) => t.id === id);

            expect(idx('step-a')).toBeLessThan(idx('step-b'));
            expect(idx('step-a')).toBeLessThan(idx('step-c'));
            expect(idx('step-b')).toBeLessThan(idx('step-d'));
            expect(idx('step-c')).toBeLessThan(idx('step-d'));
        });
    });

    // -------------------------------------------------------------------------
    // 7. Pipeline with cycle throws with cycle path
    // -------------------------------------------------------------------------

    describe('resolvePipeline — cycle detection', () => {
        it('throws for A → B → C → A', () => {
            const a = makeTask('cycle-a', {
                pipeline: { of: 'cycle-pipe', after: ['cycle-c'] },
            });
            const b = makeTask('cycle-b', {
                pipeline: { of: 'cycle-pipe', after: ['cycle-a'] },
            });
            const c = makeTask('cycle-c', {
                pipeline: { of: 'cycle-pipe', after: ['cycle-b'] },
            });

            reg.registerTask(a);
            reg.registerTask(b);
            reg.registerTask(c);

            expect(() => reg.resolvePipeline('cycle-pipe')).toThrow(/cycle/i);
        });

        it('throws for self-reference A → A at defineTask validation time', () => {
            // The SDK now catches self-references at defineTask validation, so
            // the cycle never reaches resolvePipeline. Expectation updated to
            // match the earlier — and more useful — failure mode.
            expect(() =>
                makeTask('self-ref', {
                    pipeline: { of: 'self-pipe', after: ['self-ref'] },
                }),
            ).toThrow(/own id/i);
        });
    });

    // -------------------------------------------------------------------------
    // 8. Pipeline after: references missing task → throws
    // -------------------------------------------------------------------------

    describe('validateAt — pipeline reference integrity', () => {
        it('throws when after references a task not in the same pipeline', () => {
            const a = makeTask('pipe-task-a', { pipeline: { of: 'pipe-x' } });
            const b = makeTask('pipe-task-b', {
                pipeline: { of: 'pipe-x', after: ['nonexistent-task'] },
            });

            reg.registerTask(a);
            reg.registerTask(b);

            expect(() => reg.validateAt('startup')).toThrow(/nonexistent-task/);
        });

        it('throws when after references a task from a different pipeline', () => {
            const a = makeTask('pipe-y-task', { pipeline: { of: 'pipe-y' } });
            const b = makeTask('pipe-x-task', {
                pipeline: { of: 'pipe-x', after: ['pipe-y-task'] },
            });

            reg.registerTask(a);
            reg.registerTask(b);

            expect(() => reg.validateAt('startup')).toThrow(/not in this pipeline/);
        });

        it('passes for valid cross-pipeline-isolated references', () => {
            const a = makeTask('step-one', { pipeline: { of: 'pipe-v' } });
            const b = makeTask('step-two', {
                pipeline: { of: 'pipe-v', after: ['step-one'] },
            });

            reg.registerTask(a);
            reg.registerTask(b);

            expect(() => reg.validateAt('startup')).not.toThrow();
        });

        it('passes when a pipeline task declares multiple predecessors (gate synthesis supported)', () => {
            const a = makeTask('multi-a', { pipeline: { of: 'multi-pipe' } });
            const b = makeTask('multi-b', { pipeline: { of: 'multi-pipe' } });
            const c = makeTask('multi-c', {
                pipeline: { of: 'multi-pipe', after: ['multi-a', 'multi-b'] },
            });

            reg.registerTask(a);
            reg.registerTask(b);
            reg.registerTask(c);

            expect(() => reg.validateAt('startup')).not.toThrow();
        });

        it('throws at registration (validateAt) for a diamond DAG A→B, A→C, B+C→D', () => {
            // Mirrors the fixture in "resolvePipeline — diamond DAG" above,
            // which shows resolvePipeline() (topological sort alone) happily
            // orders a diamond — the cycle detector doesn't see a problem.
            // pipeline-builder.ts's buildPipelinePlan() rejects this shape at
            // RUN time instead (FlowProducer needs a tree, not a DAG), which
            // violates the fail-fast-at-registration guarantee. validateAt()
            // must catch it at boot instead.
            const a = makeTask('diamond-reg-a', { pipeline: { of: 'diamond-reg' } });
            const b = makeTask('diamond-reg-b', {
                pipeline: { of: 'diamond-reg', after: ['diamond-reg-a'] },
            });
            const c = makeTask('diamond-reg-c', {
                pipeline: { of: 'diamond-reg', after: ['diamond-reg-a'] },
            });
            const d = makeTask('diamond-reg-d', {
                pipeline: { of: 'diamond-reg', after: ['diamond-reg-b', 'diamond-reg-c'] },
            });

            reg.registerTask(a);
            reg.registerTask(b);
            reg.registerTask(c);
            reg.registerTask(d);

            expect(() => reg.validateAt('startup')).toThrow(/diamond-reg-a.*feeds into/s);
        });

        it('throws at registration for a simple fan-out even without reconvergence (A→B, A→C)', () => {
            // The underlying buildPipelinePlan() predicate rejects a
            // predecessor with fan-out >= 2 the moment it is seen twice,
            // regardless of whether the branches ever reconverge downstream.
            const a = makeTask('fanout-a', { pipeline: { of: 'fanout-pipe' } });
            const b = makeTask('fanout-b', {
                pipeline: { of: 'fanout-pipe', after: ['fanout-a'] },
            });
            const c = makeTask('fanout-c', {
                pipeline: { of: 'fanout-pipe', after: ['fanout-a'] },
            });

            reg.registerTask(a);
            reg.registerTask(b);
            reg.registerTask(c);

            expect(() => reg.validateAt('startup')).toThrow(/diamond DAGs/);
        });
    });

    // -------------------------------------------------------------------------
    // 9. Empty getAllTasks() works
    // -------------------------------------------------------------------------

    describe('empty registry', () => {
        it('getAllTasks returns empty array', () => {
            expect(reg.getAllTasks()).toEqual([]);
        });

        it('getAllProviders returns empty array', () => {
            expect(reg.getAllProviders()).toEqual([]);
        });

        it('getAllTrickplays returns empty array', () => {
            expect(reg.getAllTrickplays()).toEqual([]);
        });

        it('getAllWatchSyncs returns empty array', () => {
            expect(reg.getAllWatchSyncs()).toEqual([]);
        });

        it('getAllFeatures returns empty array', () => {
            expect(reg.getAllFeatures()).toEqual([]);
        });

        it('getAllIntegrations returns empty array', () => {
            expect(reg.getAllIntegrations()).toEqual([]);
        });

        it('validateAt on empty registry does not throw', () => {
            expect(() => reg.validateAt('startup')).not.toThrow();
        });
    });

    // -------------------------------------------------------------------------
    // 10. resolvePipeline('nonexistent') throws
    // -------------------------------------------------------------------------

    describe('resolvePipeline — nonexistent pipeline', () => {
        it('throws for an unknown pipeline name', () => {
            expect(() => reg.resolvePipeline('does-not-exist')).toThrow(
                /no tasks in pipeline "does-not-exist"/,
            );
        });

        it('throws even when other pipelines exist', () => {
            reg.registerTask(makeTask('known-task', { pipeline: { of: 'known-pipe' } }));
            expect(() => reg.resolvePipeline('unknown-pipe')).toThrow(/no tasks in pipeline/);
        });
    });

    // -------------------------------------------------------------------------
    // 11. validateFeedsInto
    // -------------------------------------------------------------------------

    describe('validateFeedsInto', () => {
        it('passes when declared edge points at a known task', () => {
            reg.registerTask(makeTask('upstream-task', { feedsInto: ['downstream-task'] }));
            reg.registerTask(makeTask('downstream-task'));
            expect(() => reg.validateAt('startup')).not.toThrow();
        });

        it('throws when feedsInto references an unknown task, message includes upstream and downstream', () => {
            reg.registerTask(makeTask('upstream-task', { feedsInto: ['missing-task'] }));
            expect(() => reg.validateAt('startup')).toThrow(/upstream-task/);
            expect(() => {
                const r = new TaskRegistry();
                r.registerTask(makeTask('src-task', { feedsInto: ['ghost-task'] }));
                r.validateAt('startup');
            }).toThrow(/ghost-task/);
        });

        it('throws for a self-loop', () => {
            reg.registerTask(makeTask('self-task', { feedsInto: ['self-task'] }));
            expect(() => reg.validateAt('startup')).toThrow(/self-loop/);
        });
    });

    // -------------------------------------------------------------------------
    // coversStages validation
    // -------------------------------------------------------------------------

    describe('coversStages validation', () => {
        it('accepts unique stage IDs across tasks', () => {
            const taskA = makeTask('covers-a', {
                coversStages: [
                    { id: 'stage-1', appliesTo: ['movie'] },
                    { id: 'stage-2', appliesTo: ['movie'] },
                ],
            });
            const taskB = makeTask('covers-b', {
                coversStages: [{ id: 'stage-3', appliesTo: ['movie'] }],
            });
            reg.registerTask(taskA);
            reg.registerTask(taskB);
            expect(reg.allStageIds().sort()).toEqual(['stage-1', 'stage-2', 'stage-3']);
        });

        it('rejects duplicate stage IDs across tasks', () => {
            const taskA = makeTask('covers-dup-a', {
                coversStages: [{ id: 'shared-stage', appliesTo: ['movie'] }],
            });
            const taskB = makeTask('covers-dup-b', {
                coversStages: [{ id: 'shared-stage', appliesTo: ['movie'] }],
            });
            reg.registerTask(taskA);
            expect(() => reg.registerTask(taskB)).toThrow(/duplicate stage id: shared-stage/i);
        });

        it('error message names both the existing and new task', () => {
            const taskA = makeTask('owner-task', {
                coversStages: [{ id: 'contested-stage', appliesTo: ['movie'] }],
            });
            const taskB = makeTask('interloper-task', {
                coversStages: [{ id: 'contested-stage', appliesTo: ['movie'] }],
            });
            reg.registerTask(taskA);
            let caught: unknown;
            try {
                reg.registerTask(taskB);
            } catch (e) {
                caught = e;
            }
            expect(caught).toBeInstanceOf(Error);
            const msg = (caught as Error).message;
            expect(msg).toContain('owner-task');
            expect(msg).toContain('interloper-task');
        });

        it('returns empty array from allStageIds() when no task declares coversStages', () => {
            reg.registerTask(makeTask('plain-task'));
            expect(reg.allStageIds()).toEqual([]);
        });

        it('accepts a task with no coversStages field alongside one that does', () => {
            reg.registerTask(makeTask('no-stages'));
            reg.registerTask(
                makeTask('has-stages', {
                    coversStages: [{ id: 'unique-stage', appliesTo: ['movie'] }],
                }),
            );
            expect(reg.allStageIds()).toEqual(['unique-stage']);
        });

        it('collects stage IDs from multiple tasks correctly', () => {
            reg.registerTask(
                makeTask('multi-a', {
                    coversStages: [
                        { id: 'ms-1', appliesTo: ['movie'] },
                        { id: 'ms-2', appliesTo: ['series'] },
                    ],
                }),
            );
            reg.registerTask(
                makeTask('multi-b', {
                    coversStages: [{ id: 'ms-3', appliesTo: ['episode'] }],
                }),
            );
            reg.registerTask(makeTask('multi-c'));
            expect(reg.allStageIds().sort()).toEqual(['ms-1', 'ms-2', 'ms-3']);
        });
    });

    // -------------------------------------------------------------------------
    // Static load()
    // -------------------------------------------------------------------------

    describe('TaskRegistry.load()', () => {
        it('returns an empty registry (no builtins wired yet)', async () => {
            const r = await TaskRegistry.load();
            expect(r).toBeInstanceOf(TaskRegistry);
            expect(r.getAllTasks()).toHaveLength(0);
        });
    });

    // -------------------------------------------------------------------------
    // classifyTriggers — boot audit support
    // -------------------------------------------------------------------------

    describe('TaskRegistry.classifyTriggers()', () => {
        it('classifies a static-schedule task as kind=static with cadence', () => {
            reg.registerTask(makeTask('s1', { schedule: { every: '12h' } }));
            const cov = reg.classifyTriggers();
            expect(cov.get('s1')).toEqual({ kind: 'static', every: '12h' });
        });

        it('classifies a dynamicSchedule task as kind=dynamic with sweepEvery', () => {
            reg.registerTask(
                makeTask('d1', {
                    dynamicSchedule: {
                        loader: async () => [],
                        sweepEvery: '10m',
                    },
                }),
            );
            const cov = reg.classifyTriggers();
            expect(cov.get('d1')).toEqual({
                kind: 'dynamic',
                sweepEvery: '10m',
            });
        });

        it('defaults dynamicSchedule.sweepEvery to "5m" when unspecified', () => {
            reg.registerTask(makeTask('d2', { dynamicSchedule: { loader: async () => [] } }));
            const cov = reg.classifyTriggers();
            expect(cov.get('d2')).toEqual({
                kind: 'dynamic',
                sweepEvery: '5m',
            });
        });

        it('classifies a demo task as kind=demo, ignoring trigger absence', () => {
            reg.registerTask(makeTask('demo1', { demo: true }));
            const cov = reg.classifyTriggers();
            expect(cov.get('demo1')).toEqual({ kind: 'demo' });
        });

        it('classifies a manualOnly task as kind=manual-only', () => {
            reg.registerTask(makeTask('m1', { manualOnly: true }));
            const cov = reg.classifyTriggers();
            expect(cov.get('m1')).toEqual({ kind: 'manual-only' });
        });

        it('classifies a task with an enqueueable covered stage as kind=coverage', () => {
            // Triggered by the stage-sweep (enqueues coversStages[].enqueueable
            // tasks), so it must NOT be flagged as an orphan by the boot audit.
            reg.registerTask(
                makeTask('cov1', {
                    // Declarative Stage Contract is fail-closed: an enqueueable
                    // stage must declare a terminalDisposition or registration throws.
                    coversStages: [
                        {
                            id: 'cov1',
                            appliesTo: ['movie'],
                            enqueueable: true,
                            terminalDisposition: {
                                kind: 'self-terminal',
                                ruleId: 'cov1-self-terminal',
                            },
                        },
                    ],
                }),
            );
            const cov = reg.classifyTriggers();
            expect(cov.get('cov1')).toEqual({ kind: 'coverage' });
        });

        it('does NOT treat a non-enqueueable covered stage as a trigger', () => {
            reg.registerTask(
                makeTask('cov2', {
                    coversStages: [{ id: 'cov2', appliesTo: ['movie'], enqueueable: false }],
                }),
            );
            const cov = reg.classifyTriggers();
            expect(cov.get('cov2')).toEqual({ kind: 'unknown' });
        });

        // Declarative Stage Contract (Phase 3) — fail-closed. An enqueueable
        // stage with no terminalDisposition can wedge (a pending row it cannot
        // process survives every drain cycle), so registration MUST throw. This
        // is the structural guarantee that makes the wedge bug class impossible.
        it('THROWS when an enqueueable stage declares no terminalDisposition', () => {
            expect(() =>
                reg.registerTask(
                    makeTask('cov-nodisp', {
                        coversStages: [
                            {
                                id: 'cov-nodisp',
                                appliesTo: ['movie'],
                                enqueueable: true,
                            },
                        ],
                    }),
                ),
            ).toThrow(/terminalDisposition/);
        });

        it('does NOT throw for a non-enqueueable stage without a disposition', () => {
            expect(() =>
                reg.registerTask(
                    makeTask('cov-descriptive', {
                        coversStages: [
                            {
                                id: 'cov-descriptive',
                                appliesTo: ['movie'],
                                enqueueable: false,
                            },
                        ],
                    }),
                ),
            ).not.toThrow();
        });

        it('classifies a pipeline child as kind=pipeline-child with parent id', () => {
            reg.registerTask(makeTask('parent', { schedule: { every: '1h' } }));
            reg.registerTask(makeTask('child', { pipeline: { of: 'parent' } }));
            const cov = reg.classifyTriggers();
            expect(cov.get('child')).toEqual({
                kind: 'pipeline-child',
                parent: 'parent',
            });
        });

        it('reports kind=unknown for a registered task with NO trigger declaration', () => {
            // This is the bug class livetv hit: registered, but nothing fires it.
            // classifyTriggers must surface this so the boot audit can fail loudly.
            reg.registerTask(makeTask('orphan'));
            const cov = reg.classifyTriggers();
            expect(cov.get('orphan')).toEqual({ kind: 'unknown' });
        });

        it('returns coverage for every registered task (no silent drops)', () => {
            reg.registerTask(makeTask('a', { schedule: { every: '12h' } }));
            reg.registerTask(makeTask('b', { manualOnly: true }));
            reg.registerTask(makeTask('c', { demo: true }));
            reg.registerTask(makeTask('d'));
            const cov = reg.classifyTriggers();
            expect(cov.size).toBe(4);
            expect(cov.has('a')).toBe(true);
            expect(cov.has('b')).toBe(true);
            expect(cov.has('c')).toBe(true);
            expect(cov.has('d')).toBe(true);
        });

        it('a demo task combined with schedule is rejected at registration (T9-demo-invariant)', () => {
            // Fix plan 6, ruling T9-demo-invariant: classifyTriggers() resolves
            // `demo` BEFORE `schedule`, so a demo task that also carried a
            // schedule used to classify as `demo` and silently poll fake work
            // in production while being exempted from the orphan audit.
            // registerTask() now refuses the combination outright instead of
            // relying on classification order to paper over it — see
            // registry.demo-invariant.test.ts for the full RED/GREEN coverage.
            expect(() =>
                reg.registerTask(
                    makeTask('demo-with-schedule', {
                        demo: true,
                        schedule: { every: '1h' },
                    }),
                ),
            ).toThrow(/demo: true task declares an automatic trigger/);
        });

        it('static schedule wins over manualOnly when both are present', () => {
            // SDK validation rejects this combo at defineTask time. If a
            // hand-crafted bypass gets through, prefer the more specific
            // trigger source. Construct the bad task by post-mutating a
            // schedule-only one so defineTask validation is happy.
            const base = makeTask('multi', { schedule: { every: '1h' } });
            (base as unknown as { manualOnly: boolean }).manualOnly = true;
            injectBadTask(reg, base as unknown as TaskDefinition<unknown, unknown>);
            const cov = reg.classifyTriggers();
            expect(cov.get('multi')?.kind).toBe('static');
        });
    });

    // ── Wave 8.5: legacy-class compat shim (FEATURE_PER_TASK_QUEUES on) ─────────
    describe('legacy-class compat shim', () => {
        it('leaves legacy classes untouched when the flag is off (default)', () => {
            const off = new TaskRegistry({ perTaskQueues: false });
            off.registerTask(makeTask('ingest-task', { resourceClass: 'ingest' }));
            const t = off.getTask('ingest-task')!;
            expect(t.resourceClass).toBe('ingest');
            expect(t.declaredResourceClass).toBeUndefined();
        });

        it('rewrites ingest→io + defaults maxConcurrent when the flag is on', () => {
            const on = new TaskRegistry({ perTaskQueues: true });
            on.registerTask(makeTask('ingest-task', { resourceClass: 'ingest' }));
            const t = on.getTask('ingest-task')!;
            expect(t.resourceClass).toBe('io');
            expect(t.declaredResourceClass).toBe('ingest');
            // TASK-H8: the ingest default maxConcurrent was synced to
            // LUMASTRA_CONCURRENCY_INGEST (2), down from the original 4.
            expect(t.quotas?.maxConcurrent).toBe(2);
        });

        it('rewrites analysis→cpu with maxConcurrent default 1', () => {
            const on = new TaskRegistry({ perTaskQueues: true });
            on.registerTask(makeTask('analysis-task', { resourceClass: 'analysis' }));
            const t = on.getTask('analysis-task')!;
            expect(t.resourceClass).toBe('cpu');
            expect(t.declaredResourceClass).toBe('analysis');
            expect(t.quotas?.maxConcurrent).toBe(1);
        });

        it('preserves an author-set maxConcurrent over the legacy default', () => {
            const on = new TaskRegistry({ perTaskQueues: true });
            on.registerTask(
                makeTask('bulk-task', {
                    resourceClass: 'bulk',
                    quotas: { maxConcurrent: 3 },
                }),
            );
            const t = on.getTask('bulk-task')!;
            expect(t.resourceClass).toBe('io');
            expect(t.quotas?.maxConcurrent).toBe(3);
        });

        it('does not touch physical classes', () => {
            const on = new TaskRegistry({ perTaskQueues: true });
            on.registerTask(makeTask('cpu-task', { resourceClass: 'cpu' }));
            const t = on.getTask('cpu-task')!;
            expect(t.resourceClass).toBe('cpu');
            expect(t.declaredResourceClass).toBeUndefined();
        });
    });
});
