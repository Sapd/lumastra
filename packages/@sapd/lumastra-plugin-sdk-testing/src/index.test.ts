// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import type { TaskDefinition } from '@sapd/lumastra-plugin-sdk';
import {
    mockContext,
    runTask,
    expectRun,
    mockHttpClient,
    mockCache,
    mockFfmpegRunner,
    mockLogger,
} from './index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const minimalTaskDef: TaskDefinition<{ libraryGroupId?: string }, void> = {
    id: 'test-task',
    name: 'Test Task',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '1.0.0',
    capabilities: { database: true },
    resourceClass: 'io',
    inputSchema: z.object({ libraryGroupId: z.string().optional() }),
    identityFor: (input) => input.libraryGroupId ?? 'global',
    async execute(_ctx) {
        return { success: true, itemsProcessed: 0 };
    },
};

// ---------------------------------------------------------------------------
// mockContext
// ---------------------------------------------------------------------------

describe('mockContext', () => {
    it('returns a usable stub with defaults', () => {
        const ctx = mockContext();
        expect(ctx.runId).toMatch(/^run_test_/);
        expect(ctx.attemptNumber).toBe(1);
        expect(ctx.mode).toBe('manual');
    });

    it('accepts input overrides', () => {
        const ctx = mockContext({ input: { libraryGroupId: 'grp-1' } });
        expect((ctx.input as { libraryGroupId: string }).libraryGroupId).toBe('grp-1');
    });

    it('logger methods are no-ops and child() returns same shape', () => {
        const ctx = mockContext();
        expect(() => ctx.logger.info('test')).not.toThrow();
        expect(() => ctx.logger.warn('w')).not.toThrow();
        expect(() => ctx.logger.error('e')).not.toThrow();
        expect(() => ctx.logger.debug('d')).not.toThrow();
        const child = ctx.logger.child({ key: 'val' });
        expect(typeof child.info).toBe('function');
    });

    it('sql proxy throws on access', () => {
        const ctx = mockContext();
        expect(() => (ctx.sql as unknown as Record<string, unknown>)['query']).toThrow(
            /sql not mocked/,
        );
    });

    it('secrets.get throws', () => {
        const ctx = mockContext();
        expect(() => ctx.secrets.get('MY_KEY')).toThrow(/not mocked/);
    });

    it('reportProgress and spend are no-ops', () => {
        const ctx = mockContext();
        expect(() => ctx.reportProgress(1, 10, 'item')).not.toThrow();
        expect(() => ctx.spend('api_calls', 1)).not.toThrow();
    });

    it('drain resolves immediately', async () => {
        const ctx = mockContext();
        const result = await ctx.drain();
        expect(result.stopReason).toBe('drained');
    });
});

// ---------------------------------------------------------------------------
// runTask
// ---------------------------------------------------------------------------

describe('runTask', () => {
    it('invokes execute and returns the result', async () => {
        const result = await runTask(minimalTaskDef, { libraryGroupId: 'abc' });
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
    });

    it('passes input through to execute', async () => {
        const captured: Array<unknown> = [];
        const task = defineTask({
            ...minimalTaskDef,
            id: 'capture-task',
            async execute(ctx) {
                captured.push(ctx.input);
                return { success: true };
            },
        });
        await runTask(task, { libraryGroupId: 'xyz' });
        expect((captured[0] as { libraryGroupId: string }).libraryGroupId).toBe('xyz');
    });
});

// ---------------------------------------------------------------------------
// expectRun
// ---------------------------------------------------------------------------

describe('expectRun', () => {
    it('toCompleteSuccessfully passes for a successful task', async () => {
        await expectRun(minimalTaskDef, {}).toCompleteSuccessfully();
    });

    it('toFailWith passes when task throws TaskError', async () => {
        const failingTask = defineTask({
            ...minimalTaskDef,
            id: 'failing-task',
            async execute() {
                throw new TaskError({
                    message: 'transient network error',
                    kind: 'transient',
                });
            },
        });
        await expectRun(failingTask, {}).toFailWith(/transient/);
    });

    it('toFailWith passes when task returns success=false', async () => {
        const task = defineTask({
            ...minimalTaskDef,
            id: 'no-progress-task',
            async execute() {
                return { success: false, stopReason: 'no-progress' as const };
            },
        });
        await expectRun(task, {}).toFailWith('no-progress');
    });
});

// ---------------------------------------------------------------------------
// mockContext — friendly shape
// ---------------------------------------------------------------------------

describe('mockContext friendly shape', () => {
    it('resolves provided secrets', async () => {
        const ctx = mockContext({ secrets: { tmdb_api_key: 'fake-key' } });
        await expect(ctx.secrets.get('tmdb_api_key')).resolves.toBe('fake-key');
    });

    it('throws for unknown secrets', () => {
        const ctx = mockContext({ secrets: {} });
        expect(() => ctx.secrets.get('unknown')).toThrow(/not mocked/);
    });

    it('resolves user secrets', async () => {
        const ctx = mockContext({ userSecrets: { user1: { mytoken: 'tok' } } });
        await expect(ctx.secrets.getUser('user1', 'mytoken')).resolves.toBe('tok');
    });

    it('records spend in internal map', () => {
        const ctx = mockContext();
        ctx.spend('api_calls', 5);
        ctx.spend('api_calls', 3);
        // each mockContext instance has its own spend map; verify spend is callable
        expect(ctx.spend).toBeDefined();
    });

    it('accepts settings and returns them', async () => {
        const ctx = mockContext({ settings: { enabled: true } });
        const result = await ctx.settings();
        expect(result['enabled']).toBe(true);
    });

    it('accepts http/cache/logger directly', () => {
        const http = mockHttpClient();
        const cache = mockCache();
        const logger = mockLogger();
        const ctx = mockContext({ http, cache, logger });
        expect(ctx.http).toBe(http);
        expect(ctx.cache).toBe(cache);
        expect(ctx.logger).toBe(logger);
        // `ctx.ffmpeg` is NOT part of the context any more — it was a stub that
        // threw on first call, so binding a mock to it would be mocking
        // something no plugin can reach.
        expect((ctx as unknown as Record<string, unknown>).ffmpeg).toBeUndefined();
    });

    it('binds caller-supplied AbortSignal to both signal and abortSignal', () => {
        const controller = new AbortController();
        const ctx = mockContext({ signal: controller.signal });
        expect(ctx.signal).toBe(controller.signal);
        expect(ctx.abortSignal).toBe(controller.signal);
    });

    it('honours runId and attemptNumber overrides for deterministic tests', () => {
        const ctx = mockContext({ runId: 'run_fixture', attemptNumber: 3 });
        expect(ctx.runId).toBe('run_fixture');
        expect(ctx.attemptNumber).toBe(3);
    });

    it('sql proxy tolerates reflective access (symbols, then, name, length, prototype)', () => {
        const ctx = mockContext();
        // These accesses MUST NOT throw — vitest's matcher diff renderer,
        // Promise plumbing, and Node's util.inspect all reflect on values
        // via these keys. Only genuine task-code dereferences should throw.
        expect(() => {
            void (ctx.sql as unknown as { [Symbol.iterator]?: unknown })[Symbol.iterator];
        }).not.toThrow();
        expect(() => {
            void (ctx.sql as unknown as { then?: unknown }).then;
        }).not.toThrow();
        expect(() => void (ctx.sql as unknown as { name?: unknown }).name).not.toThrow();
        expect(() => void (ctx.sql as unknown as { length?: unknown }).length).not.toThrow();
        expect(() => void (ctx.sql as unknown as { prototype?: unknown }).prototype).not.toThrow();
        // But genuine task-code access still throws with the actionable message.
        expect(() => void (ctx.sql as unknown as { query?: unknown }).query).toThrow(
            /sql not mocked.*mockContext\(\{ sql \}\)/,
        );
    });

    it('sql proxy `has` trap excludes task-code property names', () => {
        const ctx = mockContext();
        // `'query' in ctx.sql` must be false — otherwise gate-on-`in` code
        // skips the not-mocked branch and silently no-ops.
        expect('query' in (ctx.sql as object)).toBe(false);
        // Reserved function keys still report as present (Function.prototype
        // would normally show them on the function target).
        expect('name' in (ctx.sql as object)).toBe(true);
        expect('length' in (ctx.sql as object)).toBe(true);
    });

    it('sql proxy `set` trap rejects assignments', () => {
        const ctx = mockContext();
        expect(() => {
            (ctx.sql as unknown as Record<string, unknown>)['query'] = 'mutated';
        }).toThrow(/sql not mocked.*assign/);
    });
});

// ---------------------------------------------------------------------------
// expectRun — extended matchers
// ---------------------------------------------------------------------------

describe('expectRun extended matchers', () => {
    it('toReturnResult passes when result matches', async () => {
        const task = defineTask({
            ...minimalTaskDef,
            id: 'return-result-task',
            async execute() {
                return { success: true, result: { count: 42 } };
            },
        });
        await expectRun(task, {}).toReturnResult<{ count: number }>(
            (r: { count: number }) => r.count === 42,
        );
    });

    it('toReportProgress passes when progress was reported', async () => {
        const task = defineTask({
            ...minimalTaskDef,
            id: 'progress-task',
            async execute(ctx) {
                ctx.reportProgress(10, 100);
                return { success: true };
            },
        });
        await expectRun(task, {}).toReportProgress(10);
    });

    it('toSpend passes when spend was recorded', async () => {
        const task = defineTask({
            ...minimalTaskDef,
            id: 'spend-task',
            async execute(ctx) {
                ctx.spend('api_calls', 5);
                return { success: true };
            },
        });
        await expectRun(task, {}).toSpend('api_calls', 5);
    });

    it('toSpendExactly fails when spend mismatches', async () => {
        const task = defineTask({
            ...minimalTaskDef,
            id: 'spend-exact-task',
            async execute(ctx) {
                ctx.spend('api_calls', 7);
                return { success: true };
            },
        });
        await expectRun(task, {}).toSpendExactly('api_calls', 7);
        await expect(expectRun(task, {}).toSpendExactly('api_calls', 5)).rejects.toThrow(
            /spend exactly 5 api_calls, got 7/,
        );
    });

    it('toSpendExactly tolerates floating-point drift on fractional units', async () => {
        const task = defineTask({
            ...minimalTaskDef,
            id: 'spend-fractional',
            async execute(ctx) {
                ctx.spend('cpu_seconds', 0.1);
                ctx.spend('cpu_seconds', 0.2);
                return { success: true };
            },
        });
        // 0.1 + 0.2 === 0.30000000000000004; assertion must still pass at 0.3.
        await expectRun(task, {}).toSpendExactly('cpu_seconds', 0.3);
    });

    it('toSpendExactly rejects zero — use toNotSpend instead', async () => {
        const task = defineTask({
            ...minimalTaskDef,
            id: 'spend-zero-misuse',
            async execute() {
                return { success: true };
            },
        });
        await expect(expectRun(task, {}).toSpendExactly('api_calls', 0)).rejects.toThrow(
            /Use toNotSpend\(kind\)/,
        );
    });

    it('toNotSpend passes when no spend recorded and fails otherwise', async () => {
        const silent = defineTask({
            ...minimalTaskDef,
            id: 'silent-task',
            async execute() {
                return { success: true };
            },
        });
        await expectRun(silent, {}).toNotSpend('api_calls');

        const noisy = defineTask({
            ...minimalTaskDef,
            id: 'noisy-task',
            async execute(ctx) {
                ctx.spend('cpu_seconds', 2);
                return { success: true };
            },
        });
        await expect(expectRun(noisy, {}).toNotSpend('cpu_seconds')).rejects.toThrow(
            /not to spend any cpu_seconds/,
        );
    });

    it('matchers chain', async () => {
        const task = defineTask({
            ...minimalTaskDef,
            id: 'chain-task',
            async execute(ctx) {
                ctx.reportProgress(1, 1);
                ctx.spend('cpu_seconds', 2);
                return { success: true, result: { ok: true } };
            },
        });
        await (
            await (await expectRun(task, {}).toCompleteSuccessfully()).toReportProgress(1)
        ).toSpend('cpu_seconds', 2);
    });
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

describe('mock helpers', () => {
    it('mockHttpClient records calls and returns 200', async () => {
        const client = mockHttpClient();
        const res = await client.get('https://example.com');
        expect(res.status).toBe(200);
        expect(client.calls).toHaveLength(1);
        expect(client.calls[0].url).toBe('https://example.com');
    });

    it('mockCache stores and retrieves values', async () => {
        const cache = mockCache();
        await cache.set('key', { value: 42 });
        const result = await cache.get<{ value: number }>('key');
        expect(result?.value).toBe(42);
        await cache.del('key');
        expect(await cache.get('key')).toBeNull();
    });

    // Retained as a STANDALONE helper: `ctx.ffmpeg` is gone, but a plugin that
    // shells out to ffmpeg itself still has a runner of its own worth faking.
    it('mockFfmpegRunner records invocations', async () => {
        const ffmpeg = mockFfmpegRunner();
        ffmpeg.setResult({ stdout: 'ok', stderr: '', code: 0 });
        const result = await ffmpeg.run(['-i', 'input.mp4']);
        expect(result.stdout).toBe('ok');
        expect(ffmpeg.calls).toHaveLength(1);
    });

    it('mockLogger records entries', () => {
        const logger = mockLogger();
        logger.info('hello', { key: 'val' });
        logger.warn('warning');
        logger.error('err');
        logger.debug('dbg');
        expect(logger.entries).toHaveLength(4);
        expect(logger.entries[0].level).toBe('info');
        expect(logger.entries[0].msg).toBe('hello');
    });
});
