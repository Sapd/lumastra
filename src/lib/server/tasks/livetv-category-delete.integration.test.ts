// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { ulid } from 'ulid';
import { closeTestDb, getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { mount } from '$lib/server/api/mount.js';
import { def } from '$lib/server/api/defs/livetv/admin/categories/[id]/index.js';
import {
    bulkCreateChannels,
    getCategoryById,
    getExcludedCategoryNames,
} from '$lib/server/database/queries/livetv-channels.queries.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { TaskOrchestrator, orchestrator } from './orchestrator.js';
import { TaskRegistry, registry as builtins } from './registry.js';
import { TaskRunner } from './runner.js';
import { stateMachine } from './state-machine.js';
import { requireClient } from './valkey-types.js';
import './builtin/native/livetv-tasks.js';

beforeAll(async (): Promise<void> => {
    await connectValkey();
}, 30_000);

afterAll(async (): Promise<void> => {
    await disconnectValkey();
    await closeTestDb();
}, 30_000);

it('runs an accepted category DELETE through the registered background worker', async () => {
    const sql = getTestDb();
    const sourceId = crypto.randomUUID();
    const categoryId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const actorId = crypto.randomUUID();
    const taskId = 'delete-livetv-category';
    const task = builtins.getTask(taskId);
    expect(task).toBeDefined();
    if (!task) throw new Error('Live TV category deletion is not registered');

    const registry = new TaskRegistry();
    registry.registerTask(task);
    const options = { registry, stateMachine, getSql: () => sql, getClient: requireClient };
    const queue = await TaskOrchestrator.start(['io'], {
        ...options,
        instanceId: 'category-delete-integration-orchestrator',
    });
    let runner: TaskRunner | undefined;
    let runId: string | undefined;
    const dispatch = vi
        .spyOn(orchestrator, 'startRun')
        .mockImplementation((id, input, opts) => queue.startRun(id, input, opts));
    const database = vi.spyOn(aiDbService, 'getSql').mockResolvedValue(sql);
    try {
        await sql`
            INSERT INTO livetv_sources (id, name, source_type, max_streams)
            VALUES (${sourceId}, 'Deletion source', 'm3u', 1)
        `;
        await bulkCreateChannels(sql, {
            categories: [{ id: categoryId, name: `Category ${categoryId}` }],
            channels: [
                {
                    id: channelId,
                    name: 'Example channel',
                    sourceId,
                    categoryId,
                    playlistCategoryKey: 'group:Example',
                    streamUrl: 'https://example.test/channel.m3u8',
                },
            ],
            backupGroups: [],
        });

        runner = await TaskRunner.start(['io'], {
            ...options,
            instanceId: 'category-delete-integration-runner',
            bootId: ulid(),
        });
        const { DELETE } = mount(def, { surface: 'v1' });
        const url = new URL(
            `https://example.test/api/v1/livetv/admin/categories/${categoryId}?withChannels=true`,
        );
        const event = {
            url,
            request: new Request(url, { method: 'DELETE' }),
            params: { categoryId },
            route: { id: '/api/v1/livetv/admin/categories/[id]' },
            locals: {
                principal: {
                    kind: 'pat',
                    username: 'operator',
                    userId: actorId,
                    scopes: ['livetv:admin'],
                },
            },
        } as unknown as RequestEvent;
        const response = await DELETE!(event);
        expect(response.status).toBe(202);
        const accepted = (await response.json()) as { taskId: string };
        runId = accepted.taskId;

        await vi.waitFor(
            async (): Promise<void> => {
                const run = await queue.getRun(accepted.taskId);
                expect(run).toMatchObject({ taskId, state: 'completed' });
            },
            { timeout: 15_000 },
        );

        expect(await getCategoryById(sql, categoryId)).toBeNull();
        expect(await sql`SELECT id FROM livetv_channels WHERE id = ${channelId}`).toHaveLength(0);
        expect(await getExcludedCategoryNames(sql, sourceId)).toEqual(new Set(['group:Example']));
    } finally {
        database.mockRestore();
        dispatch.mockRestore();
        await runner?.stop();
        await queue.stop();
        if (runId) await sql`DELETE FROM task_history WHERE id = ${runId}`;
        await sql`DELETE FROM livetv_sources WHERE id = ${sourceId}`;
        await sql`DELETE FROM media_items WHERE id = ${channelId}`;
        await sql`DELETE FROM livetv_categories WHERE id = ${categoryId}`;
    }
}, 30_000);
