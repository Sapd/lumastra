// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

import type { z } from 'zod';
import type { TaskDefinition, CoversStagesDeclaration, StageTerminalDisposition } from './types.js';
import { PluginDefinitionError } from './errors.js';

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * Declarative Stage Contract — parallel static check of a stage's
 * `terminalDisposition`, reachable without a live registry (unit tests + the
 * SDK `defineTask` path). Mirrors `validateTerminalDisposition` in the host's
 * `src/lib/server/tasks/stage-disposition-validation.ts`; keep the two in sync.
 *
 * PHASE 3 (CURRENT): fail-closed — collects all problems and throws a
 * `PluginDefinitionError` so an enqueueable stage with no valid disposition
 * cannot be defined.
 */
function isNonEmptyStr(v: unknown): v is string {
    return typeof v === 'string' && v.trim().length > 0;
}

function collectDispositionVariantProblems(
    stageId: string,
    d: StageTerminalDisposition,
    problems: string[],
): void {
    const ref = 'the StageTerminalDisposition type in @sapd/lumastra-plugin-sdk';
    switch (d.kind) {
        case 'predicate':
            if (!isNonEmptyStr(d.ruleId))
                problems.push(
                    `stage '${stageId}' predicate disposition missing non-empty 'ruleId' (${ref})`,
                );
            if (
                d.disposeAs !== 'skipped_permanent' &&
                d.disposeAs !== 'skipped_transient' &&
                d.disposeAs !== 'completed'
            )
                problems.push(`stage '${stageId}' predicate disposition has invalid 'disposeAs'`);
            if (!isNonEmptyStr(d.reason))
                problems.push(
                    `stage '${stageId}' predicate disposition missing non-empty 'reason'`,
                );
            if (typeof d.excludes !== 'function')
                problems.push(
                    `stage '${stageId}' predicate disposition missing 'excludes' fragment builder ((sql) => sql\`…\`)`,
                );
            if (
                d.disposeAs === 'skipped_transient' &&
                (typeof d.retryAfterMs !== 'number' || d.retryAfterMs <= 0)
            )
                problems.push(
                    `stage '${stageId}' predicate disposition disposeAs:'skipped_transient' requires positive 'retryAfterMs'`,
                );
            break;
        case 'global-guard':
            if (!isNonEmptyStr(d.ruleId))
                problems.push(
                    `stage '${stageId}' global-guard disposition missing non-empty 'ruleId'`,
                );
            if (typeof d.guard !== 'function')
                problems.push(
                    `stage '${stageId}' global-guard disposition missing 'guard' function`,
                );
            if (!isNonEmptyStr(d.reason))
                problems.push(
                    `stage '${stageId}' global-guard disposition missing non-empty 'reason'`,
                );
            if (typeof d.retryAfterMs !== 'number' || d.retryAfterMs <= 0)
                problems.push(
                    `stage '${stageId}' global-guard disposition requires positive 'retryAfterMs'`,
                );
            break;
        case 'self-terminal':
            if (!isNonEmptyStr(d.ruleId))
                problems.push(
                    `stage '${stageId}' self-terminal disposition missing non-empty 'ruleId'`,
                );
            break;
        default:
            problems.push(
                `stage '${stageId}' terminalDisposition has unknown kind '${String((d as { kind?: unknown }).kind)}'`,
            );
    }
}

/**
 * Probe-derived `MediaItemSnapshot` fields — empty right after a media item is created, populated only
 * once media-probe runs. Gating SEED-time row creation on these is the cold-start data-loss footgun, so a
 * native stage (one that also declares `eligibility.sql`) may NOT reference them in `eligibility.appliesTo`.
 */
const PROBE_DERIVED_SNAPSHOT_FIELDS = [
    'has_video',
    'has_audio',
    'has_file',
    'runtime_seconds',
] as const;

/**
 * Validate the unified `eligibility` block. The one hard rule: a NATIVE stage (declares `eligibility.sql`)
 * must NOT also gate its immutable seed-time `eligibility.appliesTo` on a probe-derived field — that is the
 * exact seam that permanently lost 34k items. (External stages declaring `appliesTo` with no `sql` are the
 * documented escape hatch: their wrongly-skipped rows are recovered by the event-independent heal pass, so
 * it is a footgun, not an error — but a native author who has SQL available has no excuse.)
 */
function collectStageEligibilityProblems(stage: CoversStagesDeclaration, problems: string[]): void {
    const elig = stage.eligibility;
    if (!elig?.sql || !elig.appliesTo) return;
    const src = elig.appliesTo.toString();
    const offending = PROBE_DERIVED_SNAPSHOT_FIELDS.filter((f) => src.includes(f));
    if (offending.length > 0) {
        problems.push(
            `stage '${stage.id}' declares both eligibility.sql and eligibility.appliesTo, but appliesTo ` +
                `references probe-derived field(s) [${offending.join(', ')}] — those are empty at seed ` +
                `time, so gating row creation on them is the cold-start data-loss footgun. Move that ` +
                `condition into eligibility.sql (re-evaluated every sweep tick against live data).`,
        );
    }
}

function collectStageDispositionProblems(stage: CoversStagesDeclaration, problems: string[]): void {
    const disposition = stage.terminalDisposition;
    if (stage.enqueueable === true && disposition === undefined) {
        // A native `eligibility.sql` block provides a bulk dispose pass that
        // structurally covers all ineligible rows (`NOT (<sql>)` → skipped_permanent),
        // so an explicit `terminalDisposition` is not required. Only `appliesTo`-only
        // (external) eligibility does not provide structural coverage — the per-row
        // external path is bounded and cannot guarantee all ineligible rows drain.
        const hasNativeSqlEligibility = typeof stage.eligibility?.sql === 'function';
        if (!hasNativeSqlEligibility) {
            problems.push(
                `enqueueable stage '${stage.id}' declares no terminalDisposition and no native ` +
                    `eligibility.sql — a pending row it cannot process can wedge. Declare a ` +
                    `terminalDisposition or add an eligibility.sql block (see ` +
                    `the StageTerminalDisposition type in @sapd/lumastra-plugin-sdk).`,
            );
        }
        return;
    }
    if (disposition === undefined) return;
    const list = Array.isArray(disposition) ? disposition : [disposition];
    for (const d of list) collectDispositionVariantProblems(stage.id, d, problems);
}

/**
 * Parse a human-friendly duration string (e.g. '15m', '1h', '7d', '2w').
 *
 * Mirrors the runtime parser in `src/lib/server/tasks/scheduler.ts`
 * (`parseDurationMs`). The runtime parser cannot be imported here because
 * this package is a peer of the host app and is bundled standalone for
 * external plugin authors. Any unit added there must be added here too —
 * the test suite covers `s | m | h | d | w` round-trips and rejection of
 * unknown units.
 *
 * Returns null for invalid input.
 */
export function parseDuration(input: string): number | null {
    if (!input) return null;
    const m = /^(\d+)\s*(s|m|h|d|w)$/.exec(input.trim());
    if (!m) return null;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) return null;
    switch (m[2]) {
        case 's':
            return n * 1_000;
        case 'm':
            return n * 60_000;
        case 'h':
            return n * 3_600_000;
        case 'd':
            return n * 86_400_000;
        case 'w':
            return n * 7 * 86_400_000;
        default:
            return null;
    }
}

function fail(id: string, message: string): never {
    throw new PluginDefinitionError({ id, message, phase: 'registration' });
}

/**
 * Helper alias that derives the input type from the schema.
 *
 * Plugin authors can use this to avoid double-specifying `TInput`:
 *
 * ```ts
 * const Input = z.object({ libraryGroupId: z.string().optional() });
 * type Input = TaskInputOf<typeof Input>;  // { libraryGroupId?: string }
 *
 * defineTask<Input, void>({ inputSchema: Input, ... });
 * ```
 *
 * Or, equivalently, pair with the `defineTaskFromSchema` overload to drop
 * the explicit generic entirely.
 */
export type TaskInputOf<S extends z.ZodSchema> = z.infer<S>;

/**
 * Alternative entry point that derives `TInput` directly from
 * `inputSchema`, eliminating the chance of Zod/TS drift.
 *
 * ```ts
 * defineTaskFromSchema(z.object({ libraryGroupId: z.string() }), {
 *     id: 'my-task',
 *     // ctx.input is auto-typed as { libraryGroupId: string }
 *     async execute(ctx) { ... },
 * });
 * ```
 *
 * The wrapped definition is fed through the same `defineTask()` validator,
 * so every registration-time check still fires.
 */
export function defineTaskFromSchema<S extends z.ZodSchema, R, TItem = unknown>(
    inputSchema: S,
    def: Omit<TaskDefinition<z.infer<S>, R, TItem>, 'inputSchema'>,
): TaskDefinition<z.infer<S>, R, TItem> {
    // Two pieces of erasure happen here that justify the inputSchema cast:
    //   1. `TaskDefinition.inputSchema` is declared as `z.ZodSchema<TInput>`,
    //      i.e. a more specific Zod-typed shape than the open `S extends
    //      z.ZodSchema`. TypeScript cannot widen `S` to `ZodSchema<z.infer<S>>`
    //      automatically because the relationship is established at use-time,
    //      not declaration-time.
    //   2. We narrow the cast surface to just `inputSchema` (NOT the entire
    //      object) so the spread of `def` is still checked against the full
    //      `TaskDefinition<z.infer<S>, R, TItem>` minus `inputSchema` — any
    //      future field that becomes TInput-dependent still produces a type
    //      error inside `def`'s shape rather than being silently allowed.
    return defineTask<z.infer<S>, R, TItem>({
        ...def,
        inputSchema: inputSchema as z.ZodSchema<z.infer<S>>,
    });
}

export function defineTask<I, R, TItem = unknown>(
    def: TaskDefinition<I, R, TItem>,
): TaskDefinition<I, R, TItem> {
    if (!def.id || !def.id.trim()) {
        throw new PluginDefinitionError({
            id: '(unknown)',
            message: 'id must not be blank',
            phase: 'registration',
        });
    }
    if (!def.name || !def.name.trim()) fail(def.id, 'name must not be blank');
    if (!def.version || !def.version.trim()) fail(def.id, 'version must not be blank');
    if (!ID_PATTERN.test(def.id)) {
        fail(def.id, `id must match /^[a-z][a-z0-9-]*$/, got: ${def.id}`);
    }
    // Checked HERE and not only by the host's registry: `validateAt('startup')`
    // sweeps every task at once and throws, so a task the SDK waves through but
    // the registry refuses turns one plugin's mistake into a failure of that
    // whole sweep, blamed on the registry pass rather than on the plugin. The
    // loader runs these validators per plugin precisely so a bad plugin fails
    // alone, which only holds while the two agree on what is valid.
    if (!Number.isInteger(def.processingVersion) || (def.processingVersion as number) < 1) {
        fail(
            def.id,
            `processingVersion must be a positive integer (got ${String(def.processingVersion)})`,
        );
    }
    if (!def.inputSchema) fail(def.id, 'inputSchema is mandatory');
    if (typeof (def.inputSchema as unknown as { parse?: unknown }).parse !== 'function') {
        fail(def.id, 'inputSchema must be a Zod schema (missing .parse method)');
    }
    if (typeof (def.inputSchema as unknown as { safeParse?: unknown }).safeParse !== 'function') {
        fail(def.id, 'inputSchema must be a Zod schema (missing .safeParse method)');
    }
    // Sanity-parse `{}` at registration time so a malformed schema (one that
    // throws at parse-time rather than returning safeParse({success:false}))
    // is caught loudly here, not at the first scheduled run. We accept
    // success=false (many tasks legitimately require non-empty input); we
    // only catch the case where safeParse itself *throws*, which signals a
    // structurally bad schema (e.g. a forgotten `.optional()` on a callable
    // refinement or a custom transform that crashes on undefined fields).
    try {
        (
            def.inputSchema as unknown as {
                safeParse: (v: unknown) => { success: boolean };
            }
        ).safeParse({});
    } catch (err) {
        fail(
            def.id,
            `inputSchema.safeParse({}) threw at registration time — ` +
                `the schema is structurally invalid: ${err instanceof Error ? err.message : String(err)}`,
        );
    }
    if (!def.identityFor) fail(def.id, 'identityFor is mandatory');
    if (!def.execute) fail(def.id, 'execute is mandatory');
    if (!def.resourceClass) fail(def.id, 'resourceClass is mandatory');

    // `ingest` / `bulk` / `analysis` are the pre-Wave-8.5 fairness lanes. They
    // stay VALID: the host's registry folds them onto their physical class
    // (`ingest`/`bulk` → `io`, `analysis` → `cpu`) and derives a default
    // `quotas.maxConcurrent`, and the host's own bundled tasks rely on that on
    // purpose. The deprecation nudge for third-party authors is emitted by the
    // host's external-plugin loader, where it names the plugin to the operator
    // (plugins/runtime/loader.ts). It used to be a console.warn right here,
    // which fired for ~30 BUNDLED tasks on every boot of every container —
    // pure noise no operator could act on (Windows e2e 2026-09-27).

    // schedule duration validation
    if (def.schedule?.every !== undefined && parseDuration(def.schedule.every) === null) {
        fail(
            def.id,
            `schedule.every must be a valid duration string (e.g. '15m', '1h'), got: '${def.schedule.every}'`,
        );
    }
    if (
        def.schedule?.startupDelay !== undefined &&
        parseDuration(def.schedule.startupDelay) === null
    ) {
        fail(
            def.id,
            `schedule.startupDelay must be a valid duration string, got: '${def.schedule.startupDelay}'`,
        );
    }

    // dynamicSchedule validation
    if (def.schedule && def.dynamicSchedule) {
        fail(
            def.id,
            'schedule and dynamicSchedule are mutually exclusive — choose one. ' +
                "Use `schedule` for static cadence (every: '12h') or `dynamicSchedule` " +
                'for DB-row-driven cadence (per-source refresh_cron etc).',
        );
    }
    if (def.dynamicSchedule) {
        if (typeof def.dynamicSchedule.loader !== 'function') {
            fail(
                def.id,
                'dynamicSchedule.loader must be a function returning an array of DynamicScheduleEntry',
            );
        }
        if (
            def.dynamicSchedule.sweepEvery !== undefined &&
            parseDuration(def.dynamicSchedule.sweepEvery) === null
        ) {
            fail(
                def.id,
                `dynamicSchedule.sweepEvery must be a valid duration string (e.g. '5m', '15m'), got: '${def.dynamicSchedule.sweepEvery}'`,
            );
        }
    }
    if (def.dynamicSchedule && def.manualOnly) {
        fail(
            def.id,
            'manualOnly cannot be combined with dynamicSchedule — a task that fires from a loader is not manual-only',
        );
    }
    if (def.schedule && def.manualOnly) {
        fail(
            def.id,
            'manualOnly cannot be combined with schedule — a task that fires on a static cadence is not manual-only',
        );
    }
    if (def.pipeline?.of && def.manualOnly) {
        fail(
            def.id,
            'manualOnly cannot be combined with pipeline.of — a pipeline child is fired by its parent, not manually',
        );
    }
    if (def.resumeAfterRestart !== undefined && typeof def.resumeAfterRestart !== 'boolean') {
        fail(def.id, 'resumeAfterRestart must be a boolean');
    }
    if (def.pipeline?.of && def.resumeAfterRestart) {
        fail(
            def.id,
            'resumeAfterRestart cannot be combined with pipeline.of — a pipeline stage is re-run by its pipeline, not resumed on its own',
        );
    }
    if (def.visibility !== undefined && def.visibility !== 'user' && def.visibility !== 'system') {
        fail(def.id, `visibility must be 'user' or 'system', got: '${String(def.visibility)}'`);
    }
    // `demo: true` + `pipeline.of` is intentionally permitted — the native
    // `file-system-scan` exemplar tutorial uses this combo to demonstrate
    // pipeline membership. classifyTriggers resolves to `demo` (wins over
    // pipeline), which is the correct behaviour for tutorial-only tasks.

    // timeout duration validation
    if (def.timeout?.hard !== undefined && parseDuration(def.timeout.hard) === null) {
        fail(
            def.id,
            `timeout.hard must be a valid duration string (e.g. '30m'), got: '${def.timeout.hard}'`,
        );
    }
    if (def.timeout?.soft !== undefined && parseDuration(def.timeout.soft) === null) {
        fail(def.id, `timeout.soft must be a valid duration string, got: '${def.timeout.soft}'`);
    }

    // timeout.soft < timeout.hard sanity check — soft >= hard means soft
    // never fires before the hard kill, which is almost always a bug.
    if (def.timeout?.hard && def.timeout?.soft) {
        const hardMs = parseDuration(def.timeout.hard);
        const softMs = parseDuration(def.timeout.soft);
        if (hardMs !== null && softMs !== null && softMs >= hardMs) {
            fail(
                def.id,
                `timeout.soft ('${def.timeout.soft}') must be strictly less than ` +
                    `timeout.hard ('${def.timeout.hard}') — otherwise soft never fires`,
            );
        }
    }

    // exclusiveWith.ttl duration validation
    if (def.exclusiveWith?.ttl !== undefined && parseDuration(def.exclusiveWith.ttl) === null) {
        fail(
            def.id,
            `exclusiveWith.ttl must be a valid duration string (e.g. '1h', '24h'), got: '${def.exclusiveWith.ttl}'`,
        );
    }

    // exclusiveWith.ttl vs timeout.hard hard constraint. The ttl is the
    // exclusivity (dedup) window; timeout.hard is the task's max runtime. If
    // ttl < hard, the SETNX identity key can expire while a run is still
    // executing, letting a second concurrent run claim the freed key and
    // defeating the mutex entirely. The host's derived-floor clamp
    // (Consolidation #2) raises the effective TTL to max(hard, every) + 10s,
    // but the SDK must reject manifests that are wrong-by-design before they
    // reach the host — a silent runtime promotion is harder to audit than a
    // loud definition-time error.
    if (def.exclusiveWith?.ttl !== undefined && def.timeout?.hard !== undefined) {
        const ttlMs = parseDuration(def.exclusiveWith.ttl);
        const hardMs = parseDuration(def.timeout.hard);
        if (ttlMs !== null && hardMs !== null && ttlMs < hardMs) {
            fail(
                def.id,
                `exclusiveWith.ttl ('${def.exclusiveWith.ttl}') is shorter than ` +
                    `timeout.hard ('${def.timeout.hard}'). The exclusivity key can ` +
                    `expire mid-run, letting a duplicate concurrent run slip through. ` +
                    `Set exclusiveWith.ttl >= timeout.hard.`,
            );
        }
    }

    // backlog.softBudget duration validation (chunked drain budget hint)
    if (def.backlog?.softBudget !== undefined && parseDuration(def.backlog.softBudget) === null) {
        fail(
            def.id,
            `backlog.softBudget must be a valid duration string (e.g. '5m'), got: '${def.backlog.softBudget}'`,
        );
    }

    // backlog.sliceSize must be a positive integer
    if (
        def.backlog?.sliceSize !== undefined &&
        (!Number.isInteger(def.backlog.sliceSize) || def.backlog.sliceSize <= 0)
    ) {
        fail(def.id, `backlog.sliceSize must be a positive integer, got: ${def.backlog.sliceSize}`);
    }

    // backlog cross-field checks
    if (def.backlog) {
        if (!def.backlog.compute || !def.backlog.stages || !def.backlog.idOf) {
            fail(
                def.id,
                'backlog declared but missing required fields: compute, stages, and idOf are all mandatory',
            );
        }
    }

    // processItems requires backlog
    if (def.processItems && !def.backlog) {
        fail(def.id, 'processItems requires backlog to be declared');
    }

    // failures.retry requires failures.list
    if (def.failures?.retry && !def.failures.list) {
        fail(def.id, 'failures.retry requires failures.list to be declared');
    }

    // pipeline.after must be non-empty strings matching the task id format.
    // We can't verify "the task exists in the registry" at SDK level (the
    // registry isn't visible here); the registry does that cycle-check on
    // load. But we can reject typos and obvious bad formats early.
    if (def.pipeline?.after) {
        for (const dep of def.pipeline.after) {
            if (typeof dep !== 'string' || dep.trim() === '') {
                fail(def.id, 'pipeline.after entries must be non-empty task id strings');
            }
            if (!ID_PATTERN.test(dep)) {
                fail(
                    def.id,
                    `pipeline.after entry '${dep}' is not a valid task id ` +
                        `(must match ${ID_PATTERN.source})`,
                );
            }
            if (dep === def.id) {
                fail(def.id, `pipeline.after cannot reference the task's own id ('${dep}')`);
            }
        }
        const seen = new Set<string>();
        for (const dep of def.pipeline.after) {
            if (seen.has(dep)) {
                fail(def.id, `pipeline.after contains duplicate entry '${dep}'`);
            }
            seen.add(dep);
        }
    }

    // pipeline.of (parent task) must also be a valid id format if present.
    if (def.pipeline?.of !== undefined) {
        if (typeof def.pipeline.of !== 'string' || !ID_PATTERN.test(def.pipeline.of)) {
            fail(def.id, `pipeline.of must be a valid task id (got '${def.pipeline.of}')`);
        }
    }

    // Declarative Stage Contract (Phase 3) — fail-closed static disposition
    // check, mirroring the live registry check (registry.ts +
    // stage-disposition-validation.ts). An enqueueable stage with no valid
    // terminalDisposition cannot be defined. See design §2.3 / §4.4.
    if (def.coversStages) {
        const dispositionProblems: string[] = [];
        for (const stage of def.coversStages) {
            collectStageDispositionProblems(stage, dispositionProblems);
            collectStageEligibilityProblems(stage, dispositionProblems);
        }
        if (dispositionProblems.length > 0) {
            fail(def.id, dispositionProblems.join('; '));
        }
    }

    return def;
}
