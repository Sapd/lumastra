// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import test from 'node:test';
import { createHarness, deferred, waitFor, withTimeout } from './harness.mjs';

function startWorkerProcess(owned, queueName) {
    const claimed = deferred();
    const closed = deferred();
    // Install handlers before sending configuration; no credentials in argv/IPC.
    const child = fork(new URL('./fixtures/worker-process.mjs', import.meta.url), [], {
        execArgv: [],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    child.on('error', (error) => claimed.reject(error));
    child.on('message', (message) => {
        if (message?.type === 'claimed') claimed.resolve(message);
        else claimed.reject(new Error('Worker process fixture reported a failure'));
    });
    child.once('close', (code, signal) => {
        claimed.reject(new Error(`Worker exited before claim: ${code ?? signal}`));
        closed.resolve({ code, signal });
    });
    child.send({ owned, queueName }, (error) => {
        if (error) claimed.reject(error);
    });
    return {
        child,
        claimed: claimed.promise,
        closed: closed.promise,
        async reap() {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            await withTimeout(closed.promise, 5000, 'owned child process reaping');
        },
    };
}

function staleRefusal(error) {
    // A timeout is an infrastructure failure, never evidence of fencing.
    assert.doesNotMatch(error.message, /timed out/i);
    assert.match(error.message, /lock|token/i);
    return true;
}

async function inState(queue, id, expected) {
    return waitFor(
        async () => {
            const job = await queue.getJob(id);
            return job && (await job.getState()) === expected && job;
        },
        { message: `process-crash job becomes ${expected}` },
    );
}

test(
    'process crash: SIGKILL recovers accepted jobs and fences the dead worker token',
    { timeout: 90000 },
    async () => {
        const h = await createHarness({ label: 'process-crash' });
        let processWorker;
        const release = deferred();
        try {
            const queue = h.queue('process-crash');
            await withTimeout(queue.waitUntilReady(), 10000, 'producer readiness');
            const payload = { fixture: 'actual-process-death', sequence: 0 };
            const original = await withTimeout(
                queue.add('crashed', payload, {
                    jobId: 'process-crash-original',
                    attempts: 3,
                }),
            );
            const identity = (
                await h.query(
                    `
                SELECT n.nspname AS schema, n.oid::text AS oid,
                       pg_get_userbyid(n.nspowner) AS owner,
                       obj_description(n.oid, 'pg_namespace') AS marker
                FROM pg_namespace n WHERE n.nspname = $1`,
                    [h.schema],
                )
            ).rows[0];
            processWorker = startWorkerProcess({ ...identity, nonce: h.nonce }, queue.name);
            const claim = await withTimeout(processWorker.claimed, 20000, 'child acquired job');
            assert.equal(claim.pid, processWorker.child.pid);
            assert.notEqual(claim.pid, process.pid);
            assert.equal(claim.id, original.id);
            assert.equal(typeof claim.token, 'string');
            assert.ok(claim.token.length > 0);
            assert.equal(claim.attemptsStarted, 1);
            const active = await inState(queue, original.id, 'active');
            assert.equal(active.attemptsStarted, 1);
            // These acknowledged jobs must survive alongside the killed active job.
            const siblings = await withTimeout(
                queue.addBulk(
                    [1, 2].map((sequence) => ({
                        name: 'waiting-at-crash',
                        data: { ...payload, sequence },
                        opts: { jobId: `process-crash-sibling-${sequence}`, attempts: 3 },
                    })),
                ),
            );
            const accepted = [original, ...siblings];
            assert.equal(processWorker.child.kill('SIGKILL'), true);
            assert.deepEqual(await withTimeout(processWorker.closed, 5000, 'SIGKILL child exit'), {
                code: null,
                signal: 'SIGKILL',
            });

            const recovered = deferred();
            const calls = new Map();
            const stalled = [];
            const successor = h.worker(
                queue.name,
                async (job, token) => {
                    calls.set(job.id, (calls.get(job.id) ?? 0) + 1);
                    if (job.id === original.id) {
                        recovered.resolve({ id: job.id, token });
                        await withTimeout(release.promise, 20000, 'successor processor gate');
                    }
                    return { sequence: job.data.sequence, recovered: job.id === original.id };
                },
                { stalledInterval: 100, lockDuration: 1000 },
            );
            successor.on('stalled', (id) => stalled.push(id));
            const replacement = await withTimeout(recovered.promise, 20000, 'OS-death recovery');
            assert.equal(replacement.id, original.id);
            assert.notEqual(replacement.token, claim.token);
            assert.ok(stalled.includes(original.id));
            assert.equal((await inState(queue, original.id, 'active')).attemptsStarted, 2);

            // Reload through the open producer: a Job from a dead/closed worker
            // cannot establish token refusal because its connection is gone.
            const stale = await withTimeout(queue.getJob(original.id));
            assert.equal(
                await withTimeout(
                    stale.extendLock(claim.token, 1000),
                    5000,
                    'dead token renewal refusal',
                ),
                0,
            );
            await assert.rejects(
                withTimeout(
                    stale.moveToCompleted('obsolete-result', claim.token, false),
                    5000,
                    'dead token completion refusal',
                ),
                staleRefusal,
            );
            const staleFailure = await withTimeout(queue.getJob(original.id));
            await assert.rejects(
                withTimeout(
                    staleFailure.moveToFailed(new Error('obsolete-failure'), claim.token, false),
                    5000,
                    'dead token failure refusal',
                ),
                staleRefusal,
            );
            const fenced = await inState(queue, original.id, 'active');
            assert.equal(fenced.attemptsStarted, 2);
            assert.equal(fenced.attemptsMade, 0);
            assert.notEqual(fenced.returnvalue, 'obsolete-result');
            release.resolve();

            for (const job of accepted) {
                const persisted = await inState(queue, job.id, 'completed');
                assert.deepEqual(persisted.data, job.data);
                assert.deepEqual(persisted.returnvalue, {
                    sequence: job.data.sequence,
                    recovered: job.id === original.id,
                });
                assert.equal(persisted.attemptsStarted, job.id === original.id ? 2 : 1);
                assert.equal(persisted.attemptsMade, 1);
                assert.equal(calls.get(job.id), 1);
            }
            const all = await withTimeout(
                queue.getJobs(
                    [
                        'wait',
                        'active',
                        'delayed',
                        'completed',
                        'failed',
                        'waiting-children',
                        'prioritized',
                    ],
                    0,
                    -1,
                ),
            );
            assert.deepEqual(all.map((job) => job.id).sort(), accepted.map((job) => job.id).sort());
            h.assertHealthy();
        } finally {
            release.resolve();
            // Never drop the parent schema while its child could still be using it.
            // If reaping fails, preserve the schema and fail instead of dropping
            // state out from under a possibly live process.
            if (processWorker) await processWorker.reap();
            await h.close();
        }
    },
);
