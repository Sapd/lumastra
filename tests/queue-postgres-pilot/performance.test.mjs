// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { platform, arch, release } from 'node:os';
import { resolve } from 'node:path';
import { createHarness, sleep, waitFor } from './harness.mjs';

function percentile(values, fraction) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? 0;
}

test(
    'bounded lab load records accepted work, latency, connections and durability settings',
    {
        timeout: 180_000,
    },
    async () => {
        const h = await createHarness({ label: 'load' });
        try {
            const queue = h.queue('load');
            const seen = new Set();
            const launches = [];
            const worker = h.worker(
                'load',
                async (job) => {
                    assert.equal(seen.has(job.id), false, 'a synthetic job executed twice');
                    seen.add(job.id);
                    launches.push(performance.now() - job.data.sentAt);
                    return { acceptedId: job.id };
                },
                { concurrency: 8 },
            );
            await worker.waitUntilReady();
            const settings = (
                await h.query(`SELECT version() AS version,
            current_setting('fsync') AS fsync,
            current_setting('synchronous_commit') AS synchronous_commit,
            current_setting('full_page_writes') AS full_page_writes`)
            ).rows[0];
            const profiles = [];
            const rssBefore = process.memoryUsage().rss;
            let maximumSampledConnections = 0;
            const digestFiles = [
                'package.json',
                'package-lock.json',
                'harness.mjs',
                'safety.test.mjs',
                'core.test.mjs',
                'process-crash.test.mjs',
                'retention-paths.test.mjs',
                'fixtures/worker-process.mjs',
                'isolation.test.mjs',
                'compatibility.test.mjs',
                'performance.test.mjs',
                'fixtures/entry.ts',
                'fixtures/sdk-plugin.ts',
            ];
            const sourceHash = createHash('sha256');
            for (const file of digestFiles) {
                sourceHash.update(file).update('\0');
                sourceHash.update(await readFile(new URL(file, import.meta.url)));
            }
            const lockSha256 = createHash('sha256')
                .update(await readFile(new URL('package-lock.json', import.meta.url)))
                .digest('hex');
            for (const profile of [
                { name: 'sustained-smoke', targetPerSecond: 100, seconds: 5, batch: 10 },
                { name: 'burst', targetPerSecond: 500, seconds: 10, batch: 20 },
            ]) {
                const total = profile.targetPerSecond * profile.seconds;
                const start = performance.now();
                const launchStart = launches.length;
                const acknowledgements = [];
                const jobs = [];
                for (let offset = 0; offset < total; offset += profile.batch) {
                    const due = start + (offset / profile.targetPerSecond) * 1000;
                    await sleep(Math.max(0, due - performance.now()));
                    const sentAt = performance.now();
                    const batch = await queue.addBulk(
                        Array.from(
                            { length: Math.min(profile.batch, total - offset) },
                            (_, index) => ({
                                name: 'synthetic',
                                data: { sentAt },
                                opts: {
                                    jobId: `${profile.name}-${offset + index}`,
                                    removeOnComplete: false,
                                },
                            }),
                        ),
                    );
                    acknowledgements.push(performance.now() - sentAt);
                    assert.equal(batch.length, Math.min(profile.batch, total - offset));
                    jobs.push(...batch);
                }
                const publishedAt = performance.now();
                await waitFor(
                    async () => {
                        const count = await queue.getJobCounts('completed', 'failed');
                        assert.equal(count.failed, 0);
                        return (
                            count.completed === seen.size &&
                            seen.size === launches.length &&
                            jobs.every((job) => seen.has(job.id))
                        );
                    },
                    { timeoutMs: 90_000, message: 'load cohort durable completion' },
                );
                // Confirm each returned identity is durable and the result belongs to
                // that job, rather than treating a worker callback as completion ACK.
                for (let offset = 0; offset < jobs.length; offset += 50) {
                    const cohort = await Promise.all(
                        jobs.slice(offset, offset + 50).map((job) => queue.getJob(job.id)),
                    );
                    for (const job of cohort) {
                        assert.ok(job);
                        assert.equal(await job.getState(), 'completed');
                        assert.equal(job.returnvalue.acceptedId, job.id);
                    }
                }
                const finishedAt = performance.now();
                const samples = (
                    await h.query(
                        `SELECT application_name, count(*)::int AS count FROM pg_stat_activity
                       WHERE datname = current_database()
                         AND application_name IN ($1, $2)
                       GROUP BY application_name`,
                        [h.applicationName, h.name('load')],
                    )
                ).rows;
                const connections = {
                    queryPools:
                        samples.find((row) => row.application_name === h.applicationName)?.count ??
                        0,
                    dedicatedListeners:
                        samples.find((row) => row.application_name === h.name('load'))?.count ?? 0,
                };
                connections.total = connections.queryPools + connections.dedicatedListeners;
                assert.ok(
                    connections.dedicatedListeners >= 1,
                    'worker LISTEN connection was not counted',
                );
                maximumSampledConnections = Math.max(maximumSampledConnections, connections.total);
                const launchSample = launches.slice(launchStart);
                profiles.push({
                    ...profile,
                    accepted: jobs.length,
                    actualSubmissionJobsPerSecond: total / ((publishedAt - start) / 1000),
                    completionAndVerificationMs: finishedAt - start,
                    postPublicationDrainAndVerificationMs: finishedAt - publishedAt,
                    batchAckMs: {
                        p50: percentile(acknowledgements, 0.5),
                        p95: percentile(acknowledgements, 0.95),
                        p99: percentile(acknowledgements, 0.99),
                    },
                    submissionStartToHandlerMs: {
                        p50: percentile(launchSample, 0.5),
                        p95: percentile(launchSample, 0.95),
                        p99: percentile(launchSample, 0.99),
                    },
                    observedConnections: connections,
                });
            }
            assert.equal(seen.size, 5500);
            h.assertHealthy();
            const observation = {
                observedAt: new Date().toISOString(),
                bullmq: '6.3.15',
                pg: '8.23.1',
                node: process.version,
                profiles,
                settings,
                maximumSampledConnections,
                provenance: {
                    baselineCommit: process.env.PILOT_BASELINE_COMMIT ?? null,
                    fixtureSourceSha256: sourceHash.digest('hex'),
                    digestFiles,
                    lockSha256,
                    platform: platform(),
                    architecture: arch(),
                    kernel: release(),
                    configuration: {
                        workerConcurrency: 8,
                        queryPoolMaxPerResource: 2,
                        drainDelaySeconds: 0.1,
                    },
                    matchingLog: process.env.PILOT_MATCHING_LOG ?? null,
                },
                pilotProcessRssBefore: rssBefore,
                pilotProcessRssAfter: process.memoryUsage().rss,
                limitations: [
                    'Synthetic no-op handlers and bulk submission, not real task throughput or a controller benchmark',
                    'The sustained profile is a five-second smoke; it is not a sustained-capacity or retention soak',
                    'Timings include payload preparation, batching, scheduling and pool effects; no paired Redis baseline',
                    'Connection observations are point samples, not a measured global peak',
                    'Node process RSS is not whole-deployment RAM; PostgreSQL and other processes are excluded',
                    'Runner durability settings may differ from production; fsync-off is not production durability evidence',
                ],
            };
            if (process.env.BULLMQ_PG_PILOT_REPORT) {
                // A caller-selected artifact path writes local test evidence only;
                // it is never a database/source/deployment setting.
                const target = resolve(process.env.BULLMQ_PG_PILOT_REPORT);
                await mkdir(resolve(target, '..'), { recursive: true });
                await writeFile(target, `${JSON.stringify(observation, null, 2)}\n`, {
                    mode: 0o600,
                });
            }
            console.log(`PILOT_LOAD_OBSERVATION ${JSON.stringify(observation)}`);
        } finally {
            await h.close();
        }
    },
);
