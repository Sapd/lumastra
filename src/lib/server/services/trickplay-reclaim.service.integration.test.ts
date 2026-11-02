// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    afterAll,
    afterEach,
    beforeAll,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type MockInstance,
} from 'vitest';
import {
    mkdtemp,
    mkdir,
    rename,
    rm,
    writeFile,
    chmod,
    readFile,
    copyFile,
    appendFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { mockContext, mockLogger } from '@sapd/lumastra-plugin-sdk-testing';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import {
    deleteStaleMediaFile,
    upsertMediaFile,
    attachFileToItem,
} from '../database/queries/media-files.queries.js';
import {
    findReclaimableByHash,
    undismissMediaItem,
} from '../database/queries/file-rematch.queries.js';
import { getTrickplayParams } from '../database/queries/trickplay-params.queries.js';
import { upsertCompletedRow } from '../database/queries/stage-state.queries.js';
import { syncEventOutboxFlag } from '../database/queries/event-outbox.queries.js';
import { hashFileHead } from '../utils/file-hash.js';
import { TaskRegistry } from '../tasks/registry.js';
import { trickplayGenerationTask } from '../tasks/builtin/native/media-item-tasks.js';
import { processVideoFile } from '../tasks/builtin/native/media-sources/_helpers/file-scanner/video-processor.js';
import { wrapExecute } from '../tasks/run-wrapper.js';
import { StageStateService } from './stage-state.service.js';
import {
    PipelineEventDispatcher,
    _clearPipelineEventHandlersForTesting,
} from './pipeline-event-dispatcher.service.js';
import {
    fingerprintTrickplaySource,
    restoreReclaimedTrickplay,
    completeTrickplayGeneration,
} from './trickplay-reclaim.service.js';
import {
    saveSpriteSheet,
    saveTrickplayManifest,
    getSpriteSheet,
    getTrickplayManifest,
    type TrickplayManifest,
} from './trickplay-storage.service.js';
import { MediaLifecycleService } from './media-lifecycle.service.js';
import * as stageQueries from '../database/queries/stage-state.queries.js';
import * as rematchQueries from '../database/queries/file-rematch.queries.js';
import * as generator from './trickplay-generator.service.js';
import * as ffmpeg from '../utils/ffmpeg-spawn.js';
import * as containedFs from '../utils/contained-fs.js';
import * as safeFs from '../utils/safe-fs.js';

const settings = vi.hoisted(() => ({
    TRICKPLAY_ENABLED: true,
    TRICKPLAY_PROVIDER: 'local_only',
    TRICKPLAY_HWACCEL: 'off',
    TRICKPLAY_STORAGE_PATH: '',
    TRICKPLAY_STORAGE_LOCATION: 'central',
    METADATA_STORAGE_LOCATION: 'central',
    TRICKPLAY_WIDTH: 320,
    TRICKPLAY_INTERVAL_MS: 10000,
    TRICKPLAY_TILE_WIDTH: 10,
    TRICKPLAY_TILE_HEIGHT: 10,
    TRICKPLAY_QUALITY: 80,
}));
vi.mock('$lib/server/config.js', async (original) => {
    const actual = await original<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        FEATURE_PIPELINE_EVENT_OUTBOX: true,
        getAuthoritativeStageIds: () => new Set(['trickplay-generation']),
        config: new Proxy(actual.config, {
            get: (target, key) =>
                key in settings ? settings[key as keyof typeof settings] : Reflect.get(target, key),
        }),
    };
});
vi.mock('$lib/server/cache/pipeline-pubsub.js', () => ({
    publishStageStateChange: vi.fn().mockResolvedValue(undefined),
}));
// Queue transport only; scanner/lifecycle SQL and outbox dispatch stay real.
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: {
        startRun: vi.fn().mockResolvedValue(undefined),
        getQueueDepths: vi.fn().mockResolvedValue({}),
    },
}));

const logger = mockLogger();

describe('hash reclaim through dismissal, outbox dispatch and the real trickplay task', () => {
    let sql: postgres.Sql;
    let previousOutboxFlag: string | null;
    let root: string,
        itemId: string,
        oldId: string,
        oldPath: string,
        newPath: string,
        newId: string;
    let svc: StageStateService;
    let registry: TaskRegistry;
    let manifest: TrickplayManifest;
    let dispatcher: PipelineEventDispatcher;
    let ffmpegRuns: MockInstance<typeof ffmpeg.spawnFFmpegSafely>;
    beforeAll(async () => {
        sql = getTestDb();
        const [flag] = await sql<
            { value: string }[]
        >`SELECT value FROM feature_flags WHERE key = 'event_outbox_enabled'`;
        previousOutboxFlag = flag?.value ?? null;
    });
    afterAll(async () => {
        // syncEventOutboxFlag never downgrades an enabled cluster. Restore the
        // fixture's prior DB flag explicitly, or later legacy-path suites start
        // a background dispatcher against unexpected events while TRUNCATE runs.
        if (previousOutboxFlag === null)
            await sql`DELETE FROM feature_flags WHERE key = 'event_outbox_enabled'`;
        else
            await sql`UPDATE feature_flags SET value = ${previousOutboxFlag} WHERE key = 'event_outbox_enabled'`;
        await sql`DELETE FROM event_outbox`;
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.mediaFiles, ...TEST_TABLES.media]);
        await sql`DELETE FROM event_outbox`;
        await syncEventOutboxFlag(sql, true);
        _clearPipelineEventHandlersForTesting();
        root = await mkdtemp(join(tmpdir(), 'trick-reclaim-pg-'));
        Object.assign(settings, {
            TRICKPLAY_STORAGE_PATH: join(root, 'central'),
            TRICKPLAY_ENABLED: true,
            TRICKPLAY_STORAGE_LOCATION: 'central',
            TRICKPLAY_QUALITY: 80,
            TRICKPLAY_WIDTH: 320,
            TRICKPLAY_INTERVAL_MS: 10000,
            TRICKPLAY_TILE_WIDTH: 10,
            TRICKPLAY_TILE_HEIGHT: 10,
        });
        oldPath = join(root, 'old.mp4');
        newPath = join(root, 'renamed.mp4');
        await copyFile(join(process.cwd(), 'tests/fixtures/test-video.mp4'), oldPath);
        const [item] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type) VALUES ('Trick reclaim', 'movie') RETURNING id`;
        itemId = item.id;
        oldId = (
            await upsertMediaFile(sql, {
                filePath: oldPath,
                fileHashHead: await hashFileHead(oldPath),
            })
        ).id;
        await attachFileToItem(sql, oldId, itemId);
        await videoStream(oldId);
        await upsertCompletedRow(sql, {
            mediaItemId: itemId,
            stageId: 'trickplay-generation',
            processingVersion: 1,
        });
        manifest = {
            version: '1.0',
            width: 320,
            height: 180,
            tileWidth: 10,
            tileHeight: 10,
            interval: 10000,
            thumbnailCount: 1,
            format: 'webp',
            sheets: [{ index: 0, filename: '0.webp', startTime: 0, endTime: 0, thumbnailCount: 1 }],
            reuse: {
                ...(await fingerprintTrickplaySource(oldPath)),
                quality: 80,
                spriteQuality: 80,
                providerId: 'local-trickplay',
            },
        };
        registry = new TaskRegistry();
        registry.registerTask(trickplayGenerationTask);
        svc = new StageStateService(
            sql,
            registry,
            vi.fn().mockResolvedValue(undefined),
            async () => ({}),
        );
        dispatcher = new PipelineEventDispatcher({
            sql,
            stageState: svc,
            isLeader: () => true,
            drainBudgetMs: 30000,
        });
        // Exclude unrelated cache/embedding cleanup while retaining the real
        // afterDismissed stage deletion and item.dismissed emission.
        vi.spyOn(MediaLifecycleService, 'afterDeleted').mockResolvedValue(undefined);
        ffmpegRuns = vi.spyOn(ffmpeg, 'spawnFFmpegSafely');
        const { aiDbService } = await import('./database.service.js');
        vi.spyOn(aiDbService, 'getSql').mockResolvedValue(sql);
        await sql`DELETE FROM event_outbox`;
    });
    afterEach(async () => {
        dispatcher.stop();
        vi.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
    });
    async function videoStream(fileId: string): Promise<void> {
        await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec) VALUES (${fileId}, 'video', 0, 'h264') ON CONFLICT DO NOTHING`;
    }
    async function publish(storageGeneration?: string): Promise<void> {
        await saveSpriteSheet(oldId, 320, 0, Buffer.from('sprite'), oldPath, storageGeneration);
        await saveTrickplayManifest(
            oldId,
            320,
            { ...manifest, ...(storageGeneration ? { storageGeneration } : {}) },
            oldPath,
        );
    }
    async function drain(): Promise<void> {
        expect((await dispatcher.tick()).deadLettered).toBe(0);
    }
    async function snapshot(): Promise<unknown> {
        const [row] = await sql<
            { snapshot: unknown }[]
        >`SELECT processing_state->'trickplay-reclaim' AS snapshot FROM media_items WHERE id = ${itemId}`;
        return row.snapshot;
    }
    async function status(): Promise<string | undefined> {
        const [row] = await sql<
            { status: string }[]
        >`SELECT status FROM media_item_stage_state WHERE media_item_id = ${itemId} AND stage_id = 'trickplay-generation'`;
        return row?.status;
    }
    async function runTask(
        overrides: { width?: number; intervalMs?: number; quality?: number } = {},
    ): Promise<unknown> {
        const signal = new AbortController().signal;
        return wrapExecute({
            sql,
            mediaItemId: itemId,
            stageId: 'trickplay-generation',
            pluginId: 'trickplay-generation',
            runId: 'trick-reclaim-test',
            processingVersion: 1,
            currentAttempt: 1,
            inner: () =>
                trickplayGenerationTask.execute(
                    mockContext({
                        sql,
                        input: { mediaItemId: itemId, ...overrides },
                        signal,
                        logger,
                    }),
                ),
        });
    }
    async function reconnect(kind = 'movie'): Promise<void> {
        await rename(oldPath, newPath);
        await deleteStaleMediaFile(sql, oldPath);
        await drain(); // real item.dismissed removes stage coverage
        expect(await status()).toBeUndefined();
        expect((await findReclaimableByHash(sql, await hashFileHead(newPath)))?.media_item_id).toBe(
            itemId,
        );
        newId = (
            await upsertMediaFile(sql, {
                filePath: newPath,
                fileHashHead: await hashFileHead(newPath),
            })
        ).id;
        await attachFileToItem(sql, newId, itemId);
        await videoStream(newId);
        await undismissMediaItem(sql, itemId);
        if (kind !== 'movie')
            await sql`UPDATE media_items SET media_type = ${kind} WHERE id = ${itemId}`;
        await MediaLifecycleService.afterReclaimed(itemId, sql);
        await drain();
        expect(await status()).toBe('pending');
    }
    it('REAL scanner dismissal → item.reclaimed dispatch → task reuse generates ZERO ffmpeg and clears snapshot', async () => {
        // Publish with the actual generator, then take the scanner's hash-reclaim
        // branch rather than manually attaching the replacement row.
        expect(
            (await generator.generateTrickplayForMediaItem(sql, itemId, { force: true })).generated,
        ).toBeGreaterThan(0);
        await rename(oldPath, newPath);
        await deleteStaleMediaFile(sql, oldPath);
        await drain();
        const [group] = await sql<
            { id: string }[]
        >`INSERT INTO library_groups (name) VALUES (${root}) RETURNING id`;
        const [library] =
            await sql`INSERT INTO library_paths (path, media_type, library_group_id, enabled) VALUES (${root}, 'movie', ${group.id}, true) RETURNING *`;
        try {
            await processVideoFile(
                sql,
                newPath,
                library as never,
                [],
                mockContext({ sql, logger }) as never,
            );
            // Scanner's lifecycle hook is intentionally asynchronous. Wait for
            // its real emission, then let the real dispatcher consume it.
            await vi.waitFor(async () => {
                const events =
                    await sql`SELECT 1 FROM event_outbox WHERE media_item_id = ${itemId} AND event_name = 'item.reclaimed'`;
                expect(events.length).toBeGreaterThan(0);
            });
            const [file] = await sql<
                { id: string }[]
            >`SELECT id FROM media_files WHERE file_path = ${newPath}`;
            newId = file.id;
            await videoStream(newId);
            await drain();
            expect(await status()).toBe('pending');
            expect(await snapshot()).not.toBeNull();
            ffmpegRuns.mockClear();
            await runTask();
            expect(ffmpegRuns).not.toHaveBeenCalled();
            expect(await status()).toBe('completed');
            expect(await snapshot()).toBeNull();
            expect(await getTrickplayParams(sql, itemId, newId)).toHaveLength(1);
        } finally {
            await sql`DELETE FROM library_paths WHERE id = ${library.id}`;
            await sql`DELETE FROM library_groups WHERE id = ${group.id}`;
        }
    });
    it('same-folder rename keeps dispatch pending, then task reuse completes with zero generation', async () => {
        await publish();
        await reconnect();
        for (const event of [
            'file.attached',
            'file.detached',
            'file.defaultChanged',
            'file.probed',
        ] as const)
            await svc.invalidateByEvent(itemId, event);
        expect(await snapshot()).not.toBeNull();
        await runTask();
        expect(ffmpegRuns).not.toHaveBeenCalled();
        expect(await status()).toBe('completed');
        expect(await snapshot()).toBeNull();
        expect(await getTrickplayParams(sql, itemId, newId)).toMatchObject([
            { source: 'local', bandwidth: 5 },
        ]);
        expect((await getSpriteSheet(newId, 320, 0, newPath))?.toString()).toBe('sprite');
    });
    it('reclaims an immutable generation into a different file ID without copying a stale generation pointer', async () => {
        const generation = '00000000-0000-4000-8000-000000000005';
        await publish(generation);
        await reconnect();
        await runTask();
        expect(ffmpegRuns).not.toHaveBeenCalled();
        expect(await status()).toBe('completed');
        expect(
            (await getTrickplayManifest(newId, 320, newPath))?.storageGeneration,
        ).toBeUndefined();
        expect((await getSpriteSheet(newId, 320, 0, newPath))?.toString()).toBe('sprite');
        expect((await getSpriteSheet(oldId, 320, 0))?.toString()).toBe('sprite');
    });
    it('central reuse across folders/libraries keeps source sheets intact', async () => {
        await publish();
        await mkdir(join(root, 'other-library'));
        newPath = join(root, 'other-library', 'movie.mp4');
        await reconnect();
        await runTask();
        expect(ffmpegRuns).not.toHaveBeenCalled();
        expect(await status()).toBe('completed');
        expect((await getSpriteSheet(oldId, 320, 0))?.toString()).toBe('sprite');
    });
    it('add-before-unlink preserves the locator until detach makes the stage pending', async () => {
        await publish();
        await rename(oldPath, newPath);
        newId = (
            await upsertMediaFile(sql, {
                filePath: newPath,
                fileHashHead: await hashFileHead(newPath),
            })
        ).id;
        await attachFileToItem(sql, newId, itemId);
        await videoStream(newId);
        await drain();
        expect(await status()).toBe('completed');
        expect(await snapshot()).not.toBeNull();
        await deleteStaleMediaFile(sql, oldPath);
        await drain();
        expect(await status()).toBe('pending');
        await runTask();
        expect(ffmpegRuns).not.toHaveBeenCalled();
        expect(await status()).toBe('completed');
        expect(await snapshot()).toBeNull();
    });
    it.each([false, true])(
        'sidecar moved with rename: %s — skip reuse without touching it',
        async (moved) => {
            settings.TRICKPLAY_STORAGE_LOCATION = 'alongside';
            await publish();
            const { createHash } = await import('node:crypto');
            const key = (name: string): string =>
                createHash('sha1').update(name).digest('hex').slice(0, 16);
            const sidecar = join(root, '.trickplay', key('old.mp4'));
            await writeFile(join(sidecar, 'notes.txt'), 'user file');
            if (moved) await rename(sidecar, join(root, '.trickplay', key('renamed.mp4')));
            await reconnect();
            expect(await restoreReclaimedTrickplay(sql, itemId, 1)).toBe(false);
            expect(await status()).toBe('pending');
            expect(await snapshot()).toBeNull();
            expect(
                await readFile(
                    join(root, '.trickplay', key(moved ? 'renamed.mp4' : 'old.mp4'), 'notes.txt'),
                    'utf8',
                ),
            ).toBe('user file');
        },
    );
    it('regenerates an orphaned alongside sidecar for different bytes re-added under the same name', async () => {
        settings.TRICKPLAY_STORAGE_LOCATION = 'alongside';
        await publish();
        // The old row disappears, but the basename-addressed sidecar survives.
        await deleteStaleMediaFile(sql, oldPath);
        await appendFile(oldPath, Buffer.from('replacement bytes'));
        const replacement = await upsertMediaFile(sql, {
            filePath: oldPath,
            fileHashHead: await hashFileHead(oldPath),
        });
        expect(replacement.id).not.toBe(oldId);
        await attachFileToItem(sql, replacement.id, itemId);
        await videoStream(replacement.id);
        await undismissMediaItem(sql, itemId);

        const result = await generator.generateTrickplayForMediaItem(sql, itemId);

        expect(result.skipped).toBe(0);
        expect(result.generated).toBeGreaterThan(0);
        expect(ffmpegRuns).toHaveBeenCalled();
    });

    it('skips complete alongside output when its source fingerprint still matches', async () => {
        settings.TRICKPLAY_STORAGE_LOCATION = 'alongside';
        await publish();
        const result = await generator.generateTrickplayForMediaItem(sql, itemId);
        expect(result.skipped).toBe(1);
        expect(result.generated).toBe(0);
        expect(ffmpegRuns).not.toHaveBeenCalled();
    });

    it('regenerates alongside output without a source fingerprint', async () => {
        settings.TRICKPLAY_STORAGE_LOCATION = 'alongside';
        delete manifest.reuse;
        await publish();
        const result = await generator.generateTrickplayForMediaItem(sql, itemId);
        expect(result.skipped).toBe(0);
        expect(result.generated).toBeGreaterThan(0);
    });

    it('central reuse works on a read-only media share', async () => {
        await publish();
        await reconnect();
        await chmod(root, 0o555);
        try {
            await runTask();
        } finally {
            await chmod(root, 0o755);
        }
        expect(ffmpegRuns).not.toHaveBeenCalled();
        expect(await status()).toBe('completed');
    });
    it.each(['quality', 'width', 'interval', 'tileWidth', 'tileHeight'])(
        'changed %s stays pending then generates in the task',
        async (field) => {
            await publish();
            if (field === 'quality') settings.TRICKPLAY_QUALITY = 50;
            if (field === 'width') settings.TRICKPLAY_WIDTH = 480;
            if (field === 'interval') settings.TRICKPLAY_INTERVAL_MS = 5000;
            if (field === 'tileWidth') settings.TRICKPLAY_TILE_WIDTH = 5;
            if (field === 'tileHeight') settings.TRICKPLAY_TILE_HEIGHT = 5;
            await reconnect();
            await runTask();
            expect(ffmpegRuns).toHaveBeenCalled();
            expect(await status()).toBe('completed');
            expect(await snapshot()).toBeNull();
        },
    );
    it.each([{ width: 480 }, { intervalMs: 5000 }, { quality: 50 }])(
        'explicit settings override %j refuses reuse and generates from pending',
        async (override) => {
            await publish();
            await reconnect();
            expect(await status()).toBe('pending');
            await runTask(override);
            expect(ffmpegRuns).toHaveBeenCalled();
            expect(await status()).toBe('completed');
            expect(await snapshot()).toBeNull();
        },
    );
    it('derives params source from the provider id instead of a legacy manifest label', async () => {
        Object.assign(manifest.reuse!, { source: 'obsolete-provider-label' });
        await publish();
        await reconnect();
        await runTask();
        expect(ffmpegRuns).not.toHaveBeenCalled();
        expect(await getTrickplayParams(sql, itemId, newId)).toMatchObject([{ source: 'local' }]);
    });
    it.each([
        'failed',
        'cancelled',
        'missing-sheet',
        'legacy',
        'different-content',
        'different-kind',
        'imported',
    ])('rejects %s proof and expires snapshot', async (mode) => {
        if (['legacy', 'cancelled', 'imported'].includes(mode)) delete manifest.reuse;
        await publish();
        if (mode === 'failed')
            await sql`UPDATE media_item_stage_state SET status = 'failed_transient' WHERE media_item_id = ${itemId}`;
        if (mode === 'missing-sheet')
            await rm(join(settings.TRICKPLAY_STORAGE_PATH, oldId, '320', '0.webp'));
        if (mode === 'different-content') {
            const bytes = await readFile(oldPath);
            bytes[bytes.length - 1] ^= 1;
            await writeFile(oldPath, bytes);
            await sql`UPDATE media_files SET file_hash_head = ${await hashFileHead(oldPath)} WHERE id = ${oldId}`;
        }
        await reconnect(mode === 'different-kind' ? 'episode' : 'movie');
        expect(await restoreReclaimedTrickplay(sql, itemId, 1)).toBe(false);
        expect(await status()).toBe('pending');
        expect(await snapshot()).toBeNull();
    });
    it.each(['disabled', 'ineligible', 'no-video', 'completed', 'completed-running'])(
        'does no reuse filesystem work for %s classification',
        async (classification) => {
            await publish();
            await reconnect();
            if (classification === 'disabled') settings.TRICKPLAY_ENABLED = false;
            if (classification === 'ineligible')
                await sql`UPDATE media_item_stage_state SET status = 'skipped_permanent', skipped_reason = 'ineligible' WHERE media_item_id = ${itemId}`;
            if (classification === 'no-video')
                await sql`DELETE FROM media_streams WHERE file_id = ${newId}`;
            if (classification.startsWith('completed')) {
                const previousSnapshot = await snapshot();
                expect(await restoreReclaimedTrickplay(sql, itemId, 1)).toBe(true);
                // Simulate a locator left over by an older worker after this
                // CURRENT file was fully covered, including its params.
                await sql`UPDATE media_items SET processing_state = processing_state || ${sql.json({ 'trickplay-reclaim': previousSnapshot } as never)} WHERE id = ${itemId}`;
            }
            if (classification === 'completed-running')
                await stageQueries.upsertRunningRow(sql, {
                    mediaItemId: itemId,
                    stageId: 'trickplay-generation',
                    processingVersion: 1,
                    runId: 'duplicate-run',
                });
            const sample = vi.spyOn(containedFs, 'createNoFollowReadStream');
            const statFile = vi.spyOn(safeFs, 'safeStat');
            expect(await restoreReclaimedTrickplay(sql, itemId, 1)).toBe(false);
            expect(sample).not.toHaveBeenCalled();
            expect(statFile).not.toHaveBeenCalled();
            if (['disabled', 'ineligible', 'completed'].includes(classification))
                expect(await snapshot()).toBeNull();
        },
    );
    it.each(['expired', 'undated'])('expires %s snapshots before touching files', async (age) => {
        await publish();
        await reconnect();
        if (age === 'expired')
            await sql`UPDATE media_items SET processing_state = jsonb_set(processing_state, '{trickplay-reclaim,capturedAtMs}', to_jsonb(${Date.now() - 8 * 86400000}::bigint)) WHERE id = ${itemId}`;
        else
            await sql`UPDATE media_items SET processing_state = processing_state #- '{trickplay-reclaim,capturedAtMs}' WHERE id = ${itemId}`;
        const sample = vi.spyOn(containedFs, 'createNoFollowReadStream');
        expect(await restoreReclaimedTrickplay(sql, itemId, 1)).toBe(false);
        expect(sample).not.toHaveBeenCalled();
        expect(await snapshot()).toBeNull();
    });
    it('publication permits concurrent FK child inserts while holding the item lock', async () => {
        const connection = postgres(getTestDatabaseUrl(), { max: 1 });
        let release!: () => void;
        let locked!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        const ready = new Promise<void>((resolve) => {
            locked = resolve;
        });
        const publication = sql.begin(async (tx) => {
            await rematchQueries.lockTrickplayReclaimItem(tx as unknown as postgres.Sql, itemId);
            locked();
            await held;
        });
        try {
            await ready;
            await connection.begin(async (tx) => {
                await tx`SET LOCAL lock_timeout = '250ms'`;
                await tx`INSERT INTO media_item_stage_state (media_item_id,stage_id,status,processing_version) VALUES (${itemId},'fk-child-probe','pending',1)`;
            });
        } finally {
            release();
            await publication;
            await connection.end();
        }
    });
    it('retries deadlocked publication without repeating filesystem work', async () => {
        await publish();
        await reconnect();
        const completed = vi
            .spyOn(stageQueries, 'upsertCompletedRow')
            .mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: '40P01' }))
            .mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: '40P01' }));
        const samples = vi.spyOn(containedFs, 'createNoFollowReadStream');
        expect(await restoreReclaimedTrickplay(sql, itemId, 1)).toBe(true);
        expect(completed).toHaveBeenCalledTimes(3);
        expect(samples).toHaveBeenCalledTimes(3);
        expect(await snapshot()).toBeNull();
        expect(await status()).toBe('completed');
        expect(await getTrickplayParams(sql, itemId, newId)).toHaveLength(1);
    });
    it.each(['40P01', '23503'])('bounds completion retries for SQLSTATE %s', async (code) => {
        await publish();
        await reconnect();
        const completed = vi
            .spyOn(stageQueries, 'upsertCompletedRow')
            .mockRejectedValue(Object.assign(new Error('SQL failure'), { code }));
        await expect(completeTrickplayGeneration(sql, itemId, 1)).rejects.toMatchObject({ code });
        expect(completed).toHaveBeenCalledTimes(code === '40P01' ? 3 : 1);
        expect(await status()).toBe('pending');
        expect(await snapshot()).toBeNull();
    });
    it('completion retries a deadlock then atomically retires its snapshot', async () => {
        await publish();
        await reconnect();
        const completed = vi
            .spyOn(stageQueries, 'upsertCompletedRow')
            .mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: '40P01' }));
        await completeTrickplayGeneration(sql, itemId, 1);
        expect(completed).toHaveBeenCalledTimes(2);
        expect(await status()).toBe('completed');
        expect(await snapshot()).toBeNull();
    });
    it('a duplicate at another item never borrows or removes the original output', async () => {
        await publish();
        const originalItem = itemId;
        const [other] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title,media_type) VALUES ('Duplicate','movie') RETURNING id`;
        await copyFile(oldPath, newPath);
        newId = (
            await upsertMediaFile(sql, {
                filePath: newPath,
                fileHashHead: await hashFileHead(newPath),
            })
        ).id;
        await attachFileToItem(sql, newId, other.id);
        await videoStream(newId);
        await svc.seedRowsForCreate(other.id);
        itemId = other.id;
        await runTask();
        expect(ffmpegRuns).toHaveBeenCalled();
        expect(await status()).toBe('completed');
        expect((await getSpriteSheet(oldId, 320, 0, oldPath))?.toString()).toBe('sprite');
        expect(await getTrickplayParams(sql, originalItem, oldId)).toEqual([]);
    });
    it('retires the snapshot using the same transaction as params and completion', async () => {
        await publish();
        await reconnect();
        const completed = vi.spyOn(stageQueries, 'upsertCompletedRow');
        const cleared = vi.spyOn(rematchQueries, 'clearTrickplayReclaimSnapshot');
        expect(await restoreReclaimedTrickplay(sql, itemId, 1)).toBe(true);
        expect(completed).toHaveBeenCalledOnce();
        expect(cleared).toHaveBeenCalledOnce();
        expect(cleared.mock.calls[0]![0]).toBe(completed.mock.calls[0]![0]);
        expect(cleared.mock.calls[0]![0]).not.toBe(sql);
        expect(await snapshot()).toBeNull();
        expect(await status()).toBe('completed');
    });
    it('rolls back params on a completion failure and expires the snapshot', async () => {
        await publish();
        await reconnect();
        vi.spyOn(stageQueries, 'upsertCompletedRow').mockRejectedValueOnce(
            new Error('publication failed'),
        );
        await expect(restoreReclaimedTrickplay(sql, itemId, 1)).rejects.toThrow(
            'publication failed',
        );
        expect(await getTrickplayParams(sql, itemId, newId)).toEqual([]);
        expect(await status()).toBe('pending');
        expect(await snapshot()).toBeNull();
    });
    it('concurrent publication, dispatcher seed/invalidation and attach surface no deadlock', async () => {
        await publish();
        await reconnect();
        // Each worker has its own physical connection. Dispatcher snapshot reads
        // use another connection, as they intentionally happen outside its tx.
        const connections = Array.from({ length: 5 }, () =>
            postgres(getTestDatabaseUrl(), { max: 1 }),
        );
        const [publisherSql, completionSql, attachSql, dispatchSql, snapshotSql] = connections;
        const concurrentStages = new StageStateService(
            snapshotSql,
            registry,
            vi.fn().mockResolvedValue(undefined),
            async () => ({}),
        );
        const seed = vi.spyOn(concurrentStages, 'seedRowsForCreate');
        const invalidate = vi.spyOn(concurrentStages, 'invalidateByEvent');
        const concurrentDispatcher = new PipelineEventDispatcher({
            sql: dispatchSql,
            stageState: concurrentStages,
            isLeader: () => true,
            drainBudgetMs: 30000,
            drainConcurrency: 1,
        });
        try {
            const results = await Promise.allSettled([
                (async () => {
                    await restoreReclaimedTrickplay(publisherSql, itemId, 1);
                    for (let i = 0; i < 12; i++)
                        await completeTrickplayGeneration(publisherSql, itemId, 1);
                })(),
                (async () => {
                    for (let i = 0; i < 12; i++)
                        await completeTrickplayGeneration(completionSql, itemId, 1);
                })(),
                (async () => {
                    for (let i = 0; i < 12; i++) await attachFileToItem(attachSql, newId, itemId);
                })(),
                (async () => {
                    for (let i = 0; i < 12; i++) {
                        await dispatchSql`INSERT INTO event_outbox (event_name,media_item_id,payload) VALUES ('item.reclaimed',${itemId},'{}'), ('file.probed',${itemId},'{}')`;
                        expect((await concurrentDispatcher.tick()).deadLettered).toBe(0);
                    }
                })(),
            ]);
            expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
            expect(seed).toHaveBeenCalled();
            expect(invalidate).toHaveBeenCalled();
            const failures =
                await sql`SELECT last_error FROM event_outbox WHERE media_item_id = ${itemId} AND attempts > 0`;
            expect(failures).toEqual([]);
            await completeTrickplayGeneration(publisherSql, itemId, 1);
            expect(await status()).toBe('completed');
            expect(await snapshot()).toBeNull();
        } finally {
            concurrentDispatcher.stop();
            await Promise.all(connections.map((connection) => connection.end()));
        }
    });
    it('batch renames hold no filesystem work inside dispatcher transactions', async () => {
        await publish();
        await reconnect();
        const state = await snapshot();
        const batch: string[] = [];
        for (let i = 0; i < 20; i++) {
            const [item] = await sql<
                { id: string }[]
            >`INSERT INTO media_items (title,media_type,processing_state) VALUES (${`Rename ${i}`},'movie',${sql.json({ 'trickplay-reclaim': state } as never)}) RETURNING id`;
            const old = join(root, `old-${i}.mp4`),
                current = join(root, `renamed-${i}.mp4`);
            await copyFile(newPath, old);
            await rename(old, current);
            const file = await upsertMediaFile(sql, {
                filePath: current,
                fileHashHead: await hashFileHead(current),
            });
            await attachFileToItem(sql, file.id, item.id);
            await videoStream(file.id);
            await sql`INSERT INTO event_outbox (event_name,media_item_id,payload) VALUES ('item.reclaimed',${item.id},'{}')`;
            batch.push(item.id);
        }
        const stats = vi.spyOn(safeFs, 'safeStat');
        const reads = vi.spyOn(containedFs, 'readContainedFile');
        const samples = vi.spyOn(containedFs, 'createNoFollowReadStream');
        await drain();
        expect(stats).not.toHaveBeenCalled();
        expect(reads).not.toHaveBeenCalled();
        expect(samples).not.toHaveBeenCalled();
        const rows =
            await sql`SELECT status FROM media_item_stage_state WHERE media_item_id = ANY(${batch}::uuid[]) AND stage_id = 'trickplay-generation'`;
        expect(rows).toHaveLength(20);
        expect(rows.every((row) => row.status === 'pending')).toBe(true);
        expect(await status()).toBe('pending');
        expect(await snapshot()).not.toBeNull();
    });
});
