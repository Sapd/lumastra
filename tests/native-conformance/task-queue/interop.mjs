// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Actual binary / exact installed npm client / real isolated Valkey. No mocks.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { connect, createServer } from 'node:net';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
    Queue,
    Worker,
    QueueEvents,
    FlowProducer,
    DelayedError,
    WaitingChildrenError,
    UnrecoverableError,
} from 'bullmq';
import Redis from 'ioredis';
import { publishedCommand } from './script-audit.mjs';

const require = createRequire(import.meta.url);
assert.equal(
    require('bullmq/package.json').version,
    '6.3.15',
    'qualify the exact pinned npm client',
);
const BINARY =
    process.env.NATIVE_TASK_QUEUE_BINARY ??
    path.resolve('native/task-queue/target/debug/lumastra-task-queue');
const cache = process.env.TEST_CACHE_URL ?? process.env.CACHE_URL;
assert.ok(cache, 'runner-isolated TEST_CACHE_URL/CACHE_URL required');
const target = new URL(cache);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname));
assert.ok(Number(target.pathname.slice(1)) > 0, 'refuse default/shared Valkey database');
const childEnv = { PATH: process.env.PATH, LANG: process.env.LANG ?? 'C.UTF-8' };

async function until(read, predicate, timeout = 10_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await within(read(), Math.min(2_000, Math.max(1, deadline - Date.now())));
        if (predicate(value)) return value;
        await sleep(20);
    }
    throw new Error('bounded fixture condition timed out');
}

async function within(operation, ms) {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('bounded fixture RPC timed out')), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

function native(command, scope, input, hardDeadlineMs, connectionOverride) {
    const child = spawn(BINARY, [command, scope.prefix, scope.name], {
        env: {
            ...childEnv,
            LUMASTRA_TASK_QUEUE_TEST: '1',
            TEST_CACHE_URL: connectionOverride ?? cache,
            ...(hardDeadlineMs === undefined
                ? {}
                : { LUMASTRA_TASK_QUEUE_TEST_DEADLINE_MS: String(hardDeadlineMs) }),
        },
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    const records = [];
    let buffer = '';
    let stderr = '';
    let bytes = 0;
    const deadline = setTimeout(() => child.kill('SIGKILL'), 32_000);
    const result = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            bytes += Buffer.byteLength(chunk, 'utf8');
            if (bytes > 1_048_576) {
                child.kill('SIGKILL');
                return;
            }
            buffer += chunk;
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + 1);
                try {
                    records.push(JSON.parse(line));
                } catch {
                    child.kill('SIGKILL');
                    reject(new Error('malformed native frame'));
                }
            }
        });
        child.stderr.on('data', (chunk) => {
            stderr = (stderr + chunk).slice(-4096);
        });
        child.once('close', (code, signal) => {
            clearTimeout(deadline);
            resolve({ code, signal, stderr, records });
        });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(input));
    scope.children.push(child);
    return { child, records, result };
}

async function runNative(command, scope, input) {
    const result = await native(command, scope, input).result;
    assert.equal(result.code, 0, `${command} failed: ${result.stderr}`);
    return result.records;
}

async function scope(t, label) {
    const prefix = `lumastra-native-compat-${randomBytes(12).toString('hex')}`;
    const name = `compat-${label}`;
    const connection = new Redis(cache, {
        maxRetriesPerRequest: 1,
        commandTimeout: 2_000,
        connectTimeout: 2_000,
        retryStrategy: () => null,
    });
    const workerConnection = new Redis(cache, {
        maxRetriesPerRequest: null,
        connectTimeout: 2_000,
        retryStrategy: () => null,
    });
    connection.on('error', () => {});
    workerConnection.on('error', () => {});
    const queue = new Queue(name, { connection, prefix });
    const sentinel = `lumastra-native-sentinel-${randomBytes(12).toString('hex')}`;
    const value = {
        prefix,
        name,
        connection,
        workerConnection,
        queue,
        children: [],
        workers: [],
        closers: [],
    };
    t.after(async () => {
        try {
            await within(
                Promise.all(
                    value.children.map((child) => {
                        if (child.exitCode !== null || child.signalCode !== null)
                            return Promise.resolve();
                        return new Promise((resolve) => {
                            child.once('exit', resolve);
                            child.kill('SIGKILL');
                        });
                    }),
                ),
                2_000,
            );
            await within(Promise.all(value.workers.map((worker) => worker.close(true))), 3_000);
            await within(Promise.all(value.closers.map((close) => close())), 3_000);
            assert.ok(prefix.startsWith('lumastra-native-compat-'));
            await within(queue.obliterate({ force: true }), 3_000); // Only this test's random queue prefix.
            assert.equal(await connection.get(sentinel), 'unrelated-queue-data');
            await connection.del(sentinel);
        } finally {
            await within(queue.close(), 1_000).catch(() => {});
            await Promise.all(
                value.workers.map((worker) => within(worker.disconnect(), 500).catch(() => {})),
            );
            connection.disconnect();
            workerConnection.disconnect();
        }
    });
    await connection.set(sentinel, 'unrelated-queue-data');
    return value;
}

async function tsWorker(s, processor) {
    const worker = new Worker(s.name, processor, {
        connection: s.workerConnection,
        prefix: s.prefix,
        concurrency: 1,
        lockDuration: 1_000,
        lockRenewTime: 200,
        stalledInterval: 500,
    });
    worker.on('error', () => {});
    s.workers.push(worker);
    await worker.waitUntilReady();
    return worker;
}

async function finished(s, ids, state = 'completed') {
    const states = await until(
        async () => {
            const jobs = await Promise.all(ids.map((id) => s.queue.getJob(id)));
            return Promise.all(jobs.map((job) => job?.getState()));
        },
        (states) => states.every((value) => value === state),
    );
    // A job may finish between its hash read and getState(). Re-read its final
    // payload after observing the terminal state, rather than return stale data.
    return { states, jobs: await Promise.all(ids.map((id) => s.queue.getJob(id))) };
}

test('test driver has no operational default and validates target before connection', () => {
    const version = spawnSync(BINARY, ['--version'], {
        env: childEnv,
        encoding: 'utf8',
        timeout: 1_000,
    });
    assert.equal(version.status, 0);
    assert.match(version.stdout, /bullmq-official 1\.4\.0/);
    const normal = spawnSync(BINARY, [], {
        env: childEnv,
        input: '',
        encoding: 'utf8',
        timeout: 1_000,
    });
    assert.equal(normal.status, 78);
    const bad = spawnSync(BINARY, ['test-produce', 'bull', 'production'], {
        env: {
            ...childEnv,
            LUMASTRA_TASK_QUEUE_TEST: '1',
            TEST_CACHE_URL: 'redis://127.0.0.1:1/0',
        },
        input: '{"jobs":[]}',
        encoding: 'utf8',
        timeout: 1_000,
    });
    assert.equal(bad.status, 78);
    assert.match(bad.stderr, /nonzero database/);
});

test(
    'Rust producer -> TS worker: UTF-8 JSON, custom IDs, duplicate admission and queue events',
    { timeout: 20_000 },
    async (t) => {
        const s = await scope(t, 'rust-to-ts');
        const seen = [];
        const events = new QueueEvents(s.name, {
            connection: s.workerConnection,
            prefix: s.prefix,
        });
        s.closers.push(() => events.close());
        await events.waitUntilReady();
        const completed = [];
        events.on('completed', (event) => completed.push(event.jobId));
        await tsWorker(s, async (job) => {
            seen.push(job.id);
            await job.updateProgress({ source: 'typescript', percent: 75 });
            return { from: 'typescript', payload: job.data };
        });
        const data = {
            title: 'Δοκιμή 🍃',
            nested: [null, false, 1.25],
            payload: { x: 'line\nnext' },
        };
        const records = await runNative('test-produce', s, {
            jobs: [{ name: 'fixture', data, opts: { jobId: 'run_Δ🍃custom-id' } }],
        });
        assert.equal(records[0].id, 'run_Δ🍃custom-id');
        const { jobs } = await finished(s, ['run_Δ🍃custom-id']);
        assert.deepEqual(jobs[0].data, data);
        assert.deepEqual(jobs[0].returnvalue, { from: 'typescript', payload: data });
        assert.deepEqual(jobs[0].progress, { source: 'typescript', percent: 75 });
        await runNative('test-produce', s, {
            jobs: [{ name: 'fixture', data: { wrong: true }, opts: { jobId: 'run_Δ🍃custom-id' } }],
        });
        await sleep(150);
        assert.deepEqual(seen, ['run_Δ🍃custom-id']);
        await until(
            () => completed,
            (ids) => ids.includes('run_Δ🍃custom-id'),
        );
    },
);

test(
    'guarded deadline wins simultaneous Ok and lease-confirmation waits before admission/completion proposal',
    { timeout: 10_000 },
    async (t) => {
        const cases = [
            {
                label: 'preclaim',
                action: 'echo',
                options: { cancelAfterMs: 0 },
                started: false,
                finished: false,
                state: 'waiting',
            },
            {
                label: 'initial-confirm',
                action: 'echo',
                options: { cancelAfterMs: 100, initialRenewDelayMs: 200 },
                started: false,
                finished: false,
                state: 'active',
            },
            {
                label: 'final-confirm',
                action: 'echo',
                options: { cancelAfterMs: 150, finalRenewDelayMs: 250 },
                started: true,
                finished: true,
                state: 'active',
            },
            {
                label: 'simultaneous',
                action: 'hold',
                sleepMs: 80,
                options: { cancelAfterMs: 80, finalRenewDelayMs: 100 },
                started: true,
                state: 'active',
            },
            {
                label: 'hard-drain',
                action: 'hold',
                sleepMs: 1_000,
                options: { closeAfterMs: 150, finalRenewDelayMs: 250 },
                started: true,
                finished: true,
                state: 'active',
            },
        ];
        for (const item of cases) {
            const s = await scope(t, `guard-boundary-${item.label}`);
            await s.queue.add(
                'boundary',
                { action: item.action, sleepMs: item.sleepMs },
                { jobId: 'boundary' },
            );
            const records = await runNative('test-guarded-worker', s, {
                count: 1,
                lockMs: 1_000,
                renewMs: 100,
                ...item.options,
            });
            assert.equal(
                records.some((r) => r.event === 'processor-start'),
                item.started,
                item.label,
            );
            if (item.finished !== undefined)
                assert.equal(
                    records.some((r) => r.event === 'processor-finished'),
                    item.finished,
                    item.label,
                );
            if (item.label !== 'preclaim')
                assert.ok(
                    records.some((r) => r.event === 'processor-aborted'),
                    item.label,
                );
            assert.equal(
                await (await s.queue.getJob('boundary')).getState(),
                item.state,
                `${item.label}: expired control deadline must suppress queue completion`,
            );
            assert.equal((await s.queue.getJob('boundary')).returnvalue, null);
            const close = records.findIndex((r) => r.event === 'close-returned');
            assert.ok(close >= 0);
            assert.equal(
                records.slice(close + 1).some((r) => r.event === 'processor-finished'),
                false,
            );
        }
    },
);

test(
    'TS producer -> Rust worker: priority, delay, JSON result/progress and native QueueEvents',
    { timeout: 20_000 },
    async (t) => {
        const s = await scope(t, 'ts-to-rust');
        await s.queue.add('lower', { order: 3 }, { jobId: 'low', priority: 20 });
        await s.queue.add('higher', { order: 1 }, { jobId: 'high', priority: 1 });
        const beforeDelayed = Date.now();
        await s.queue.add('later', { order: 4 }, { jobId: 'later', delay: 600 });
        const nativeEvents = native('test-events', s, { count: 3, timeoutMs: 10_000 });
        const records = await runNative('test-worker', s, { count: 3 });
        const { jobs } = await finished(s, ['high', 'low', 'later']);
        assert.deepEqual(
            records.filter((r) => r.event === 'processor-start').map((r) => r.id),
            ['high', 'low', 'later'],
        );
        assert.ok(
            records.find((r) => r.event === 'processor-start' && r.id === 'later').at -
                beforeDelayed >=
                550,
        );
        for (const job of jobs) {
            assert.equal(job.returnvalue.worker, 'rust');
            assert.deepEqual(job.returnvalue.data, job.data);
            assert.deepEqual(job.progress, { source: 'rust', percent: 50 });
        }
        const observed = await nativeEvents.result;
        assert.equal(observed.code, 0, observed.stderr);
        assert.equal(observed.records.filter((r) => r.name === 'completed').length, 3);
        const counts = await s.queue.getJobCounts('completed', 'active', 'waiting', 'delayed');
        assert.equal(counts.completed, 3);
        assert.equal(counts.active + counts.waiting + counts.delayed, 0);
        await jobs[0].remove();
        assert.equal(await s.queue.getJob('high'), undefined);
    },
);

test(
    'both directions preserve fixed/exponential retries and unrecoverable failures',
    { timeout: 20_000 },
    async (t) => {
        for (const rustWorker of [false, true]) {
            const s = await scope(t, rustWorker ? 'retry-rust' : 'retry-ts');
            const jobs = [
                {
                    name: 'fixed',
                    data: { action: 'retry', failUntil: 1 },
                    opts: { jobId: 'fixed', attempts: 3, backoff: { type: 'fixed', delay: 100 } },
                },
                {
                    name: 'exponential',
                    data: { action: 'retry', failUntil: 2 },
                    opts: {
                        jobId: 'exponential',
                        attempts: 3,
                        backoff: { type: 'exponential', delay: 60 },
                    },
                },
                {
                    name: 'permanent',
                    data: { action: 'unrecoverable' },
                    opts: { jobId: 'permanent', attempts: 5 },
                },
            ];
            if (rustWorker) {
                for (const job of jobs) await s.queue.add(job.name, job.data, job.opts);
                await runNative('test-worker', s, { count: 3 });
            } else {
                await runNative('test-produce', s, { jobs });
                await tsWorker(s, async (job) => {
                    if (job.data.action === 'unrecoverable')
                        throw new UnrecoverableError('fixture-permanent');
                    if (job.attemptsMade < job.data.failUntil) throw new Error('fixture-transient');
                    return { worker: 'typescript' };
                });
            }
            const result = await finished(s, ['fixed', 'exponential']);
            assert.deepEqual(
                result.jobs.map((job) => job.attemptsMade),
                [2, 3],
            );
            const permanent = (await finished(s, ['permanent'], 'failed')).jobs[0];
            assert.equal(permanent.attemptsMade, 1);
            assert.equal(permanent.failedReason, 'fixture-permanent');
        }
    },
);

test(
    'moveToDelayed token path parks without consuming retry attempts in both languages',
    { timeout: 20_000 },
    async (t) => {
        for (const rustWorker of [false, true]) {
            const s = await scope(t, rustWorker ? 'defer-rust' : 'defer-ts');
            await s.queue.add('defer', { action: 'delay' }, { jobId: 'defer', attempts: 3 });
            if (rustWorker) await runNative('test-worker', s, { count: 1 });
            else
                await tsWorker(s, async (job, token) => {
                    if (!job.data.deferred) {
                        await job.updateData({ ...job.data, deferred: true });
                        await job.moveToDelayed(Date.now() + 200, token);
                        throw new DelayedError();
                    }
                    return { worker: 'typescript' };
                });
            const job = (await finished(s, ['defer'])).jobs[0];
            assert.equal(job.attemptsMade, 1);
            assert.equal(job.attemptsStarted, 2);
            assert.equal(job.data.deferred, true);
        }
    },
);

test(
    'both FlowProducers preserve waiting-children and fan-in across the language boundary',
    { timeout: 20_000 },
    async (t) => {
        for (const rustProducer of [false, true]) {
            const s = await scope(t, rustProducer ? 'flow-rust' : 'flow-ts');
            const root = {
                name: 'parent',
                data: { root: true },
                opts: { jobId: 'parent' },
                children: [
                    { name: 'child-a', data: { value: 1 }, opts: { jobId: 'a' } },
                    { name: 'child-b', data: { value: 2 }, opts: { jobId: 'b' } },
                ],
            };
            if (rustProducer) await runNative('test-produce', s, { flow: true, jobs: [root] });
            else {
                const producer = new FlowProducer({ connection: s.connection, prefix: s.prefix });
                s.closers.push(() => producer.close());
                await producer.add({
                    ...root,
                    queueName: s.name,
                    children: root.children.map((job) => ({ ...job, queueName: s.name })),
                });
            }
            assert.equal(await (await s.queue.getJob('parent')).getState(), 'waiting-children');
            assert.equal((await s.queue.getWaitingChildren()).length, 1);
            if (rustProducer)
                await tsWorker(s, async (job) => ({
                    worker: 'typescript',
                    children: await job.getChildrenValues(),
                }));
            else await runNative('test-worker', s, { count: 3 });
            const parent = (await finished(s, ['parent', 'a', 'b'])).jobs[0];
            assert.equal(Object.keys(await parent.getChildrenValues()).length, 2);
            assert.equal(Object.keys(parent.returnvalue.children).length, 2);
        }
    },
);

test(
    'dynamic waiting-children parking resumes without spending retries in both languages',
    { timeout: 15_000 },
    async (t) => {
        for (const rustWorker of [false, true]) {
            const s = await scope(t, rustWorker ? 'dynamic-rust' : 'dynamic-ts');
            if (rustWorker)
                await s.queue.add(
                    'dynamic-parent',
                    { action: 'waitchildren' },
                    { jobId: 'parent', attempts: 3 },
                );
            else
                await runNative('test-produce', s, {
                    jobs: [
                        {
                            name: 'dynamic-parent',
                            data: { action: 'waitchildren' },
                            opts: { jobId: 'parent', attempts: 3 },
                        },
                    ],
                });
            if (rustWorker) await runNative('test-worker', s, { count: 2 });
            else
                await tsWorker(s, async (job, token) => {
                    if (job.data.action === 'waitchildren' && !job.data.deferred) {
                        await job.updateData({ ...job.data, deferred: true });
                        await s.queue.add(
                            'dynamic-child',
                            { value: 42 },
                            {
                                jobId: `${job.id}-child`,
                                parent: { id: job.id, queue: job.queueQualifiedName },
                            },
                        );
                        if (await job.moveToWaitingChildren(token))
                            throw new WaitingChildrenError();
                    }
                    return { children: await job.getChildrenValues() };
                });
            const parent = (await finished(s, ['parent', 'parent-child'])).jobs[0];
            assert.equal(parent.attemptsMade, 1);
            assert.equal(parent.attemptsStarted, 2);
            assert.equal(Object.keys(await parent.getChildrenValues()).length, 1);
            assert.equal(Object.keys(parent.returnvalue.children).length, 1);
        }
    },
);

test(
    'native renews a long job lock; TS stalled recovery consumes work after native SIGKILL',
    { timeout: 20_000 },
    async (t) => {
        const s = await scope(t, 'lease');
        await s.queue.add('long', { action: 'sleep', sleepMs: 1_400 }, { jobId: 'long' });
        const long = native('test-worker', s, {
            count: 1,
            lockMs: 400,
            renewMs: 100,
            stallMs: 200,
        });
        await until(
            () => long.records,
            (rs) => rs.some((r) => r.event === 'processor-start'),
        );
        await sleep(800);
        assert.ok(
            (await s.connection.pttl(`${s.prefix}:${s.name}:long:lock`)) > 0,
            'lock must be renewed beyond its original expiry',
        );
        assert.equal((await long.result).code, 0);
        assert.equal((await finished(s, ['long'])).jobs[0].attemptsStarted, 1);
        await s.queue.add('crash', { action: 'hold', sleepMs: 10_000 }, { jobId: 'crash' });
        const crashed = native('test-worker', s, {
            count: 2,
            lockMs: 400,
            renewMs: 100,
            stallMs: 200,
        });
        await until(
            () => crashed.records,
            (rs) => rs.some((r) => r.event === 'processor-start' && r.id === 'crash'),
        );
        crashed.child.kill('SIGKILL');
        assert.equal((await crashed.result).signal, 'SIGKILL');
        let redelivered = 0;
        await tsWorker(s, async () => {
            redelivered++;
            return { recovered: true };
        });
        const recovered = (await finished(s, ['crash'])).jobs[0];
        assert.equal(redelivered, 1);
        assert.equal(recovered.attemptsStarted, 2);
        assert.deepEqual(recovered.returnvalue, { recovered: true });
    },
);

test(
    'qualification exposes lost-lock cancellation and close/drain safety gaps',
    { timeout: 20_000 },
    async (t) => {
        const s = await scope(t, 'lost-lock');
        await s.queue.add('lost', { action: 'sleep', sleepMs: 900 }, { jobId: 'lost' });
        const worker = native('test-worker', s, {
            count: 1,
            timeoutMs: 2_000,
            lockMs: 400,
            renewMs: 100,
            stallMs: 200,
        });
        await until(
            () => worker.records,
            (rs) => rs.some((r) => r.event === 'processor-start'),
        );
        // Replace only the fixture lock, so extendLock returns 0 for this owner.
        await s.connection.set(
            `${s.prefix}:${s.name}:lost:lock`,
            'different-fixture-owner',
            'PX',
            4_000,
        );
        const result = await worker.result;
        const settled = result.records.find((r) => r.event === 'processor-finished');
        assert.ok(settled, 'old handler actually ran after losing the lock');
        assert.equal(settled.cancelled, false, 'record the upstream missing abort signal');
        assert.equal(
            await (await s.queue.getJob('lost')).getState(),
            'active',
            'Lua rejects stale completion',
        );
        assert.notEqual(result.code, 0, 'stale completion cannot satisfy the fixture');
        const drain = await scope(t, 'drain');
        await drain.queue.add('slow', { action: 'sleep', sleepMs: 800 }, { jobId: 'slow' });
        const close = await runNative('test-worker', drain, {
            count: 1,
            closeAfterMs: 150,
            lockMs: 400,
            renewMs: 100,
            stallMs: 200,
        });
        const closeIndex = close.findIndex((r) => r.event === 'close-returned');
        const finishIndex = close.findIndex((r) => r.event === 'processor-finished');
        assert.ok(closeIndex >= 0 && close[closeIndex].activeBefore > 0);
        assert.ok(
            finishIndex > closeIndex,
            'upstream close returned while processor remained live',
        );
        if (process.env.REQUIRE_NATIVE_QUEUE_SAFETY === '1') {
            assert.equal(
                settled.cancelled,
                true,
                'native ownership gate: lost-lock handler must be aborted',
            );
            assert.ok(
                finishIndex < closeIndex,
                'native drain gate: close must confirm no live handlers',
            );
        }
    },
);

test(
    'Rust prioritized/delayed producer is consumed in order by the TS worker',
    { timeout: 10_000 },
    async (t) => {
        const s = await scope(t, 'priority-rust');
        const starts = [];
        const before = Date.now();
        await runNative('test-produce', s, {
            jobs: [
                { name: 'low', data: {}, opts: { jobId: 'low', priority: 20 } },
                { name: 'high', data: {}, opts: { jobId: 'high', priority: 1 } },
                { name: 'later', data: {}, opts: { jobId: 'later', delay: 600 } },
            ],
        });
        await tsWorker(s, async (job) => {
            starts.push({ id: job.id, at: Date.now() });
            return { ok: true };
        });
        await finished(s, ['high', 'low', 'later']);
        assert.deepEqual(
            starts.map((v) => v.id),
            ['high', 'low', 'later'],
        );
        assert.ok(starts[2].at - before >= 550);
    },
);

test(
    'both language flow workers propagate failed-child policies',
    { timeout: 20_000 },
    async (t) => {
        for (const rustProducer of [false, true]) {
            for (const policy of [
                'failParentOnFailure',
                'ignoreDependencyOnFailure',
                'removeDependencyOnFailure',
                'continueParentOnFailure',
            ]) {
                const s = await scope(
                    t,
                    `failed-${rustProducer ? 'rust' : 'ts'}-${policy.toLowerCase()}`,
                );
                const root = {
                    name: 'parent',
                    data: {},
                    opts: { jobId: 'parent' },
                    children: [
                        {
                            name: 'child',
                            data: { action: 'unrecoverable' },
                            opts: { jobId: 'child', [policy]: true },
                        },
                    ],
                };
                if (rustProducer) await runNative('test-produce', s, { flow: true, jobs: [root] });
                else {
                    const flow = new FlowProducer({ connection: s.connection, prefix: s.prefix });
                    s.closers.push(() => flow.close());
                    await flow.add({
                        ...root,
                        queueName: s.name,
                        children: root.children.map((v) => ({ ...v, queueName: s.name })),
                    });
                }
                if (rustProducer)
                    await tsWorker(s, async (job) => {
                        if (job.name === 'child') throw new UnrecoverableError('fixture-permanent');
                        return { ok: true };
                    });
                else await runNative('test-worker', s, { count: 2 });
                const expected = policy === 'failParentOnFailure' ? 'failed' : 'completed';
                const parent = (await finished(s, ['parent'], expected)).jobs[0];
                assert.equal(await (await s.queue.getJob('child')).getState(), 'failed');
                if (expected === 'failed') assert.match(parent.failedReason, /child/);
            }
        }
    },
);

test(
    'guarded manual wrapper aborts a lost-lock handler before any late completion',
    { timeout: 10_000 },
    async (t) => {
        const s = await scope(t, 'guard-lost');
        await s.queue.add('lost', { action: 'hold', sleepMs: 900 }, { jobId: 'lost' });
        const worker = native('test-guarded-worker', s, { count: 1, lockMs: 400, renewMs: 100 });
        await until(
            () => worker.records,
            (rs) => rs.some((r) => r.event === 'processor-start'),
        );
        await s.connection.set(
            `${s.prefix}:${s.name}:lost:lock`,
            'replacement-fixture-owner',
            'PX',
            500,
        );
        const result = await worker.result;
        assert.equal(result.code, 78);
        assert.ok(result.records.some((r) => r.event === 'ownership-lost' && r.cancelled === true));
        assert.equal(
            result.records.some((r) => r.event === 'processor-finished'),
            false,
        );
        assert.equal(await (await s.queue.getJob('lost')).getState(), 'active');
        await tsWorker(s, async () => ({ replacement: true }));
        await finished(s, ['lost']);
        await sleep(950);
        assert.deepEqual((await s.queue.getJob('lost')).returnvalue, { replacement: true });
        assert.equal(
            result.records.some((r) => r.event === 'processor-finished'),
            false,
        );
    },
);

test(
    'guarded manual drain waits for a short handler, or drops a noncooperative async hold before acknowledging',
    { timeout: 10_000 },
    async (t) => {
        for (const short of [true, false]) {
            const s = await scope(t, short ? 'guard-short-drain' : 'guard-long-drain');
            await s.queue.add(
                'slow',
                { action: 'hold', sleepMs: short ? 500 : 10_000 },
                { jobId: 'slow' },
            );
            const records = await runNative('test-guarded-worker', s, {
                count: 1,
                closeAfterMs: 150,
                lockMs: 400,
                renewMs: 100,
            });
            const close = records.findIndex((r) => r.event === 'close-returned');
            const finish = records.findIndex((r) => r.event === 'processor-finished');
            assert.ok(close > records.findIndex((r) => r.event === 'drain-started'));
            assert.equal(records[close].liveHandlers, 0);
            if (short) {
                assert.ok(finish >= 0 && finish < close);
                assert.equal(await (await s.queue.getJob('slow')).getState(), 'completed');
            } else {
                assert.equal(
                    finish,
                    -1,
                    'handler ignores CancellationToken, but its owned future is dropped',
                );
                assert.ok(
                    records.some(
                        (r) => r.event === 'processor-aborted' && r.reason === 'drain-timeout',
                    ),
                );
                assert.equal(
                    await (await s.queue.getJob('slow')).getState(),
                    'active',
                    'interrupted work is not acknowledged',
                );
                await tsWorker(s, async () => ({ recoveredAfterDrain: true }));
                await finished(s, ['slow']);
            }
            assert.equal(
                records.slice(close + 1).some((r) => r.event === 'processor-finished'),
                false,
            );
        }
    },
);

test(
    'guarded cancellation suppresses late Ok; CPU-blocked future requires actual process exit',
    { timeout: 10_000 },
    async (t) => {
        const s = await scope(t, 'guard-cancel');
        await s.queue.add('cancel', { action: 'hold', sleepMs: 900 }, { jobId: 'cancel' });
        const records = await runNative('test-guarded-worker', s, {
            count: 1,
            cancelAfterMs: 150,
            lockMs: 400,
            renewMs: 100,
        });
        assert.ok(records.some((r) => r.event === 'processor-aborted' && r.reason === 'cancel'));
        assert.equal(
            records.some((r) => r.event === 'processor-finished'),
            false,
        );
        assert.equal(await (await s.queue.getJob('cancel')).getState(), 'active');
        await tsWorker(s, async () => ({ replacementAfterCancel: true }));
        await finished(s, ['cancel']);
        await sleep(950);
        assert.deepEqual((await s.queue.getJob('cancel')).returnvalue, {
            replacementAfterCancel: true,
        });
        const blocked = await scope(t, 'guard-blocked');
        await blocked.queue.add('block', { action: 'block', sleepMs: 10_000 }, { jobId: 'block' });
        const child = native(
            'test-guarded-worker',
            blocked,
            { count: 1, closeAfterMs: 150, lockMs: 400, renewMs: 100 },
            1_200,
        );
        await until(
            () => child.records,
            (rs) => rs.some((r) => r.event === 'processor-start'),
        );
        const result = await child.result;
        assert.equal(
            result.code,
            124,
            'independent OS thread terminates the entire wedged fixture process',
        );
        assert.equal(
            result.records.some(
                (r) => r.event === 'processor-finished' || r.event === 'close-returned',
            ),
            false,
        );
        await tsWorker(blocked, async () => ({ replacementAfterProcessExit: true }));
        await finished(blocked, ['block']);
    },
);

test(
    'slow successful periodic renewal cannot starve a ready guarded handler',
    { timeout: 5_000 },
    async (t) => {
        const s = await scope(t, 'guard-slow-renew');
        await s.queue.add('slow-renew', { action: 'hold', sleepMs: 120 }, { jobId: 'slow-renew' });
        const records = await runNative('test-guarded-worker', s, {
            count: 1,
            timeoutMs: 800,
            lockMs: 1_000,
            renewMs: 100,
            periodicRenewDelayMs: 150,
        });
        assert.ok(records.some((r) => r.event === 'processor-finished'));
        assert.equal(await (await s.queue.getJob('slow-renew')).getState(), 'completed');
    },
);

test(
    'in-flight completion with delayed ACK is surfaced as uncertain and requires reconciliation',
    { timeout: 5_000 },
    async (t) => {
        const s = await scope(t, 'guard-ack');
        await s.queue.add('ack', { fixture: 'receipt' }, { jobId: 'ack' });
        const worker = native('test-guarded-worker', s, {
            count: 1,
            lockMs: 1_000,
            renewMs: 200,
            cancelAfterMs: 150,
            completionReplyDelayMs: 250,
        });
        const result = await worker.result;
        assert.equal(result.code, 78);
        assert.ok(result.records.some((r) => r.event === 'completion-uncertain'));
        // Real Lua committed before the deliberately delayed reply was cancelled.
        // Do not reinterpret a timeout as failed admission, undo, or safe redelivery.
        const job = await s.queue.getJob('ack');
        assert.equal(await job.getState(), 'completed');
        assert.equal(job.attemptsStarted, 1);
        assert.equal(result.records.filter((r) => r.event === 'processor-start').length, 1);
    },
);

test(
    'actual socket reset after terminal Lua commit is an uncertain receipt, not safe replay',
    { timeout: 5_000 },
    async (t) => {
        const s = await scope(t, 'guard-reset');
        await s.queue.add('reset', { fixture: 'lost-reply' }, { jobId: 'reset' });
        const lua = await publishedCommand('moveToFinished');
        const sha = createHash('sha1').update(lua).digest('hex');
        assert.equal(await s.connection.script('LOAD', lua), sha);
        const sockets = new Set();
        let intercepted = false;
        let reset = false;
        let faultError;
        const server = createServer((client) => {
            const upstream = connect({
                host: target.hostname.replace(/^\[|\]$/g, ''),
                port: Number(target.port || 6379),
            });
            for (const socket of [client, upstream]) {
                sockets.add(socket);
                socket.setTimeout(2_000, () => socket.destroy());
                socket.on('error', () => {});
                socket.once('close', () => sockets.delete(socket));
            }
            client.once('close', () => upstream.destroy());
            upstream.once('close', () => client.destroy());
            let tail = Buffer.alloc(0);
            client.on('data', (chunk) => {
                const bytes = Buffer.concat([tail, chunk]);
                tail = bytes.subarray(Math.max(0, bytes.length - 64));
                if (intercepted || !bytes.includes(Buffer.from(sha))) return;
                intercepted = true;
                // Forward the real request but withhold its reply. Reset only after
                // a separate real connection proves the terminal mutation committed.
                upstream.unpipe(client);
                void (async () => {
                    await finished(s, ['reset']);
                    reset = true;
                    server.close();
                    client.resetAndDestroy();
                    upstream.destroy();
                })().catch((error) => {
                    faultError = error;
                    client.destroy();
                    upstream.destroy();
                });
            });
            client.pipe(upstream);
            upstream.pipe(client);
        });
        server.maxConnections = 8;
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });
        t.after(async () => {
            for (const socket of sockets) socket.destroy();
            await within(new Promise((resolve) => server.close(resolve)), 1_000);
        });
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const proxy = new URL(cache);
        proxy.hostname = '127.0.0.1';
        proxy.port = String(address.port);
        const worker = native(
            'test-guarded-worker',
            s,
            { count: 1, lockMs: 2_000, renewMs: 500 },
            undefined,
            proxy.href,
        );
        const result = await worker.result;
        assert.equal(faultError, undefined);
        assert.ok(intercepted && reset, 'fault must happen after real commit');
        assert.equal(result.code, 78);
        assert.ok(
            result.records.some(
                (r) => r.event === 'completion-uncertain' && r.reason === 'ack-error',
            ),
            'transport error before the receipt timeout must remain indeterminate',
        );
        const job = await s.queue.getJob('reset');
        assert.equal(await job.getState(), 'completed');
        assert.equal(job.attemptsStarted, 1);
    },
);
