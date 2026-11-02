// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { mkdtemp, writeFile, stat, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type postgres from 'postgres';
import { saveFingerprint } from '$lib/server/database/queries/media-segment-fingerprints.queries.js';
import { getAnalyzerInputSnapshot } from '$lib/server/database/queries/media-segment-input.queries.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { z } from 'zod';
import { FFmpegTimeoutError } from '$lib/server/utils/ffmpeg-spawn.js';
import { config as serverConfig } from '$lib/server/config.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { TaskRegistry } from '../../../registry.js';
import { TaskOrchestrator } from '../../../orchestrator.js';
import { TaskRunner } from '../../../runner.js';
import { stateMachine } from '../../../state-machine.js';
import { requireClient } from '../../../valkey-types.js';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';

const detectors = vi.hoisted(() => ({ chapters: vi.fn(), fingerprint: vi.fn() }));
vi.mock('$lib/server/utils/ffprobe.js', async (original) => ({
    ...(await original<typeof import('$lib/server/utils/ffprobe.js')>()),
    probeChapters: detectors.chapters,
}));
vi.mock('$lib/server/utils/ffmpeg-analysis.js', async (original) => ({
    ...(await original<typeof import('$lib/server/utils/ffmpeg-analysis.js')>()),
    chromaprintFingerprint: detectors.fingerprint,
}));
import {
    lumastraIntroAnalyzerTask,
    ANALYZER_VISUAL_STAGE_ID,
    ANALYZER_ACOUSTIC_STAGE_ID,
} from '../lumastra-intro-analyzer.js';

const PLUGIN = 'lumastra-intro-analyzer';
const BUDGET_MS = 30 * 60_000;
let sql: postgres.Sql;
let directory: string;
const items: string[] = [];
const files: string[] = [];

async function seedSeason(count: number): Promise<string[]> {
    const series = crypto.randomUUID(),
        season = crypto.randomUUID();
    items.push(series, season);
    await sql`INSERT INTO media_items(id,title,media_type,status) VALUES (${series},'The Lantern Atlas','tv','active')`;
    await sql`INSERT INTO media_items(id,title,media_type,status,parent_id,season_number) VALUES (${season},'The Lantern Atlas — season one','season','active',${series},1)`;
    const episodes: string[] = [];
    for (let n = 1; n <= count; n++) {
        const id = crypto.randomUUID(),
            file = crypto.randomUUID();
        items.push(id);
        files.push(file);
        episodes.push(id);
        const filePath = path.join(directory, file + '.mkv');
        await writeFile(filePath, 'invented episode bytes');
        const old = new Date(Date.now() - 2 * 60 * 60_000);
        await utimes(filePath, old, old);
        const physical = await stat(filePath);
        await sql`INSERT INTO media_items(id,title,media_type,status,parent_id,season_number,episode_number,has_files)
            VALUES (${id},${`Lantern chapter ${n}`},'episode','active',${season},1,${n},true)`;
        await sql`INSERT INTO media_files(id,file_path,duration_seconds,file_size_bytes,file_mtime,file_hash_head,created_at,updated_at)
            VALUES (${file},${filePath},1200,${physical.size},${physical.mtime},'invented-source',now()-interval '2 hours',now()-interval '2 hours')`;
        await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default) VALUES (${file},${id},true)`;
        await sql`INSERT INTO media_streams(file_id,stream_type,stream_index) VALUES (${file},'video',0)`;
    }
    return episodes;
}

async function clearFixtures(): Promise<void> {
    await sql`DELETE FROM plugin_failure_events WHERE plugin_id=${PLUGIN}`;
    await sql`DELETE FROM media_items WHERE id=ANY(${items}::uuid[])`;
    await sql`DELETE FROM media_files WHERE id=ANY(${files}::uuid[])`;
    await sql`DELETE FROM plugin_settings WHERE plugin_id=${PLUGIN}`;
    items.length = 0;
    files.length = 0;
}

async function settings(acoustic: boolean): Promise<void> {
    for (const [key, value] of Object.entries({
        chapterDetection: true,
        blackframeDetection: false,
        chromaprintDetection: acoustic,
        episodeConcurrency: 1,
    }))
        await sql`INSERT INTO plugin_settings(plugin_id,key,value) VALUES (${PLUGIN},${key},${sql.json(value)})
            ON CONFLICT(plugin_id,key) DO UPDATE SET value=EXCLUDED.value`;
}

async function completed(stage: string): Promise<string[]> {
    const rows = await sql<
        { media_item_id: string }[]
    >`SELECT media_item_id FROM media_item_stage_state
        WHERE media_item_id=ANY(${items}::uuid[]) AND stage_id=${stage} AND status='completed'`;
    return rows.map((r) => r.media_item_id);
}

beforeAll(async () => {
    sql = getTestDb();
    directory = await mkdtemp(path.join(tmpdir(), 'intro-budget-'));
});
beforeEach(async () => {
    vi.restoreAllMocks();
    await clearFixtures();
    detectors.chapters.mockReset().mockResolvedValue({ chapters: [], durationMs: 1200000 });
    detectors.fingerprint.mockReset().mockResolvedValue(new Uint32Array([1, 2, 3]));
    await settings(false);
});
afterAll(async () => {
    vi.restoreAllMocks();
    await clearFixtures();
    await rm(directory, { recursive: true, force: true });
    await closeTestDb();
});

describe('intro analyzer durable bounded drain', () => {
    it('survives a real runner wall-clock timeout and resumes committed extraction on its next execution', async () => {
        await settings(true);
        const episodes = await seedSeason(8);
        await connectValkey();
        vi.spyOn(serverConfig, 'WORKER_MODE', 'get').mockReturnValue('enabled');
        vi.spyOn(serverConfig, 'DEDICATED_WORKER', 'get').mockReturnValue(true);
        const taskId = `intro-timeout-${crypto.randomUUID()}`;
        const registry = new TaskRegistry();
        let observedAbort = false;
        let settled = false;
        detectors.fingerprint.mockImplementation(async (_file, _start, _end, _tmp, options) => {
            if (detectors.fingerprint.mock.calls.length === 4) {
                await new Promise<void>((resolve) => {
                    options.abortSignal.addEventListener(
                        'abort',
                        () => {
                            observedAbort = true;
                            resolve();
                        },
                        { once: true },
                    );
                });
                throw new DOMException('runner hard deadline', 'AbortError');
            }
            return new Uint32Array([1, 2, 3]);
        });
        registry.registerTask(
            defineTask({
                id: taskId,
                name: 'Bounded native intro timeout fixture',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                resourceClass: 'io',
                capabilities: { database: true },
                inputSchema: z.object({}),
                identityFor: () => 'global',
                timeout: { soft: '2s', hard: '3s' },
                execute: async (ctx) => {
                    try {
                        return await lumastraIntroAnalyzerTask.execute(ctx);
                    } finally {
                        settled = true;
                    }
                },
            }),
        );
        const options = {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient: () => requireClient(),
        };
        const orch = await TaskOrchestrator.start(['io'], options);
        const runner = await TaskRunner.start(['io'], {
            ...options,
            instanceId: taskId,
            bootId: crypto.randomUUID(),
        });
        let runId: string | undefined;
        try {
            runId = (await orch.startRun(taskId, {})).runId;
            const deadline = Date.now() + 15_000;
            while ((!observedAbort || !settled) && Date.now() < deadline)
                await new Promise((resolve) => setTimeout(resolve, 25));
            expect(observedAbort).toBe(true);
            expect(settled).toBe(true);
            // The watchdog aborts the handler before its asynchronous terminal
            // history write finishes; handler settlement alone is not a DB fence.
            for (let attempt = 0; attempt < 200; attempt++) {
                const [row] = await sql<
                    { state: string }[]
                >`SELECT state FROM task_history WHERE id=${runId}`;
                if (row?.state === 'failed') break;
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            const [execution] = await sql<
                { state: string; error: { reason: string } }[]
            >`SELECT state,error FROM task_history WHERE id=${runId}`;
            expect(execution).toMatchObject({
                state: 'failed',
                error: { reason: 'watchdog-timeout-hard' },
            });
            expect(await completed(ANALYZER_VISUAL_STAGE_ID)).toHaveLength(episodes.length);
            expect(await completed(ANALYZER_ACOUSTIC_STAGE_ID)).toHaveLength(0);
            expect(
                await sql`SELECT * FROM media_segment_fingerprints WHERE media_id=ANY(${episodes}::uuid[])`,
            ).toHaveLength(3);
            await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
            expect(await completed(ANALYZER_ACOUSTIC_STAGE_ID)).toHaveLength(episodes.length);
            expect(detectors.fingerprint).toHaveBeenCalledTimes(episodes.length * 2 + 1);
            expect(detectors.chapters).toHaveBeenCalledTimes(episodes.length);
        } finally {
            await runner.stop();
            await orch.stop();
            if (runId) await sql`DELETE FROM task_history WHERE id=${runId}`;
            await disconnectValkey();
        }
    }, 45_000);

    it('stops inside a large catchup slice, saves completed items, and the next run finishes without repeating them', async () => {
        const episodes = (await Promise.all([seedSeason(8), seedSeason(8), seedSeason(8)])).flat();
        let now = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        detectors.chapters.mockImplementation(async () => {
            if (detectors.chapters.mock.calls.length === 5) now += BUDGET_MS + 1;
            return { chapters: [], durationMs: 1200000 };
        });
        const progress = vi.fn();
        const first = await lumastraIntroAnalyzerTask.execute(
            mockContext({ sql, input: {}, runId: 'budget-first', onProgress: progress }),
        );
        expect(first.stopReason).toBe('budget');
        expect(first.itemsProcessed).toBe(5);
        expect(await completed(ANALYZER_VISUAL_STAGE_ID)).toHaveLength(5);
        expect(progress).toHaveBeenCalled();
        const second = await lumastraIntroAnalyzerTask.execute(
            mockContext({ sql, input: {}, runId: 'budget-second' }),
        );
        expect(second.itemsProcessed).toBe(episodes.length - 5);
        expect(await completed(ANALYZER_VISUAL_STAGE_ID)).toHaveLength(episodes.length);
        expect(detectors.chapters).toHaveBeenCalledTimes(episodes.length);
        const third = await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
        expect(third.itemsProcessed).toBe(0);
        expect(detectors.chapters).toHaveBeenCalledTimes(episodes.length);
    });

    it('preserves individual visual checkpoints when cancellation arrives before the season finishes', async () => {
        const episodes = await seedSeason(8);
        const controller = new AbortController();
        const progress = vi.fn(() => {
            if (progress.mock.calls.length === 2) controller.abort();
        });
        await lumastraIntroAnalyzerTask.execute(
            mockContext({ sql, input: {}, signal: controller.signal, onProgress: progress }),
        );
        expect(await completed(ANALYZER_VISUAL_STAGE_ID)).toHaveLength(2);
        await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
        expect(await completed(ANALYZER_VISUAL_STAGE_ID)).toHaveLength(episodes.length);
        expect(detectors.chapters).toHaveBeenCalledTimes(episodes.length);
    });

    it('retries a failed visual item without redoing its completed siblings', async () => {
        const episodes = await seedSeason(8);
        detectors.chapters.mockRejectedValueOnce(new Error('invented decoder failure'));
        await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
        expect(await completed(ANALYZER_VISUAL_STAGE_ID)).toHaveLength(episodes.length - 1);
        const second = await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
        expect(second.itemsProcessed).toBe(1);
        expect(await completed(ANALYZER_VISUAL_STAGE_ID)).toHaveLength(episodes.length);
        expect(detectors.chapters).toHaveBeenCalledTimes(episodes.length + 1);
    });

    it('reports a run as success when a timed-out item backs off, and counts it as deferred', async () => {
        const episodes = await seedSeason(8);
        detectors.chapters.mockRejectedValueOnce(new FFmpegTimeoutError(300_000, ''));
        const result = await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
        expect(result).toMatchObject({
            success: true,
            result: { analysisOutcome: 'deferred', deferredItems: 1 },
        });
        expect(await completed(ANALYZER_VISUAL_STAGE_ID)).toHaveLength(episodes.length - 1);
        // The timeout is a back-off, not a strike: no stage-attributed failure row.
        const strikes = await sql`SELECT 1 FROM plugin_failure_events
            WHERE plugin_id=${PLUGIN} AND stage_id IS NOT NULL`;
        expect(strikes).toHaveLength(0);
        const backedOff = await sql`SELECT 1 FROM media_item_stage_state
            WHERE media_item_id=ANY(${episodes}::uuid[]) AND stage_id=${ANALYZER_VISUAL_STAGE_ID}
              AND status='skipped_transient' AND next_eligible_at > now()`;
        expect(backedOff).toHaveLength(1);
    });

    it('reports a run as failed when a detector really errors', async () => {
        await seedSeason(8);
        detectors.chapters.mockRejectedValueOnce(new Error('invented decoder failure'));
        const result = await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
        expect(result).toMatchObject({ success: false, result: { analysisOutcome: 'partial' } });
        expect(result.result).not.toHaveProperty('deferredItems');
    });

    it('quarantines an item that keeps failing even when a stale completed row is still on file', async () => {
        const episodes = await seedSeason(8);
        const poison = episodes[3]!;
        // A completed row from an earlier file generation: no analysis pass backs it,
        // so the drain re-selects the item, yet the row used to block the tombstone.
        await sql`INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status, completed_at)
            VALUES (${poison}::uuid, ${ANALYZER_VISUAL_STAGE_ID}, 1, 'completed', now())`;
        detectors.chapters.mockImplementation(async (filePath: string) => {
            const [row] = await sql`SELECT 1 FROM media_files mf
                JOIN media_file_items mfi ON mfi.file_id = mf.id
                WHERE mfi.media_item_id=${poison}::uuid AND mf.file_path=${filePath}`;
            if (row) throw new Error('invented poison decoder failure');
            return { chapters: [], durationMs: 1200000 };
        });
        for (let run = 0; run < 5; run++) {
            const result = await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
            expect(result.success).toBe(false);
        }
        const [row] = await sql<{ status: string }[]>`SELECT status FROM media_item_stage_state
            WHERE media_item_id=${poison}::uuid AND stage_id=${ANALYZER_VISUAL_STAGE_ID}`;
        expect(row!.status).toBe('skipped_permanent');
        // Tombstoned: the next run no longer selects it, so it neither retries nor fails.
        const calls = detectors.chapters.mock.calls.length;
        const after = await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
        expect(after.result).toMatchObject({ analysisOutcome: 'skipped' });
        expect(detectors.chapters.mock.calls.length).toBe(calls);
    });

    it('resumes a budget-interrupted acoustic cohort using saved head and tail fingerprints', async () => {
        await settings(true);
        const episodes = await seedSeason(8);
        let now = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        detectors.fingerprint.mockImplementation(async () => {
            if (detectors.fingerprint.mock.calls.length === 11) now += BUDGET_MS + 1;
            return new Uint32Array([1, 2, 3]);
        });
        const first = await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
        expect(first.stopReason).toBe('budget');
        expect(detectors.fingerprint).toHaveBeenCalledTimes(11);
        expect(await completed(ANALYZER_ACOUSTIC_STAGE_ID)).toHaveLength(0);
        expect(await completed(ANALYZER_VISUAL_STAGE_ID)).toHaveLength(episodes.length);
        await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
        expect(await completed(ANALYZER_ACOUSTIC_STAGE_ID)).toHaveLength(episodes.length);
        expect(detectors.fingerprint).toHaveBeenCalledTimes(episodes.length * 2);
        expect(detectors.chapters).toHaveBeenCalledTimes(episodes.length);
    });

    it('retains committed fingerprints and visual results after a hard abort, leaving unfinished acoustic work eligible', async () => {
        await settings(true);
        const episodes = await seedSeason(8);
        const controller = new AbortController();
        detectors.fingerprint.mockImplementation(async () => {
            if (detectors.fingerprint.mock.calls.length === 4) {
                controller.abort();
                throw new DOMException('execution stopped', 'AbortError');
            }
            return new Uint32Array([1, 2, 3]);
        });
        await lumastraIntroAnalyzerTask.execute(
            mockContext({ sql, input: {}, signal: controller.signal }),
        );
        expect(await completed(ANALYZER_VISUAL_STAGE_ID)).toHaveLength(episodes.length);
        expect(await completed(ANALYZER_ACOUSTIC_STAGE_ID)).toHaveLength(0);
        await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
        expect(await completed(ANALYZER_ACOUSTIC_STAGE_ID)).toHaveLength(episodes.length);
        expect(detectors.fingerprint).toHaveBeenCalledTimes(episodes.length * 2 + 1);
        expect(detectors.chapters).toHaveBeenCalledTimes(episodes.length);
        const failures =
            await sql`SELECT * FROM plugin_failure_events WHERE plugin_id=${PLUGIN} AND resolved_at IS NULL`;
        expect(failures).toHaveLength(0);
    });

    it('bounds the movie fallback and resumes it without redoing completed films', async () => {
        const movies = await seedSeason(8);
        await sql`UPDATE media_items SET media_type='movie',parent_id=NULL WHERE id=ANY(${movies}::uuid[])`;
        let now = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        detectors.chapters.mockImplementation(async () => {
            if (detectors.chapters.mock.calls.length === 3) now += BUDGET_MS + 1;
            return { chapters: [], durationMs: 1200000 };
        });
        const first = await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
        expect(first).toMatchObject({ stopReason: 'budget', itemsProcessed: 3 });
        expect(await completed(ANALYZER_VISUAL_STAGE_ID)).toHaveLength(3);
        await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
        expect(await completed(ANALYZER_VISUAL_STAGE_ID)).toHaveLength(movies.length);
        expect(detectors.chapters).toHaveBeenCalledTimes(movies.length);
    });

    it('honors the runtime soft deadline without cancelling the run or striking a file', async () => {
        await seedSeason(8);
        const soft = new AbortController();
        const ctx = {
            ...mockContext({ sql, input: { mode: 'manual' }, onProgress: () => soft.abort() }),
            softSignal: soft.signal,
        };
        const first = await lumastraIntroAnalyzerTask.execute(ctx);
        expect(first).toMatchObject({ success: true, stopReason: 'budget', itemsProcessed: 1 });
        expect(ctx.signal.aborted).toBe(false);
        expect(await completed(ANALYZER_VISUAL_STAGE_ID)).toHaveLength(1);
        expect(
            await sql`SELECT * FROM plugin_failure_events WHERE plugin_id=${PLUGIN}`,
        ).toHaveLength(0);
    });

    it.each(['bytes', 'physical-file', 'window', 'settings'])(
        'rejects saved fingerprints after %s changes between chunks',
        async (change) => {
            await settings(true);
            const episodes = await seedSeason(8);
            let now = Date.now();
            vi.spyOn(Date, 'now').mockImplementation(() => now);
            detectors.fingerprint.mockImplementation(async () => {
                if (detectors.fingerprint.mock.calls.length === 5) now += BUDGET_MS + 1;
                return new Uint32Array([0xffffffff, 0x80000000, 0]);
            });
            const first = await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
            expect(first.stopReason).toBe('budget');
            const [checkpoint] = await sql<{ media_id: string; points: Buffer }[]>`
                SELECT media_id,points FROM media_segment_fingerprints WHERE media_id=ANY(${episodes}::uuid[]) LIMIT 1`;
            expect(checkpoint?.points.readUInt32LE(0)).toBe(0xffffffff);
            expect(checkpoint?.points.readUInt32LE(4)).toBe(0x80000000);
            const id = checkpoint!.media_id;
            if (change === 'bytes') {
                await sql`UPDATE media_files SET file_hash_head='replacement-bytes' WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id=${id})`;
            } else if (change === 'physical-file') {
                const [file] = await sql<
                    { file_path: string }[]
                >`SELECT file_path FROM media_files WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id=${id})`;
                await writeFile(
                    file!.file_path,
                    'replacement physical file bytes of a different size',
                );
            } else if (change === 'window') {
                await sql`UPDATE media_file_items SET start_offset_ms=1000,end_offset_ms=1100000 WHERE media_item_id=${id}`;
            } else {
                await sql`INSERT INTO plugin_settings(plugin_id,key,value) VALUES (${PLUGIN},'introWindowMaxSec','500'::jsonb)`;
            }
            await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
            expect(await completed(ANALYZER_ACOUSTIC_STAGE_ID)).toHaveLength(episodes.length);
            // A changed setting invalidates every window; a changed item invalidates only its own.
            expect(detectors.fingerprint).toHaveBeenCalledTimes(
                episodes.length * 2 + (change === 'settings' ? 5 : 1),
            );
        },
    );
    it('deletes completed cohort checkpoints but preserves an interrupted cohort', async () => {
        await settings(true);
        const episodes = await seedSeason(8);
        let now = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        detectors.fingerprint.mockImplementation(async () => {
            if (detectors.fingerprint.mock.calls.length === 5) now += BUDGET_MS + 1;
            return new Uint32Array([1, 2, 3]);
        });
        await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
        expect(
            await sql`SELECT * FROM media_segment_fingerprints WHERE media_id=ANY(${episodes}::uuid[])`,
        ).toHaveLength(5);
        await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
        expect(await completed(ANALYZER_ACOUSTIC_STAGE_ID)).toHaveLength(8);
        expect(
            await sql`SELECT * FROM media_segment_fingerprints WHERE media_id=ANY(${episodes}::uuid[])`,
        ).toHaveLength(0);
    });

    it('deletes checkpoints immediately when the source file is replaced', async () => {
        const [id] = await seedSeason(2);
        const input = (await getAnalyzerInputSnapshot(sql, id))!;
        await saveFingerprint(
            sql,
            {
                mediaId: id,
                pass: 'intro',
                inputIdentity: input.inputIdentity,
                physicalIdentity: 'fixture-stat',
                processingVersion: 4,
                startSec: 0,
                endSec: 600,
            },
            new Uint32Array([1, 2, 3]),
        );
        await sql`UPDATE media_files SET file_hash_head='replacement' WHERE id=${input.fileId}`;
        expect(
            await sql`SELECT * FROM media_segment_fingerprints WHERE media_id=${id}`,
        ).toHaveLength(0);
    });

    it('clears all fingerprints through the force wipe hook', async () => {
        const [id] = await seedSeason(2);
        const input = (await getAnalyzerInputSnapshot(sql, id))!;
        await saveFingerprint(
            sql,
            {
                mediaId: id,
                pass: 'intro',
                inputIdentity: input.inputIdentity,
                physicalIdentity: 'fixture-stat',
                processingVersion: 4,
                startSec: 0,
                endSec: 600,
            },
            new Uint32Array([1, 2, 3]),
        );
        await lumastraIntroAnalyzerTask.backlog!.wipe!(mockContext({ sql }));
        expect(await sql`SELECT * FROM media_segment_fingerprints`).toHaveLength(0);
    });

    it('rotates lanes so a permanently backlogged season lane cannot starve single episodes or movies', async () => {
        await seedSeason(24);
        const [single] = await seedSeason(1);
        const [movie] = await seedSeason(1);
        await sql`UPDATE media_items SET media_type='movie',parent_id=NULL WHERE id=${movie}`;
        let now = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        detectors.chapters.mockImplementation(async () => {
            now += BUDGET_MS + 1;
            return { chapters: [], durationMs: 1200000 };
        });
        for (let n = 0; n < 3; n++)
            await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
        const done = await completed(ANALYZER_VISUAL_STAGE_ID);
        expect(done).toContain(single);
        expect(done).toContain(movie);
        expect(done).toHaveLength(3);
    });

    it('reports one monotonic scale of completed media items across both detector stages', async () => {
        await settings(true);
        await seedSeason(8);
        const progress = vi.fn();
        await lumastraIntroAnalyzerTask.execute(
            mockContext({ sql, input: {}, onProgress: progress }),
        );
        const values = progress.mock.calls.map(([processed]) => processed as number);
        expect(values.length).toBeGreaterThan(8);
        expect(values).toEqual([...values].sort((a, b) => a - b));
        expect(values.at(-1)).toBe(8);
        for (const [, total] of progress.mock.calls) expect(total).toBeUndefined();
    });

    it('reports pending backlog when a chunk yields', async () => {
        await seedSeason(8);
        const soft = new AbortController();
        const ctx = {
            ...mockContext({ sql, input: {}, onProgress: () => soft.abort() }),
            softSignal: soft.signal,
        };
        const outcome = await lumastraIntroAnalyzerTask.execute(ctx);
        expect(outcome.result).toMatchObject({
            pendingBacklog: { seasons: 1, singleEpisodes: 0, movies: 0 },
        });
    });

    it('keeps a fully drained result when the last item crosses the deadline', async () => {
        const [movie] = await seedSeason(1);
        await sql`UPDATE media_items SET media_type='movie',parent_id=NULL WHERE id=${movie}`;
        let now = Date.now();
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        detectors.chapters.mockImplementation(async () => {
            now += BUDGET_MS + 1;
            return { chapters: [], durationMs: 1200000 };
        });
        const outcome = await lumastraIntroAnalyzerTask.execute(mockContext({ sql, input: {} }));
        expect(outcome.stopReason).toBeUndefined();
        expect(outcome.result).toMatchObject({
            pendingBacklog: { seasons: 0, singleEpisodes: 0, movies: 0 },
        });
    });

    it('measures representative uncompressed head and tail checkpoint row sizes', async () => {
        const [id] = await seedSeason(2);
        const input = (await getAnalyzerInputSnapshot(sql, id))!;
        let random = 0x9e3779b9;
        for (const [pass, length] of [
            ['intro', 4800],
            ['credits', 2400],
        ] as const) {
            const points = Uint32Array.from({ length }, () => {
                random ^= random << 13;
                random ^= random >>> 17;
                random ^= random << 5;
                return random >>> 0;
            });
            await saveFingerprint(
                sql,
                {
                    mediaId: id,
                    pass,
                    inputIdentity: input.inputIdentity,
                    physicalIdentity: 'device:inode:104857600:mtime-ns:ctime-ns',
                    processingVersion: 4,
                    startSec: 0,
                    endSec: length / 8,
                },
                points,
            );
        }
        const sizes =
            await sql`SELECT pass,pg_column_size(f) AS row_bytes,pg_column_size(points) AS point_bytes FROM media_segment_fingerprints f WHERE media_id=${id} ORDER BY pass`;
        console.info('fingerprint checkpoint fixture bytes', JSON.stringify(sizes));
        expect(sizes).toHaveLength(2);
        expect(
            sizes.reduce((total, row) => total + Number(row.point_bytes), 0),
        ).toBeGreaterThanOrEqual(28800);
    });
});
