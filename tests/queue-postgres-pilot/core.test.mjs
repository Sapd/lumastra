// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, deferred, sleep, waitFor, withTimeout } from './harness.mjs';

const testOptions = { timeout: 45000 };

async function fixture(run) {
    const h = await createHarness({ label: 'core' });
    try {
        await run(h);
        h.assertHealthy();
    } finally {
        await h.close();
    }
}

async function state(queue, id, expected) {
    return waitFor(async () => (await queue.getJob(id))?.getState().then((s) => s === expected), {
        message: `job becomes ${expected}`,
    });
}

test(
    'core: add/get, structured progress, result and published completion agree',
    testOptions,
    async () =>
        fixture(async (h) => {
            const queue = h.queue('lifecycle');
            // PostgreSQL cursors are decimal bigint IDs, not Redis stream IDs.
            const events = h.events(queue.name, { lastEventId: '0' });
            const progress = [];
            const completed = [];
            events.on('progress', (event) => progress.push(event));
            events.on('completed', (event) => completed.push(event));
            await events.waitUntilReady();
            const job = await queue.add(
                'scan',
                { root: 'fixture', paths: ['one', 'two'] },
                { jobId: 'lifecycle-job' },
            );
            assert.deepEqual((await queue.getJob(job.id)).data, job.data);
            h.worker(queue.name, async (active) => {
                await active.updateProgress({ completed: 1, total: 2 });
                return { indexed: active.data.paths.length };
            });
            assert.deepEqual(await job.waitUntilFinished(events, 15000), { indexed: 2 });
            await waitFor(() => progress.length && completed.length);
            const persisted = await queue.getJob(job.id);
            assert.equal(await persisted.getState(), 'completed');
            assert.deepEqual(persisted.progress, { completed: 1, total: 2 });
            assert.deepEqual(persisted.returnvalue, { indexed: 2 });
            assert.deepEqual(progress[0].data, persisted.progress);
            assert.equal(completed[0].jobId, job.id);
            assert.deepEqual(completed[0].returnvalue, persisted.returnvalue);
        }),
);

test(
    'core: stable custom job IDs suppress duplicates without replacing persisted payload',
    testOptions,
    async () =>
        fixture(async (h) => {
            const queue = h.queue('identity');
            const original = await queue.add('scan', { revision: 1 }, { jobId: 'media-fixture' });
            const duplicate = await queue.add('scan', { revision: 2 }, { jobId: 'media-fixture' });
            assert.equal(duplicate.id, original.id);
            assert.equal(await queue.getWaitingCount(), 1);
            assert.deepEqual((await queue.getJob(original.id)).data, { revision: 1 });
            let calls = 0;
            h.worker(queue.name, async () => {
                calls += 1;
                return 'ok';
            });
            await state(queue, original.id, 'completed');
            await queue.add('scan', { revision: 3 }, { jobId: 'media-fixture' });
            await sleep(100);
            assert.equal(calls, 1);
            assert.deepEqual((await queue.getJob(original.id)).data, { revision: 1 });
        }),
);

test(
    'core: simple deduplication lasts through completion and then releases its key',
    testOptions,
    async () =>
        fixture(async (h) => {
            const queue = h.queue('dedup');
            const first = await queue.add(
                'refresh',
                { version: 1 },
                { deduplication: { id: 'library' } },
            );
            const second = await queue.add(
                'refresh',
                { version: 2 },
                { deduplication: { id: 'library' } },
            );
            assert.equal(first.id, second.id);
            assert.equal(await queue.getWaitingCount(), 1);
            h.worker(queue.name, async (job) => job.data.version);
            await state(queue, first.id, 'completed');
            const next = await queue.add(
                'refresh',
                { version: 3 },
                { deduplication: { id: 'library' } },
            );
            assert.notEqual(next.id, first.id);
            await state(queue, next.id, 'completed');
            assert.equal((await queue.getJob(next.id)).returnvalue, 3);
        }),
);

test('core: queued priorities execute in numeric priority order', testOptions, async () =>
    fixture(async (h) => {
        const queue = h.queue('priority');
        const seen = [];
        await queue.add('background', {}, { priority: 20, jobId: 'low' });
        await queue.add('interactive', {}, { priority: 1, jobId: 'high' });
        await queue.add('normal', {}, { priority: 5, jobId: 'middle' });
        h.worker(queue.name, async (job) => {
            seen.push(job.id);
        });
        await waitFor(() => seen.length === 3);
        assert.deepEqual(seen, ['high', 'middle', 'low']);
        await state(queue, 'low', 'completed');
    }),
);

test('core: delayed work is not executed before its due time', testOptions, async () =>
    fixture(async (h) => {
        const queue = h.queue('delay');
        const job = await queue.add('scheduled', {}, { delay: 350 });
        assert.equal(await job.getState(), 'delayed');
        let started;
        h.worker(queue.name, async () => {
            started = Date.now();
            return 'due';
        });
        await state(queue, job.id, 'completed');
        assert.ok(started >= job.timestamp + 350, 'delayed job started before due time');
    }),
);

test(
    'core: fixed backoff retries transient failure and preserves final attempt accounting',
    testOptions,
    async () =>
        fixture(async (h) => {
            const queue = h.queue('retry');
            const starts = [];
            h.worker(queue.name, async () => {
                starts.push(Date.now());
                if (starts.length < 3) throw new Error('fixture transient failure');
                return 'recovered';
            });
            const job = await queue.add(
                'retryable',
                {},
                { attempts: 3, backoff: { type: 'fixed', delay: 150 } },
            );
            await state(queue, job.id, 'completed');
            const persisted = await queue.getJob(job.id);
            assert.equal(starts.length, 3);
            assert.ok(starts[1] - starts[0] >= 150);
            assert.ok(starts[2] - starts[1] >= 150);
            assert.equal(persisted.attemptsMade, 3);
            assert.equal(persisted.returnvalue, 'recovered');
        }),
);

test('core: UnrecoverableError fails permanently despite a retry budget', testOptions, async () =>
    fixture(async (h) => {
        const queue = h.queue('permanent');
        let calls = 0;
        h.worker(queue.name, async () => {
            calls += 1;
            throw new h.classes.UnrecoverableError('fixture permanently invalid');
        });
        const job = await queue.add('invalid', {}, { attempts: 4, backoff: 50 });
        await state(queue, job.id, 'failed');
        await sleep(150);
        const persisted = await queue.getJob(job.id);
        assert.equal(calls, 1);
        assert.equal(persisted.attemptsMade, 1);
        assert.match(persisted.failedReason, /permanently invalid/);
    }),
);

test(
    'core: global pause/resume and worker concurrency bound active processors',
    testOptions,
    async () =>
        fixture(async (h) => {
            const queue = h.queue('concurrency');
            const release = deferred();
            let active = 0;
            let peak = 0;
            let starts = 0;
            await queue.pause();
            const worker = h.worker(
                queue.name,
                async () => {
                    starts += 1;
                    active += 1;
                    peak = Math.max(peak, active);
                    try {
                        await withTimeout(release.promise, 15000, 'concurrency processor gate');
                    } finally {
                        active -= 1;
                    }
                },
                { concurrency: 2 },
            );
            try {
                await worker.waitUntilReady();
                const jobs = await queue.addBulk(
                    Array.from({ length: 4 }, (_, i) => ({
                        name: 'bounded',
                        data: { i },
                        opts: { jobId: `bounded-${i}` },
                    })),
                );
                await sleep(150);
                assert.equal(starts, 0);
                assert.equal(await queue.isPaused(), true);
                await queue.resume();
                await waitFor(() => active === 2);
                assert.equal(await queue.getActiveCount(), 2);
                assert.equal(starts, 2);
                release.resolve();
                for (const job of jobs) await state(queue, job.id, 'completed');
                assert.equal(starts, 4);
                assert.equal(peak, 2);
            } finally {
                release.resolve();
            }
        }),
);

test(
    'core: strict-tree flow waits for both children and exposes their results',
    testOptions,
    async () =>
        fixture(async (h) => {
            const parentQueue = h.queue('flow_parent');
            const childQueue = h.queue('flow_child');
            const flow = h.flow();
            const tree = await flow.add({
                name: 'aggregate',
                queueName: parentQueue.name,
                data: {},
                children: [1, 2].map((value) => ({
                    name: 'leaf',
                    queueName: childQueue.name,
                    data: { value },
                })),
            });
            assert.equal(await tree.job.getState(), 'waiting-children');
            assert.equal((await tree.job.getDependenciesCount()).unprocessed, 2);
            let parentCalls = 0;
            h.worker(parentQueue.name, async (job) => {
                parentCalls += 1;
                return Object.values(await job.getChildrenValues()).sort();
            });
            await sleep(100);
            assert.equal(parentCalls, 0);
            h.worker(childQueue.name, async (job) => job.data.value * 10, { concurrency: 2 });
            await state(parentQueue, tree.job.id, 'completed');
            assert.equal(parentCalls, 1);
            assert.deepEqual((await parentQueue.getJob(tree.job.id)).returnvalue, [10, 20]);
            assert.equal((await tree.job.getDependenciesCount()).processed, 2);
        }),
);

test(
    'core: active parent can attach a real child, park, and resume without consuming an attempt',
    testOptions,
    async () =>
        fixture(async (h) => {
            const parentQueue = h.queue('park_parent');
            const childQueue = h.queue('park_child');
            let starts = 0;
            h.worker(parentQueue.name, async (job, token) => {
                starts += 1;
                if (starts === 1) {
                    await childQueue.add(
                        'child',
                        {},
                        {
                            parent: { id: job.id, queue: parentQueue.qualifiedName },
                        },
                    );
                    assert.equal(await job.moveToWaitingChildren(token), true);
                    throw new h.classes.WaitingChildrenError();
                }
                return Object.values(await job.getChildrenValues());
            });
            const parent = await parentQueue.add('dynamic-parent', {}, { attempts: 1 });
            await state(parentQueue, parent.id, 'waiting-children');
            assert.equal(starts, 1);
            h.worker(childQueue.name, async () => 'child-result');
            await state(parentQueue, parent.id, 'completed');
            const persisted = await parentQueue.getJob(parent.id);
            assert.equal(starts, 2);
            assert.equal(persisted.attemptsMade, 1);
            assert.deepEqual(persisted.returnvalue, ['child-result']);
        }),
);

test(
    'core: waiting-children does not provide arbitrary manual parking without pending children',
    testOptions,
    async () =>
        fixture(async (h) => {
            const queue = h.queue('empty_park');
            const job = await queue.add('no-children', {});
            const worker = h.worker(queue.name, null, { autorun: false });
            const active = await worker.getNextJob('pilot-manual-token', { block: false });
            assert.equal(active.id, job.id);
            assert.equal(await active.moveToWaitingChildren('pilot-manual-token'), false);
            assert.equal(await active.getState(), 'active');
            await active.moveToCompleted('finished', 'pilot-manual-token', false);
            assert.equal(await job.getState(), 'completed');
        }),
);

test(
    'core: automatic renewal survives multiple lease durations and rejects stale-token writes',
    testOptions,
    async () =>
        fixture(async (h) => {
            const queue = h.queue('renewal');
            const started = deferred();
            const release = deferred();
            h.worker(
                queue.name,
                async (job) => {
                    started.resolve(job);
                    await withTimeout(release.promise, 15000, 'renewal processor gate');
                    return 'renewed';
                },
                { lockDuration: 400, lockRenewTime: 100, stalledInterval: 150 },
            );
            try {
                const job = await queue.add('long', {});
                const active = await withTimeout(started.promise, 15000, 'long processor start');
                await sleep(1100);
                assert.equal(await job.getState(), 'active');
                assert.equal(await active.extendLock('stale-owner', 400), 0);
                await assert.rejects(
                    active.moveToCompleted('stale-result', 'stale-owner', false),
                    /lock|token/i,
                );
                release.resolve();
                await state(queue, job.id, 'completed');
                assert.equal((await queue.getJob(job.id)).returnvalue, 'renewed');
            } finally {
                release.resolve();
            }
        }),
);

test(
    'core: an abandoned claim expires, is recovered, and cannot acknowledge its replacement',
    testOptions,
    async () =>
        fixture(async (h) => {
            const queue = h.queue('recovery');
            const job = await queue.add('abandoned', {});
            const oldWorker = h.worker(queue.name, null, {
                autorun: false,
                lockDuration: 250,
                skipLockRenewal: true,
            });
            const abandoned = await oldWorker.getNextJob('old-claim', { block: false });
            assert.equal(abandoned.id, job.id);
            await oldWorker.close(true);
            await sleep(350);
            const recovered = deferred();
            const release = deferred();
            const replacement = h.worker(
                queue.name,
                async (active) => {
                    recovered.resolve(active);
                    await withTimeout(release.promise, 15000, 'recovery processor gate');
                    return 'replacement-result';
                },
                { stalledInterval: 100, lockDuration: 1000 },
            );
            const stalled = [];
            replacement.on('stalled', (id) => stalled.push(id));
            try {
                await withTimeout(recovered.promise, 15000, 'stalled claim recovery');
                assert.ok(stalled.includes(job.id));
                // A Job belongs to the resource that loaded it. Query through
                // the still-open producer after closing the abandoned worker;
                // the pinned backend intentionally never settles closed-pool
                // operations, which cannot prove a stale-token fence.
                const staleView = await queue.getJob(job.id);
                assert.equal(
                    await withTimeout(
                        staleView.extendLock('old-claim', 1000),
                        5000,
                        'stale owner lock refusal',
                    ),
                    0,
                );
                await assert.rejects(
                    withTimeout(
                        staleView.moveToCompleted('obsolete', 'old-claim', false),
                        5000,
                        'stale owner acknowledgement refusal',
                    ),
                    /lock|token/i,
                );
                release.resolve();
                await state(queue, job.id, 'completed');
                const persisted = await queue.getJob(job.id);
                assert.equal(persisted.returnvalue, 'replacement-result');
                assert.equal(persisted.attemptsStarted, 2);
            } finally {
                release.resolve();
            }
        }),
);

test(
    'core: cancelJob delivers the real processor AbortSignal and persists cooperative failure',
    testOptions,
    async () =>
        fixture(async (h) => {
            const queue = h.queue('cancel');
            const started = deferred();
            let abortReason;
            let calls = 0;
            const worker = h.worker(queue.name, async (_job, _token, signal) => {
                calls += 1;
                assert.ok(signal instanceof AbortSignal);
                started.resolve();
                await new Promise((_, reject) => {
                    signal.addEventListener(
                        'abort',
                        () => {
                            abortReason = signal.reason;
                            reject(
                                new h.classes.UnrecoverableError('fixture cancellation observed'),
                            );
                        },
                        { once: true },
                    );
                });
            });
            const job = await queue.add('cancellable', {}, { attempts: 3 });
            try {
                await withTimeout(started.promise, 15000, 'cancellable processor start');
                assert.equal(worker.cancelJob('missing-job', 'missing'), false);
                assert.equal(worker.cancelJob(job.id, 'pilot cancellation'), true);
                await state(queue, job.id, 'failed');
                assert.equal(abortReason, 'pilot cancellation');
                assert.equal(calls, 1);
                assert.match((await queue.getJob(job.id)).failedReason, /cancellation observed/);
            } finally {
                worker.cancelAllJobs('fixture cleanup');
            }
        }),
);

test(
    'characterization: published event replay exceeds configured maxLen (retention remains a gap)',
    testOptions,
    async () =>
        fixture(async (h) => {
            const bound = 4;
            const sample = 256;
            const queue = h.queue('retention', { streams: { events: { maxLen: bound } } });
            await queue.addBulk(
                Array.from({ length: sample }, (_, i) => ({
                    name: 'retained-event',
                    data: { i },
                })),
            );
            const replay = h.events(queue.name, { lastEventId: '0' });
            const waiting = new Set();
            replay.on('waiting', ({ jobId }) => waiting.add(jobId));
            await replay.waitUntilReady();
            await waitFor(() => waiting.size === sample);
            assert.equal(waiting.size, sample);
            assert.ok(
                waiting.size > bound,
                'Reassess bulk-insert retention characterization if this path starts trimming',
            );
            // This bounded sample demonstrates overshoot; by itself it cannot prove
            // indefinitely unbounded retention. It is never a bounded-retention pass.
            // Do not substitute unsupported trimEvents here.
        }),
);

test(
    "core: terminating only this run's LISTEN session recovers delivery without losing a job",
    testOptions,
    async () =>
        fixture(async (h) => {
            const queue = h.queue('outage');
            const events = h.events(queue.name, { lastEventId: '0' });
            const completions = [];
            events.on('completed', (event) => completions.push(event));
            await events.waitUntilReady();
            let calls = 0;
            const worker = h.worker(
                queue.name,
                async () => {
                    calls += 1;
                    return 'after-reconnect';
                },
                { runRetryDelay: 100 },
            );
            await worker.waitUntilReady();
            const originalListener = await waitFor(
                async () => {
                    const result = await h.query(
                        `SELECT pid FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = $1
          AND pid <> pg_backend_pid()`,
                        [queue.name],
                    );
                    return result.rows.length === 1 ? result.rows[0] : false;
                },
                { message: 'run-owned LISTEN session is visible' },
            );
            assert.ok(queue.name.startsWith(`${h.nonce}_`));
            const killed = await h.query(
                `SELECT pid, pg_terminate_backend(pid) AS terminated
      FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = $1
        AND pid = $2 AND pid <> pg_backend_pid()`,
                [queue.name, originalListener.pid],
            );
            assert.equal(killed.rows.length, 1);
            assert.equal(killed.rows[0].pid, originalListener.pid);
            assert.equal(killed.rows[0].terminated, true);
            await waitFor(() => h.observedErrors.length > 0, {
                message: 'real terminated connection surfaces an error',
            });
            const replacementListener = await waitFor(
                async () => {
                    const result = await h.query(
                        `SELECT pid FROM pg_stat_activity
                         WHERE datname = current_database() AND application_name = $1
                           AND pid <> pg_backend_pid()`,
                        [queue.name],
                    );
                    return result.rows.length === 1 && result.rows[0].pid !== originalListener.pid
                        ? result.rows[0]
                        : false;
                },
                { message: 'exactly one new run-owned LISTEN session replaces the terminated PID' },
            );
            assert.notEqual(replacementListener.pid, originalListener.pid);
            const job = await queue.add('after-outage', {}, { jobId: 'after-outage-once' });
            await state(queue, job.id, 'completed');
            await waitFor(() => completions.some((event) => event.jobId === job.id), {
                message: 'QueueEvents publishes completion after the listener fault',
            });
            assert.equal(calls, 1);
            assert.equal((await queue.getJob(job.id)).returnvalue, 'after-reconnect');
            assert.deepEqual(
                completions
                    .filter((event) => event.jobId === job.id)
                    .map((event) => event.returnvalue),
                ['after-reconnect'],
            );
            for (const error of h.observedErrors) {
                assert.match(
                    String(error.message),
                    /terminat|connection.*closed|connection.*lost/i,
                );
            }
            h.observedErrors.splice(0); // Only the asserted fault-injection errors are acknowledged.
            // A lost LISTEN socket is not an unknown commit ACK. The latter still
            // needs a separate real transport fault at the commit/response boundary.
        }),
);
