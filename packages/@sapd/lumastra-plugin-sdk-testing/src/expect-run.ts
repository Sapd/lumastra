// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import type { TaskDefinition, TaskContext, CostKind } from '@sapd/lumastra-plugin-sdk';
import { TaskError } from '@sapd/lumastra-plugin-sdk';
import { mockContext } from './mock-context.js';

// ---------------------------------------------------------------------------
// Internal state per RunMatcher instance
// ---------------------------------------------------------------------------

interface MatcherState<I, R> {
    task: TaskDefinition<I, R>;
    ctx: TaskContext<I>;
    progressCalls: Array<{
        processed: number;
        total?: number;
        currentItem?: string;
    }>;
    depCalls: Set<string>;
    spendMap: Map<CostKind, number>;
}

function buildState<I, R>(
    task: TaskDefinition<I, R>,
    input: I,
    ctxOverrides?: Partial<TaskContext<I>>,
): MatcherState<I, R> {
    const progressCalls: Array<{
        processed: number;
        total?: number;
        currentItem?: string;
    }> = [];
    const depCalls = new Set<string>();
    const spendMap = new Map<CostKind, number>();

    const baseCtx = mockContext<I>({
        input,
        onProgress: (processed, total, currentItem) => {
            progressCalls.push({ processed, total, currentItem });
        },
    });

    // Override spend to record into our local map
    const ctxWithSpend: TaskContext<I> = {
        ...baseCtx,
        ...ctxOverrides,
        spend(kind: CostKind, units: number): void {
            spendMap.set(kind, (spendMap.get(kind) ?? 0) + units);
        },
    };

    // Wrap dep() to record calls
    const ctx = new Proxy(ctxWithSpend, {
        get(target, prop) {
            if (prop === 'dep') {
                return (name: string) => {
                    depCalls.add(name);
                    return target.dep(name);
                };
            }
            return (target as unknown as Record<string | symbol, unknown>)[prop];
        },
    });

    return { task, ctx, progressCalls, depCalls, spendMap };
}

// ---------------------------------------------------------------------------
// RunMatcher
// ---------------------------------------------------------------------------

export interface RunMatcher {
    toCompleteSuccessfully(): Promise<this>;
    toFailWith(pattern: RegExp | string): Promise<this>;
    toReturnResult<R>(matcher: (r: R) => boolean): Promise<this>;
    toReportProgress(processedAtLeast: number): Promise<this>;
    toSpend(kind: CostKind, atLeast?: number): Promise<this>;
    /** Asserts spend on `kind` equals exactly `exact` (e.g. `toSpendExactly('api_calls', 3)`). */
    toSpendExactly(kind: CostKind, exact: number): Promise<this>;
    /** Asserts spend on `kind` is zero (no call to `ctx.spend(kind, ...)`). */
    toNotSpend(kind: CostKind): Promise<this>;
    toCallDep(name: string): Promise<this>;
    toAbortWithin(ms: number): Promise<this>;
    getSpend(): Map<CostKind, number>;
}

export function expectRun<I, R>(
    task: TaskDefinition<I, R>,
    input: I,
    ctxOverrides?: Partial<TaskContext<I>>,
): RunMatcher {
    const state = buildState(task, input, ctxOverrides);

    let _result: { success: boolean; result?: unknown; stopReason?: unknown } | undefined;
    let _error: unknown = undefined;
    let _executed = false;

    async function execute(): Promise<void> {
        if (_executed) return;
        _executed = true;
        try {
            _result = await state.task.execute(state.ctx);
        } catch (err) {
            _error = err;
        }
    }

    function getErrorMessage(): string {
        if (_error instanceof TaskError) {
            return `${_error.kind}: ${_error.message}`;
        } else if (_error instanceof Error) {
            return _error.message;
        } else if (_error !== undefined) {
            return String(_error);
        }
        return '';
    }

    const matcher: RunMatcher = {
        async toCompleteSuccessfully() {
            await execute();
            if (_error !== undefined) {
                assert.fail(
                    `Expected task "${task.id}" to complete successfully but it threw: ${String(_error)}`,
                );
            }
            assert.equal(
                _result?.success,
                true,
                `Expected task "${task.id}" result.success to be true`,
            );
            return this;
        },

        async toFailWith(pattern: RegExp | string) {
            await execute();
            const threw = _error !== undefined || _result?.success === false;
            assert.equal(threw, true, `Expected task "${task.id}" to fail but it succeeded`);

            let message: string;
            if (_error !== undefined) {
                message = getErrorMessage();
            } else {
                message = String(_result?.stopReason ?? 'result.success=false');
            }

            if (pattern instanceof RegExp) {
                assert.match(
                    message,
                    pattern,
                    `Expected failure message "${message}" to match ${pattern}`,
                );
            } else {
                assert.ok(
                    message.includes(pattern),
                    `Expected failure message "${message}" to include "${pattern}"`,
                );
            }
            return this;
        },

        async toReturnResult<Rv>(matcher: (r: Rv) => boolean) {
            await execute();
            if (_error !== undefined) {
                assert.fail(
                    `Expected task "${task.id}" to return a result but it threw: ${String(_error)}`,
                );
            }
            assert.equal(
                _result?.success,
                true,
                `Expected task "${task.id}" result.success to be true`,
            );
            const ok = matcher(_result?.result as Rv);
            assert.equal(ok, true, `Expected task "${task.id}" result.data to pass the matcher`);
            return this;
        },

        async toReportProgress(processedAtLeast: number) {
            await execute();
            const maxProcessed = state.progressCalls.reduce(
                (acc, c) => Math.max(acc, c.processed),
                0,
            );
            assert.ok(
                state.progressCalls.length > 0 && maxProcessed >= processedAtLeast,
                `Expected task "${task.id}" to report progress >= ${processedAtLeast}, got max ${maxProcessed} across ${state.progressCalls.length} call(s)`,
            );
            return this;
        },

        async toSpend(kind: CostKind, atLeast = 1) {
            await execute();
            const actual = state.spendMap.get(kind) ?? 0;
            assert.ok(
                actual >= atLeast,
                `Expected task "${task.id}" to spend at least ${atLeast} ${kind}, got ${actual}`,
            );
            return this;
        },

        async toSpendExactly(kind: CostKind, exact: number) {
            await execute();
            // Reject the zero overload — `toNotSpend(kind)` is the documented
            // way to assert "no spend recorded" and having two paths to the
            // same assertion leads to inconsistent idioms across plugin
            // authors.
            if (exact === 0) {
                throw new Error(
                    'toSpendExactly: pass a non-zero value. Use toNotSpend(kind) to assert zero spend.',
                );
            }
            const actual = state.spendMap.get(kind) ?? 0;
            // Floating-point tolerance: cpu_seconds is commonly fractional
            // and exact equality would intermittently fail (0.1 + 0.2 !==
            // 0.3). Use 9 significant digits of tolerance — well below any
            // meaningful cost-tracking granularity.
            const FP_EPSILON = 1e-9;
            assert.ok(
                Math.abs(actual - exact) < FP_EPSILON,
                `Expected task "${task.id}" to spend exactly ${exact} ${kind}, got ${actual}`,
            );
            return this;
        },

        async toNotSpend(kind: CostKind) {
            await execute();
            const actual = state.spendMap.get(kind) ?? 0;
            assert.equal(
                actual,
                0,
                `Expected task "${task.id}" not to spend any ${kind}, got ${actual}`,
            );
            return this;
        },

        async toCallDep(name: string) {
            await execute();
            assert.ok(
                state.depCalls.has(name),
                `Expected task "${task.id}" to call dep("${name}") but it was not called. Called deps: [${[...state.depCalls].join(', ')}]`,
            );
            return this;
        },

        async toAbortWithin(ms: number) {
            const controller = new AbortController();
            const abortCtx = {
                ...buildState(task, input, ctxOverrides).ctx,
                signal: controller.signal as unknown as TaskContext['signal'],
                abortSignal: controller.signal as unknown as TaskContext['abortSignal'],
            };

            const timer = setTimeout(() => controller.abort(), ms);
            let threw = false;
            let isAbort = false;
            try {
                await task.execute(abortCtx);
            } catch (err) {
                threw = true;
                isAbort =
                    err instanceof Error &&
                    (err.name === 'AbortError' || err.message.includes('abort'));
            } finally {
                clearTimeout(timer);
            }

            assert.equal(threw, true, `Expected task "${task.id}" to throw after abort signal`);
            assert.equal(
                isAbort,
                true,
                `Expected task "${task.id}" to throw an AbortError within ${ms}ms`,
            );
            return this;
        },

        getSpend() {
            return state.spendMap;
        },
    };

    return matcher;
}
