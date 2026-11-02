// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { z } from 'zod';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { createAndInsertTestSeries } from '../../../../tests/integration/fixtures/index.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import { TaskRegistry } from '$lib/server/tasks/registry.js';
import { PipelineEventDispatcher } from './pipeline-event-dispatcher.service.js';
import { StageStateService } from './stage-state.service.js';
import {
    upsertCompletedRow,
    upsertRunningRow,
} from '$lib/server/database/queries/stage-state.queries.js';

vi.mock('$lib/server/cache/pipeline-pubsub.js', () => ({ publishStageStateChange: vi.fn() }));
vi.mock('$lib/server/tasks/observability/heartbeat.js', () => ({
    beatAlive: vi.fn(),
    writeHeartbeat: vi.fn(),
}));

describe('episode file events invalidate ancestor chapter work through the outbox', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        await sql`DELETE FROM event_outbox`;
    });

    it.each([
        ['completed', 'file.attached'],
        ['completed', 'file.contentChanged'],
        ['running', 'file.attached'],
        ['running', 'file.contentChanged'],
    ])(
        'invalidates the correct series from an episode file when chapter stage is %s for %s',
        async (status, event) => {
            const { seriesId } = await createAndInsertTestSeries(sql, {
                tmdbId: 990001,
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            const other = await createAndInsertTestSeries(sql, {
                tmdbId: 990002,
                seasonCount: 1,
                episodesPerSeason: 1,
            });
            const [episode] = await sql<
                { id: string }[]
            >`SELECT ep.id FROM media_items ep JOIN media_items season ON season.id=ep.parent_id WHERE season.parent_id=${seriesId} AND ep.media_type='episode'`;
            const registry = new TaskRegistry();
            registry.registerTask(
                defineTask({
                    id: 'chapter-fanup-fixture',
                    name: 'Chapter fan-up fixture',
                    version: '1.0.0',
                    processingVersion: 1,
                    minAppVersion: '0.0.0',
                    capabilities: {},
                    resourceClass: 'io',
                    inputSchema: z.object({}),
                    identityFor: () => 'fixture',
                    manualOnly: true,
                    coversStages: [
                        {
                            id: 'chapter-sync',
                            appliesTo: ['series', 'movie'],
                            invalidatedBy: ['file.attached', 'file.contentChanged'],
                        },
                        {
                            id: 'unrelated-series-work',
                            appliesTo: ['series'],
                            invalidatedBy: ['file.attached'],
                        },
                    ],
                    async execute() {
                        return { success: true };
                    },
                }),
            );
            for (const id of [seriesId, other.seriesId]) {
                for (const stageId of ['chapter-sync', 'unrelated-series-work']) {
                    await upsertCompletedRow(sql, {
                        mediaItemId: id,
                        stageId,
                        processingVersion: 1,
                    });
                }
            }
            if (status === 'running') {
                await upsertRunningRow(sql, {
                    mediaItemId: seriesId,
                    stageId: 'chapter-sync',
                    processingVersion: 1,
                    runId: crypto.randomUUID(),
                });
                await sql`UPDATE media_item_stage_state SET started_at=now()-interval '1 minute' WHERE media_item_id=${seriesId} AND stage_id='chapter-sync'`;
            }
            // Isolate the normal file event from fixture-creation triggers.
            await sql`DELETE FROM event_outbox`;
            await sql`INSERT INTO event_outbox(event_name,media_item_id,payload) VALUES(${event},${episode.id},${sql.json({ mediaId: episode.id, fileId: crypto.randomUUID() })})`;
            const dispatcher = new PipelineEventDispatcher({
                sql,
                isLeader: () => true,
                stageState: new StageStateService(sql, registry),
            });
            expect(await dispatcher.tick()).toMatchObject({ deadLettered: 0 });
            const [own] =
                await sql`SELECT status,invalidated_at FROM media_item_stage_state WHERE media_item_id=${seriesId} AND stage_id='chapter-sync'`;
            if (status === 'running') {
                expect(own.invalidated_at).not.toBeNull();
                await upsertCompletedRow(sql, {
                    mediaItemId: seriesId,
                    stageId: 'chapter-sync',
                    processingVersion: 1,
                });
                const [after] =
                    await sql`SELECT status FROM media_item_stage_state WHERE media_item_id=${seriesId} AND stage_id='chapter-sync'`;
                expect(after.status).toBe('obsolete');
            } else expect(own.status).toBe('pending');
            const others =
                await sql`SELECT status FROM media_item_stage_state WHERE media_item_id=${other.seriesId} OR stage_id='unrelated-series-work'`;
            expect(others.every((row) => row.status === 'completed')).toBe(true);
            expect(
                await sql`SELECT stage_id FROM media_item_stage_state WHERE media_item_id=${episode.id} AND stage_id='chapter-sync'`,
            ).toHaveLength(0);
        },
    );
});
