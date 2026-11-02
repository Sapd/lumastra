// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import postgres from 'postgres';
import { build } from 'esbuild';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { PER_TASK_QUEUE_PREFIX, perTaskQueueName } from '../lib/server/tasks/queue-naming.js';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import type { UpgradeReceipt } from './upgrade-control.js';

import { isolateQualificationTaskStore } from './__fixtures__/qualification-task-store.js';
let disposeTaskStore: (() => Promise<void>) | undefined;
beforeAll(async () => {
    disposeTaskStore = await isolateQualificationTaskStore();
});
afterAll(async () => {
    await disposeTaskStore?.();
});

async function availablePort(): Promise<number> {
    const server = createServer();
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP address');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return address.port;
}

async function eventually(
    check: () => Promise<boolean>,
    child: ChildProcess,
    logs: () => string,
): Promise<void> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null)
            throw new Error(`Task runtime exited ${child.exitCode}: ${logs()}`);
        if (await check()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    throw new Error(`Task runtime smoke timed out: ${logs()}`);
}

async function runUpgradeCommand(args: string[]): Promise<UpgradeReceipt> {
    const command = spawn(process.execPath, ['build/task-runtime.js', ...args], {
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    for (const stream of [command.stdout, command.stderr])
        stream?.on('data', (chunk: Buffer) => {
            output = (output + chunk.toString()).slice(-32768);
        });
    const timer = setTimeout(() => command.kill('SIGKILL'), 60_000);
    try {
        const [code] = await once(command, 'close');
        if (code !== 0) throw new Error(`Upgrade CLI failed ${code}: ${output}`);
        const line = output
            .trim()
            .split('\n')
            .reverse()
            .find((value) => value.startsWith('{') && value.includes('"instance"'));
        if (!line) throw new Error(`Missing upgrade receipt: ${output}`);
        return JSON.parse(line) as UpgradeReceipt;
    } finally {
        clearTimeout(timer);
    }
}

describe('actual standalone task process', () => {
    it.each(['TERM', 'guarded-upgrade'] as const)(
        'loads an unmodified SDK plugin, executes real context and stops through %s',
        async (stopMode) => {
            // This suite deliberately fails if its required binary is absent.
            await access(path.resolve('build/task-runtime.js'));
            const databaseUrl = process.env.TEST_DATABASE_URL;
            const cacheUrl = process.env.TEST_CACHE_URL ?? process.env.CACHE_URL;
            const taskCacheUrl = process.env.TEST_TASK_CACHE_URL ?? process.env.TASK_CACHE_URL;
            if (
                !databaseUrl ||
                !cacheUrl ||
                !taskCacheUrl ||
                Number(new URL(cacheUrl).pathname.slice(1)) < 1 ||
                Number(new URL(taskCacheUrl).pathname.slice(1)) < 1
            )
                throw new Error('Use the sanctioned integration runner DB and Valkey');
            const name = new URL(databaseUrl).pathname.slice(1);
            if (!name.startsWith('lumastra_t_') && name !== 'lumastra_tests')
                throw new Error('Refusing non-test database');
            const directory = await mkdtemp(path.join(tmpdir(), 'lumastra-runtime-smoke-'));
            const taskId = `native-runtime-${randomUUID()}`;
            const instanceId = `runtime-smoke-${randomUUID()}`;
            const pluginDir = path.join(directory, 'plugins', taskId);
            await mkdir(pluginDir, { recursive: true });
            await writeFile(
                path.join(pluginDir, 'package.json'),
                JSON.stringify({ type: 'module' }),
            );
            // Build an ordinary SDK task package; the task host receives its normal
            // default export, not a test dispatch/context hook.
            await build({
                stdin: {
                    resolveDir: process.cwd(),
                    sourcefile: 'native-runtime-fixture.ts',
                    loader: 'ts',
                    contents: `import { defineTask } from '@sapd/lumastra-plugin-sdk';
                    import { z } from 'zod';
                    export default defineTask({
                        id:'${taskId}', name:'Runtime fixture', version:'1.0.0', processingVersion:1,
                        minAppVersion:'0.1.0', resourceClass:'io', capabilities:{database:true,cache:true},
                        inputSchema:z.object({}), identityFor:()=> 'global', schedule:{every:'1h',runOnStartup:true},
                        async execute(ctx) {
                            await ctx.sql\`SELECT 1\`;
                            if (!ctx.cache || !ctx.catalog || !ctx.mediaItems || !ctx.mediaFiles || !ctx.userCredentials || !ctx.signal) throw new Error('Missing SDK context surface');
                            await ctx.cache.set('runtime-fixture', {ok:true}, 60000);
                            const value=await ctx.cache.get('runtime-fixture');
                            if (!value || !value.ok) throw new Error('Scoped cache unavailable');
                            ctx.reportProgress(1,1);
                            ctx.logger.info('RUNTIME_FIXTURE_EXECUTED');
                            return {success:true,itemsProcessed:1};
                        }
                    });`,
                },
                outfile: path.join(pluginDir, 'index.js'),
                bundle: true,
                platform: 'node',
                format: 'esm',
                target: 'node24',
                logLevel: 'silent',
            });
            const port = await availablePort();
            const sql = postgres(databaseUrl, { max: 1 });
            let output = '';
            let upgradeSocket = '';
            const evidenceLines: string[] = [];
            const child = spawn(process.execPath, ['build/task-runtime.js', '--startup-evidence'], {
                env: {
                    ...process.env,
                    NODE_ENV: 'production',
                    VITEST: undefined,
                    WORKER_MODE: 'enabled',
                    DEDICATED_WORKER: 'true',
                    DATABASE_URL: databaseUrl,
                    INSTANCE_ID: instanceId,
                    CACHE_URL: cacheUrl,
                    TASK_CACHE_URL: taskCacheUrl,
                    CONFIG_PATH: path.join(directory, 'config/settings.json'),
                    BASE_PATH: directory,
                    PLUGINS_EXTERNAL_DIR: path.join(directory, 'plugins'),
                    PLUGINS_REQUIRE_REGISTRY: 'false',
                    HOST: '127.0.0.1',
                    PORT: String(port),
                    APP_VERSION: '0.1.0',
                    LICENSE_SERVER_CONTACT_ENABLED: 'false',
                    FEATURE_JELLYFIN_SYNC: 'false',
                    LUMASTRA_METRICS_PUBLIC: 'false',
                    LUMASTRA_METRICS_BEARER_TOKEN: 'runtime-smoke-token',
                },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            for (const stream of [child.stdout, child.stderr]) {
                let pendingLine = '';
                stream?.on('data', (chunk: Buffer) => {
                    output = (output + chunk.toString()).slice(-32_768);
                    const lines = (pendingLine + chunk.toString()).split('\n');
                    pendingLine = (lines.pop() ?? '').slice(-8192);
                    for (const line of lines) {
                        if (line.includes('Dedicated task upgrade control ready')) {
                            const start = line.indexOf('{"socketPath"');
                            if (start >= 0)
                                upgradeSocket = (
                                    JSON.parse(line.slice(start)) as { socketPath: string }
                                ).socketPath;
                        }
                        if (line.startsWith('TASK_RUNTIME_EVIDENCE ') && evidenceLines.length < 2)
                            evidenceLines.push(line);
                    }
                });
            }
            const base = `http://127.0.0.1:${port}`;
            try {
                await eventually(
                    async () =>
                        fetch(`${base}/api/health/ready`)
                            .then((response) => response.status === 200)
                            .catch(() => false),
                    child,
                    () => output,
                );
                expect(await (await fetch(`${base}/api/health`)).json()).toEqual({
                    status: 'pass',
                });
                expect((await fetch(`${base}/metrics`)).status).toBe(401);
                const metrics = await fetch(`${base}/metrics`, {
                    headers: { authorization: 'Bearer runtime-smoke-token' },
                });
                expect(metrics.status).toBe(200);
                expect(await metrics.text()).toContain('lumastra_task_runs_total');
                await eventually(
                    async () => {
                        const rows = await sql<
                            { state: string }[]
                        >`SELECT state FROM task_history WHERE task_id = ${taskId} ORDER BY started_at DESC LIMIT 1`;
                        if (rows[0]?.state === 'failed')
                            throw new Error(`Fixture failed: ${output}`);
                        return rows[0]?.state === 'completed';
                    },
                    child,
                    () => output,
                );
                expect(output).toContain('RUNTIME_FIXTURE_EXECUTED');
                const evidence = evidenceLines.map(
                    (line) =>
                        JSON.parse(line.slice('TASK_RUNTIME_EVIDENCE '.length)) as {
                            phase: string;
                            elapsedMs: number;
                            memoryBytes: { rss: number };
                            maxRssBytes: number;
                            activeResources: Record<string, number>;
                        },
                );
                expect(evidence.map((sample) => sample.phase)).toEqual(['imports', 'ready']);
                for (const sample of evidence) {
                    expect(sample.elapsedMs).toBeGreaterThan(0);
                    expect(sample.memoryBytes.rss).toBeGreaterThan(0);
                    expect(sample.maxRssBytes).toBeGreaterThan(0);
                    expect(sample.activeResources).toBeTypeOf('object');
                }
                const exited = once(child, 'exit');
                if (stopMode === 'guarded-upgrade') {
                    expect(upgradeSocket).toBeTruthy();
                    const prepared = await runUpgradeCommand([
                        '--prepare-upgrade',
                        upgradeSocket,
                    ]).catch((error: unknown) => {
                        throw new Error(`${String(error)}\nHOST LOG:\n${output}`);
                    });
                    expect(prepared).toMatchObject({ pid: child.pid, state: 'prepared' });
                    expect((await fetch(`${base}/api/health/ready`)).status).toBe(503);
                    expect((await fetch(`${base}/api/health`)).status).toBe(200);
                    const completedBefore = Number(
                        (
                            await sql<
                                { count: string }[]
                            >`SELECT count(*)::text AS count FROM task_history WHERE task_id = ${taskId} AND state = 'completed'`
                        )[0]?.count,
                    );
                    // Make an actual scheduler occurrence due during suspension.
                    // Boot catch-up holds the SAME bucket claim as regular ticks
                    // for up to 30 seconds. Hold beyond that lease plus a full real
                    // 10-second tick (and 2 seconds margin), so a missing suspension
                    // cannot hide behind startup deduplication. Count every history
                    // state, including a pending job that this paused consumer
                    // cannot execute yet.
                    const historyBefore = (
                        await sql<
                            { count: string }[]
                        >`SELECT count(*)::text AS count FROM task_history WHERE task_id = ${taskId}`
                    )[0]?.count;
                    const dueSchedule = await sql<{ schedule: Record<string, unknown> }[]>`
                        UPDATE scheduler_state SET next_fire_at = NOW() - INTERVAL '1 hour', last_fired_at = NOW() - INTERVAL '2 hours'
                        WHERE task_id = ${taskId} RETURNING to_jsonb(scheduler_state) AS schedule
                    `;
                    expect(dueSchedule).toHaveLength(1);
                    const holdUntil = performance.now() + 42_000;
                    do {
                        expect(child.exitCode, output).toBeNull();
                        expect(child.signalCode, output).toBeNull();
                        const held = await sql<
                            { count: string; schedule: Record<string, unknown> }[]
                        >`
                            SELECT (SELECT count(*)::text FROM task_history WHERE task_id = ${taskId}) AS count,
                                to_jsonb(scheduler_state) AS schedule
                            FROM scheduler_state WHERE task_id = ${taskId}
                        `;
                        expect(held).toHaveLength(1);
                        expect(held[0]?.count, 'Prepared scheduler admitted an occurrence').toBe(
                            historyBefore,
                        );
                        expect(
                            held[0]?.schedule,
                            'Prepared scheduler advanced the persisted occurrence',
                        ).toEqual(dueSchedule[0]?.schedule);
                        expect((await fetch(`${base}/api/health/ready`)).status).toBe(503);
                        await new Promise<void>((resolve) => setTimeout(resolve, 200));
                    } while (performance.now() < holdUntil);
                    expect(
                        (await runUpgradeCommand(['--upgrade-status', upgradeSocket])).state,
                    ).toBe('prepared');
                    // Only explicit resume may admit and finish this due occurrence.
                    expect(
                        (await runUpgradeCommand(['--resume-upgrade', upgradeSocket])).state,
                    ).toBe('idle');
                    await eventually(
                        async () =>
                            Number(
                                (
                                    await sql<
                                        { count: string }[]
                                    >`SELECT count(*)::text AS count FROM task_history WHERE task_id = ${taskId} AND state = 'completed'`
                                )[0]?.count,
                            ) > completedBefore,
                        child,
                        () => output,
                    );
                    const resumedRows = await sql<{ count: string; scheduled: string }[]>`
                        SELECT count(*)::text AS count,
                            count(*) FILTER (WHERE trigger->>'kind' = 'scheduled')::text AS scheduled
                        FROM task_history WHERE task_id = ${taskId}
                    `;
                    expect(Number(resumedRows[0]?.count)).toBe(Number(historyBefore) + 1);
                    expect(Number(resumedRows[0]?.scheduled)).toBeGreaterThan(0);
                    const resumedSchedule = await sql<{ schedule: Record<string, unknown> }[]>`
                        SELECT to_jsonb(scheduler_state) AS schedule FROM scheduler_state WHERE task_id = ${taskId}
                    `;
                    expect(resumedSchedule[0]?.schedule).not.toEqual(dueSchedule[0]?.schedule);
                    expect((await fetch(`${base}/api/health/ready`)).status).toBe(200);
                    const rePrepared = await runUpgradeCommand([
                        '--prepare-upgrade',
                        upgradeSocket,
                    ]);
                    expect(rePrepared.instance).toBe(prepared.instance);
                    expect(
                        (
                            await runUpgradeCommand([
                                '--stop-upgrade',
                                upgradeSocket,
                                rePrepared.nonce ?? '',
                            ])
                        ).state,
                    ).toBe('stopping');
                } else child.kill('SIGTERM');
                const result = await Promise.race([
                    exited,
                    new Promise<never>((_, reject) => {
                        const timer = setTimeout(
                            () => reject(new Error(`Task shutdown timed out: ${output}`)),
                            30_000,
                        );
                        timer.unref();
                    }),
                ]);
                expect(result[0], output).toBe(0);
            } finally {
                if (child.exitCode === null && child.signalCode === null) {
                    child.kill('SIGKILL');
                    await once(child, 'exit');
                }
                // Full startup also schedules builtin maintenance. Remove this
                // boot's surviving queue jobs BEFORE deleting their SQL rows:
                // otherwise the next real host consumes jobs whose history was
                // erased by this fixture and correctly retains UNKNOWN writes.
                try {
                    const owned = await sql<
                        { id: string; task_id: string }[]
                    >`SELECT id, task_id FROM task_history WHERE owner_instance_id = ${instanceId}`;
                    const ownedIds = new Set(owned.map((row) => row.id));
                    const connection = new IORedis(taskCacheUrl, { maxRetriesPerRequest: 1 });
                    try {
                        for (const ownedTask of new Set(owned.map((row) => row.task_id))) {
                            const queue = new Queue(perTaskQueueName(ownedTask), {
                                connection,
                                prefix: PER_TASK_QUEUE_PREFIX,
                            });
                            try {
                                const jobStates: Parameters<typeof queue.getJobs>[0] = [
                                    'wait',
                                    'active',
                                    'delayed',
                                    'prioritized',
                                    'waiting-children',
                                    'completed',
                                    'failed',
                                ];
                                const jobs = await queue.getJobs(jobStates, 0, -1);
                                for (const job of jobs) {
                                    if (
                                        typeof job.data.runId === 'string' &&
                                        ownedIds.has(job.data.runId)
                                    )
                                        await job.remove();
                                }
                                const remaining = await queue.getJobs(jobStates, 0, -1);
                                expect(
                                    remaining.filter(
                                        (job) =>
                                            typeof job.data.runId === 'string' &&
                                            ownedIds.has(job.data.runId),
                                    ),
                                    'Owned task queue jobs must be removed before deleting history',
                                ).toEqual([]);
                            } finally {
                                await queue.close();
                            }
                        }
                        await sql`DELETE FROM task_history WHERE owner_instance_id = ${instanceId}`;
                    } finally {
                        connection.disconnect();
                    }
                } finally {
                    try {
                        await sql.end({ timeout: 2 });
                    } finally {
                        await rm(directory, { recursive: true, force: true });
                    }
                }
            }
        },
        150_000,
    );
});
