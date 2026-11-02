// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import postgres from 'postgres';
import { build } from 'esbuild';
import { Worker, Queue } from 'bullmq';
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { expect, it } from 'vitest';
import { TaskRegistry } from '$lib/server/tasks/registry.js';
import { TaskOrchestrator } from '$lib/server/tasks/orchestrator.js';
import { StateMachine } from '$lib/server/tasks/state-machine.js';
import {
    quarantineValkeyTaskAuthority,
    installValkeyTaskAuthority,
} from '$lib/server/tasks/lua/fenced-control.js';
import {
    VALKEY_TASK_AUTHORITY_KEY,
    VALKEY_TASK_MANAGED_KEY,
} from '$lib/server/tasks/lua/fenced.js';
import { requireClient } from '$lib/server/tasks/valkey-types.js';
import { getQueueConnectionOptions } from '$lib/server/tasks/connection.js';
import { PER_TASK_QUEUE_PREFIX } from '$lib/server/tasks/queue-naming.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { AuthorityStore } from './authority/store.js';
import { startExecutorProcess, type SupervisedExecutor } from './executor-supervisor.js';
import { ExecutorClient } from './executor-client.js';

it('runs an unchanged SDK plugin through the compiled supervised executor, durable admission and actual Unix transport', async () => {
    await access('build/task-executor.js'); // Required artifact; never skip missing build.
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
        throw new Error('Isolated integration services required');
    const sql = postgres(databaseUrl, { max: 3 });
    const authorityStore = new AuthorityStore(sql);
    const authority = await authorityStore.initialize('tasks', randomUUID(), 'typescript', 120_000);
    const directory = await mkdtemp(path.join(tmpdir(), 'executor-plugin-'));
    const taskId = `bridge-${randomUUID()}`;
    const pluginDir = path.join(directory, 'plugins', taskId);
    await mkdir(pluginDir, { recursive: true });
    await writeFile(path.join(pluginDir, 'package.json'), JSON.stringify({ type: 'module' }));
    await build({
        stdin: {
            resolveDir: process.cwd(),
            sourcefile: 'executor-plugin.ts',
            loader: 'ts',
            contents: `
        import {defineTask} from '@sapd/lumastra-plugin-sdk'; import {z} from 'zod';
        export default defineTask({id:'${taskId}',name:'Executor process fixture',version:'1.0.0',processingVersion:1,minAppVersion:'0.1.0',resourceClass:'io',capabilities:{database:true,cache:true},inputSchema:z.object({identity:z.string()}),identityFor:i=>i.identity,
        async execute(ctx){await ctx.sql\`SELECT 1\`;if(!ctx.catalog||!ctx.mediaItems||!ctx.mediaFiles||!ctx.userCredentials||!ctx.signal)throw new Error('Missing context');await ctx.cache.set('bridge',{ok:true},60000);if(!(await ctx.cache.get('bridge'))?.ok)throw new Error('Missing cache');ctx.reportProgress(1,1);return {success:true,itemsProcessed:1};}});`,
        },
        outfile: path.join(pluginDir, 'index.js'),
        bundle: true,
        platform: 'node',
        format: 'esm',
        target: 'node24',
        logLevel: 'silent',
    });
    const registry = new TaskRegistry();
    registry.registerTask(
        defineTask({
            id: taskId,
            name: 'Executor process fixture',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '0.1.0',
            resourceClass: 'io',
            capabilities: { database: true, cache: true },
            inputSchema: z.object({ identity: z.string() }),
            identityFor: (i) => i.identity,
            async execute() {
                throw new Error('Parent must not execute plugin');
            },
        }),
    );
    await connectValkey();
    await quarantineValkeyTaskAuthority(requireClient());
    const [lease] = await sql<
        { lease_until: Date }[]
    >`SELECT lease_until FROM task_runtime_authorities WHERE partition = ${authority.partition}`;
    await installValkeyTaskAuthority(requireClient(), undefined, {
        authority,
        phase: 'active',
        leaseUntilMs: lease.lease_until.getTime(),
    });
    const connection = getQueueConnectionOptions();
    if (!connection) throw new Error('Missing queue connection');
    const orchestrator = await TaskOrchestrator.start(['io'], {
        registry,
        stateMachine: new StateMachine(requireClient, authority),
        authority,
        getSql: () => sql,
        getClient: requireClient,
        perTaskQueues: true,
    });
    const claimant = new Worker(taskId, null, {
        connection,
        prefix: PER_TASK_QUEUE_PREFIX,
        autorun: false,
        skipStalledCheck: true,
        skipLockRenewal: true,
        lockDuration: 120_000,
    });
    const queue = new Queue(taskId, { connection, prefix: PER_TASK_QUEUE_PREFIX });
    let child: SupervisedExecutor | undefined;
    try {
        child = await startExecutorProcess({
            entry: 'build/task-executor.js',
            authority,
            eligibleTaskIds: [taskId],
            env: {
                ...process.env,
                NODE_ENV: 'production',
                VITEST: undefined,
                DATABASE_URL: databaseUrl,
                CACHE_URL: cacheUrl,
                TASK_CACHE_URL: taskCacheUrl,
                CONFIG_PATH: path.join(directory, 'config/settings.json'),
                BASE_PATH: directory,
                PLUGINS_EXTERNAL_DIR: path.join(directory, 'plugins'),
                PLUGINS_REQUIRE_REGISTRY: 'false',
                APP_VERSION: '0.1.0',
                LICENSE_SERVER_CONTACT_ENABLED: 'false',
                FEATURE_JELLYFIN_SYNC: 'false',
            },
        });
        expect(child.catalogRevision).toMatch(/^[a-f0-9]{64}$/);
        expect(child.controlSocketPath).toMatch(/\/executor-control\.sock$/);
        expect(await new ExecutorClient(child).request({ operation: 'status' })).toMatchObject({
            status: { quiescent: true },
        });
        const catalogRevision = child.catalogRevision;
        if (!catalogRevision) throw new Error('Missing executor catalog revision');
        for (let index = 0; index < 2; index++) {
            const { runId } = await orchestrator.startRun(taskId, { identity: randomUUID() });
            const token = randomUUID();
            const job = await claimant.getNextJob(token, { block: false });
            if (!job?.id) throw new Error('Missing claimed job');
            const command = {
                invocationId: randomUUID(),
                dispatchId: randomUUID(),
                authority,
                catalogRevision,
                runId,
                taskId,
                queueName: taskId,
                jobId: job.id,
                lockToken: token,
                lockDurationMs: 120_000,
            };
            const staleInvocation = randomUUID();
            expect(
                await new ExecutorClient(child).request({
                    operation: 'execute',
                    execution: {
                        ...command,
                        invocationId: staleInvocation,
                        dispatchId: randomUUID(),
                        authority: { ...authority, generation: '2' },
                    },
                }),
            ).toMatchObject({ status: 'rejected' });
            expect(await authorityStore.lookupExecution(authority, staleInvocation)).toBeNull();
            const response = await new ExecutorClient(child).execute(command);
            const history = await sql`SELECT state,error FROM task_history WHERE id=${runId}`;
            expect(response, JSON.stringify(history)).toMatchObject({
                admitted: true,
                outcome: { status: 'completed', result: { success: true, itemsProcessed: 1 } },
            });
            const settlementDeadline = Date.now() + 5000;
            let persisted = await authorityStore.lookupExecution(authority, command.invocationId);
            while (persisted?.state !== 'settled' && Date.now() < settlementDeadline) {
                await new Promise((resolve) => setTimeout(resolve, 20));
                persisted = await authorityStore.lookupExecution(authority, command.invocationId);
            }
            expect(persisted).toMatchObject({
                state: 'settled',
                dispatchId: command.dispatchId,
                outcome: { status: 'completed' },
            });
            expect(await job.getState()).toBe('active');
            await job.moveToCompleted({ success: true }, token, false);
            expect(
                (
                    await sql<{ state: string }[]>`SELECT state FROM task_history WHERE id=${runId}`
                )[0]?.state,
            ).toBe('completed');
            // Lost/repeated dispatch gets the same admission and stored result, never a second run.
            expect(await new ExecutorClient(child).execute(command)).toMatchObject({
                admitted: true,
                duplicate: true,
                outcome: { status: 'completed' },
            });
        }
        expect(await child.stop()).toEqual({ stopped: true, escalated: false });
    } finally {
        await child?.stop();
        await claimant.close();
        await orchestrator.stop();
        await queue.obliterate({ force: true });
        await queue.close();
        await requireClient().customCommand([
            'DEL',
            VALKEY_TASK_AUTHORITY_KEY,
            VALKEY_TASK_MANAGED_KEY,
        ]);
        await disconnectValkey();
        await sql`DELETE FROM task_history WHERE task_id=${taskId}`;
        await sql`DELETE FROM task_runtime_executions WHERE partition=${authority.partition}`;
        await sql`DELETE FROM task_runtime_authorities WHERE partition=${authority.partition}`;
        await sql.end();
        await rm(directory, { recursive: true, force: true });
    }
}, 90_000);

it('refuses a durable Rust owner at the production executor entry while legacy writers remain unfenced', async () => {
    await access('build/task-executor.js');
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
        throw new Error('Isolated integration services required');
    const sql = postgres(databaseUrl, { max: 1 });
    const store = new AuthorityStore(sql);
    const authority = await store.initialize(`blocked:${randomUUID()}`, randomUUID(), 'rust');
    const directory = await mkdtemp(path.join(tmpdir(), 'executor-blocked-'));
    try {
        await expect(
            startExecutorProcess({
                entry: 'build/task-executor.js',
                authority,
                startupTimeoutMs: 10_000,
                env: {
                    ...process.env,
                    NODE_ENV: 'production',
                    VITEST: undefined,
                    DATABASE_URL: databaseUrl,
                    CACHE_URL: cacheUrl,
                    TASK_CACHE_URL: taskCacheUrl,
                    CONFIG_PATH: path.join(directory, 'settings.json'),
                    BASE_PATH: directory,
                    LICENSE_SERVER_CONTACT_ENABLED: 'false',
                },
            }),
        ).rejects.toThrow('activation_blocked');
    } finally {
        await sql`DELETE FROM task_runtime_authorities WHERE partition=${authority.partition}`;
        await sql.end();
        await rm(directory, { recursive: true, force: true });
    }
}, 20_000);
