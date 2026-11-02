// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the `stage-sweep` task.
 *
 * Exercises the end-to-end behaviour against a real Postgres `lumastra_tests`
 * database and a mocked orchestrator. The sweeper logic:
 *
 *   1. Walks all registered tasks with `coversStages`.
 *   2. For each stage with `enqueueable: true`, queries the coverage table
 *      for sweepable rows.
 *   3. Calls `orchestrator.startRun(task.id, { mediaItemId }, ...)` per row.
 *
 * The orchestrator is mocked via `vi.mock` so we can assert the calls and
 * return synthesized `StartRunResult`s without standing up BullMQ + Valkey.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import { copyFile, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type postgres from 'postgres';
import { getAnalyzerInputSnapshot } from '$lib/server/database/queries/media-segment-input.queries.js';
import { recordFailure } from '$lib/server/database/queries/plugin-failure-events.queries.js';
import { StageStateService } from '$lib/server/services/stage-state.service.js';
import { registry } from '../../registry.js';
import { z } from 'zod';
import { defineTask, TaskError, type AnyTaskDefinition } from '@sapd/lumastra-plugin-sdk';
import { runTask, mockContext } from '@sapd/lumastra-plugin-sdk-testing';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';

// Mock the orchestrator BEFORE importing the sweeper so the import binds to
// the mock. The sweeper imports `{ orchestrator }` from `../../orchestrator.js`
// at module-eval time; that import resolves to the mock factory below.
const startRunMock = vi.fn();
const getQueueDepthsMock = vi.fn();
vi.mock('../../orchestrator.js', () => ({
    orchestrator: {
        startRun: (...args: unknown[]) => startRunMock(...args),
        getQueueDepths: (...args: unknown[]) => getQueueDepthsMock(...args),
    },
}));

// Mock the registry singleton so the sweeper sees the test registry instead
// of whatever the boot loader populated. We swap `getAllTasks` to return the
// per-test array.
//
// The self-heal phase in stage-sweep (bug C fix) also calls registry.getTask()
// and registry.findTaskByStage() via StageStateService, so the mock exposes
// those too — both delegate to the per-test testTasks array.
let testTasks: AnyTaskDefinition[] = [];
vi.mock('../../registry.js', () => ({
    registry: {
        registerTask: () => undefined,
        getAllTasks: () => testTasks,
        getTask: (id: string) => testTasks.find((t) => t.id === id),
        findTaskByStage: (stageId: string) =>
            testTasks.find((t) => (t.coversStages ?? []).some((s) => s.id === stageId)),
    },
}));

// Now import the sweeper. Top-level `registry.registerTask(stageSweepTask)`
// is a no-op because the registry mock above stubs it.
const { stageSweepTask, resetPerStageHealQuiet } = await import('./stage-sweep.js');
const { integrityScannerTask } = await import('./integrity-scanner.js');
const {
    lumastraIntroAnalyzerTask,
    ANALYZER_VISUAL_STAGE_ID,
    ANALYZER_ACOUSTIC_STAGE_ID,
    VISUAL_PROCESSING_VERSION,
    getUnanalyzedMovies,
    markAnalyzed,
} = await import('./lumastra-intro-analyzer.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function insertMediaItem(sql: postgres.Sql, title: string): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, is_dismissed)
        VALUES (${id}::uuid, ${title}, 'movie', 'active', false)
    `;
    return id;
}

async function insertPendingRow(
    sql: postgres.Sql,
    mediaItemId: string,
    stageId: string,
): Promise<void> {
    await sql`
        INSERT INTO media_item_stage_state
            (media_item_id, stage_id, processing_version, status, attempt, updated_at)
        VALUES (${mediaItemId}::uuid, ${stageId}, 1, 'pending', 0, now())
        ON CONFLICT (media_item_id, stage_id) DO NOTHING
    `;
}

function mkCoveringTask(
    id: string,
    stageId: string,
    opts: {
        enqueueable?: boolean;
        perItem?: boolean;
        /** Further stages the same task covers (media-probe covers a + b). */
        extraStageIds?: string[];
        resourceClass?: 'io' | 'analysis' | 'ingest' | 'bulk' | 'cpu' | 'embedding' | 'maintenance';
    } = {},
): AnyTaskDefinition {
    return defineTask({
        id,
        name: id,
        version: '1.0.0',
        processingVersion: 1,
        minAppVersion: '1.0.0',
        capabilities: {},
        resourceClass: opts.resourceClass ?? 'io',
        inputSchema: z.object({ mediaItemId: z.string().optional() }).passthrough(),
        // perItem === true → identity varies by mediaItemId (per-item task);
        // otherwise → constant 'global' (global-identity task).
        identityFor: opts.perItem
            ? (input: unknown) => (input as { mediaItemId?: string }).mediaItemId ?? 'global'
            : () => 'global',
        manualOnly: true,
        coversStages: [stageId, ...(opts.extraStageIds ?? [])].map((id) => ({
            id,
            appliesTo: ['movie'] as const,
            enqueueable: opts.enqueueable,
            // Declarative Stage Contract is fail-closed: an enqueueable stage
            // must declare a disposition. This fixture's execute() always
            // returns success (terminal), so self-terminal is accurate.
            ...(opts.enqueueable
                ? {
                      terminalDisposition: {
                          kind: 'self-terminal' as const,
                          ruleId: `${id}-self-terminal`,
                      },
                  }
                : {}),
        })),
        async execute() {
            return { success: true };
        },
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('stage-sweep task (integration)', () => {
    let sql: postgres.Sql;
    const fixtureFileIds = new Set<string>();
    const fixtureDirectories = new Set<string>();
    let savedSettings: Array<{ key: string; value: unknown }> = [];
    async function seedMovie(
        label: string,
        status: string,
        reason: string | null = null,
    ): Promise<string> {
        const id = await insertMediaItem(sql, `sweep-task-test-movie-${label}`);
        const fileId = crypto.randomUUID();
        fixtureFileIds.add(fileId);
        await sql`INSERT INTO media_files (id, file_path, duration_seconds, is_missing)
                VALUES (${fileId}::uuid, ${`/fixtures/sweep-task-test-${id}.mkv`}, 7200, false)`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${fileId}::uuid, ${id}::uuid, true)`;
        await sql`INSERT INTO media_streams (file_id, stream_type, stream_index)
                VALUES (${fileId}::uuid, 'video', 0)`;
        await sql`INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, skipped_reason, completed_at)
                VALUES (${id}::uuid, ${ANALYZER_VISUAL_STAGE_ID}, ${VISUAL_PROCESSING_VERSION}, ${status}, ${reason},
                    CASE WHEN ${status} = 'completed' THEN now() ELSE NULL END)`;
        if (status === 'completed') {
            const input = (await getAnalyzerInputSnapshot(sql, id))!;
            await markAnalyzed(
                sql,
                [id],
                ANALYZER_VISUAL_STAGE_ID,
                VISUAL_PROCESSING_VERSION,
                new Map([[id, input]]),
            );
        }
        if (reason?.startsWith('poison-') || status === 'skipped_transient') {
            const input = (await getAnalyzerInputSnapshot(sql, id))!;
            await recordFailure(
                sql,
                lumastraIntroAnalyzerTask.id,
                id,
                reason,
                'current-sweep-fixture',
                status === 'skipped_transient' ? null : ANALYZER_VISUAL_STAGE_ID,
                {
                    ...input,
                    analysisStageId: ANALYZER_VISUAL_STAGE_ID,
                    processingVersion: VISUAL_PROCESSING_VERSION,
                },
            );
        }
        return id;
    }

    async function seedChapterAlternate(
        mediaId: string,
    ): Promise<{ fileId: string; filePath: string }> {
        await sql`UPDATE media_files SET is_missing = true WHERE id IN (
            SELECT file_id FROM media_file_items WHERE media_item_id = ${mediaId}::uuid)`;
        const fileId = crypto.randomUUID();
        fixtureFileIds.add(fileId);
        const directory = await mkdtemp(join(tmpdir(), 'sweep-task-test-'));
        fixtureDirectories.add(directory);
        const filePath = join(directory, 'alternate.mp4');
        await copyFile(
            new URL('../../../../../../tests/fixtures/test-video.mp4', import.meta.url),
            filePath,
        );
        const identity = await stat(filePath);
        // Use actual media bytes and their identity. Cached chapters/runtime model
        // an already-probed feature, so this test needs no two-hour media asset.
        await sql`INSERT INTO media_files (id, file_path, duration_seconds, file_mtime,
            file_size_bytes, chapters_probed_mtime, chapters_probed_size)
            VALUES (${fileId}::uuid, ${filePath}, 7200,
                ${identity.mtime}, ${identity.size}, ${identity.mtime}, ${identity.size})`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${fileId}::uuid, ${mediaId}::uuid, false)`;
        await sql`INSERT INTO media_streams (file_id, stream_type, stream_index)
            VALUES (${fileId}::uuid, 'video', 0)`;
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, end_ticks, source)
            VALUES (${fileId}::uuid, 0, 'Opening', 0, 900000000, 'file'),
                   (${fileId}::uuid, 1, 'Feature', 900000000, 72000000000, 'file')`;
        await sql`INSERT INTO plugin_settings (plugin_id, key, value)
            VALUES ('lumastra-intro-analyzer', 'blackframeDetection', 'false'::jsonb)`;
        return { fileId, filePath };
    }

    beforeAll(async () => {
        sql = getTestDb();
        savedSettings = await sql<{ key: string; value: unknown }[]>`
            SELECT key, value FROM plugin_settings WHERE plugin_id = 'lumastra-intro-analyzer'
            AND key IN ('chapterDetection', 'blackframeDetection', 'chromaprintDetection')`;
    });

    afterEach(async () => {
        for (const directory of fixtureDirectories) {
            await rm(directory, { recursive: true, force: true });
        }
        fixtureDirectories.clear();
        // Include older fixtures that insert a linked file directly, as well
        // as the tracked IDs needed for missing/unlinked movie input cases.
        const linkedFiles = await sql<{ file_id: string }[]>`
            SELECT mfi.file_id FROM media_file_items mfi
            JOIN media_items mi ON mi.id = mfi.media_item_id
            WHERE mi.title LIKE 'sweep-task-test-%'`;
        for (const row of linkedFiles) fixtureFileIds.add(row.file_id);
        await sql`DELETE FROM plugin_failure_events WHERE item_id IN (
            SELECT id::text FROM media_items WHERE title LIKE 'sweep-task-test-%')`;
        await sql`DELETE FROM media_items WHERE title LIKE 'sweep-task-test-%'`;
        if (fixtureFileIds.size > 0) {
            await sql`DELETE FROM media_files WHERE id = ANY(${[...fixtureFileIds]}::uuid[])`;
            fixtureFileIds.clear();
        }
        await sql`DELETE FROM plugin_settings WHERE plugin_id = 'lumastra-intro-analyzer'
            AND key IN ('chapterDetection', 'blackframeDetection', 'chromaprintDetection')`;
    });

    afterAll(async () => {
        expect(
            await sql`SELECT id FROM media_files WHERE file_path LIKE '/fixtures/sweep-task-test-%'
            OR file_path LIKE '/fixtures/elig-sweep-task-test-%'`,
        ).toHaveLength(0);
        for (const row of savedSettings) {
            await sql`INSERT INTO plugin_settings (plugin_id, key, value)
                VALUES ('lumastra-intro-analyzer', ${row.key}, ${sql.json(row.value as never)})`;
        }
        await closeTestDb();
    });

    beforeEach(async () => {
        // Clear test fixtures from prior tests in this file.
        await sql`DELETE FROM media_items WHERE title LIKE 'sweep-task-test-%'`;
        // The self-heal phase scans ALL movie items in the test DB (the
        // registered test tasks declare appliesTo: ['movie']) and seeds
        // coverage rows for any missing them, so a movie left behind by
        // another test file becomes an extra candidate and every count in
        // this file goes up by one.
        //
        // This used to delete only movies with NO coverage row at all, which
        // was sufficient until the PER-STAGE coverage backfill landed: that
        // phase seeds a row for any item missing THIS stage specifically, and
        // every test here registers a brand-new stage id, so EVERY
        // pre-existing movie is missing it — coverage rows or not. A movie
        // from another file therefore gets seeded and enqueued, and the
        // failure lands here as an off-by-one on a global count.
        //
        // So: remove every movie that is not this file's own fixture. Scoped
        // to `movie` because that is what the test tasks apply to; other
        // files' non-movie data is untouched. Integration files run serially,
        // so nothing else is mid-test while this runs. Tests that exercise
        // self-heal insert their own orphans AFTER this cleanup.
        await sql`
            DELETE FROM media_items
             WHERE media_type = 'movie'
               AND title NOT LIKE 'sweep-task-test-%'
        `;
        await sql`DELETE FROM media_files WHERE file_path LIKE '/fixtures/sweep-task-test-%'
            OR file_path LIKE '/fixtures/elig-sweep-task-test-%'`;
        await sql`DELETE FROM plugin_settings WHERE plugin_id = 'lumastra-intro-analyzer'
            AND key IN ('chapterDetection', 'blackframeDetection', 'chromaprintDetection')`;
        startRunMock.mockReset();
        startRunMock.mockResolvedValue({ runId: 'run_test', deduped: false });
        // Default: no backpressure (empty depth map → proceed normally).
        getQueueDepthsMock.mockReset();
        getQueueDepthsMock.mockResolvedValue({});
        testTasks = [];
        resetPerStageHealQuiet();
    });

    it('exposes the canonical task surface', () => {
        expect(stageSweepTask.id).toBe('stage-sweep');
        expect(stageSweepTask.resourceClass).toBe('maintenance');
        expect(stageSweepTask.schedule?.every).toBe('60s');
        // Sweeper itself is global — no per-item coverage.
        expect(stageSweepTask.coversStages).toBeUndefined();
    });

    it('enqueues one run per candidate for enqueueable stages (per-item task)', async () => {
        const stageId = `sweep-task-test-stage-${Date.now()}-a`;
        const task = mkCoveringTask('t-enqueueable', stageId, {
            enqueueable: true,
            perItem: true,
        });
        testTasks = [task];

        const item1 = await insertMediaItem(sql, 'sweep-task-test-1');
        const item2 = await insertMediaItem(sql, 'sweep-task-test-2');
        const item3 = await insertMediaItem(sql, 'sweep-task-test-3');
        await insertPendingRow(sql, item1, stageId);
        await insertPendingRow(sql, item2, stageId);
        await insertPendingRow(sql, item3, stageId);

        const result = await runTask(stageSweepTask, {}, { sql });

        expect(result.success).toBe(true);
        expect(startRunMock).toHaveBeenCalledTimes(3);

        const enqueuedIds = startRunMock.mock.calls
            .map((c) => (c[1] as { mediaItemId: string }).mediaItemId)
            .sort();
        expect(enqueuedIds).toEqual([item1, item2, item3].sort());

        // Verify trigger metadata is set correctly.
        const firstCall = startRunMock.mock.calls[0];
        expect(firstCall[0]).toBe('t-enqueueable');
        const opts = firstCall[2] as {
            trigger?: { kind: string; sourceRoute?: string };
            idempotencyKey?: string;
        };
        expect(opts.trigger?.sourceRoute).toBe('stage-sweep');
        // Aligned with eager-enqueue: `coverage:<stageId>:<mediaItemId>`
        expect(opts.idempotencyKey).toMatch(/^coverage:/);
        const enqueuedKeys = startRunMock.mock.calls
            .map((c) => (c[2] as { idempotencyKey?: string }).idempotencyKey)
            .sort();
        expect(enqueuedKeys).toEqual(
            [
                `coverage:${stageId}:${item1}`,
                `coverage:${stageId}:${item2}`,
                `coverage:${stageId}:${item3}`,
            ].sort(),
        );

        const summary = result.result as {
            enqueued: number;
            candidatesFound: number;
        };
        expect(summary.enqueued).toBe(3);
        expect(summary.candidatesFound).toBe(3);
    });

    it('collapses to ONE enqueue for global-identity tasks regardless of candidate count', async () => {
        const stageId = `sweep-task-test-stage-${Date.now()}-global`;
        // perItem omitted → identityFor returns constant 'global'
        const task = mkCoveringTask('t-global', stageId, { enqueueable: true });
        testTasks = [task];

        const item1 = await insertMediaItem(sql, 'sweep-task-test-g1');
        const item2 = await insertMediaItem(sql, 'sweep-task-test-g2');
        const item3 = await insertMediaItem(sql, 'sweep-task-test-g3');
        await insertPendingRow(sql, item1, stageId);
        await insertPendingRow(sql, item2, stageId);
        await insertPendingRow(sql, item3, stageId);

        const result = await runTask(stageSweepTask, {}, { sql });

        // Despite 3 candidates, the sweeper must enqueue exactly ONCE.
        expect(startRunMock).toHaveBeenCalledTimes(1);

        const [taskId, input, opts] = startRunMock.mock.calls[0] as [
            string,
            Record<string, unknown>,
            { trigger?: { sourceRoute?: string }; idempotencyKey?: string },
        ];
        expect(taskId).toBe('t-global');
        // The single sweep enqueue should NOT carry a mediaItemId — the task's
        // own backlog scan drains the whole library.
        expect(input).toEqual({});
        expect(opts.trigger?.sourceRoute).toBe('stage-sweep');
        expect(opts.idempotencyKey).toBe(`coverage:${stageId}:global`);

        const summary = result.result as {
            enqueued: number;
            candidatesFound: number;
        };
        expect(summary.enqueued).toBe(1);
        expect(summary.candidatesFound).toBe(3);
        expect(result.success).toBe(true);
    });

    it('enqueues a global-identity task ONCE per tick even when it covers several stages with candidates', async () => {
        // media-probe covers media-probe-a and -b. One run drains both phases, so a
        // second enqueue (different idempotency key, same task) only spawned a
        // concurrent run that re-probed the same new file.
        const stageA = `sweep-task-test-stage-${Date.now()}-multi-a`;
        const stageB = `sweep-task-test-stage-${Date.now()}-multi-b`;
        const task = mkCoveringTask('t-global-multi', stageA, {
            enqueueable: true,
            extraStageIds: [stageB],
        });
        testTasks = [task];

        const item = await insertMediaItem(sql, 'sweep-task-test-multi');
        await insertPendingRow(sql, item, stageA);
        await insertPendingRow(sql, item, stageB);

        const result = await runTask(stageSweepTask, {}, { sql });

        expect(startRunMock).toHaveBeenCalledTimes(1);
        const summary = result.result as { enqueued: number };
        expect(summary.enqueued).toBe(1);
    });

    it('skips stages without enqueueable: true', async () => {
        const optedIn = `sweep-task-test-stage-${Date.now()}-in`;
        const optedOut = `sweep-task-test-stage-${Date.now()}-out`;
        const taskIn = mkCoveringTask('t-in', optedIn, {
            enqueueable: true,
            perItem: true,
        });
        const taskOut = mkCoveringTask('t-out', optedOut, {
            enqueueable: false,
            perItem: true,
        });
        testTasks = [taskIn, taskOut];

        const itemIn = await insertMediaItem(sql, 'sweep-task-test-stage-in');
        const itemOut = await insertMediaItem(sql, 'sweep-task-test-stage-out');
        await insertPendingRow(sql, itemIn, optedIn);
        await insertPendingRow(sql, itemOut, optedOut);

        await runTask(stageSweepTask, {}, { sql });

        const dispatched = startRunMock.mock.calls.map((c) => ({
            taskId: c[0] as string,
            mediaItemId: (c[1] as { mediaItemId?: string }).mediaItemId,
        }));

        // The actual contract of this test: a non-enqueueable stage is NEVER
        // dispatched, whoever seeded its row.
        expect(dispatched.some((d) => d.taskId === 't-out')).toBe(false);
        expect(dispatched).toContainEqual({ taskId: 't-in', mediaItemId: itemIn });

        // itemOut is dispatched for t-in too, and that is correct: it had no row
        // on the enqueueable stage at all, the per-stage coverage backfill seeds
        // one, and a seeded pending row is exactly what the sweep exists to
        // drain. A bare `toHaveBeenCalledTimes(1)` here predated that backfill
        // and would now fail for the right behaviour.
        expect(dispatched).toContainEqual({ taskId: 't-in', mediaItemId: itemOut });

        // 🔴 The regression guard that count WAS silently providing: the same
        // (task, item) pair must never be dispatched twice in one tick. Seeding
        // used to eager-enqueue the row it had just created while the sweep's
        // own pass, moments later in the same tick, enqueued it again — two runs
        // with an identical idempotency key.
        const pairs = dispatched.map((d) => `${d.taskId}:${d.mediaItemId}`);
        expect(pairs).toHaveLength(new Set(pairs).size);
    });

    it('per-stage backfill: a stage that scanned clean is not re-scanned until its quiet window ends', async () => {
        const stageId = `sweep-task-test-stage-${Date.now()}-quiet`;
        testTasks = [mkCoveringTask('t-quiet', stageId, { enqueueable: false })];

        const covered = await insertMediaItem(sql, 'sweep-task-test-quiet-covered');
        await insertPendingRow(sql, covered, stageId);
        await runTask(stageSweepTask, {}, { sql }); // scans clean -> quiet

        // A later item holding SOME row (so the any-row self-heal skips it) but
        // not this stage's row: exactly the gap the per-stage backfill repairs.
        const late = await insertMediaItem(sql, 'sweep-task-test-quiet-late');
        await insertPendingRow(sql, late, `${stageId}-other`);
        const hasRow = async (): Promise<boolean> => {
            const rows = await sql`
                SELECT 1 FROM media_item_stage_state
                WHERE media_item_id = ${late}::uuid AND stage_id = ${stageId}`;
            return rows.length > 0;
        };

        await runTask(stageSweepTask, {}, { sql });
        expect(await hasRow()).toBe(false);

        resetPerStageHealQuiet(); // stands in for the 15-minute window elapsing
        await runTask(stageSweepTask, {}, { sql });
        expect(await hasRow()).toBe(true);
    });

    it('eligibility heal: a stage that re-enrolled nothing is not re-checked until its quiet window ends', async () => {
        const stageId = `sweep-task-test-stage-${Date.now()}-elig`;
        const base = mkCoveringTask('t-elig', stageId, { enqueueable: true, perItem: true });
        testTasks = [
            {
                ...base,
                coversStages: (base.coversStages ?? []).map((st) => ({
                    ...st,
                    eligibility: { sql: (s: postgres.Sql) => s`true` },
                })),
            } as AnyTaskDefinition,
        ];

        await runTask(stageSweepTask, {}, { sql }); // nothing skipped -> quiet

        const item = await insertMediaItem(sql, 'sweep-task-test-elig-item');
        await sql`
            INSERT INTO media_files (file_path) VALUES (${`/fixtures/elig-${stageId}.mkv`})`;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id, is_default)
            SELECT id, ${item}::uuid, true FROM media_files
            WHERE file_path = ${`/fixtures/elig-${stageId}.mkv`}`;
        await sql`
            INSERT INTO media_item_stage_state
                (media_item_id, stage_id, processing_version, status, skipped_reason, updated_at)
            VALUES (${item}::uuid, ${stageId}, 1, 'skipped_permanent', 'ineligible', now())`;
        const status = async (): Promise<string> => {
            const [row] = await sql<{ status: string }[]>`
                SELECT status FROM media_item_stage_state
                WHERE media_item_id = ${item}::uuid AND stage_id = ${stageId}`;
            return row.status;
        };

        await runTask(stageSweepTask, {}, { sql });
        expect(await status()).toBe('skipped_permanent');

        resetPerStageHealQuiet(); // stands in for the 15-minute window elapsing
        await runTask(stageSweepTask, {}, { sql });
        expect(await status()).not.toBe('skipped_permanent');
    });

    it('recovers supported movie visual coverage through the real sweep without changing protected rows', async () => {
        testTasks = [lumastraIntroAnalyzerTask];
        const stageId = ANALYZER_VISUAL_STAGE_ID;
        const pending = await seedMovie('pending', 'pending');
        const recovered = await seedMovie('ineligible', 'skipped_permanent', 'ineligible');
        const completed = await seedMovie('completed', 'completed');
        const operator = await seedMovie('operator', 'skipped_permanent', 'operator-skip');
        const unsupported = await seedMovie(
            'unsupported',
            'skipped_permanent',
            'poison-episode: 5 failures — unsupported video codec',
        );
        const cooling = await seedMovie('cooling', 'skipped_transient', 'analysis-ffmpeg-timeout');
        await sql`UPDATE media_item_stage_state SET next_eligible_at = now() + interval '1 hour'
            WHERE media_item_id = ${cooling}::uuid AND stage_id = ${stageId}`;
        const discovered = await seedMovie('discovered', 'pending');
        await sql`DELETE FROM media_item_stage_state WHERE media_item_id = ${discovered}::uuid`;
        const invalidIds: string[] = [];
        for (const kind of [
            'missing',
            'unprobed',
            'short',
            'unknown-duration',
            'unlinked',
            'split-input',
        ]) {
            const id = await seedMovie(kind, 'skipped_permanent', 'ineligible');
            invalidIds.push(id);
            const [file] = await sql<{ file_id: string }[]>`
                SELECT file_id FROM media_file_items WHERE media_item_id = ${id}::uuid`;
            if (kind === 'missing') {
                await sql`UPDATE media_files SET is_missing = true WHERE id = ${file.file_id}::uuid`;
            } else if (kind === 'unprobed' || kind === 'split-input') {
                await sql`DELETE FROM media_streams WHERE file_id = ${file.file_id}::uuid`;
                if (kind === 'split-input') {
                    // Neither file is usable on its own: the present one has no
                    // video, and the alternate with video is missing.
                    const other = crypto.randomUUID();
                    fixtureFileIds.add(other);
                    await sql`INSERT INTO media_files (id, file_path, duration_seconds, is_missing)
                        VALUES (${other}::uuid, ${`/fixtures/sweep-task-test-${other}.mkv`}, 7200, true)`;
                    await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
                        VALUES (${other}::uuid, ${id}::uuid, false)`;
                    await sql`INSERT INTO media_streams (file_id, stream_type, stream_index)
                        VALUES (${other}::uuid, 'video', 0)`;
                }
            } else if (kind === 'unlinked') {
                await sql`DELETE FROM media_file_items WHERE media_item_id = ${id}::uuid`;
            } else {
                await sql`UPDATE media_files SET duration_seconds = ${kind === 'short' ? 60 : null}
                    WHERE id = ${file.file_id}::uuid`;
            }
        }
        const protectedIds = [completed, operator, unsupported, cooling, ...invalidIds];
        await recordFailure(sql, lumastraIntroAnalyzerTask.id, recovered, 'timed out', null);

        const failureIds = [recovered, unsupported];
        const failuresBefore = await sql`SELECT * FROM plugin_failure_events
            WHERE item_id = ANY(${failureIds}::text[]) ORDER BY id`;
        expect(failuresBefore).toHaveLength(2);
        const before = await sql`SELECT * FROM media_item_stage_state
            WHERE media_item_id = ANY(${protectedIds}::uuid[]) ORDER BY media_item_id`;

        const result = await runTask(stageSweepTask, {}, { sql });
        expect(result.success).toBe(true);
        const rows = await sql<{ media_item_id: string; status: string }[]>`
            SELECT media_item_id, status FROM media_item_stage_state
            WHERE media_item_id = ANY(${[pending, recovered, discovered]}::uuid[]) AND stage_id = ${stageId}`;
        expect(rows).toHaveLength(3);
        expect(rows.every((row) => row.status === 'pending')).toBe(true);
        // The analyzer is a global drain: the sweep starts one global run,
        // whose movie backlog must now contain every recovered/new subject.
        const analyzerCalls = startRunMock.mock.calls.filter(
            (call) => call[0] === lumastraIntroAnalyzerTask.id,
        );
        expect(analyzerCalls).toHaveLength(1);
        expect(analyzerCalls[0][1]).toEqual({});
        const drainIds = (
            await getUnanalyzedMovies(sql, stageId, VISUAL_PROCESSING_VERSION, 1000)
        ).map((movie) => movie.mediaId);
        expect(drainIds).toContain(pending);
        expect(drainIds).toContain(recovered);
        expect(drainIds).toContain(discovered);
        for (const id of protectedIds) expect(drainIds).not.toContain(id);
        expect(
            await sql`SELECT * FROM media_item_stage_state
            WHERE media_item_id = ANY(${protectedIds}::uuid[]) ORDER BY media_item_id`,
        ).toEqual(before);
        expect(
            await sql`SELECT * FROM plugin_failure_events
            WHERE item_id = ANY(${failureIds}::text[]) ORDER BY id`,
        ).toEqual(failuresBefore);
        await sql`DELETE FROM plugin_failure_events WHERE item_id = ANY(${failureIds}::text[])`;
        expect(
            await sql`SELECT 1 FROM media_item_stage_state
            WHERE media_item_id = ANY(${[pending, recovered, discovered, ...protectedIds]}::uuid[])
              AND stage_id = ${ANALYZER_ACOUSTIC_STAGE_ID}`,
        ).toHaveLength(0);
    });

    it('re-enters completed historical movies that have no verified current pass', async () => {
        const id = await seedMovie('historical-unverified', 'completed');
        await sql`DELETE FROM media_segment_analysis_passes WHERE media_id=${id}`;
        await recordFailure(
            sql,
            lumastraIntroAnalyzerTask.id,
            id,
            'legacy poison without provenance',
            'historical-run',
            ANALYZER_VISUAL_STAGE_ID,
        );
        expect(
            (
                await getUnanalyzedMovies(
                    sql,
                    ANALYZER_VISUAL_STAGE_ID,
                    VISUAL_PROCESSING_VERSION,
                    1000,
                )
            ).map((row) => row.mediaId),
        ).toContain(id);
        expect(
            (await sql`SELECT resolved_at FROM plugin_failure_events WHERE item_id=${id}`)[0]
                .resolved_at,
        ).toBeNull();
    });

    it('keeps disabled movie visual work terminal until a visual detector is enabled', async () => {
        testTasks = [lumastraIntroAnalyzerTask];
        const id = await seedMovie('disabled', 'pending');
        const unprobed = await seedMovie('disabled-unprobed', 'pending');
        await sql`DELETE FROM media_streams WHERE file_id IN (
            SELECT file_id FROM media_file_items WHERE media_item_id = ${unprobed}::uuid)`;
        const completed = await seedMovie('disabled-completed', 'completed');
        const operator = await seedMovie('disabled-operator', 'skipped_permanent', 'operator-skip');
        const season = crypto.randomUUID();
        const specials = crypto.randomUUID();
        await sql`INSERT INTO media_items (id, title, media_type, season_number)
            VALUES (${season}::uuid, 'sweep-task-test-season', 'season', 1),
                   (${specials}::uuid, 'sweep-task-test-specials', 'season', 0)`;
        const episode = await seedMovie('ordinary-episode', 'pending');
        const special = await seedMovie('special-episode', 'pending');
        await sql`UPDATE media_items SET media_type = 'episode', parent_id = ${season}::uuid,
            runtime_seconds = 7200 WHERE id = ${episode}::uuid`;
        await sql`UPDATE media_items SET media_type = 'episode', parent_id = ${specials}::uuid,
            runtime_seconds = 7200 WHERE id = ${special}::uuid`;
        await sql`INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status, completed_at)
            VALUES (${episode}::uuid, ${ANALYZER_ACOUSTIC_STAGE_ID}, 1, 'completed', now())`;
        const protectedIds = [completed, operator, episode];
        const protectedBefore = await sql`SELECT * FROM media_item_stage_state
            WHERE media_item_id = ANY(${protectedIds}::uuid[]) ORDER BY media_item_id, stage_id`;

        await sql`INSERT INTO plugin_settings (plugin_id, key, value)
            VALUES ('lumastra-intro-analyzer', 'chapterDetection', 'false'::jsonb),
                   ('lumastra-intro-analyzer', 'blackframeDetection', 'false'::jsonb)`;
        await runTask(stageSweepTask, {}, { sql });
        const state = async () =>
            await sql`SELECT * FROM media_item_stage_state
            WHERE media_item_id = ${id}::uuid AND stage_id = ${ANALYZER_VISUAL_STAGE_ID}`;
        const disabled = await state();
        expect(
            await sql`SELECT status, skipped_reason FROM media_item_stage_state
            WHERE media_item_id = ${special}::uuid AND stage_id = ${ANALYZER_VISUAL_STAGE_ID}`,
        ).toMatchObject([{ status: 'skipped_permanent', skipped_reason: 'ineligible' }]);
        expect(
            await sql`SELECT * FROM media_item_stage_state
            WHERE media_item_id = ANY(${protectedIds}::uuid[]) ORDER BY media_item_id, stage_id`,
        ).toEqual(protectedBefore);

        expect(disabled[0]).toMatchObject({
            status: 'skipped_permanent',
            skipped_reason: 'movie-visual-detection-disabled',
        });
        resetPerStageHealQuiet();
        await runTask(stageSweepTask, {}, { sql });
        expect(await state()).toEqual(disabled);
        await sql`UPDATE plugin_settings SET value = 'true'::jsonb
            WHERE plugin_id = 'lumastra-intro-analyzer' AND key = 'chapterDetection'`;
        resetPerStageHealQuiet();
        await runTask(stageSweepTask, {}, { sql });
        expect((await state())[0]?.status).toBe('pending');
        expect(
            await sql`SELECT status, skipped_reason FROM media_item_stage_state
            WHERE media_item_id = ${unprobed}::uuid AND stage_id = ${ANALYZER_VISUAL_STAGE_ID}`,
        ).toMatchObject([{ status: 'skipped_permanent', skipped_reason: 'ineligible' }]);

        expect(
            await sql`SELECT * FROM media_item_stage_state
            WHERE media_item_id = ANY(${protectedIds}::uuid[]) ORDER BY media_item_id, stage_id`,
        ).toEqual(protectedBefore);
    });

    it('disposes detached integrity coverage through the registered sweep and recovers on reattach', async () => {
        testTasks = [integrityScannerTask];
        const service = new StageStateService(sql, registry);
        const series = crypto.randomUUID();
        const season = crypto.randomUUID();
        const episode = crypto.randomUUID();
        const missingEpisode = crypto.randomUUID();
        await sql`INSERT INTO media_items (id, title, media_type, status, parent_id)
            VALUES (${series}::uuid, 'sweep-task-test-integrity-series', 'tv', 'active', NULL),
                (${season}::uuid, 'sweep-task-test-integrity-season', 'season', 'active', ${series}::uuid),
                (${episode}::uuid, 'sweep-task-test-integrity-episode', 'episode', 'active', ${season}::uuid),
                (${missingEpisode}::uuid, 'sweep-task-test-integrity-missing', 'episode', 'active', ${season}::uuid)`;
        const presentFile = crypto.randomUUID();
        const missingFile = crypto.randomUUID();
        fixtureFileIds.add(presentFile);
        fixtureFileIds.add(missingFile);
        await sql`INSERT INTO media_files (id, file_path, is_missing, probed_at)
            VALUES (${presentFile}::uuid, ${`/fixtures/sweep-task-test-${presentFile}.mkv`}, false, now()),
                (${missingFile}::uuid, ${`/fixtures/sweep-task-test-${missingFile}.mkv`}, true, now())`;
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
            VALUES (${presentFile}::uuid, ${episode}::uuid, true),
                (${missingFile}::uuid, ${missingEpisode}::uuid, true)`;
        await service.seedRowsForCreate(episode);
        await service.seedRowsForCreate(missingEpisode);
        const state = async (
            id: string,
        ): Promise<{ status: string; skipped_reason: string | null }[]> =>
            await sql`SELECT status, skipped_reason FROM media_item_stage_state
                WHERE media_item_id = ${id}::uuid AND stage_id = 'integrity-file-present'`;
        expect(await state(episode)).toMatchObject([{ status: 'pending' }]);

        for (let cycle = 0; cycle < 2; cycle++) {
            await sql`DELETE FROM media_file_items WHERE media_item_id = ${episode}::uuid`;
            await service.invalidateByEvent(episode, 'file.detached');
            // Events retain the row; the registered sweep owns eligibility disposal.
            await runTask(stageSweepTask, {}, { sql });
            expect(await state(episode)).toEqual([
                { status: 'skipped_permanent', skipped_reason: 'ineligible' },
            ]);
            expect(startRunMock).not.toHaveBeenCalled();
            await runTask(integrityScannerTask, {}, { sql });
            expect(await state(missingEpisode)).toMatchObject([{ status: 'failed_permanent' }]);
            expect(await state(episode)).toEqual([
                { status: 'skipped_permanent', skipped_reason: 'ineligible' },
            ]);

            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default)
                VALUES (${presentFile}::uuid, ${episode}::uuid, true)`;
            await service.invalidateByEvent(episode, 'file.attached');
            expect(await state(episode)).toMatchObject([{ status: 'pending' }]);
            await runTask(integrityScannerTask, {}, { sql });
            expect(await state(episode)).toMatchObject([{ status: 'completed' }]);
            expect(await state(missingEpisode)).toMatchObject([{ status: 'failed_permanent' }]);
            resetPerStageHealQuiet();
        }
    });

    it('disposes a pending unprobed movie then recovers it on a later stream arrival', async () => {
        testTasks = [lumastraIntroAnalyzerTask];
        const id = await seedMovie('stream-arrival', 'pending');
        const [file] = await sql<{ file_id: string }[]>`SELECT file_id FROM media_file_items
            WHERE media_item_id = ${id}::uuid`;
        // The schema already enforces present path values; do not weaken it
        // just to manufacture an input shape production cannot store.
        await expect(
            sql`UPDATE media_files SET file_path = NULL WHERE id = ${file.file_id}::uuid`,
        ).rejects.toMatchObject({ code: '23502' });
        await sql`DELETE FROM media_streams WHERE file_id = ${file.file_id}::uuid`;
        const deleted = await seedMovie('deleted', 'skipped_permanent', 'ineligible');
        await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${deleted}::uuid`;
        await runTask(stageSweepTask, {}, { sql });
        expect(
            await sql`SELECT status, skipped_reason FROM media_item_stage_state
            WHERE media_item_id = ${id}::uuid AND stage_id = ${ANALYZER_VISUAL_STAGE_ID}`,
        ).toMatchObject([{ status: 'skipped_permanent', skipped_reason: 'ineligible' }]);
        await sql`INSERT INTO media_streams (file_id, stream_type, stream_index)
            VALUES (${file.file_id}::uuid, 'video', 0)`;
        resetPerStageHealQuiet();
        await runTask(stageSweepTask, {}, { sql });
        expect(
            await sql`SELECT status FROM media_item_stage_state
            WHERE media_item_id = ${id}::uuid AND stage_id = ${ANALYZER_VISUAL_STAGE_ID}`,
        ).toMatchObject([{ status: 'pending' }]);
        const drain = await getUnanalyzedMovies(
            sql,
            ANALYZER_VISUAL_STAGE_ID,
            VISUAL_PROCESSING_VERSION,
            1000,
        );
        expect(drain.map((row) => row.mediaId)).toContain(id);
        expect(drain.map((row) => row.mediaId)).not.toContain(deleted);
        expect(
            await sql`SELECT 1 FROM media_item_stage_state WHERE media_item_id = ${deleted}::uuid
            AND status = 'pending'`,
        ).toHaveLength(0);
    });

    it('uses a qualifying alternate when the default is missing and completes real chapter analysis without acoustic work', async () => {
        testTasks = [lumastraIntroAnalyzerTask];
        const id = await seedMovie('alternate-chapters', 'pending');
        const { fileId: alternate } = await seedChapterAlternate(id);
        await runTask(stageSweepTask, {}, { sql });
        expect(
            (
                await getUnanalyzedMovies(
                    sql,
                    ANALYZER_VISUAL_STAGE_ID,
                    VISUAL_PROCESSING_VERSION,
                    1000,
                )
            ).map((row) => row.mediaId),
        ).toContain(id);
        const result = await runTask(lumastraIntroAnalyzerTask, { mediaId: id }, { sql });
        expect(result).toMatchObject({
            success: true,
            itemsProcessed: 1,
            result: { analysisOutcome: 'completed' },
        });
        expect(
            await sql`SELECT status FROM media_item_stage_state WHERE media_item_id = ${id}::uuid
            AND stage_id = ${ANALYZER_VISUAL_STAGE_ID}`,
        ).toMatchObject([{ status: 'completed' }]);
        expect(
            await sql`SELECT file_id, type, start_time, end_time FROM media_segments WHERE media_id = ${id}::uuid
            AND source = 'lumastra-intro-analyzer'`,
        ).toMatchObject([{ file_id: alternate, type: 'Intro', start_time: 0, end_time: 90 }]);
        expect(
            await sql`SELECT 1 FROM media_item_stage_state WHERE media_item_id = ${id}::uuid
            AND stage_id = ${ANALYZER_ACOUSTIC_STAGE_ID}`,
        ).toHaveLength(0);
    });

    it('does not complete chapter analysis when the qualifying alternate is physically absent', async () => {
        testTasks = [lumastraIntroAnalyzerTask];
        const id = await seedMovie('absent-alternate-chapters', 'pending');
        const { filePath } = await seedChapterAlternate(id);
        await rm(filePath);
        await runTask(stageSweepTask, {}, { sql });
        const before = await sql`SELECT * FROM media_item_stage_state
            WHERE media_item_id = ${id}::uuid ORDER BY stage_id`;

        const result = await runTask(lumastraIntroAnalyzerTask, { mediaId: id }, { sql });

        expect(result).toMatchObject({
            success: false,
            itemsProcessed: 0,
            result: { analysisOutcome: 'skipped', skipReason: 'no-eligible-targets' },
        });
        expect(
            await sql`SELECT * FROM media_item_stage_state
                WHERE media_item_id = ${id}::uuid ORDER BY stage_id`,
        ).toEqual(before);
        expect(before).toMatchObject([{ stage_id: ANALYZER_VISUAL_STAGE_ID, status: 'pending' }]);
        expect(await sql`SELECT 1 FROM media_segments WHERE media_id = ${id}::uuid`).toHaveLength(
            0,
        );
    });

    it('counts deduped startRun results separately from enqueued', async () => {
        const stageId = `sweep-task-test-stage-${Date.now()}-d`;
        const task = mkCoveringTask('t-dedup', stageId, {
            enqueueable: true,
            perItem: true,
        });
        testTasks = [task];

        const a = await insertMediaItem(sql, 'sweep-task-test-dedup-a');
        const b = await insertMediaItem(sql, 'sweep-task-test-dedup-b');
        await insertPendingRow(sql, a, stageId);
        await insertPendingRow(sql, b, stageId);

        // First call enqueues, second returns deduped.
        startRunMock
            .mockResolvedValueOnce({ runId: 'run_a', deduped: false })
            .mockResolvedValueOnce({
                runId: 'run_a',
                deduped: true,
                existingRunId: 'run_a',
            });

        const result = await runTask(stageSweepTask, {}, { sql });

        const summary = result.result as { enqueued: number; deduped: number };
        expect(summary.enqueued).toBe(1);
        expect(summary.deduped).toBe(1);
    });

    it('continues across stages when startRun throws for one candidate', async () => {
        const stageId = `sweep-task-test-stage-${Date.now()}-err`;
        const task = mkCoveringTask('t-err', stageId, {
            enqueueable: true,
            perItem: true,
        });
        testTasks = [task];

        const a = await insertMediaItem(sql, 'sweep-task-test-err-a');
        const b = await insertMediaItem(sql, 'sweep-task-test-err-b');
        await insertPendingRow(sql, a, stageId);
        await insertPendingRow(sql, b, stageId);

        startRunMock
            .mockRejectedValueOnce(new Error('synthetic startRun failure'))
            .mockResolvedValueOnce({ runId: 'run_ok', deduped: false });

        const result = await runTask(stageSweepTask, {}, { sql });

        const summary = result.result as { enqueued: number; failed: number };
        expect(summary.failed).toBe(1);
        expect(summary.enqueued).toBe(1);
        // Partial failure (1 failed, 1 enqueued) — sweep is NOT a "failed" run.
        // success: false only when EVERY attempted enqueue failed.
        expect(result.success).toBe(true);
    });

    it.each([true, false])(
        'does not fail its own run for a child circuit (per-item=%s)',
        async (perItem) => {
            const stageId = `sweep-task-test-stage-${Date.now()}-child-circuit`;
            testTasks = [
                mkCoveringTask('t-child-circuit', stageId, {
                    enqueueable: true,
                    perItem,
                }),
            ];
            const item = await insertMediaItem(sql, 'sweep-task-test-child-circuit');
            await insertPendingRow(sql, item, stageId);
            startRunMock.mockRejectedValueOnce(
                new TaskError({
                    message: 'Circuit breaker is open for task t-child-circuit: open_with_cooldown',
                    kind: 'transient',
                }),
            );

            const result = await runTask(stageSweepTask, {}, { sql });

            expect(result.success).toBe(true);
            expect(result.result).toMatchObject({ enqueued: 0, deduped: 0, failed: 1 });
            expect(startRunMock).toHaveBeenCalledTimes(1);
        },
    );

    it('counts a deduped enqueue as progress when another child fails', async () => {
        const stageId = `sweep-task-test-stage-${Date.now()}-dedup-failure`;
        testTasks = [
            mkCoveringTask('t-dedup-failure', stageId, {
                enqueueable: true,
                perItem: true,
            }),
        ];
        const a = await insertMediaItem(sql, 'sweep-task-test-dedup-failure-a');
        const b = await insertMediaItem(sql, 'sweep-task-test-dedup-failure-b');
        await insertPendingRow(sql, a, stageId);
        await insertPendingRow(sql, b, stageId);
        startRunMock
            .mockRejectedValueOnce(new Error('synthetic enqueue failure'))
            .mockResolvedValueOnce({ runId: 'run_existing', deduped: true });

        const result = await runTask(stageSweepTask, {}, { sql });

        expect(result.success).toBe(true);
        expect(result.result).toMatchObject({ enqueued: 0, deduped: 1, failed: 1 });
    });

    it('throws a transient TaskError (never a silent {success:false}) when EVERY enqueue fails', async () => {
        // Regression for the bug where an all-failed tick returned
        // `{success: false}` — a shape the runner never reads (any
        // non-throwing return is recorded 'completed' and credits the
        // circuit breaker a success). The ONLY way to mark this run failed,
        // trigger retry, and let the breaker see the failure is to throw.
        const stageId = `sweep-task-test-stage-${Date.now()}-allfail`;
        const task = mkCoveringTask('t-allfail', stageId, {
            enqueueable: true,
            perItem: true,
        });
        testTasks = [task];

        const a = await insertMediaItem(sql, 'sweep-task-test-allfail-a');
        const b = await insertMediaItem(sql, 'sweep-task-test-allfail-b');
        await insertPendingRow(sql, a, stageId);
        await insertPendingRow(sql, b, stageId);

        startRunMock.mockRejectedValue(new Error('synthetic total failure'));

        await expect(runTask(stageSweepTask, {}, { sql })).rejects.toMatchObject({
            name: 'TaskError',
            kind: 'transient',
            message: expect.stringContaining('every enqueue attempt failed'),
        });
    });

    // TASK-M-backpressure: analysis/ingest/bulk are slow-consuming classes that
    // stage-sweep can flood. They MUST have a queue-depth skip threshold or
    // their BullMQ queues grow unbounded during a bulk stage-state migration.
    it.each([
        { cls: 'analysis' as const, depth: 400 }, // threshold 300
        { cls: 'ingest' as const, depth: 31000 }, // threshold 30000
        { cls: 'bulk' as const, depth: 1600 }, // threshold 1500
    ])(
        'TASK-M-backpressure: skips $cls-class stages when its queue depth is over threshold',
        async ({ cls, depth }) => {
            const stageId = `sweep-task-test-stage-${Date.now()}-${cls}`;
            const task = mkCoveringTask(`t-${cls}`, stageId, {
                enqueueable: true,
                perItem: true,
                resourceClass: cls,
            });
            testTasks = [task];

            const item = await insertMediaItem(sql, `sweep-task-test-${cls}`);
            await insertPendingRow(sql, item, stageId);

            // Class is over its skip threshold → stage-sweep must back off entirely.
            getQueueDepthsMock.mockResolvedValue({
                [cls]: { waiting: depth, delayed: 0 },
            });

            const result = await runTask(stageSweepTask, {}, { sql });

            // No enqueue should have happened — the class was throttled this tick.
            expect(startRunMock).not.toHaveBeenCalled();
            const summary = result.result as {
                enqueued: number;
                stagesSkippedBackpressure: number;
            };
            expect(summary.enqueued).toBe(0);
            expect(summary.stagesSkippedBackpressure).toBeGreaterThanOrEqual(1);
        },
    );

    it('TASK-M-backpressure: still enqueues bulk-class stages when depth is below threshold', async () => {
        const stageId = `sweep-task-test-stage-${Date.now()}-bulk-ok`;
        const task = mkCoveringTask('t-bulk-ok', stageId, {
            enqueueable: true,
            perItem: true,
            resourceClass: 'bulk',
        });
        testTasks = [task];

        const item = await insertMediaItem(sql, 'sweep-task-test-bulk-ok');
        await insertPendingRow(sql, item, stageId);

        // Below the bulk threshold (1500) → no throttle.
        getQueueDepthsMock.mockResolvedValue({
            bulk: { waiting: 100, delayed: 0 },
        });

        const result = await runTask(stageSweepTask, {}, { sql });

        expect(startRunMock).toHaveBeenCalledTimes(1);
        const summary = result.result as {
            enqueued: number;
            stagesSkippedBackpressure: number;
        };
        expect(summary.enqueued).toBe(1);
        expect(summary.stagesSkippedBackpressure).toBe(0);
    });

    it('no-ops when no tasks declare enqueueable stages', async () => {
        const stageId = `sweep-task-test-stage-${Date.now()}-z`;
        // Task declares the stage but does NOT opt in.
        testTasks = [mkCoveringTask('t-noopt', stageId, { perItem: true })];

        const item = await insertMediaItem(sql, 'sweep-task-test-noopt');
        await insertPendingRow(sql, item, stageId);

        const result = await runTask(stageSweepTask, {}, { sql });
        expect(startRunMock).not.toHaveBeenCalled();
        const summary = result.result as {
            stagesScanned: number;
            enqueued: number;
        };
        expect(summary.stagesScanned).toBe(0);
        expect(summary.enqueued).toBe(0);
    });

    // -------------------------------------------------------------------------
    // Bug C — self-heal phase
    // -------------------------------------------------------------------------

    it('self-heal: seeds coverage rows for an item with ZERO stage_state rows', async () => {
        const stageId = `sweep-task-test-stage-${Date.now()}-heal`;
        // Task is enqueueable so the orphan, after seeding, also triggers
        // an eager-enqueue startRun via StageStateService.
        const task = mkCoveringTask('t-heal', stageId, {
            enqueueable: true,
            perItem: true,
        });
        testTasks = [task];

        // Insert an orphan: movie item with NO stage_state rows. This
        // mimics the bug — afterCreated was not called when the item was
        // upserted via some non-lifecycle code path.
        const orphan = await insertMediaItem(sql, 'sweep-task-test-heal-orphan');

        const result = await runTask(stageSweepTask, {}, { sql });

        // Self-heal must have found the orphan and seeded a row.
        const summary = result.result as {
            selfHealFound: number;
            selfHealSeeded: number;
        };
        expect(summary.selfHealFound).toBe(1);
        expect(summary.selfHealSeeded).toBe(1);

        // Coverage row now exists.
        const rows = await sql<{ stage_id: string; status: string }[]>`
            SELECT stage_id, status
              FROM media_item_stage_state
             WHERE media_item_id = ${orphan}::uuid
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0].stage_id).toBe(stageId);
        expect(rows[0].status).toBe('pending');
    });

    it('self-heal: a clean whole-catalog scan rests until its quiet window ends', async () => {
        const stageId = `sweep-task-test-stage-${Date.now()}-healquiet`;
        testTasks = [mkCoveringTask('t-healquiet', stageId, { enqueueable: false })];

        const first = await runTask(stageSweepTask, {}, { sql }); // scans clean -> quiet
        expect((first.result as { selfHealFound: number }).selfHealFound).toBe(0);

        const orphan = await insertMediaItem(sql, 'sweep-task-test-healquiet-orphan');
        const hasAnyRow = async (): Promise<boolean> => {
            const rows = await sql`
                SELECT 1 FROM media_item_stage_state WHERE media_item_id = ${orphan}::uuid`;
            return rows.length > 0;
        };

        await runTask(stageSweepTask, {}, { sql });
        expect(await hasAnyRow()).toBe(false);

        resetPerStageHealQuiet(); // stands in for the 15-minute window elapsing
        await runTask(stageSweepTask, {}, { sql });
        expect(await hasAnyRow()).toBe(true);
    });

    it('self-heal: skips items that already have at least one coverage row', async () => {
        const stageId = `sweep-task-test-stage-${Date.now()}-skip`;
        const task = mkCoveringTask('t-skip', stageId, {
            enqueueable: true,
            perItem: true,
        });
        testTasks = [task];

        // Item already has a coverage row → must NOT be re-seeded.
        const covered = await insertMediaItem(sql, 'sweep-task-test-skip-covered');
        await insertPendingRow(sql, covered, stageId);

        const result = await runTask(stageSweepTask, {}, { sql });

        const summary = result.result as { selfHealFound: number };
        expect(summary.selfHealFound).toBe(0);
    });

    it('self-heal: skips dismissed items', async () => {
        const stageId = `sweep-task-test-stage-${Date.now()}-dismissed`;
        const task = mkCoveringTask('t-dismissed', stageId, {
            enqueueable: true,
            perItem: true,
        });
        testTasks = [task];

        // Insert an orphan, then dismiss it.
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, is_dismissed)
            VALUES (
                ${id}::uuid,
                'sweep-task-test-dismissed-item',
                'movie',
                'active',
                true
            )
        `;

        const result = await runTask(stageSweepTask, {}, { sql });

        const summary = result.result as { selfHealFound: number };
        expect(summary.selfHealFound).toBe(0);
    });

    // -------------------------------------------------------------------------
    // Bug 2 — self-heal / eligibility-heal phases must honor softSignal +
    // sweepDeadline, not just the hard `signal.aborted`.
    // -------------------------------------------------------------------------

    it('bails out of the self-heal phase when softSignal has already fired', async () => {
        // Regression: the self-heal (seed-missing-coverage) and
        // event-independent eligibility-heal phases used to check ONLY
        // `signal.aborted`, ignoring `softSignal?.aborted` and the
        // wall-clock `sweepDeadline` that the main rotation loop honors.
        // A soft-timeout fire (or an already-exhausted wall-clock budget)
        // must stop BOTH heal phases just like it stops the main loop,
        // instead of running them to completion and risking the 5-minute
        // hard kill.
        const stageId = `sweep-task-test-stage-${Date.now()}-softbail`;
        const task = mkCoveringTask('t-softbail', stageId, {
            enqueueable: true,
            perItem: true,
        });
        testTasks = [task];

        // Orphan that self-heal would normally find + seed within one tick.
        await insertMediaItem(sql, 'sweep-task-test-softbail-orphan');

        const softController = new AbortController();
        softController.abort(); // simulate the soft timeout having already fired

        // mockContext's "raw partial" mode is detected by a `secrets.get`
        // function (see mock-context.ts); using it lets us set `softSignal`,
        // which the friendly MockContextOptions shape doesn't expose.
        const ctx = mockContext({
            input: {},
            sql,
            secrets: {
                get: () => Promise.reject(new Error('not mocked')),
                getOptional: () => Promise.resolve(null),
                getUser: () => Promise.reject(new Error('not mocked')),
            },
            softSignal: softController.signal,
        });

        const result = await stageSweepTask.execute(ctx);

        const summary = result.result as {
            selfHealFound: number;
            selfHealSeeded: number;
        };
        // Bailed before even querying for missing-coverage candidates.
        expect(summary.selfHealFound).toBe(0);
        expect(summary.selfHealSeeded).toBe(0);
        // The sweeper itself never got to the enqueue loop either — but that's
        // bailed via the pre-existing `signal.aborted || softSignal?.aborted`
        // check in the main rotation loop (untouched by this fix).
        expect(startRunMock).not.toHaveBeenCalled();
    });
});
