// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { config } from '../config.js';
import { TaskRegistry } from '../tasks/registry.js';
import { imageSyncTask } from '../tasks/builtin/native/media-item-tasks.js';
import {
    ingestSingleFile,
    scanForSync,
} from '../tasks/builtin/native/media-sources/file-scanner.js';
import { createProcessFileForWatcher } from '../tasks/builtin/native/media-sources/_helpers/file-scanner/watcher-process-file.js';
import { flushRecencyRefreshes } from '../tasks/builtin/native/media-sources/_helpers/file-scanner/watcher-recency.js';
import { cancelWatcherFlowDebouncer } from '../tasks/builtin/native/media-sources/_helpers/file-scanner/flow-debouncer.js';
import { getEnabledLibraryPaths } from '../database/queries/library-paths.queries.js';
import { CatalogService } from './catalog.service.js';
import { MediaLifecycleService } from './media-lifecycle.service.js';
import { LoggerInstance } from '../utils/logger.js';
import { StageStateService, type StartRunFn } from './stage-state.service.js';
import { PipelineEventDispatcher } from './pipeline-event-dispatcher.service.js';
import { wrapExecute } from '../tasks/run-wrapper.js';
import { markRunning, markCompleted } from '../database/queries/stage-state.queries.js';

vi.mock('$lib/server/cache/pipeline-pubsub.js', () => ({
    publishStageStateChange: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { startRun: vi.fn().mockResolvedValue({}), getQueueDepths: async () => ({}) },
}));

describe('watcher add → image scan', () => {
    let sql: postgres.Sql;
    let root: string;
    let groupId: string;
    let seriesId: string;
    let file: string;
    let pathId: string;
    let svc: StageStateService;
    let dispatcher: PipelineEventDispatcher;
    let starts: string[];

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        starts = [];
        vi.spyOn(config, 'IMAGE_SYNC_LOCAL_FILE_SCANNING', 'get').mockReturnValue(true);
        vi.spyOn(MediaLifecycleService, 'afterMatched').mockResolvedValue(undefined);
        const info = LoggerInstance.prototype.info;
        vi.spyOn(LoggerInstance.prototype, 'info').mockImplementation(function (
            this: LoggerInstance,
            message,
            meta,
        ) {
            if (
                message === 'Starting image scan' &&
                meta &&
                'targetMediaId' in meta &&
                typeof meta.targetMediaId === 'string'
            ) {
                starts.push(meta.targetMediaId);
            }
            return info.call(this, message, meta);
        });
        await sql`DELETE FROM event_outbox`;
        await sql`INSERT INTO feature_flags (key, value) VALUES ('event_outbox_enabled', 'on')
                  ON CONFLICT (key) DO UPDATE SET value = 'on'`;
        root = await mkdtemp(join(tmpdir(), 'watcher-images-'));
        const [group] = await sql<{ id: string }[]>`
            INSERT INTO library_groups (name) VALUES (${root}) RETURNING id`;
        groupId = group.id;
        const [libraryPath] = await sql<{ id: string }[]>`
            INSERT INTO library_paths (path, media_type, library_group_id, enabled)
            VALUES (${root}, 'tv', ${groupId}, true) RETURNING id`;
        pathId = libraryPath.id;
        const [series] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, library_group_id)
            VALUES ('Watcher Images', 'tv', ${groupId}) RETURNING id`;
        seriesId = series.id;
        await new CatalogService(sql, { skipLifecycleHooks: true }).upsertExternalId(seriesId, {
            provider: 'imdb',
            id: 'tt9998811',
            mediaType: 'tv',
        });
        const dir = join(root, 'Watcher Images', 'Season 01');
        await mkdir(dir, { recursive: true });
        file = join(dir, 'Watcher Images - S01E01.mp4');
        await copyFile('tests/fixtures/test-video.mp4', file);
        await writeFile(
            join(root, 'Watcher Images', 'tvshow.nfo'),
            '<tvshow><uniqueid type="imdb" default="true">tt9998811</uniqueid></tvshow>',
        );
        const registry = new TaskRegistry();
        registry.registerTask(imageSyncTask);
        const startRun: StartRunFn = async (taskId, input) => {
            expect(taskId).toBe('image-sync');
            const mediaItemId = String(input.mediaItemId);
            const ctx = mockContext({ sql, input: { mediaItemId } });
            const result = await wrapExecute({
                sql,
                mediaItemId,
                stageId: 'image-sync',
                processingVersion: 1,
                runId: ctx.runId,
                currentAttempt: 1,
                pluginId: 'image-sync',
                inner: () => imageSyncTask.execute(ctx),
            });
            const [stage] = await sql<{ status: string }[]>`
                SELECT status FROM media_item_stage_state
                WHERE media_item_id = ${mediaItemId}::uuid AND stage_id = 'image-sync'`;
            expect(stage.status).toBe('completed');
            return result;
        };
        svc = new StageStateService(sql, registry, startRun, async () => ({}));
        dispatcher = new PipelineEventDispatcher({
            sql,
            isLeader: () => true,
            stageState: svc,
            drainBudgetMs: 30_000,
        });
        await sql`DELETE FROM event_outbox`;
    });
    afterEach(async () => {
        await flushRecencyRefreshes();
        cancelWatcherFlowDebouncer();
        vi.restoreAllMocks();
        await sql`UPDATE feature_flags SET value = 'off' WHERE key = 'event_outbox_enabled'`;
        await sql`DELETE FROM event_outbox`;
        await sql`DELETE FROM media_items WHERE id = ${seriesId}::uuid`;
        await sql`DELETE FROM media_files WHERE library_group_id = ${groupId}::uuid`;
        await sql`DELETE FROM library_paths WHERE library_group_id = ${groupId}::uuid`;
        await sql`DELETE FROM library_groups WHERE id = ${groupId}::uuid`;
        await rm(root, { recursive: true, force: true });
    });

    async function ingestEpisode(): Promise<string> {
        // The Node callback used by both native protocol-2 and native watcher adds.
        const processFile = createProcessFileForWatcher({
            getEnabledLibraryPaths,
            ingestSingleFile,
        });
        await processFile(sql, file, mockContext({ sql }) as never);
        const [episode] = await sql<{ id: string }[]>`
            SELECT mi.id FROM media_items mi JOIN media_file_items mfi ON mfi.media_item_id = mi.id
            JOIN media_files mf ON mf.id = mfi.file_id WHERE mf.file_path = ${file}`;
        expect(episode).toBeDefined();
        return episode.id;
    }

    it('starts exactly one image scan for one newly ingested episode, including delayed ingest events', async () => {
        const id = await ingestEpisode();
        const events = await sql<{ event_name: string }[]>`
            SELECT event_name FROM event_outbox WHERE media_item_id = ${id}::uuid ORDER BY id`;
        expect(events.map((e) => e.event_name)).toContain('item.created');
        expect(events.map((e) => e.event_name)).toContain('metadata.changed');
        const result = await dispatcher.tick();
        expect(result.deadLettered).toBe(0);

        // A late lifecycle seed for this same creation must also be idempotent.
        await svc.seedRowsForCreate(id);
        await svc.seedRowsForBatch([id]);
        expect(starts.filter((item) => item === id)).toHaveLength(1);
    });

    it('still scans a new episode discovered by a full library scan', async () => {
        await scanForSync(pathId, mockContext({ sql }) as never);
        const [episode] = await sql<{ id: string }[]>`
            SELECT id FROM media_items WHERE media_type = 'episode' AND parent_id IN (
                SELECT id FROM media_items WHERE parent_id = ${seriesId}::uuid
            )`;
        expect(episode).toBeDefined();
        expect((await dispatcher.tick()).deadLettered).toBe(0);
        expect(starts.filter((item) => item === episode.id)).toHaveLength(1);
    });

    it('preserves subsequent metadata changes and explicit manual rescans', async () => {
        const id = await ingestEpisode();
        await dispatcher.tick();
        expect(starts.filter((item) => item === id)).toHaveLength(1);
        await sql`UPDATE media_items SET overview = 'A later metadata edit' WHERE id = ${id}::uuid`;
        expect((await dispatcher.tick()).deadLettered).toBe(0);
        expect(starts.filter((item) => item === id)).toHaveLength(2);
        await imageSyncTask.execute(mockContext({ sql, input: { mediaItemId: id, force: true } }));
        expect(starts.filter((item) => item === id)).toHaveLength(3);
    });

    it('coalesces pre-run events while running but preserves a change during the run', async () => {
        const id = await ingestEpisode();
        await svc.seedRowsForCreate(id);
        await markRunning(sql, { mediaItemId: id, stageId: 'image-sync', runId: 'held-image-run' });
        expect((await dispatcher.tick()).deadLettered).toBe(0);
        const [before] = await sql<{ invalidated_at: Date | null }[]>`
            SELECT invalidated_at FROM media_item_stage_state
            WHERE media_item_id = ${id}::uuid AND stage_id = 'image-sync'`;
        expect(before.invalidated_at).toBeNull();
        await sql`UPDATE media_items SET overview = 'Changed during scan' WHERE id = ${id}::uuid`;
        expect((await dispatcher.tick()).deadLettered).toBe(0);
        await markCompleted(sql, {
            mediaItemId: id,
            stageId: 'image-sync',
            runId: 'held-image-run',
        });
        const [after] = await sql<{ status: string }[]>`
            SELECT status FROM media_item_stage_state
            WHERE media_item_id = ${id}::uuid AND stage_id = 'image-sync'`;
        expect(after.status).toBe('obsolete');
    });
});
