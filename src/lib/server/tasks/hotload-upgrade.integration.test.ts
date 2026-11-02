// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { Queue } from 'bullmq';
import postgres from 'postgres';
import { expect, it, vi } from 'vitest';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import * as configuration from '$lib/server/config.js';
import { registry } from './registry.js';
import { startTaskRunner, stopTaskRunner } from './runner.js';
import { TaskOrchestrator } from './orchestrator.js';
import { StateMachine } from './state-machine.js';
import { requireClient } from './valkey-types.js';
import { PER_TASK_QUEUE_PREFIX } from './queue-naming.js';
import { getQueueConnectionOptions } from './connection.js';
import { loadAndWirePlugin } from '$lib/server/plugins/runtime/loader.js';

it('adopts a plugin registered by the real hot loader while prepared, without another reload', async () => {
    const id = `upgrade-hotload-${randomUUID()}`;
    const directory = await mkdtemp(path.join(tmpdir(), 'lumastra-upgrade-hotload-'));
    const pluginDirectory = path.join(directory, id);
    const sql = postgres(getTestDatabaseUrl(), { max: 4 });
    const gate = vi
        .spyOn(configuration.config, 'PLUGINS_REQUIRE_REGISTRY', 'get')
        .mockReturnValue(false);
    let owner: TaskOrchestrator | undefined;
    let queue: Queue | undefined;
    try {
        await connectValkey();
        const stateMachine = new StateMachine(requireClient);
        owner = await TaskOrchestrator.start(['io'], {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient: requireClient,
            perTaskQueues: true,
        });
        const runner = await startTaskRunner(['io'], {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient: requireClient,
            perTaskQueues: true,
        });
        if (!runner) throw new Error('Fixture requires an enabled task runner');
        expect(
            await runner.prepareUpgrade({
                deadlineMs: 5000,
                settled: () => owner!.isUpgradeQuiescent(),
            }),
        ).toEqual({ prepared: true });
        await mkdir(pluginDirectory);
        await writeFile(
            path.join(pluginDirectory, 'package.json'),
            JSON.stringify({ type: 'module' }),
        );
        await build({
            stdin: {
                resolveDir: process.cwd(),
                sourcefile: 'upgrade-hotload-fixture.ts',
                loader: 'ts',
                contents: `
            import { defineTask } from '@sapd/lumastra-plugin-sdk';
            import { z } from 'zod';
            export default defineTask({ id: '${id}', name: 'Hotload upgrade fixture', version: '1.0.0', processingVersion: 1,
                minAppVersion: '0.1.0', resourceClass: 'io', manualOnly: true, capabilities: { database: true }, inputSchema: z.object({}), identityFor: () => 'global',
                async execute(ctx) { await ctx.sql\`SELECT 1\`; return { success: true, itemsProcessed: 1 }; }
            });`,
            },
            outfile: path.join(pluginDirectory, 'index.js'),
            bundle: true,
            platform: 'node',
            format: 'esm',
            target: 'node24',
            logLevel: 'silent',
        });
        const loaded = await loadAndWirePlugin(pluginDirectory, sql);
        expect(loaded.loaded, loaded.error).toBe(true);
        const run = await owner.startRun(id, {});
        const connection = getQueueConnectionOptions();
        if (!connection) throw new Error('Queue connection required');
        queue = new Queue(id, { connection, prefix: PER_TASK_QUEUE_PREFIX });
        expect(
            (
                await sql<
                    { state: string }[]
                >`SELECT state FROM task_history WHERE id = ${run.runId}`
            )[0]?.state,
        ).toBe('pending');
        await runner.resumeAfterUpgrade();
        const deadline = performance.now() + 10_000;
        while (
            (
                await sql<
                    { state: string }[]
                >`SELECT state FROM task_history WHERE id = ${run.runId}`
            )[0]?.state !== 'completed'
        ) {
            if (performance.now() > deadline)
                throw new Error('Hot-loaded task did not acquire a consumer after restoration');
            await new Promise<void>((resolve) => setTimeout(resolve, 20));
        }
        expect(
            (
                await sql<
                    { result: { itemsProcessed: number } }[]
                >`SELECT result FROM task_history WHERE id = ${run.runId}`
            )[0]?.result.itemsProcessed,
        ).toBe(1);
    } finally {
        await stopTaskRunner({ strict: true });
        await owner?.stop({ strict: true });
        if (queue) {
            await queue.obliterate({ force: true });
            await queue.close();
        }
        await sql`DELETE FROM task_history WHERE task_id = ${id}`;
        await sql.end();
        await disconnectValkey();
        gate.mockRestore();
        await rm(directory, { recursive: true, force: true });
    }
}, 30_000);
