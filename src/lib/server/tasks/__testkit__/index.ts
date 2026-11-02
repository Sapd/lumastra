// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared, TYPED test harness for the Lumastra task system.
 *
 * ## Why this module exists — "one compile error, not N silent drifts"
 *
 * Task tests need doubles for four moving targets: the SDK `TaskContext`, the
 * SDK `TaskDefinition`, and the host's `StateMachine` + `TaskRegistry`. Hand-
 * rolling those doubles in every coverage test (`as unknown as TaskDefinition`,
 * ad-hoc `sql` fakes, `{ transitionRun: vi.fn() } as unknown as StateMachine`)
 * is the bug class this module eliminates:
 *
 *   - When an SDK field is ADDED (`catalog`, `mediaItems`, `userCredentials`,
 *     `coversStages`, …), a hand-rolled `as unknown as` stub silently misses it
 *     and the task throws `TypeError` at runtime — the test still "passes"
 *     because it never reached the new surface.
 *   - When a REQUIRED field is added to `TaskDefinition`, N hand-rolled literals
 *     drift independently; nothing forces them to update.
 *
 * By funnelling every double through ONE source-of-truth factory that returns
 * the REAL types (no `as unknown as` on the public surface for the fully-typed
 * builders), a new required SDK field becomes exactly ONE compile error — HERE —
 * instead of N silent drifts spread across the suite.
 *
 * ## What's in the box
 *
 *   - SDK testing helpers, re-exported verbatim (`mockContext`, `runTask`,
 *     `expectRun`, `mockHttpClient`, `mockCache`, `mockFfmpegRunner`,
 *     `mockLogger`). These already exist in `@sapd/lumastra-plugin-sdk-testing`
 *     and are NOT reimplemented — re-exporting keeps every task test importing
 *     from a single path.
 *   - {@link makeRecordingSql} — a callable `postgres.Sql` double that records
 *     every query and returns queue-able rows, for tasks that pass `ctx.sql`
 *     (or a `tx` handle) to a real query module. The SDK's `mockContext` builds
 *     an `sql` that THROWS on any real use (a not-mocked tripwire); this is the
 *     usable counterpart.
 *   - {@link makeTaskDef} — a fully-typed `TaskDefinition` factory (no
 *     `as unknown as`). A missing required SDK field fails to compile here.
 *   - {@link makeStateMachine} — a typed `StateMachine` double mirroring
 *     `runner.test.ts`. The single unavoidable class-double cast is contained.
 *   - {@link makeRegistry} — builds a REAL `TaskRegistry` from real
 *     `TaskDefinition`s (no cast needed; quotas / pipeline / processingVersion
 *     are just fields on the definition, collapsing the four `runner.test.ts`
 *     `makeRegistryWith*` variants into one builder).
 *
 * ## CONVENTION: spying on the REAL stage-state query module
 *
 * The downstream coverage tests must intercept the REAL `upsertCompletedRow` /
 * `upsertSkippedPermanentRow` from `stage-state.queries.ts` so they can assert a
 * task tombstoned / completed an item. `vi.mock` and `vi.hoisted` are hoisted
 * ABOVE the imports, so you CANNOT reference an imported value inside
 * `vi.hoisted`. A `typeof import('…')` type, however, is purely compile-time and
 * is legal there. Use this VERIFIED pattern (typechecks under this repo's TS +
 * vitest 4.x — proven by this module's self-test):
 *
 * ```ts
 * import type * as StageStateQueries from '$lib/server/database/queries/stage-state.queries.js';
 *
 * const stageState = vi.hoisted(() => ({
 *     upsertCompletedRow: vi.fn<typeof StageStateQueries.upsertCompletedRow>(),
 *     upsertSkippedPermanentRow: vi.fn<typeof StageStateQueries.upsertSkippedPermanentRow>(),
 * }));
 * vi.mock('$lib/server/database/queries/stage-state.queries.js', () => stageState);
 * ```
 *
 * Note `vi.fn<typeof StageStateQueries.upsertCompletedRow>()` (the `typeof` of a
 * VALUE accessed through a type-only namespace import) rather than the
 * indexed-access `vi.fn<StageStateQueries['upsertCompletedRow']>()` form — both
 * resolve to the same function type, but `typeof <namespace>.<member>` is the
 * form proven to typecheck cleanly here. The mock object is the module
 * namespace, so any OTHER export of `stage-state.queries.js` the task imports
 * would be `undefined` — add it to the `vi.hoisted` factory if the task needs
 * it.
 *
 * @module
 */

import { vi } from 'vitest';
import { z } from 'zod';
import type postgres from 'postgres';
import { defineTask, type TaskDefinition } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from '../registry.js';
import type {
    StateMachine,
    TransitionResult,
    IncrementStageResult,
    ClaimResult,
} from '../state-machine.js';

// ── SDK testing helper re-exports ───────────────────────────────────────────
// These already exist and work; re-exported so every task test imports doubles
// from one path. Do NOT reimplement them here.

export {
    mockContext,
    runTask,
    expectRun,
    mockHttpClient,
    mockCache,
    mockFfmpegRunner,
    mockLogger,
} from '@sapd/lumastra-plugin-sdk-testing';
export type {
    MockContextOptions,
    RunMatcher,
    MockHttpClient,
    MockCache,
    MockFfmpegRunner,
    MockLogger,
} from '@sapd/lumastra-plugin-sdk-testing';

// ── makeRecordingSql ────────────────────────────────────────────────────────

/** One recorded `sql\`…\`` invocation. */
export interface RecordedSqlCall {
    /**
     * The static string fragments of the tagged template, joined by `?` at the
     * interpolation points — e.g. `` sql`SELECT ${id}` `` records
     * `'SELECT ?'`. Use `.includes(...)` to assert on the query shape.
     */
    query: string;
    /** Raw static fragments, exactly as passed to the tag (unjoined). */
    strings: readonly string[];
    /** The interpolated values, in order. */
    values: unknown[];
}

/** Options for {@link makeRecordingSql}. */
export interface MakeRecordingSqlOptions<RowsT = unknown[]> {
    /**
     * Rows returned by the FIRST `sql\`…\`` invocation. Subsequent calls return
     * `[]` unless more rows are queued via {@link RecordingSql.queueRows}.
     * Equivalent to a single `queueRows(rows)`.
     */
    rows?: RowsT;
}

/** The callable `postgres.Sql` double returned by {@link makeRecordingSql}. */
export interface RecordingSql {
    /** Use exactly like a real `sql` instance: `await sql.sql\`SELECT 1\``. */
    sql: postgres.Sql;
    /**
     * Every recorded invocation, in call order. Read `.calls[0].query` to assert
     * the SQL shape and `.calls[0].values` for the interpolated parameters.
     */
    calls: RecordedSqlCall[];
    /**
     * Queue rows for the next (and only the next) `sql\`…\`` call. Each queued
     * batch is consumed FIFO; once the queue is empty, calls return `[]`.
     */
    queueRows: (rows: unknown[]) => void;
}

/**
 * Build a callable `postgres.Sql` double for tasks that pass `ctx.sql` (or a
 * transaction handle) into a real query module without a live database.
 *
 * Unlike the SDK's `mockContext().sql` (which THROWS on any real use as a
 * not-mocked tripwire), this returns a working tagged-template that records
 * every call and returns queue-able rows. It is intentionally minimal — the
 * lightest thing that lets a task issue queries — and tolerates `.json`,
 * `.begin`, `.unsafe` access so passing it around / constructing it doesn't
 * explode. `.begin(fn)` invokes `fn` with the same recording double so a task
 * that wraps writes in a transaction still records its statements.
 *
 * @example
 * const rec = makeRecordingSql({ rows: [{ id: 'a' }] });
 * const out = await rec.sql`SELECT id FROM t WHERE x = ${42}`;
 * out;                       // → [{ id: 'a' }]
 * rec.calls[0].query;        // → 'SELECT id FROM t WHERE x = ?'
 * rec.calls[0].values;       // → [42]
 */
export function makeRecordingSql<RowsT = unknown[]>(
    opts: MakeRecordingSqlOptions<RowsT> = {},
): RecordingSql {
    const calls: RecordedSqlCall[] = [];
    const rowQueue: unknown[][] = [];
    if (opts.rows !== undefined) {
        rowQueue.push(opts.rows as unknown[]);
    }

    const queueRows = (rows: unknown[]): void => {
        rowQueue.push(rows);
    };

    // Tagged-template entrypoint. Records the call and resolves the next queued
    // row batch (or [] when the queue is exhausted).
    function tag(
        strings: TemplateStringsArray | string | readonly string[],
        ...values: unknown[]
    ): Promise<unknown[]> {
        // `sql('col')` / `sql(['a', 'b'])` is postgres.js's identifier helper, not a
        // query: hand back a marker for the enclosing template to interpolate.
        if (typeof strings === 'string' || !('raw' in strings)) {
            return { identifier: strings } as unknown as Promise<unknown[]>;
        }
        calls.push({
            query: strings.join('?'),
            strings: [...strings],
            values,
        });
        const rows = rowQueue.shift() ?? [];
        return Promise.resolve(rows);
    }

    // Minimal surface that postgres.Sql exposes and that task / query code may
    // touch when handed an `sql` instance. Kept deliberately small.
    const helpers = {
        // `sql.json(value)` wraps a value as a jsonb param in real postgres;
        // for a recording double, identity is enough.
        json: (value: unknown): unknown => value,
        // `sql.begin(fn)` runs `fn` inside a transaction; recurse with the same
        // double so statements issued in the callback are still recorded.
        begin: (fn: (txSql: postgres.Sql) => unknown): Promise<unknown> =>
            Promise.resolve(fn(callable as unknown as postgres.Sql)),
        // `sql.unsafe(query)` — record it like a tagged call and return queued
        // rows. Test doubles may use unsafe; production code may not.
        unsafe: (query: string, params: unknown[] = []): Promise<unknown[]> => {
            calls.push({ query, strings: [query], values: params });
            return Promise.resolve(rowQueue.shift() ?? []);
        },
    };

    const callable = Object.assign(tag, helpers);

    // Single contained cast — postgres.Sql's full type surface is enormous and
    // a recording double only needs the tagged-template + a few helpers. This
    // mirrors `runner.test.ts`'s `makeFakeSql` (`as unknown as postgres.Sql`).
    return {
        sql: callable as unknown as postgres.Sql,
        calls,
        queueRows,
    };
}

// ── makeTaskDef ─────────────────────────────────────────────────────────────

/**
 * Build a fully-typed {@link TaskDefinition} with sensible defaults, merging
 * `overrides` on top.
 *
 * This is the linchpin of the "one compile error, not N drifts" guarantee: it
 * routes through the SDK's `defineTask`, so if a future SDK adds a REQUIRED
 * field, the defaults object below fails to compile HERE — not silently at N
 * call sites. There is NO `as unknown as` on this builder.
 *
 * Defaults: `id: 'testkit-task'`, `name: 'Testkit Task'`, `version: '1.0.0'`,
 * `processingVersion: 1`, `minAppVersion: '1.0.0'`, `capabilities: {}`,
 * `resourceClass: 'io'`, `inputSchema: z.object({})`, `identityFor: () =>
 * 'global'`, and an `execute` that resolves `{ success: true, itemsProcessed: 0 }`.
 *
 * @example
 * const def = makeTaskDef({ id: 'my-task', resourceClass: 'cpu' });
 * def.id; // → 'my-task'
 */
export function makeTaskDef(overrides: Partial<TaskDefinition> = {}): TaskDefinition {
    return defineTask({
        id: 'testkit-task',
        name: 'Testkit Task',
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: 'io',
        inputSchema: z.object({}),
        identityFor: () => 'global',
        execute: async () => ({ success: true, itemsProcessed: 0 }),
        ...overrides,
    });
}

// ── makeStateMachine ────────────────────────────────────────────────────────

/**
 * The vitest-mock surface of {@link StateMachine}. Each method is a `vi.fn()`
 * so tests can assert call args and override resolutions. Mirrors the five
 * methods `runner.test.ts` builds: `transitionRun`, `transitionStage`,
 * `incrementStage`, `claimRun`, `reseedForRetry`.
 */
export interface StateMachineMock {
    transitionRun: ReturnType<typeof vi.fn>;
    transitionStage: ReturnType<typeof vi.fn>;
    incrementStage: ReturnType<typeof vi.fn>;
    claimRun: ReturnType<typeof vi.fn>;
    reseedForRetry: ReturnType<typeof vi.fn>;
}

/**
 * Build a typed {@link StateMachine} double whose methods are `vi.fn()`s
 * resolving to sensible success shapes (`transitionRun`/`transitionStage` →
 * `{ ok: true }`, `incrementStage` → `{ ok: true, processed: 0,
 * autoCompleted: false }`, `claimRun` → `{ ok: true }`, `reseedForRetry` →
 * `'reseeded'`). Pass `over` to swap any method for a custom `vi.fn()`.
 *
 * Returns the value typed as the REAL `StateMachine`. The single unavoidable
 * class-double cast (a `vi.fn()` map is structurally not a `StateMachine`
 * because of its private members) is contained here, exactly as
 * `runner.test.ts:makeStateMachine` does it.
 *
 * @example
 * const sm = makeStateMachine();
 * await sm.transitionRun({ runId: 'r', from: 'pending', to: 'active' });
 */
export function makeStateMachine(over: Partial<StateMachineMock> = {}): StateMachine {
    const mock: StateMachineMock = {
        transitionRun: vi.fn(async (): Promise<TransitionResult> => ({ ok: true })),
        transitionStage: vi.fn(async (): Promise<TransitionResult> => ({ ok: true })),
        incrementStage: vi.fn(async (): Promise<IncrementStageResult> => ({
            ok: true,
            processed: 0,
            autoCompleted: false,
        })),
        claimRun: vi.fn(async (): Promise<ClaimResult> => ({ ok: true })),
        reseedForRetry: vi.fn(
            async (): Promise<'reseeded' | 'skipped' | 'kept-active'> => 'reseeded',
        ),
        ...over,
    };
    // Single contained cast — a structural vi.fn() map can't satisfy the
    // private members of the StateMachine class. Mirrors runner.test.ts.
    return mock as unknown as StateMachine;
}

// ── makeRegistry ────────────────────────────────────────────────────────────

/**
 * Build a REAL {@link TaskRegistry} populated with `tasks`. Because the
 * registry is a concrete class that accepts real `TaskDefinition`s, NO cast is
 * needed — pass definitions from {@link makeTaskDef} (with whatever
 * `quotas` / `pipeline` / `processingVersion` fields you need set directly on
 * them). This collapses `runner.test.ts`'s four `makeRegistryWith*` variants
 * into one builder: those variants only differed by which `TaskDefinition`
 * field they set, and those are all plain fields here.
 *
 * The runner resolves tasks via `registry.getTask(jobName)`; a definition's
 * `id` is the job name it's looked up by.
 *
 * @example
 * const reg = makeRegistry([makeTaskDef({ id: 'a' }), makeTaskDef({ id: 'b' })]);
 * reg.getTask('a')?.id; // → 'a'
 */
export function makeRegistry(tasks: TaskDefinition[]): TaskRegistry {
    const reg = new TaskRegistry();
    for (const task of tasks) {
        reg.registerTask(task);
    }
    return reg;
}
