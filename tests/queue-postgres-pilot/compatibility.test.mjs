// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHarness, waitFor } from './harness.mjs';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));

async function compileFixtures(directory) {
    // Use the app's existing compiler on the isolated runner. Resolve the SDK
    // source explicitly so stale, locally built SDK dist cannot qualify a run.
    const { build } = await import('esbuild');
    const outfile = path.join(directory, 'plugin-fixtures.mjs');
    let redirectedRegistrations = 0;
    await build({
        absWorkingDir: appRoot,
        entryPoints: ['tests/queue-postgres-pilot/fixtures/entry.ts'],
        outfile,
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        logLevel: 'silent',
        alias: {
            '@sapd/lumastra-plugin-sdk': path.join(
                appRoot,
                'packages/@sapd/lumastra-plugin-sdk/src/index.ts',
            ),
        },
        plugins: [
            {
                name: 'record-only-builtin-registration',
                setup(build) {
                    build.onResolve({ filter: /^\.\.\/\.\.\/registry\.js$/ }, (args) => {
                        assert.equal(
                            args.importer,
                            path.join(appRoot, 'src/lib/server/tasks/builtin/native/dummy-sync.ts'),
                        );
                        redirectedRegistrations += 1;
                        return { path: 'dummy-registration-only', namespace: 'pilot-registration' };
                    });
                    build.onLoad({ filter: /.*/, namespace: 'pilot-registration' }, () => ({
                        // Import-time registration is the sole host replacement.
                        // Actual registry/config/loader/TaskRunner are NOT exercised.
                        contents:
                            'export const registry={registerTask(t){if(t.id!=="dummy-sync")throw new Error("Unexpected builtin")}};',
                        loader: 'js',
                    }));
                },
            },
        ],
    });
    assert.equal(redirectedRegistrations, 1);
    return import(pathToFileURL(outfile).href);
}

async function terminal(job, state = 'completed') {
    await waitFor(async () => (await job.getState()) === state, {
        message: `job ${job.id} did not reach ${state}`,
    });
    return job.queue.getJob(job.id);
}

test(
    'unchanged TypeScript SDK definitions execute through a real PostgreSQL BullMQ worker',
    {
        timeout: 90_000,
    },
    async (t) => {
        const h = await createHarness({ label: 'compat' });
        let directory;
        try {
            directory = await mkdtemp(path.join(tmpdir(), 'bullmq-pg-sdk-'));
            const { sdkTask, dummySyncTask, mockContext, TaskError, PLUGIN_SDK_ABI } =
                await compileFixtures(directory);
            assert.equal(Number.isInteger(PLUGIN_SDK_ABI), true);

            // These are explicitly SDK test contexts, NOT production contexts. The
            // real queue lifecycle, processor invocation and persisted progress are
            // exercised; the full host capability implementations are unqualified.
            function processor(task, observations, { abortAt, mapFatal = false } = {}) {
                return async (job) => {
                    let writes = Promise.resolve();
                    const controller = new AbortController();
                    const trace = {
                        progress: [],
                        logs: [],
                        errors: [],
                        attempts: job.attemptsMade + 1,
                    };
                    observations.set(job.id, trace);
                    const input = task.inputSchema.parse(job.data.input);
                    const logger = {
                        info: (...args) => trace.logs.push(args),
                        warn() {},
                        error() {},
                        debug() {},
                        child() {
                            return this;
                        },
                    };
                    const ctx = mockContext({
                        input,
                        runId: job.data.runId,
                        mode: 'manual',
                        attemptNumber: job.attemptsMade + 1,
                        signal: controller.signal,
                        logger,
                        onProgress(processed, total, currentItem) {
                            const progress = {
                                processed,
                                total,
                                ...(currentItem ? { currentItem } : {}),
                            };
                            trace.progress.push(progress);
                            writes = writes.then(() => job.updateProgress(progress));
                            if (processed === abortAt) controller.abort();
                        },
                    });
                    try {
                        return await task.execute(ctx);
                    } catch (error) {
                        trace.errors.push({
                            name: error.name,
                            kind: error.kind,
                            message: error.message,
                        });
                        // Small pilot policy only. Production classification and
                        // task_history transitions remain in TaskRunner.
                        if (mapFatal && error instanceof TaskError && error.kind !== 'transient')
                            throw new h.classes.UnrecoverableError(error.message);
                        throw error;
                    } finally {
                        await writes;
                    }
                };
            }

            await t.test(
                'SDK validation, identity, metadata, logs, result and persisted progress',
                async () => {
                    assert.equal(sdkTask.inputSchema.safeParse({ identity: '' }).success, false);
                    const input = sdkTask.inputSchema.parse({ identity: 'alpha' });
                    assert.equal(input.failure, 'none');
                    assert.equal(sdkTask.identityFor(input), 'alpha');
                    const traces = new Map();
                    const queue = h.queue('sdk-success');
                    const worker = h.worker('sdk-success', processor(sdkTask, traces));
                    await worker.waitUntilReady();
                    const job = await queue.add(sdkTask.id, { input, runId: 'run-sdk-alpha' });
                    const saved = await terminal(job);
                    assert.deepEqual(saved.returnvalue, {
                        success: true,
                        itemsProcessed: 2,
                        result: {
                            identity: 'alpha',
                            runId: 'run-sdk-alpha',
                            attemptNumber: 1,
                            mode: 'manual',
                        },
                    });
                    assert.deepEqual(saved.progress, {
                        processed: 2,
                        total: 2,
                        currentItem: 'alpha',
                    });
                    assert.equal(traces.get(job.id).progress.length, 2);
                    assert.equal(traces.get(job.id).logs[0][0], 'SDK fixture running');
                    const malformed = await queue.add(sdkTask.id, {
                        input: { identity: '' },
                        runId: 'run-malformed',
                    });
                    const rejected = await terminal(malformed, 'failed');
                    assert.match(rejected.failedReason, /identity/);
                    assert.deepEqual(traces.get(malformed.id).progress, []);
                    assert.deepEqual(traces.get(malformed.id).logs, []);
                    await worker.close();
                },
            );

            await t.test(
                'SDK transient error reaches worker retry with incremented attempt metadata',
                async () => {
                    const traces = new Map();
                    const allErrors = [];
                    const queue = h.queue('sdk-retry');
                    const execute = processor(sdkTask, traces);
                    const worker = h.worker('sdk-retry', async (job) => {
                        try {
                            return await execute(job);
                        } catch (error) {
                            allErrors.push([error.name, error.kind]);
                            throw error;
                        }
                    });
                    const job = await queue.add(
                        sdkTask.id,
                        {
                            input: { identity: 'retry', failure: 'transient' },
                            runId: 'run-retry',
                        },
                        { attempts: 2, backoff: { type: 'fixed', delay: 25 } },
                    );
                    const saved = await terminal(job);
                    assert.deepEqual(allErrors, [['TaskError', 'transient']]);
                    assert.equal(saved.returnvalue.result.attemptNumber, 2);
                    assert.equal(saved.attemptsMade, 2);
                    await worker.close();
                },
            );

            await t.test(
                'SDK permanent/fatal classification can suppress queue retries explicitly',
                async () => {
                    for (const failure of ['permanent', 'fatal']) {
                        const traces = new Map();
                        const queue = h.queue(`sdk-${failure}`);
                        const worker = h.worker(
                            `sdk-${failure}`,
                            processor(sdkTask, traces, { mapFatal: true }),
                        );
                        const job = await queue.add(
                            sdkTask.id,
                            {
                                input: { identity: failure, failure },
                                runId: `run-${failure}`,
                            },
                            { attempts: 3 },
                        );
                        const saved = await terminal(job, 'failed');
                        assert.equal(saved.attemptsMade, 1);
                        assert.equal(saved.failedReason, `SDK ${failure} fixture`);
                        assert.deepEqual(traces.get(job.id).errors[0], {
                            name: 'TaskError',
                            kind: failure,
                            message: `SDK ${failure} fixture`,
                        });
                        await worker.close();
                    }
                },
            );

            await t.test(
                'existing builtin source retains success, ordinary failure and cooperative abort',
                async () => {
                    for (const scenario of ['success', 'failure', 'abort']) {
                        const traces = new Map();
                        const queue = h.queue(`builtin-${scenario}`);
                        const worker = h.worker(
                            `builtin-${scenario}`,
                            processor(dummySyncTask, traces, {
                                abortAt: scenario === 'abort' ? 2 : undefined,
                            }),
                        );
                        const job = await queue.add(dummySyncTask.id, {
                            input: {
                                itemCount: 4,
                                itemDelayMs: 1,
                                mode: scenario === 'failure' ? 'fail' : 'ok',
                            },
                            runId: `run-builtin-${scenario}`,
                        });
                        const saved = await terminal(
                            job,
                            scenario === 'failure' ? 'failed' : 'completed',
                        );
                        if (scenario === 'success') {
                            assert.deepEqual(saved.returnvalue, {
                                success: true,
                                itemsProcessed: 4,
                                result: { processed: 4 },
                            });
                            assert.deepEqual(saved.progress, { processed: 4, total: 4 });
                        } else if (scenario === 'failure') {
                            assert.equal(saved.failedReason, 'Simulated failure at midpoint');
                        } else {
                            assert.deepEqual(saved.returnvalue, {
                                success: false,
                                itemsProcessed: 2,
                                stopReason: 'aborted',
                            });
                            assert.equal(traces.get(job.id).progress.length, 2);
                            // A returned abort result is queue-completed here. Only the
                            // full TaskRunner can qualify application cancelled state.
                            assert.equal(await saved.getState(), 'completed');
                        }
                        await worker.close();
                    }
                },
            );
            h.assertHealthy();
        } finally {
            try {
                await h.close();
            } finally {
                if (directory) await rm(directory, { recursive: true, force: true });
            }
        }
    },
);
