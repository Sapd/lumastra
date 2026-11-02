// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import {
    getTestDb,
    getTestDatabaseUrl,
    closeTestDb,
} from '../../../../tests/integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { TaskOrchestrator, orchestrator as facade } from './orchestrator.js';
import { TaskRunner } from './runner.js';
import { upsertTaskSettings } from '../database/queries/task-settings.queries.js';
import { requestJellyfinSetupInventory } from '../services/jellyfin-setup-sync.service.js';
import { getSetupJellyfinStatus } from '../database/queries/onboarding.queries.js';
import { features } from '../config.js';
import { TaskRegistry } from './registry.js';
import { requireClient } from './valkey-types.js';
import { computeIdentity, identityKey } from './identity.js';
import { jellyfinFileInventoryTask } from './builtin/native/jellyfin-file-inventory.js';
import { watchSyncPullTask } from './builtin/native/watch-sync-pull.js';

const engine = vi.hoisted(() => ({ pull: vi.fn() }));
vi.mock('$lib/server/services/watch-sync-engine.service.js', () => ({
    watchSyncEngine: { runPull: engine.pull },
}));

describe('Jellyfin follow-up deduplication (PostgreSQL + Valkey)', () => {
    let sql: postgres.Sql;
    let orchestrator: TaskOrchestrator;
    const runs = new Set<string>();
    const tasks = [jellyfinFileInventoryTask, watchSyncPullTask];

    beforeAll(async () => {
        sql = getTestDb();
        await connectValkey();
        const registry = new TaskRegistry();
        for (const task of tasks) registry.registerTask({ ...task, schedule: undefined });
        orchestrator = await TaskOrchestrator.start(['io'], {
            registry,
            getSql: () => sql,
            getClient: requireClient,
        });
        vi.spyOn(facade, 'startRun').mockImplementation((...args) =>
            orchestrator.startRun(...args),
        );
    }, 30_000);

    afterAll(async () => {
        if (orchestrator) {
            await Promise.allSettled(
                [...runs].map((runId) => orchestrator.cancelRun(runId, { hard: true })),
            );
            await orchestrator.stop();
        }
        if (sql) {
            await sql`DELETE FROM plugin_settings WHERE plugin_id = 'jellyfin-setup-sync'`;
            for (const runId of runs) await sql`DELETE FROM task_history WHERE id = ${runId}`;
            for (const task of tasks) {
                await requireClient().customCommand([
                    'DEL',
                    identityKey(task.id, computeIdentity(task, {})),
                ]);
            }
        }
        await disconnectValkey();
        await closeTestDb();
        vi.restoreAllMocks();
    });

    it('honours one pending kick after an older pull has finished, instead of dropping it on deduplication', async () => {
        vi.spyOn(features, 'jellyfinSync', 'get').mockReturnValue(true);
        for (const runId of runs) await orchestrator.cancelRun(runId, { hard: true });
        await sql`DELETE FROM plugin_settings WHERE plugin_id = 'jellyfin-setup-sync'`;
        let finish = (): void => undefined;
        engine.pull
            .mockReset()
            .mockResolvedValue([])
            .mockImplementationOnce(
                () =>
                    new Promise<unknown[]>((resolve) => {
                        finish = () => resolve([]);
                    }),
            );
        const registry = new TaskRegistry();
        registry.registerTask({ ...watchSyncPullTask, schedule: undefined });
        const runner = await TaskRunner.start(['io'], {
            registry,
            getSql: () => sql,
            getClient: requireClient,
            instanceId: 'jellyfin-followup-test',
            bootId: crypto.randomUUID(),
            heartbeatIntervalMs: 1000,
            subscribe: async () => null,
        });
        try {
            const first = await orchestrator.startRun('watch-sync-pull', {});
            runs.add(first.runId);
            await expect.poll(() => engine.pull.mock.calls.length, { timeout: 10_000 }).toBe(1);
            await upsertTaskSettings(sql, 'jellyfin-setup-sync', {
                'pending-pull': {
                    token: crypto.randomUUID(),
                    requestedAt: new Date().toISOString(),
                },
            });
            const kicked = await orchestrator.startRun('watch-sync-pull', {});
            expect(kicked).toMatchObject({ runId: first.runId, deduped: true });
            finish();
            await expect.poll(() => engine.pull.mock.calls.length, { timeout: 10_000 }).toBe(2);
            const rows = await sql<
                { id: string }[]
            >`SELECT id FROM task_history WHERE task_id = 'watch-sync-pull'`;
            for (const row of rows) runs.add(row.id);
        } finally {
            finish();
            await runner.stop();
        }
    }, 30_000);

    it('coalesces a wave across independent connections even after the inventory run completed', async () => {
        for (const runId of runs) await orchestrator.cancelRun(runId, { hard: true });
        await sql`DELETE FROM plugin_settings WHERE plugin_id = 'jellyfin-setup-sync'`;
        const logger = { warn: vi.fn() };
        const callsBefore = vi.mocked(facade.startRun).mock.calls.length;
        expect(await requestJellyfinSetupInventory(sql, 'file-library-scan', logger)).toBe(true);
        const [first] = await sql<{ id: string }[]>`
            SELECT id FROM task_history WHERE task_id = 'jellyfin-file-inventory'
            ORDER BY started_at DESC LIMIT 1
        `;
        runs.add(first.id);
        await sql`UPDATE task_history SET state = 'completed', completed_at = now() WHERE id = ${first.id}`;
        const writers = Array.from({ length: 4 }, () => postgres(getTestDatabaseUrl(), { max: 1 }));
        try {
            expect(
                await Promise.all(
                    writers.map((writer) =>
                        requestJellyfinSetupInventory(writer, 'file-library-scan', logger),
                    ),
                ),
            ).toEqual([true, true, true, true]);
            expect(vi.mocked(facade.startRun).mock.calls.length - callsBefore).toBe(1);
            expect(logger.warn).not.toHaveBeenCalled();
        } finally {
            await Promise.all(writers.map((writer) => writer.end()));
        }
    });

    it('records enqueue failure for status without throwing or poisoning the scan wave', async () => {
        await sql`DELETE FROM plugin_settings WHERE plugin_id = 'jellyfin-setup-sync'`;
        const logger = { warn: vi.fn() };
        vi.mocked(facade.startRun).mockRejectedValueOnce(
            new Error('test-secret http://user:password@host'),
        );
        await expect(
            requestJellyfinSetupInventory(sql, '/api/setup/jellyfin', logger),
        ).resolves.toBe(false);
        expect(await getSetupJellyfinStatus(sql)).toMatchObject({ syncStarted: false });
        expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/test-secret|user:|password/);
        const rows =
            await sql`SELECT 1 FROM plugin_settings WHERE plugin_id = 'jellyfin-setup-sync' AND key = 'inventory-wave'`;
        expect(rows).toHaveLength(0);
    });

    it.each(tasks.map((task) => task.id))(
        '%s collapses concurrent follow-ups and can run again after termination',
        async (taskId) => {
            const first = await orchestrator.startRun(
                taskId,
                {},
                {
                    trigger: { kind: 'in-process', sourceRoute: 'file-library-scan' },
                },
            );
            runs.add(first.runId);
            const repeated = await Promise.all(
                Array.from({ length: 5 }, () =>
                    orchestrator.startRun(
                        taskId,
                        {},
                        {
                            trigger: { kind: 'in-process', sourceRoute: '/api/setup/jellyfin' },
                        },
                    ),
                ),
            );
            for (const run of repeated) {
                runs.add(run.runId);
                expect(run).toMatchObject({ runId: first.runId, deduped: true });
            }
            const [count] = await sql<{ count: number }[]>`
            SELECT COUNT(*)::int AS count FROM task_history
            WHERE task_id = ${taskId} AND state IN ('pending', 'active', 'cancelling')
        `;
            expect(count?.count).toBe(1);
            await orchestrator.cancelRun(first.runId, { hard: true });
            const retry = await orchestrator.startRun(taskId, {});
            runs.add(retry.runId);
            expect(retry.runId).not.toBe(first.runId);
            expect(retry.deduped).not.toBe(true);
        },
    );
});
