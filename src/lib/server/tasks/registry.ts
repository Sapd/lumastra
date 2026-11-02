// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type {
    TaskDefinition,
    ProviderDefinition,
    TrickplayProviderDefinition,
    WatchSyncDefinition,
    FeatureDefinition,
    IntegrationDefinition,
    ExternalServiceDefinition,
    MediaSourceDefinition,
    SubtitleProviderDefinition,
    LyricsProviderDefinition,
    AuthProviderDefinition,
    ResourceClass,
    SettingField,
} from '@sapd/lumastra-plugin-sdk';
import { PluginDefinitionError } from '@sapd/lumastra-plugin-sdk';
import { Logger } from '$lib/server/utils/logger.js';
import {
    FEATURE_PER_TASK_QUEUES,
    LUMASTRA_CONCURRENCY_ANALYSIS,
    LUMASTRA_CONCURRENCY_BULK,
    LUMASTRA_CONCURRENCY_INGEST,
} from '$lib/server/config.js';
import { validateTerminalDisposition } from './stage-disposition-validation.js';
import { ID_PATTERN } from './plugin-id.js';

export { ID_PATTERN } from './plugin-id.js';

/**
 * Wave 8.5 — legacy fairness-lane class → physical budget class mapping.
 * When FEATURE_PER_TASK_QUEUES is on, a task declaring one of these classes is
 * rewritten at registration: `resourceClass` becomes the physical class (which
 * drives the budget semaphore + QueueEvents grouping) and `quotas.maxConcurrent`
 * defaults to the legacy class's effective concurrency when the author left it
 * unset. The declared value is preserved on `declaredResourceClass` for admin
 * surfaces. Flag-off, the legacy classes keep their own per-class queues and
 * this shim is a no-op.
 *
 * `defaultMaxConcurrent` is the legacy class's configured concurrency
 * (`LUMASTRA_CONCURRENCY_INGEST/_BULK/_ANALYSIS`), read at call time, so an
 * operator who raises a legacy knob raises the per-task cap too. This used to
 * be a hand-copied literal that drifted from config (TASK-H8), and it kept a
 * cap of 3 on bulk tasks while the configured default was 1.
 */
function legacyClassMapping(
    cls: ResourceClass,
): { physical: ResourceClass; defaultMaxConcurrent: number } | undefined {
    switch (cls) {
        case 'ingest':
            return { physical: 'io', defaultMaxConcurrent: LUMASTRA_CONCURRENCY_INGEST };
        case 'bulk':
            return { physical: 'io', defaultMaxConcurrent: LUMASTRA_CONCURRENCY_BULK };
        case 'analysis':
            return { physical: 'cpu', defaultMaxConcurrent: LUMASTRA_CONCURRENCY_ANALYSIS };
        default:
            return undefined;
    }
}

/**
 * Contract types tracked by the cross-contract id table. Two definitions of
 * different types sharing the same id is treated as a misconfiguration — see
 * `assertIdAvailable()` below.
 */
type ContractKind =
    | 'task'
    | 'provider'
    | 'trickplay'
    | 'watch-sync'
    | 'feature'
    | 'integration'
    | 'external-service'
    | 'media-source'
    | 'subtitle-provider'
    | 'lyrics-provider'
    | 'auth-provider';

/**
 * Normalized shape returned by `getConfigurable()` — the minimal surface the
 * admin settings route (/api/admin/plugins/[id]/settings) needs to read and
 * persist a plugin's settings, regardless of which contract kind declared
 * them. `onConfigChange` is only ever populated for tasks (the sole contract
 * with a config-change lifecycle hook); all other kinds leave it undefined.
 */
export interface ConfigurableDefinition {
    id: string;
    name?: string;
    settings?: { fields: SettingField[] };
    onConfigChange?: NonNullable<TaskDefinition['lifecycle']>['onConfigChange'];
}

const log = Logger.for('TaskRegistry');

// ---------------------------------------------------------------------------
// Trigger coverage — see TaskRegistry.classifyTriggers()
// ---------------------------------------------------------------------------

export type TriggerCoverage =
    | { kind: 'demo' }
    | { kind: 'static'; every: string }
    | { kind: 'dynamic'; sweepEvery: string }
    | { kind: 'pipeline-child'; parent: string }
    | { kind: 'coverage' }
    | { kind: 'manual-only' }
    | { kind: 'unknown' };

// ---------------------------------------------------------------------------
// Kahn's algorithm — topological sort with cycle detection
// ---------------------------------------------------------------------------

function topologicalSort(
    tasks: TaskDefinition[],
    deps: (t: TaskDefinition) => string[],
): TaskDefinition[] {
    const idToTask = new Map<string, TaskDefinition>(tasks.map((t) => [t.id, t]));
    const inDegree = new Map<string, number>(tasks.map((t) => [t.id, 0]));
    const adjacency = new Map<string, string[]>(tasks.map((t) => [t.id, []]));

    for (const task of tasks) {
        for (const depId of deps(task)) {
            adjacency.get(depId)!.push(task.id);
            inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
        }
    }

    const queue: string[] = [];
    for (const [id, degree] of inDegree) {
        if (degree === 0) queue.push(id);
    }

    const result: TaskDefinition[] = [];
    while (queue.length > 0) {
        const current = queue.shift()!;
        result.push(idToTask.get(current)!);
        for (const neighbor of adjacency.get(current) ?? []) {
            const newDegree = (inDegree.get(neighbor) ?? 0) - 1;
            inDegree.set(neighbor, newDegree);
            if (newDegree === 0) queue.push(neighbor);
        }
    }

    if (result.length !== tasks.length) {
        const cycleIds = tasks.map((t) => t.id).filter((id) => !result.some((r) => r.id === id));
        throw new Error(`Pipeline cycle detected among tasks: [${cycleIds.join(', ')}]`);
    }

    return result;
}

// ---------------------------------------------------------------------------
// TaskRegistry
// ---------------------------------------------------------------------------

export class TaskRegistry {
    private readonly tasks = new Map<string, TaskDefinition>();
    private readonly providers = new Map<string, ProviderDefinition>();
    private readonly trickplays = new Map<string, TrickplayProviderDefinition>();
    private readonly watchSyncs = new Map<string, WatchSyncDefinition>();
    private readonly features = new Map<string, FeatureDefinition>();
    private readonly integrations = new Map<string, IntegrationDefinition>();
    private readonly externalServices = new Map<string, ExternalServiceDefinition>();
    private readonly mediaSources = new Map<string, MediaSourceDefinition>();
    private readonly subtitleProviders = new Map<string, SubtitleProviderDefinition>();
    private readonly lyricsProviders = new Map<string, LyricsProviderDefinition>();
    private readonly authProviders = new Map<string, AuthProviderDefinition>();

    /**
     * Stage id → task id map. Populated by `validateCoversStages` on each
     * `registerTask` call. Ensures no two tasks claim the same stage id.
     */
    private readonly stageIds = new Map<string, string>();

    /**
     * Cross-contract id → contract-kind table. Each `register*` method enters
     * its id here in addition to its own Map so that an id collision across
     * contract types (e.g. a task and a provider both calling themselves
     * `tmdb`) is caught at registration time rather than silently producing
     * two valid lookups under the same string.
     *
     * Two contracts of different types sharing an id is a misconfiguration:
     * any code that resolves "the plugin called X" needs an unambiguous
     * answer. We throw (rather than soft-warn) so the boot loader fails fast.
     */
    private readonly _allRegisteredIds = new Map<string, ContractKind>();

    /**
     * Whether the per-task-queue legacy-class compat shim is active. Defaults to
     * the `FEATURE_PER_TASK_QUEUES` flag; overridable in tests.
     */
    private readonly perTaskQueues: boolean;

    constructor(opts: { perTaskQueues?: boolean } = {}) {
        this.perTaskQueues = opts.perTaskQueues ?? FEATURE_PER_TASK_QUEUES;
    }

    /**
     * Guard helper: assert that `id` is not yet registered against any other
     * contract type. If it is, log a `warn` (with both types so an operator
     * scanning logs can locate the collision) and throw a
     * `PluginDefinitionError` so the boot loader surfaces the error path
     * uniformly with manifest-validation failures.
     */
    private assertIdAvailable(id: string, newKind: ContractKind): void {
        const existing = this._allRegisteredIds.get(id);
        if (existing !== undefined && existing !== newKind) {
            log.warn('cross-contract id collision', {
                id,
                existingKind: existing,
                newKind,
            });
            throw new PluginDefinitionError({
                id,
                message:
                    `id "${id}" is already registered as a ${existing} — ` +
                    `cannot also register it as a ${newKind}. Two contracts of ` +
                    `different types sharing an id is a misconfiguration.`,
                phase: 'registration',
                contract: `TaskRegistry.register${newKind[0].toUpperCase()}${newKind.slice(1)}`,
            });
        }
    }

    /**
     * Guard helper: assert that none of the stage ids declared by `task` are
     * already claimed by another task. Throws `PluginDefinitionError` on the
     * first collision found, with a message that names both tasks.
     */
    private validateCoversStages(task: TaskDefinition): void {
        if (!task.coversStages || task.coversStages.length === 0) return;
        for (const stage of task.coversStages) {
            const existing = this.stageIds.get(stage.id);
            if (existing !== undefined) {
                throw new PluginDefinitionError({
                    id: task.id,
                    message: `duplicate stage id: ${stage.id} (declared by both '${existing}' and '${task.id}')`,
                    phase: 'registration',
                    contract: 'TaskRegistry.registerTask',
                });
            }
            // Declarative Stage Contract (Phase 1) — disposition completeness.
            // WARN-ONLY during the phased rollout: see design §4.4 step 1
            // ("land enforcement as warn-not-throw until migration completes").
            validateTerminalDisposition(task.id, stage, (msg) =>
                log.warn(msg, { taskId: task.id, stageId: stage.id }),
            );
        }
        // All clear — record the mappings.
        for (const stage of task.coversStages) {
            this.stageIds.set(stage.id, task.id);
        }
    }

    /**
     * Returns all stage IDs that have been registered across all tasks.
     */
    allStageIds(): string[] {
        return Array.from(this.stageIds.keys());
    }

    /**
     * Guard helper (fix plan 6, ruling T9-demo-invariant): a `demo: true`
     * task must be reachable ONLY through an explicit manual start (the two
     * gated trigger defs — `tasks/[taskId]/run.ts`,
     * `admin/plugins/[pluginId]/index.ts`). `classifyTriggers()` resolves
     * `demo` before it even looks at `schedule`/`dynamicSchedule`, so a demo
     * task that also declared one of those would poll fake work in
     * production AND be silently exempted from the trigger-orphan boot
     * audit — comment convention was the only thing preventing it. Throwing
     * here makes the conflicting declaration unregistrable instead of
     * reordering the classifier to catch it after the fact.
     *
     * Checked automatic triggers: `schedule`, `dynamicSchedule`,
     * `failures.retry` (a per-item retry the un-gated
     * `tasks/[taskId]/failures/[itemId]/retry.ts` route calls directly off the task
     * definition), and any `coversStages[].enqueueable === true` entry (the
     * stage-sweep fires these per item with no trigger-def gate at all).
     * `feedsInto` is NOT checked — it only wires cross-task staleness health
     * probes (`validateFeedsInto()`), it never causes a run. Tasks have no
     * event-subscription field (`subscribes` exists only on
     * `IntegrationDefinition`), so there is nothing to check there.
     */
    private validateDemoInvariant(task: TaskDefinition): void {
        if (!task.demo) return;
        const violations: string[] = [];
        if (task.schedule) violations.push('schedule');
        if (task.dynamicSchedule) violations.push('dynamicSchedule');
        if (task.failures?.retry) violations.push('failures.retry');
        const enqueueableStages = (task.coversStages ?? [])
            .filter((s) => s.enqueueable === true)
            .map((s) => s.id);
        if (enqueueableStages.length > 0) {
            violations.push(`coversStages[${enqueueableStages.join(', ')}].enqueueable`);
        }
        if (violations.length > 0) {
            throw new PluginDefinitionError({
                id: task.id,
                message:
                    `demo: true task declares an automatic trigger (${violations.join(', ')}) — ` +
                    `a demo task may be started only manually (the gated /run and admin ` +
                    `plugin-trigger routes). Remove the trigger or drop 'demo: true'.`,
                phase: 'registration',
                contract: 'TaskRegistry.registerTask',
            });
        }
    }

    // -------------------------------------------------------------------------
    // Registration
    // -------------------------------------------------------------------------

    registerTask<I, R>(task: TaskDefinition<I, R>): void {
        if (this.tasks.has(task.id)) {
            throw new Error(`TaskRegistry: duplicate task id "${task.id}"`);
        }
        this.assertIdAvailable(task.id, 'task');
        this.applyLegacyClassShim(task as TaskDefinition);
        this.validateCoversStages(task as TaskDefinition);
        this.validateDemoInvariant(task as TaskDefinition);
        this.tasks.set(task.id, task as TaskDefinition);
        this._allRegisteredIds.set(task.id, 'task');
    }

    /**
     * Wave 8.5 — rewrite a legacy fairness-lane `resourceClass`
     * (`ingest`/`bulk`/`analysis`) to its physical budget class and default
     * `quotas.maxConcurrent` when the author left it unset. No-op unless the
     * per-task-queue flag is on. Mutates the task in place (defineTask returns
     * an unfrozen object) so every downstream reader sees the physical class.
     */
    private applyLegacyClassShim(task: TaskDefinition): void {
        if (!this.perTaskQueues) return;
        const mapping = legacyClassMapping(task.resourceClass);
        if (!mapping) return;
        task.declaredResourceClass = task.resourceClass;
        task.resourceClass = mapping.physical;
        if (task.quotas?.maxConcurrent === undefined) {
            task.quotas = {
                ...(task.quotas ?? {}),
                maxConcurrent: mapping.defaultMaxConcurrent,
            };
        }
        // debug, not info: it runs for every bundled legacy-lane task on every
        // boot and is expected — see legacyClassMapping.
        log.debug('Wave 8.5 legacy-class shim applied', {
            taskId: task.id,
            declared: task.declaredResourceClass,
            physical: task.resourceClass,
            maxConcurrent: task.quotas?.maxConcurrent,
        });
    }

    registerProvider<P, T>(p: ProviderDefinition<P, T>): void {
        if (this.providers.has(p.id)) {
            throw new Error(`TaskRegistry: duplicate provider id "${p.id}"`);
        }
        this.assertIdAvailable(p.id, 'provider');
        this.providers.set(p.id, p as ProviderDefinition);
        this._allRegisteredIds.set(p.id, 'provider');
    }

    registerTrickplay(p: TrickplayProviderDefinition): void {
        if (this.trickplays.has(p.id)) {
            throw new Error(`TaskRegistry: duplicate trickplay provider id "${p.id}"`);
        }
        this.assertIdAvailable(p.id, 'trickplay');
        this.trickplays.set(p.id, p);
        this._allRegisteredIds.set(p.id, 'trickplay');
    }

    registerWatchSync(p: WatchSyncDefinition): void {
        if (this.watchSyncs.has(p.id)) {
            throw new Error(`TaskRegistry: duplicate watch-sync id "${p.id}"`);
        }
        this.assertIdAvailable(p.id, 'watch-sync');
        this.watchSyncs.set(p.id, p);
        this._allRegisteredIds.set(p.id, 'watch-sync');
    }

    registerFeature(f: FeatureDefinition): void {
        if (this.features.has(f.id)) {
            throw new Error(`TaskRegistry: duplicate feature id "${f.id}"`);
        }
        this.assertIdAvailable(f.id, 'feature');
        this.features.set(f.id, f);
        this._allRegisteredIds.set(f.id, 'feature');
    }

    registerIntegration(i: IntegrationDefinition): void {
        if (this.integrations.has(i.id)) {
            throw new Error(`TaskRegistry: duplicate integration id "${i.id}"`);
        }
        this.assertIdAvailable(i.id, 'integration');
        this.integrations.set(i.id, i);
        this._allRegisteredIds.set(i.id, 'integration');
    }

    registerExternalService(svc: ExternalServiceDefinition): void {
        if (this.externalServices.has(svc.id)) {
            throw new Error(`TaskRegistry: duplicate external-service id "${svc.id}"`);
        }
        this.assertIdAvailable(svc.id, 'external-service');
        this.externalServices.set(svc.id, svc);
        this._allRegisteredIds.set(svc.id, 'external-service');
        log.info('external service registered', { id: svc.id });
    }

    registerSubtitleProvider(def: SubtitleProviderDefinition): void {
        if (this.subtitleProviders.has(def.id)) {
            throw new Error(`TaskRegistry: duplicate subtitle-provider id "${def.id}"`);
        }
        this.assertIdAvailable(def.id, 'subtitle-provider');
        this.subtitleProviders.set(def.id, def);
        this._allRegisteredIds.set(def.id, 'subtitle-provider');
        log.info('subtitle provider registered', { id: def.id });
    }

    getSubtitleProvider(id: string): SubtitleProviderDefinition | undefined {
        return this.subtitleProviders.get(id);
    }

    getAllSubtitleProviders(): SubtitleProviderDefinition[] {
        return Array.from(this.subtitleProviders.values());
    }

    registerLyricsProvider(def: LyricsProviderDefinition): void {
        if (this.lyricsProviders.has(def.id)) {
            throw new Error(`TaskRegistry: duplicate lyrics-provider id "${def.id}"`);
        }
        this.assertIdAvailable(def.id, 'lyrics-provider');
        this.lyricsProviders.set(def.id, def);
        this._allRegisteredIds.set(def.id, 'lyrics-provider');
        log.info('lyrics provider registered', { id: def.id });
    }

    getLyricsProvider(id: string): LyricsProviderDefinition | undefined {
        return this.lyricsProviders.get(id);
    }

    getAllLyricsProviders(): LyricsProviderDefinition[] {
        return Array.from(this.lyricsProviders.values());
    }

    registerAuthProvider(def: AuthProviderDefinition): void {
        if (this.authProviders.has(def.id)) {
            throw new Error(`TaskRegistry: duplicate auth-provider id "${def.id}"`);
        }
        this.assertIdAvailable(def.id, 'auth-provider');
        this.authProviders.set(def.id, def);
        this._allRegisteredIds.set(def.id, 'auth-provider');
        // Logged at INFO because an auth provider entering the registry is
        // worth seeing in a boot log even though it is inert until an operator
        // names it in AUTH_PLUGIN_PROVIDERS.
        log.info('auth provider registered (inert until allowlisted)', { id: def.id });
    }

    getAuthProvider(id: string): AuthProviderDefinition | undefined {
        return this.authProviders.get(id);
    }

    getAllAuthProviders(): AuthProviderDefinition[] {
        return Array.from(this.authProviders.values());
    }

    registerMediaSource(def: MediaSourceDefinition): void {
        if (this.mediaSources.has(def.id)) {
            throw new Error(`TaskRegistry: duplicate media-source id "${def.id}"`);
        }
        this.assertIdAvailable(def.id, 'media-source');
        this.mediaSources.set(def.id, def);
        this._allRegisteredIds.set(def.id, 'media-source');
        log.info('media source registered', { id: def.id });
    }

    // -------------------------------------------------------------------------
    // Lookup
    // -------------------------------------------------------------------------

    getTask(id: string): TaskDefinition | undefined {
        return this.tasks.get(id);
    }

    getProvider(id: string): ProviderDefinition | undefined {
        return this.providers.get(id);
    }

    getTrickplay(id: string): TrickplayProviderDefinition | undefined {
        return this.trickplays.get(id);
    }

    getWatchSync(id: string): WatchSyncDefinition | undefined {
        return this.watchSyncs.get(id);
    }

    getFeature(id: string): FeatureDefinition | undefined {
        return this.features.get(id);
    }

    getIntegration(id: string): IntegrationDefinition | undefined {
        return this.integrations.get(id);
    }

    getExternalService(id: string): ExternalServiceDefinition | undefined {
        return this.externalServices.get(id);
    }

    getMediaSource(id: string): MediaSourceDefinition | undefined {
        return this.mediaSources.get(id);
    }

    /**
     * Cross-contract resolver for the admin settings UI. Returns the first
     * registered definition — across EVERY contract kind that can declare a
     * `settings` block — whose id matches, normalized to {@link
     * ConfigurableDefinition}. Only TaskDefinition carries an `onConfigChange`
     * lifecycle hook; for all other kinds it is left undefined.
     *
     * The settings route (/api/admin/plugins/[id]/settings) previously resolved
     * `getTask(id)` alone, so it 404'd for every settings-bearing provider /
     * feature / integration / external-service / media-source / watch-sync —
     * e.g. the OpenAI external service, whose admin "Settings" button opens a
     * modal that GETs this route.
     */
    getConfigurable(id: string): ConfigurableDefinition | undefined {
        const task = this.tasks.get(id);
        if (task) {
            return {
                id,
                name: task.name,
                settings: task.settings,
                onConfigChange: task.lifecycle?.onConfigChange,
            };
        }
        const provider = this.providers.get(id);
        if (provider) return { id, name: provider.name, settings: provider.settings };
        const externalService = this.externalServices.get(id);
        if (externalService)
            return {
                id,
                name: externalService.name,
                settings: externalService.settings,
            };
        const mediaSource = this.mediaSources.get(id);
        if (mediaSource)
            return {
                id,
                name: mediaSource.name,
                settings: mediaSource.settings,
            };
        const watchSync = this.watchSyncs.get(id);
        if (watchSync) return { id, name: watchSync.name, settings: watchSync.settings };
        const feature = this.features.get(id);
        if (feature) return { id, settings: feature.settings };
        const integration = this.integrations.get(id);
        if (integration) return { id, settings: integration.settings };
        return undefined;
    }

    /**
     * Returns the TaskDefinition that owns the given stage id, or undefined if
     * no task has declared that stage. Used by the eager-enqueue path in
     * StageStateService to resolve the owning task without a full scan.
     */
    findTaskByStage(stageId: string): TaskDefinition | undefined {
        const taskId = this.stageIds.get(stageId);
        return taskId ? this.tasks.get(taskId) : undefined;
    }

    /**
     * Cross-contract presence check. Returns true if `id` is registered as ANY
     * contract kind (task / provider / trickplay / watch-sync / feature /
     * integration / external-service / media-source).
     *
     * Used by the hot-load path to skip plugin directories already present on
     * the registry without having to query each per-kind Map individually.
     */
    hasPluginRegistered(id: string): boolean {
        return this._allRegisteredIds.has(id);
    }

    // -------------------------------------------------------------------------
    // Bulk access
    // -------------------------------------------------------------------------

    getAllTasks(): TaskDefinition[] {
        return Array.from(this.tasks.values());
    }

    getAllProviders(): ProviderDefinition[] {
        return Array.from(this.providers.values());
    }

    getAllTrickplays(): TrickplayProviderDefinition[] {
        return Array.from(this.trickplays.values());
    }

    getAllWatchSyncs(): WatchSyncDefinition[] {
        return Array.from(this.watchSyncs.values());
    }

    getAllFeatures(): FeatureDefinition[] {
        return Array.from(this.features.values());
    }

    getAllIntegrations(): IntegrationDefinition[] {
        return Array.from(this.integrations.values());
    }

    getAllExternalServices(): ExternalServiceDefinition[] {
        return Array.from(this.externalServices.values());
    }

    getAllMediaSources(): MediaSourceDefinition[] {
        return Array.from(this.mediaSources.values());
    }

    // -------------------------------------------------------------------------
    // Trigger coverage audit
    // -------------------------------------------------------------------------

    /**
     * Build a map of every registered task to its trigger source. The boot
     * audit consumes this to ensure no task is silently orphaned —
     * registered but with nothing to fire it.
     *
     * Resolution order (first match wins):
     *   demo       → `demo: true` (tutorial-only)
     *   static     → `schedule.every` present
     *   dynamic    → `dynamicSchedule.loader` present
     *   pipeline   → task belongs to a `pipeline.of` group (fired by parent)
     *   manual     → `manualOnly: true` (admin/service-triggered only)
     *   unknown    → none of the above — boot audit fails on this
     */
    classifyTriggers(): Map<string, TriggerCoverage> {
        const result = new Map<string, TriggerCoverage>();
        const tasks = this.getAllTasks();
        const taskIds = new Set(tasks.map((t) => t.id));

        // Pre-compute pipeline membership. A task is a valid pipeline child
        // only if its `pipeline.of` points at an EXISTING task — otherwise
        // the FlowProducer chain has no parent to fire it, so the child is
        // silently orphaned. Treat such cases as `unknown` so the boot
        // audit surfaces them.
        const pipelineMembers = new Set<string>();
        for (const t of tasks) {
            const parentId = t.pipeline?.of;
            if (parentId && parentId !== t.id && taskIds.has(parentId)) {
                pipelineMembers.add(t.id);
            }
        }

        for (const t of tasks) {
            if (t.demo) {
                result.set(t.id, { kind: 'demo' });
            } else if (t.schedule?.every) {
                result.set(t.id, { kind: 'static', every: t.schedule.every });
            } else if (t.dynamicSchedule) {
                result.set(t.id, {
                    kind: 'dynamic',
                    sweepEvery: t.dynamicSchedule.sweepEvery ?? '5m',
                });
            } else if (pipelineMembers.has(t.id)) {
                result.set(t.id, {
                    kind: 'pipeline-child',
                    parent: t.pipeline?.of ?? '',
                });
            } else if (t.coversStages?.some((s) => s.enqueueable === true)) {
                // Triggered by the stage-sweep: it enqueues per-item runs of any
                // task whose covered stage opts in via `coversStages[].enqueueable`
                // (see builtin/native/stage-sweep.ts). That's a real auto-trigger,
                // so these tasks aren't orphans even without schedule/pipeline.
                result.set(t.id, { kind: 'coverage' });
            } else if (t.manualOnly) {
                result.set(t.id, { kind: 'manual-only' });
            } else {
                result.set(t.id, { kind: 'unknown' });
            }
        }
        return result;
    }

    // -------------------------------------------------------------------------
    // Pipeline DAG resolution
    // -------------------------------------------------------------------------

    resolvePipeline(of: string): TaskDefinition[] {
        const members = this.getAllTasks().filter((t) => t.pipeline?.of === of);
        if (members.length === 0) {
            throw new Error(`TaskRegistry: no tasks in pipeline "${of}"`);
        }
        return topologicalSort(members, (t) => t.pipeline?.after ?? []);
    }

    /**
     * Evaluate a task's `pipeline.when` predicate against the parent result.
     * Returns true when the stage should be skipped (predicate returned false).
     * Returns false when:
     *   - the task has no `pipeline.when` (always run), or
     *   - the predicate returns true (run the stage).
     *
     * Called by the runner before invoking `execute()` on pipeline children.
     * When the stage is skipped the runner marks the run `cancelled` with
     * reason "skipped_due_to_pipeline_when".
     */
    shouldSkipStage(task: TaskDefinition, parentResult: unknown): boolean {
        if (!task.pipeline?.when) return false;
        try {
            const result = task.pipeline.when(parentResult) as unknown;
            // Async predicates are NOT supported — Promise.then truthy makes
            // the negation always false, the stage always runs, and the
            // author can spend hours debugging "why does my skip never fire?"
            // Surface the misuse loudly.
            if (
                result &&
                typeof result === 'object' &&
                typeof (result as { then?: unknown }).then === 'function'
            ) {
                throw new Error(
                    `pipeline.when for task '${task.id}' returned a Promise — async ` +
                        `predicates are not supported. Make 'when' return a sync boolean.`,
                );
            }
            return !result;
        } catch (err) {
            // A throwing predicate is treated as "run the stage" so we don't
            // silently drop work, but we surface the error to the registry's
            // logger so the misbehaving predicate doesn't sit invisible.
            log.warn('pipeline.when predicate threw', {
                taskId: task.id,
                err: err instanceof Error ? err.message : String(err),
            });
            return false;
        }
    }

    // -------------------------------------------------------------------------
    // feedsInto validation
    // -------------------------------------------------------------------------

    validateFeedsInto(): void {
        for (const task of this.getAllTasks()) {
            if (!task.feedsInto || task.feedsInto.length === 0) continue;
            for (const ref of task.feedsInto) {
                if (ref === task.id) {
                    throw new Error(
                        `TaskRegistry: task "${task.id}" declares feedsInto: ["${ref}"] — self-loops are not allowed`,
                    );
                }
                const downstream = this.tasks.get(ref);
                if (!downstream) {
                    throw new Error(
                        `TaskRegistry: task "${task.id}" declares feedsInto: ["${ref}"] but "${ref}" is not a registered task`,
                    );
                }
                // Health probes compare against `2 * downstream.schedule.every`,
                // so a downstream without a schedule gets no staleness probe.
                // That is normal for an EVENT-DRIVEN downstream — e.g.
                // file-reconcile → file-delta-ingest, which reconcile enqueues
                // itself and which the edge exists for (trigger coverage), not
                // for a probe. debug, not warn: it was a WARN on every boot that
                // no operator could act on (Windows e2e 2026-09-27).
                if (!downstream.schedule?.every) {
                    log.debug('feedsInto edge has no probe — downstream has no schedule', {
                        upstream: task.id,
                        downstream: ref,
                    });
                }
            }
        }
    }

    // -------------------------------------------------------------------------
    // Validation
    // -------------------------------------------------------------------------

    validateAt(_stage: 'startup' | 'reload'): void {
        // --- Task validations ---
        for (const task of this.getAllTasks()) {
            if (!ID_PATTERN.test(task.id)) {
                throw new Error(
                    `TaskRegistry: invalid task id "${task.id}" (must match /^[a-z][a-z0-9-]*$/)`,
                );
            }
            if (!Number.isInteger(task.processingVersion) || task.processingVersion < 1) {
                throw new Error(
                    `TaskRegistry: task "${task.id}" processingVersion must be a positive integer (got ${task.processingVersion})`,
                );
            }
            // A per-stage override has to satisfy the same contract as the task
            // value it replaces: `detectVersionBumps` compares it with `>` and
            // treats an unseen ledger as 0, so a zero or fractional version
            // either never fires or fires forever.
            for (const stage of task.coversStages ?? []) {
                if (stage.processingVersion === undefined) continue;
                if (!Number.isInteger(stage.processingVersion) || stage.processingVersion < 1) {
                    throw new Error(
                        `TaskRegistry: stage "${stage.id}" processingVersion must be a positive integer (got ${stage.processingVersion})`,
                    );
                }
            }
        }

        // --- Pipeline reference and cycle validation ---
        //
        // Multi-parent fan-in (A+B → C): SUPPORTED via gate-task synthesis in
        // `pipeline-builder.ts`. `pipeline.after.length > 1` no longer throws at
        // registration; the builder inserts a synthetic `__gate__<taskId>` job
        // that collects all predecessors as its children and becomes the sole
        // child of the convergent task.
        //
        // Diamond DAGs (one predecessor feeding multiple successors, e.g. A → B,
        // A → C, B+C → D): NOT supported. `pipeline-builder.ts` rejects this at
        // build time because FlowProducer expects a tree, not a DAG — embedding
        // the same FlowJob reference under two parents enqueues the predecessor
        // twice. Workaround: factor the shared work into its own task that emits
        // a single output the convergent stage reads.
        const pipelineNames = new Set<string>();
        for (const t of this.getAllTasks()) {
            if (t.pipeline?.of) pipelineNames.add(t.pipeline.of);
        }

        for (const name of pipelineNames) {
            const members = this.getAllTasks().filter((t) => t.pipeline?.of === name);
            const memberIds = new Set(members.map((m) => m.id));

            for (const m of members) {
                const afters = m.pipeline?.after ?? [];

                for (const dep of afters) {
                    if (!memberIds.has(dep)) {
                        throw new Error(
                            `TaskRegistry: pipeline "${name}" — task "${m.id}" declares after: ["${dep}"] but "${dep}" is not in this pipeline`,
                        );
                    }
                }
            }

            // Cycle detection — resolvePipeline throws with cycle path on cycle
            this.resolvePipeline(name);

            // --- Diamond DAG validation ---
            //
            // pipeline-builder.ts (buildPipelinePlan, ~lines 220-263) walks
            // pipeline members in topological order and wires each
            // predecessor as a FlowProducer child of its (single) successor.
            // The moment a predecessor id is seen a SECOND time — i.e. it
            // already sits under another parent — it throws, because
            // FlowProducer expects a strict tree: embedding the same FlowJob
            // under two parents would enqueue the predecessor twice. That
            // happens for ANY predecessor with fan-out >= 2 (e.g. A→B, A→C),
            // independent of whether the branches later reconverge (e.g. also
            // B+C→D — the classic "diamond"). Duplicated (not imported, to
            // avoid a cycle with pipeline-builder.ts) here so boot-time
            // validateAt() rejects the same shapes buildPipelinePlan() would
            // reject on every run — fail fast at registration, not at runtime.
            const successorsByPredecessor = new Map<string, Set<string>>();
            for (const m of members) {
                for (const predId of m.pipeline?.after ?? []) {
                    const successors = successorsByPredecessor.get(predId) ?? new Set<string>();
                    successors.add(m.id);
                    successorsByPredecessor.set(predId, successors);
                }
            }
            for (const [predId, successors] of successorsByPredecessor) {
                if (successors.size > 1) {
                    throw new Error(
                        `TaskRegistry: pipeline "${name}" — task "${predId}" feeds into ` +
                            `${successors.size} downstream tasks (${Array.from(successors)
                                .sort()
                                .join(', ')}); diamond DAGs (one predecessor feeding multiple ` +
                            `successors) are not supported by FlowProducer's tree shape. ` +
                            `Refactor the shared work into its own task that writes a single ` +
                            `result for the convergent stage to read, or split the convergent ` +
                            `stages.`,
                    );
                }
            }
        }

        // --- feedsInto reference validation ---
        this.validateFeedsInto();

        // --- Non-task plugin ID format validation ---
        for (const p of this.getAllProviders()) {
            if (!ID_PATTERN.test(p.id)) {
                throw new Error(
                    `TaskRegistry: invalid provider id "${p.id}" (must match /^[a-z][a-z0-9-]*$/)`,
                );
            }
        }
        for (const p of this.getAllTrickplays()) {
            if (!ID_PATTERN.test(p.id)) {
                throw new Error(
                    `TaskRegistry: invalid trickplay provider id "${p.id}" (must match /^[a-z][a-z0-9-]*$/)`,
                );
            }
        }
        for (const p of this.getAllWatchSyncs()) {
            if (!ID_PATTERN.test(p.id)) {
                throw new Error(
                    `TaskRegistry: invalid watch-sync id "${p.id}" (must match /^[a-z][a-z0-9-]*$/)`,
                );
            }
        }
        for (const f of this.getAllFeatures()) {
            if (!ID_PATTERN.test(f.id)) {
                throw new Error(
                    `TaskRegistry: invalid feature id "${f.id}" (must match /^[a-z][a-z0-9-]*$/)`,
                );
            }
        }
        for (const i of this.getAllIntegrations()) {
            if (!ID_PATTERN.test(i.id)) {
                throw new Error(
                    `TaskRegistry: invalid integration id "${i.id}" (must match /^[a-z][a-z0-9-]*$/)`,
                );
            }
        }
        for (const s of this.getAllExternalServices()) {
            if (!ID_PATTERN.test(s.id)) {
                throw new Error(
                    `TaskRegistry: invalid external-service id "${s.id}" (must match /^[a-z][a-z0-9-]*$/)`,
                );
            }
        }
        for (const m of this.getAllMediaSources()) {
            if (!ID_PATTERN.test(m.id)) {
                throw new Error(
                    `TaskRegistry: invalid media-source id "${m.id}" (must match /^[a-z][a-z0-9-]*$/)`,
                );
            }
        }
    }

    // -------------------------------------------------------------------------
    // Static loader — returns an empty registry; callers must populate via
    // loadBuiltins() (see builtin/index.ts) or manual registerTask() calls.
    // -------------------------------------------------------------------------

    static async load(): Promise<TaskRegistry> {
        return new TaskRegistry();
    }
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

export const registry = new TaskRegistry();

// ---------------------------------------------------------------------------
// Singleton accessors (production + test override)
// ---------------------------------------------------------------------------

let _instance: TaskRegistry | null = null;

export function getRegistry(): TaskRegistry {
    return _instance ?? registry;
}

export function setTestRegistry(reg: TaskRegistry): void {
    _instance = reg;
}

// ---------------------------------------------------------------------------
// ProviderRegistry alias — non-task plugins share the same underlying maps
// ---------------------------------------------------------------------------

export { TaskRegistry as ProviderRegistry };
