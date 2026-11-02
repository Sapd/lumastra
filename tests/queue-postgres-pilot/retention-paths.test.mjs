// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, deferred, waitFor, withTimeout } from './harness.mjs';

async function fixture(run) {
    const h = await createHarness({ label: 'retention-paths' });
    try {
        await run(h);
        h.assertHealthy();
    } finally {
        await h.close();
    }
}

async function configuredQueue(h, name, maxLen) {
    const queue = h.queue(name, { streams: { events: { maxLen } } });
    // waitUntilReady alone does not wait for Queue's asynchronous metadata write.
    assert.match(await queue.getVersion(), /6\.3\.15/);
    assert.equal((await queue.getMeta()).maxLenEvents, maxLen);
    return queue;
}

async function replayUntil(h, queue, event, matchesCheckpoint) {
    const replay = h.events(queue.name, { lastEventId: '0' });
    const records = [];
    replay.on(event, (data, id) => records.push({ data, id }));
    try {
        await replay.waitUntilReady();
        await waitFor(() => records.some(matchesCheckpoint), {
            message: `replay reaches retained ${event} checkpoint`,
        });
        return [...records];
    } finally {
        await withTimeout(replay.close(), 5000, 'close retention replay');
    }
}

test(
    'characterization: independent bulk backlog overshoots maxLen, ordinary completion resumes trimming',
    { timeout: 60000 },
    async () =>
        fixture(async (h) => {
            const bound = 4;
            const sample = 256;
            const queue = await configuredQueue(h, 'bulk-retention', bound);
            const jobs = await queue.addBulk(
                Array.from({ length: sample }, (_, i) => ({
                    name: 'retained-work',
                    data: { i },
                    opts: { jobId: `bulk-${i}` },
                })),
            );
            const last = jobs.at(-1);
            const backlog = await replayUntil(
                h,
                queue,
                'waiting',
                ({ data }) => data.jobId === last.id,
            );
            assert.equal(backlog.length, sample);
            assert.ok(backlog.length > bound, 'characterize bulk overshoot, not a retention pass');
            assert.equal(await queue.getWaitingCount(), sample);

            let calls = 0;
            h.worker(
                queue.name,
                async (active) => {
                    calls += 1;
                    return { processed: active.data.i };
                },
                { concurrency: 1 },
            );
            await waitFor(async () => (await queue.getCompletedCount()) === sample, {
                timeoutMs: 30000,
                message: 'all accepted bulk jobs finish normally',
            });
            assert.equal(calls, sample);
            assert.equal(await queue.getWaitingCount(), 0);
            assert.equal(await queue.getActiveCount(), 0);
            for (const job of jobs) {
                const stored = await queue.getJob(job.id);
                assert.equal(await stored.getState(), 'completed');
                assert.deepEqual(stored.returnvalue, { processed: job.data.i });
            }

            const completed = await replayUntil(
                h,
                queue,
                'completed',
                ({ data }) => data.jobId === last.id,
            );
            assert.ok(completed.length > 0);
            assert.ok(
                completed.length <= bound + 256,
                'ordinary completion exhibits approximate trimming on this single-queue sample',
            );
            // Replaying through the latest completion also observes any older retained waiting
            // records. No marker job/event, private query or manual trim triggers recovery.
            const replay = h.events(queue.name, { lastEventId: '0' });
            const waiting = [];
            let reachedLastCompletion = false;
            replay.on('waiting', (data) => waiting.push(data.jobId));
            replay.on('completed', (data) => {
                if (data.jobId === last.id) reachedLastCompletion = true;
            });
            try {
                await replay.waitUntilReady();
                await waitFor(() => reachedLastCompletion);
                assert.equal(waiting.length, 0);
            } finally {
                await withTimeout(replay.close(), 5000, 'close completed backlog replay');
            }
            // This recovery sample does not qualify bulk-only idle retention or other queues.
        }),
);

test(
    'characterization: alternating active-job progress can starve one queue of modulo-triggered trimming',
    { timeout: 120000 },
    async () =>
        fixture(async (h) => {
            const bound = 4;
            const sample = 768;
            const queues = [
                await configuredQueue(h, 'progress-a', bound),
                await configuredQueue(h, 'progress-b', bound),
            ];
            const started = [deferred(), deferred()];
            const release = [deferred(), deferred()];
            const progress = [[], []];
            const jobs = [];
            try {
                for (const [i, queue] of queues.entries()) {
                    jobs.push(await queue.add('long-running-work', { queue: i }));
                    h.worker(
                        queue.name,
                        async (active) => {
                            started[i].resolve(active);
                            await withTimeout(release[i].promise, 90000, 'progress processor gate');
                            return { processed: i };
                        },
                        {
                            concurrency: 1,
                            lockDuration: 120000,
                            skipLockRenewal: true,
                            stalledInterval: 120000,
                        },
                    );
                    const events = h.events(queue.name, { lastEventId: '0' });
                    events.on('progress', (data, id) => progress[i].push({ data, id }));
                    await events.waitUntilReady();
                }
                const active = [];
                for (const start of started) {
                    active.push(await withTimeout(start.promise, 15000, 'progress job starts'));
                }
                const orderedIds = [];
                for (let completed = 1; completed <= sample; completed += 1) {
                    for (let i = 0; i < active.length; i += 1) {
                        await active[i].updateProgress({ completed, total: sample });
                        // Observe each actual event before publishing the next. This prevents a
                        // slow live reader from being mistaken for backend retention behavior.
                        await waitFor(() => progress[i].length === completed, {
                            intervalMs: 1,
                            message: 'live reader receives the submitted progress event',
                        });
                        orderedIds.push(BigInt(progress[i].at(-1).id));
                    }
                }
                for (let i = 1; i < orderedIds.length; i += 1) {
                    assert.equal(orderedIds[i], orderedIds[i - 1] + 1n);
                }
                // Derive the affected queue from observed IDs; do not assume which queue owns
                // odd IDs or assume the sequence starts at a particular value.
                const missedTrim = progress.map((records) =>
                    records.every(({ id }) => BigInt(id) % 256n !== 0n),
                );
                assert.equal(missedTrim.filter(Boolean).length, 1);
                const affected = missedTrim.indexOf(true);
                for (let i = 0; i < queues.length; i += 1) {
                    const lastId = progress[i].at(-1).id;
                    const replay = await replayUntil(
                        h,
                        queues[i],
                        'progress',
                        ({ id }) => id === lastId,
                    );
                    if (i === affected) {
                        assert.equal(replay.length, sample);
                        assert.ok(
                            replay.length > bound + 256,
                            'characterize modulo starvation beyond the stated approximate window',
                        );
                    } else {
                        assert.ok(progress[i].some(({ id }) => BigInt(id) % 256n === 0n));
                        assert.ok(replay.length <= bound + 256);
                    }
                    const stored = await queues[i].getJob(jobs[i].id);
                    assert.equal(await stored.getState(), 'active');
                    assert.deepEqual(stored.progress, { completed: sample, total: sample });
                }
            } finally {
                // Always unblock both processors before harness close, including failed probes.
                for (const gate of release) gate.resolve();
            }
            for (let i = 0; i < queues.length; i += 1) {
                await waitFor(async () => (await queues[i].getCompletedCount()) === 1);
                const stored = await queues[i].getJob(jobs[i].id);
                assert.deepEqual(stored.returnvalue, { processed: i });
                assert.equal(stored.attemptsStarted, 1);
            }
            // A green characterization reproduces this ordering's gap, not a retention gate pass.
        }),
);
