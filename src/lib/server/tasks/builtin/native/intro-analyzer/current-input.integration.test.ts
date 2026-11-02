// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import {
    getAnalyzerInputSnapshot,
    getAnalyzerReadiness,
} from '../../../../database/queries/media-segment-input.queries.js';
import {
    getFailureTimeline,
    getFailureAggregates,
    recordFailure as recordRawFailure,
    markFailureEventsResolved,
    countUnresolvedFailuresByPlugin,
} from '../../../../database/queries/plugin-failure-events.queries.js';

const detectors = vi.hoisted(() => ({ chapters: vi.fn(), chroma: vi.fn(), credits: vi.fn() }));
vi.mock('$lib/server/utils/ffprobe.js', async (original) => ({
    ...(await original<typeof import('$lib/server/utils/ffprobe.js')>()),
    probeChapters: detectors.chapters,
}));
vi.mock('./chromaprint.js', async (original) => ({
    ...(await original<typeof import('./chromaprint.js')>()),
    analyzeSeasonFingerprints: detectors.chroma,
    analyzeSeasonCreditsFingerprints: detectors.credits,
}));
import {
    lumastraIntroAnalyzerTask,
    markAnalyzed,
    analyzeSliceOfSeasons,
    readTaskSettings,
    ANALYZER_VISUAL_STAGE_ID,
    ANALYZER_ACOUSTIC_STAGE_ID,
    VISUAL_PROCESSING_VERSION,
    assertAnalysisRetryReady,
} from '../lumastra-intro-analyzer.js';

// Only explicitly attributed fixtures represent failures from a known invocation.
async function recordFailure(...args: Parameters<typeof recordRawFailure>) {
    const lineage = args[6];
    const stage = lineage?.analysisStageId ?? args[5];
    if (lineage && stage)
        args[6] = {
            ...lineage,
            analysisStageId: stage,
            processingVersion:
                lineage.processingVersion ??
                (stage === ANALYZER_ACOUSTIC_STAGE_ID ? 4 : VISUAL_PROCESSING_VERSION),
        };
    return recordRawFailure(...args);
}
const PLUGIN = 'lumastra-intro-analyzer';
let sql: postgres.Sql;
let directory: string;
let item: string;
let file: string;
let mediaPath: string;
const itemIds: string[] = [];
const fileIds: string[] = [];
async function seed(
    type = 'movie',
    parentId?: string,
): Promise<{ id: string; fileId: string; filePath: string }> {
    const id = randomUUID(),
        fileId = randomUUID();
    const filePath = path.join(directory, fileId + '.mkv');
    await writeFile(filePath, 'fictional media bytes');
    const physical = await stat(filePath);
    itemIds.push(id);
    fileIds.push(fileId);
    await sql`INSERT INTO media_items(id,title,media_type,status,parent_id,season_number,episode_number,has_files)
        VALUES (${id},'Fictional current source',${type},'active',${parentId ?? null},1,${itemIds.length},true)`;
    await sql`INSERT INTO media_files(id,file_path,duration_seconds,file_size_bytes,file_mtime,file_hash_head,created_at,updated_at)
        VALUES (${fileId},${filePath},1200,${physical.size},${physical.mtime},'source-a',now()-interval '2 hours',now()-interval '2 hours')`;
    await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default) VALUES (${fileId},${id},true)`;
    await sql`INSERT INTO media_streams(file_id,stream_type,stream_index,codec) VALUES (${fileId},'video',0,'test')`;
    return { id, fileId, filePath };
}
async function runSingle(extra: Record<string, unknown> = {}) {
    return lumastraIntroAnalyzerTask.execute(
        mockContext({ sql, input: { mediaId: item, ...extra }, runId: 'current-input-test-run' }),
    );
}
beforeAll(async () => {
    sql = getTestDb();
    directory = await mkdtemp(path.join(tmpdir(), 'current-input-'));
});
beforeEach(async () => {
    vi.restoreAllMocks();
    detectors.chapters.mockReset();
    detectors.chapters.mockResolvedValue({ chapters: [], durationMs: 1200000 });
    detectors.chroma.mockReset();
    detectors.chroma.mockResolvedValue(new Map());
    detectors.credits.mockReset();
    detectors.credits.mockResolvedValue(new Map());
    await sql`DELETE FROM plugin_failure_events WHERE plugin_id = ${PLUGIN}`;
    await sql`DELETE FROM plugin_settings WHERE plugin_id = ${PLUGIN}`;
    for (const [key, value] of [
        ['chapterDetection', true],
        ['blackframeDetection', false],
        ['chromaprintDetection', false],
    ] as const)
        await sql`INSERT INTO plugin_settings(plugin_id,key,value) VALUES (${PLUGIN},${key},${sql.json(value)})`;
    const seeded = await seed();
    item = seeded.id;
    file = seeded.fileId;
    mediaPath = seeded.filePath;
});
afterAll(async () => {
    await sql`DELETE FROM plugin_failure_events WHERE plugin_id = ${PLUGIN}`;
    await sql`DELETE FROM media_items WHERE id = ANY(${itemIds}::uuid[])`;
    await sql`DELETE FROM media_files WHERE id = ANY(${fileIds}::uuid[])`;
    await sql`DELETE FROM plugin_settings WHERE plugin_id = ${PLUGIN}`;
    await rm(directory, { recursive: true, force: true });
    await closeTestDb();
});

describe('current analyzer input through real consumers', () => {
    it('waits for verified duration/video and selects the same qualifying alternate as execution', async () => {
        await sql`UPDATE media_files SET duration_seconds = NULL WHERE id = ${file}`;
        expect((await getAnalyzerReadiness(sql, item)).state).toBe('awaiting-input');
        expect((await runSingle()).success).toBe(false);
        const alternate = randomUUID();
        fileIds.push(alternate);
        const alternatePath = path.join(directory, alternate + '.mkv');
        await writeFile(alternatePath, 'alternate');
        await sql`INSERT INTO media_files(id,file_path,duration_seconds,file_hash_head) VALUES (${alternate},${alternatePath},1300,'alternate')`;
        await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default) VALUES (${alternate},${item},false)`;
        await sql`INSERT INTO media_streams(file_id,stream_type,stream_index) VALUES (${alternate},'video',0)`;
        expect(await getAnalyzerReadiness(sql, item)).toMatchObject({
            state: 'ready',
            fileId: alternate,
            alternate: true,
            proof: null,
        });
        expect((await runSingle()).success).toBe(true);
        expect(detectors.chapters).toHaveBeenCalledWith(
            alternatePath,
            undefined,
            expect.anything(),
        );
        expect((await getAnalyzerReadiness(sql, item)).proof?.runId).toBe('current-input-test-run');
    });
    it('records an explicit current no-detection pass; unrelated updates do not reset its identity', async () => {
        const before = await getAnalyzerInputSnapshot(sql, item);
        const outcome = await runSingle();
        expect(outcome).toMatchObject({
            success: true,
            itemsProcessed: 1,
            result: {
                itemsAttempted: 1,
                itemsCompleted: 1,
                itemsAbstained: 1,
                segmentsProduced: 0,
                analysisOutcome: 'no-detection',
            },
        });
        const ready = await getAnalyzerReadiness(sql, item);
        expect(ready.proof).toMatchObject({
            inputIdentity: before!.inputIdentity,
            segmentsCount: 0,
            runId: 'current-input-test-run',
        });
        await sql`UPDATE media_items SET title='Fictional updated title',updated_at=clock_timestamp() WHERE id=${item}`;
        await sql`UPDATE media_files SET health_issues='[]'::jsonb,updated_at=clock_timestamp() WHERE id=${file}`;
        expect((await getAnalyzerReadiness(sql, item)).inputIdentity).toBe(before!.inputIdentity);
        expect((await getAnalyzerReadiness(sql, item)).proof).not.toBeNull();
    });
    it('does not treat old completed coverage or a proofless completion call as verified work', async () => {
        await sql`INSERT INTO media_item_stage_state(media_item_id,stage_id,processing_version,status,completed_at)
            VALUES (${item},${ANALYZER_VISUAL_STAGE_ID},${VISUAL_PROCESSING_VERSION},'completed',now())`;
        expect(
            await markAnalyzed(sql, [item], ANALYZER_VISUAL_STAGE_ID, VISUAL_PROCESSING_VERSION),
        ).toEqual([]);
        expect((await getAnalyzerReadiness(sql, item)).proof).toBeNull();
    });
    it.each(['bytes', 'window'])(
        'fences late completion and failure resolution after %s change under the same UUID',
        async (change) => {
            const input = (await getAnalyzerInputSnapshot(sql, item))!;
            await recordFailure(
                sql,
                PLUGIN,
                item,
                'earlier file error',
                'earlier-run',
                ANALYZER_VISUAL_STAGE_ID,
                input,
            );
            if (change === 'bytes')
                await sql`UPDATE media_files SET file_hash_head='source-b' WHERE id=${file}`;
            else
                await sql`UPDATE media_file_items SET start_offset_ms=1000,end_offset_ms=900000 WHERE file_id=${file} AND media_item_id=${item}`;
            expect(
                await markAnalyzed(
                    sql,
                    [item],
                    ANALYZER_VISUAL_STAGE_ID,
                    VISUAL_PROCESSING_VERSION,
                    new Map([[item, input]]),
                ),
            ).toEqual([]);
            expect((await getAnalyzerReadiness(sql, item)).proof).toBeNull();
            expect((await getFailureTimeline(sql, PLUGIN, item))[0]).toMatchObject({
                file_id: file,
                input_identity: input.inputIdentity,
                input_scope: 'earlier',
            });
            const rows =
                await sql`SELECT resolved_at FROM plugin_failure_events WHERE item_id=${item}`;
            expect(rows[0].resolved_at).toBeNull();
        },
    );
    it('drops a real detector continuation when its bytes change, without proving the new input', async () => {
        detectors.chapters.mockImplementationOnce(async () => {
            await sql`UPDATE media_files SET file_hash_head='replacement' WHERE id=${file}`;
            await writeFile(mediaPath, 'replacement content with a different size');
            return { chapters: [], durationMs: 1200000 };
        });
        expect((await runSingle()).success).toBe(false);
        expect((await getAnalyzerReadiness(sql, item)).proof).toBeNull();
        const rows =
            await sql`SELECT status FROM media_item_stage_state WHERE media_item_id=${item}`;
        expect(rows.every((row) => row.status !== 'completed')).toBe(true);
    });
    it('retains earlier and unknown failure history; resolves only this input and stage, with run links', async () => {
        await recordFailure(sql, PLUGIN, item, 'unknown legacy', 'legacy-run');
        const old = (await getAnalyzerInputSnapshot(sql, item))!;
        await recordFailure(
            sql,
            PLUGIN,
            item,
            'old content',
            'old-run',
            ANALYZER_VISUAL_STAGE_ID,
            old,
        );
        await sql`UPDATE media_files SET file_hash_head='new-content' WHERE id=${file}`;
        const current = (await getAnalyzerInputSnapshot(sql, item))!;
        await recordFailure(
            sql,
            PLUGIN,
            item,
            'current visual',
            'visual-run',
            ANALYZER_VISUAL_STAGE_ID,
            current,
        );
        await recordFailure(
            sql,
            PLUGIN,
            item,
            'current acoustic',
            'acoustic-run',
            ANALYZER_ACOUSTIC_STAGE_ID,
            current,
        );
        expect(
            (await getFailureAggregates(sql, PLUGIN, [item], ANALYZER_VISUAL_STAGE_ID, true)).get(
                item,
            )?.failure_count,
        ).toBe(1);
        expect(
            (await countUnresolvedFailuresByPlugin(sql)).find((row) => row.pluginId === PLUGIN)
                ?.count,
        ).toBeGreaterThan(0);
        await markAnalyzed(
            sql,
            [item],
            ANALYZER_VISUAL_STAGE_ID,
            VISUAL_PROCESSING_VERSION,
            new Map([[item, current]]),
        );
        const events = await getFailureTimeline(sql, PLUGIN, item);
        expect(events).toHaveLength(4);
        expect(events.find((event) => event.reason === 'old content')?.input_scope).toBe('earlier');
        expect(events.find((event) => event.reason === 'unknown legacy')?.input_scope).toBe(
            'unverified',
        );
        const retained =
            await sql`SELECT reason,resolved_at FROM plugin_failure_events WHERE item_id=${item}`;
        expect(retained.find((row) => row.reason === 'current visual')?.resolved_at).not.toBeNull();
        for (const reason of ['old content', 'unknown legacy', 'current acoustic'])
            expect(retained.find((row) => row.reason === reason)?.resolved_at).toBeNull();
        expect(await markFailureEventsResolved(sql, PLUGIN, item)).toBe(0);
    });
    it('records scoped result proof without claiming full coverage', async () => {
        expect((await runSingle({ outroOnly: true })).success).toBe(true);
        expect((await getAnalyzerReadiness(sql, item)).proof?.segmentTypes).toEqual(['Outro']);
        expect(
            await sql`SELECT status FROM media_item_stage_state WHERE media_item_id=${item}`,
        ).toHaveLength(0);
    });
    it('propagates input proof through the actual cooperative afterCreated consumer', async () => {
        const ctx = mockContext({ sql, input: {}, runId: 'cooperative-proof' });
        await lumastraIntroAnalyzerTask.processItems!(ctx, [{ id: item, mediaType: 'movie' }]);
        expect((await getAnalyzerReadiness(sql, item)).proof?.runId).toBe('cooperative-proof');
    });
    it('propagates selected input through the global season visual and acoustic consumers', async () => {
        const season = randomUUID();
        itemIds.push(season);
        await sql`INSERT INTO media_items(id,title,media_type,status,season_number) VALUES (${season},'Fictional season','season','active',1)`;
        const first = await seed('episode', season),
            second = await seed('episode', season);
        await sql`UPDATE plugin_settings SET value='true'::jsonb WHERE plugin_id=${PLUGIN} AND key='chromaprintDetection'`;
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now + 3 * 60 * 60_000);
        const ctx = mockContext({ sql });
        await analyzeSliceOfSeasons(
            sql,
            ctx.logger,
            ctx.signal,
            [{ seasonId: season, visualStale: true, acousticStale: true }],
            await readTaskSettings(sql),
            directory,
            undefined,
            {
                types: ['Intro', 'Outro', 'Preview', 'Recap', 'Commercial'],
                visualOnly: false,
                runId: 'global-proof',
            },
        );
        for (const id of [first.id, second.id]) {
            const passes =
                await sql`SELECT stage_id,run_id FROM media_segment_analysis_passes WHERE media_id=${id}`;
            expect(passes).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        stage_id: ANALYZER_VISUAL_STAGE_ID,
                        run_id: 'global-proof',
                    }),
                    expect.objectContaining({
                        stage_id: ANALYZER_ACOUSTIC_STAGE_ID,
                        run_id: 'global-proof',
                    }),
                ]),
            );
        }
    });
});

it('persists cooperative failures with current input and run lineage without inventing completion', async () => {
    detectors.chapters.mockRejectedValueOnce(new Error('fictional decoder failure'));
    await lumastraIntroAnalyzerTask.processItems!(
        mockContext({ sql, input: {}, runId: 'cooperative-failed' }),
        [{ id: item, mediaType: 'movie' }],
    );
    expect((await getAnalyzerReadiness(sql, item)).proof).toBeNull();
    expect((await getFailureTimeline(sql, PLUGIN, item))[0]).toMatchObject({
        run_id: 'cooperative-failed',
        file_id: file,
        input_scope: 'current',
    });
    expect(
        (await sql`SELECT stage_id FROM plugin_failure_events WHERE item_id=${item}`)[0].stage_id,
    ).toBe(ANALYZER_VISUAL_STAGE_ID);
});

it('keeps accepted run references while projecting earlier-source completion as pending', async () => {
    const { PipelineTimelineService } =
        await import('../../../../services/pipeline-timeline.service.js');
    await runSingle();
    const timeline = new PipelineTimelineService(sql, {
        getValkey: () => null,
        runReader: { getRun: async () => null },
    });
    const current = await timeline.buildTimeline(item);
    expect(
        current.stages.find((stage) => stage.stageId === ANALYZER_VISUAL_STAGE_ID),
    ).toMatchObject({
        status: 'completed',
        inputScope: 'current',
        run: { runId: 'current-input-test-run' },
    });
    await sql`UPDATE media_files SET file_hash_head='new-generation' WHERE id=${file}`;
    const replacement = await timeline.buildTimeline(item);
    expect(
        replacement.stages.find((stage) => stage.stageId === ANALYZER_VISUAL_STAGE_ID),
    ).toMatchObject({
        status: 'pending',
        evidenceStatus: 'completed',
        inputScope: 'earlier',
        operatorState: 'waiting',
        prioritizable: false,
        run: { runId: 'current-input-test-run' },
    });
    expect(replacement.summary.completed).toBe(0);
});
it('does not let scoped or older-version proof establish full current stage coverage', async () => {
    const { PipelineTimelineService } =
        await import('../../../../services/pipeline-timeline.service.js');
    await runSingle({ outroOnly: true });
    await sql`INSERT INTO media_item_stage_state(media_item_id,stage_id,processing_version,status,completed_at) VALUES (${item},${ANALYZER_VISUAL_STAGE_ID},${VISUAL_PROCESSING_VERSION},'completed',now())`;
    const timeline = new PipelineTimelineService(sql, {
        getValkey: () => null,
        runReader: { getRun: async () => null },
    });
    expect(
        (await timeline.buildTimeline(item)).stages.find(
            (stage) => stage.stageId === ANALYZER_VISUAL_STAGE_ID,
        ),
    ).toMatchObject({ status: 'pending', inputScope: 'unverified' });
    await runSingle();
    await sql`UPDATE media_item_stage_state SET processing_version=${VISUAL_PROCESSING_VERSION + 1} WHERE media_item_id=${item}`;
    expect(
        (await timeline.buildTimeline(item)).stages.find(
            (stage) => stage.stageId === ANALYZER_VISUAL_STAGE_ID,
        ),
    ).toMatchObject({ status: 'pending', inputScope: 'unverified' });
});
it('counts actual global no-detection work as inspected items rather than segment rows', async () => {
    const outcome = await lumastraIntroAnalyzerTask.execute(
        mockContext({ sql, input: {}, runId: 'global-metrics' }),
    );
    expect(outcome.success).toBe(true);
    expect(outcome.itemsProcessed).toBeGreaterThan(0);
    expect(outcome.result).toMatchObject({
        segmentsProduced: 0,
        analysisOutcome: 'no-detection',
        itemsCompleted: outcome.itemsProcessed,
    });
});

it('does not apply an old-input timeout cooldown to a replacement', async () => {
    const input = (await getAnalyzerInputSnapshot(sql, item))!;
    await recordFailure(sql, PLUGIN, item, 'analysis timeout', 'timed-out-run', null, {
        ...input,
        analysisStageId: ANALYZER_VISUAL_STAGE_ID,
        processingVersion: VISUAL_PROCESSING_VERSION,
    });
    await sql`INSERT INTO media_item_stage_state(media_item_id,stage_id,processing_version,status,skipped_reason,next_eligible_at) VALUES (${item},${ANALYZER_VISUAL_STAGE_ID},${VISUAL_PROCESSING_VERSION},'skipped_transient','analysis-ffmpeg-timeout',now()+interval '1 hour')`;
    await expect(assertAnalysisRetryReady(sql, item)).rejects.toThrow();
    await sql`UPDATE media_files SET file_hash_head='replacement-after-timeout' WHERE id=${file}`;
    await expect(assertAnalysisRetryReady(sql, item)).resolves.toBeUndefined();
});
it('keeps malformed generic analyzer keys as unverified history without breaking current failure queries', async () => {
    await recordFailure(
        sql,
        PLUGIN,
        'fictional-non-uuid-key',
        'legacy diagnostic',
        'legacy-key-run',
    );
    await expect(countUnresolvedFailuresByPlugin(sql)).resolves.toBeDefined();
    expect((await getFailureTimeline(sql, PLUGIN, 'fictional-non-uuid-key'))[0].input_scope).toBe(
        'unverified',
    );
});

it.each([false, true])(
    'uses only selected file windows when the alternate has a combined window (selectedCombined=%s)',
    async (selectedCombined) => {
        const alternate = randomUUID();
        fileIds.push(alternate);
        const alternatePath = path.join(directory, alternate + '.mkv');
        await writeFile(alternatePath, 'fictional alternate');
        await sql`INSERT INTO media_files(id,file_path,duration_seconds) VALUES (${alternate},${alternatePath},1200)`;
        await sql`INSERT INTO media_streams(file_id,stream_type,stream_index) VALUES (${alternate},'video',0)`;
        await sql`INSERT INTO media_file_items(file_id,media_item_id,is_default,start_offset_ms,end_offset_ms) VALUES (${alternate},${item},false,1000,900000)`;
        if (selectedCombined) {
            await sql`UPDATE media_file_items SET is_default=(file_id=${alternate}::uuid) WHERE media_item_id=${item}`;
        }
        detectors.chapters.mockResolvedValue({
            durationMs: 1200000,
            chapters: [
                { index: 0, title: 'Main feature', startTimeMs: 0, endTimeMs: 1100000 },
                { index: 1, title: 'End Credits', startTimeMs: 1100000, endTimeMs: 1200000 },
            ],
        });
        await runSingle();
        expect(detectors.chapters).toHaveBeenCalledWith(
            selectedCombined ? alternatePath : mediaPath,
            undefined,
            expect.anything(),
        );
        const segments =
            await sql`SELECT type FROM media_segments WHERE media_id=${item} AND source=${PLUGIN}`;
        expect(segments.some((segment) => segment.type === 'Outro')).toBe(!selectedCombined);
    },
);

it('binds evidence to effective result settings while ignoring operational knobs and malformed defaults', async () => {
    await runSingle();
    const original = (await getAnalyzerReadiness(sql, item)).inputIdentity;
    await sql`INSERT INTO plugin_settings(plugin_id,key,value) VALUES (${PLUGIN},'batchSize','17'),(${PLUGIN},'maxIntroDuration','"invalid"') ON CONFLICT(plugin_id,key) DO UPDATE SET value=EXCLUDED.value`;
    expect((await getAnalyzerReadiness(sql, item)).inputIdentity).toBe(original);
    await sql`UPDATE plugin_settings SET value='119'::jsonb WHERE plugin_id=${PLUGIN} AND key='maxIntroDuration'`;
    expect((await getAnalyzerReadiness(sql, item)).inputIdentity).not.toBe(original);
    expect((await getAnalyzerReadiness(sql, item)).proof).toBeNull();
    const effective = await readTaskSettings(sql);
    expect((await getAnalyzerInputSnapshot(sql, item, effective))!.inputIdentity).toBe(
        (await getAnalyzerInputSnapshot(sql, item))!.inputIdentity,
    );
    detectors.chapters.mockImplementationOnce(async () => {
        await sql`UPDATE plugin_settings SET value='118'::jsonb WHERE plugin_id=${PLUGIN} AND key='maxIntroDuration'`;
        return { chapters: [], durationMs: 1200000 };
    });
    expect((await runSingle()).success).toBe(false);
    expect((await getAnalyzerReadiness(sql, item)).proof).toBeNull();
});
it('does not expose an old processing-version pass as current readiness proof', async () => {
    await runSingle();
    await sql`UPDATE media_segment_analysis_passes SET processing_version=${VISUAL_PROCESSING_VERSION - 1} WHERE media_id=${item}`;
    expect((await getAnalyzerReadiness(sql, item)).proof).toBeNull();
});
it('keeps global Outro-only work scoped instead of certifying full visual coverage', async () => {
    const outcome = await lumastraIntroAnalyzerTask.execute(
        mockContext({ sql, input: { outroOnly: true }, runId: 'global-outro-scope' }),
    );
    expect(outcome.itemsProcessed).toBeGreaterThan(0);
    const passes =
        await sql`SELECT coverage_complete,segment_types FROM media_segment_analysis_passes WHERE media_id=${item} AND run_id='global-outro-scope'`;
    expect(passes.length).toBeGreaterThan(0);
    expect(passes.every((pass) => pass.coverage_complete === false)).toBe(true);
    expect(passes.every((pass) => JSON.stringify(pass.segment_types) === '["Outro"]')).toBe(true);
    expect(
        await sql`SELECT 1 FROM media_item_stage_state WHERE media_item_id=${item} AND status='completed'`,
    ).toHaveLength(0);
});
it('revalidates configured-disabled movie dispositions instead of projecting them as unverified work', async () => {
    const { PipelineTimelineService } =
        await import('../../../../services/pipeline-timeline.service.js');
    await sql`UPDATE plugin_settings SET value='false'::jsonb WHERE plugin_id=${PLUGIN} AND key IN ('chapterDetection','blackframeDetection')`;
    await sql`INSERT INTO media_item_stage_state(media_item_id,stage_id,processing_version,status,skipped_reason) VALUES (${item},${ANALYZER_VISUAL_STAGE_ID},${VISUAL_PROCESSING_VERSION},'skipped_permanent','movie-visual-detection-disabled')`;
    const timeline = new PipelineTimelineService(sql, {
        getValkey: () => null,
        runReader: { getRun: async () => null },
    });
    expect((await timeline.buildTimeline(item)).stages[0]).toMatchObject({
        status: 'skipped_permanent',
        operatorState: 'skipped',
    });
    await sql`UPDATE plugin_settings SET value='true'::jsonb WHERE plugin_id=${PLUGIN} AND key='chapterDetection'`;
    expect((await timeline.buildTimeline(item)).stages[0]).toMatchObject({
        status: 'pending',
        inputScope: 'unverified',
    });
});
it('removes proven season/movie backlog and re-enrolls same-UUID replacements, ignoring disabled visual work', async () => {
    const { getUnanalyzedMovies, getUnanalyzedSeasons, ACOUSTIC_PROCESSING_VERSION } =
        await import('../lumastra-intro-analyzer.js');
    await runSingle();
    expect(
        (
            await getUnanalyzedMovies(
                sql,
                ANALYZER_VISUAL_STAGE_ID,
                VISUAL_PROCESSING_VERSION,
                1000,
            )
        ).map((row) => row.mediaId),
    ).not.toContain(item);
    await sql`UPDATE media_files SET file_hash_head='new-movie-bytes' WHERE id=${file}`;
    expect(
        (
            await getUnanalyzedMovies(
                sql,
                ANALYZER_VISUAL_STAGE_ID,
                VISUAL_PROCESSING_VERSION,
                1000,
            )
        ).map((row) => row.mediaId),
    ).toContain(item);
    await sql`UPDATE plugin_settings SET value='false'::jsonb WHERE plugin_id=${PLUGIN} AND key IN ('chapterDetection','blackframeDetection')`;
    const season = randomUUID();
    itemIds.push(season);
    await sql`INSERT INTO media_items(id,title,media_type,status,season_number) VALUES (${season},'Fictional backlog season','season','active',1)`;
    const first = await seed('episode', season),
        second = await seed('episode', season);
    for (const id of [first.id, second.id]) {
        const proof = (await getAnalyzerInputSnapshot(sql, id))!;
        await markAnalyzed(
            sql,
            [id],
            ANALYZER_ACOUSTIC_STAGE_ID,
            ACOUSTIC_PROCESSING_VERSION,
            new Map([[id, proof]]),
        );
    }
    const backlog = () =>
        getUnanalyzedSeasons(
            sql,
            ANALYZER_VISUAL_STAGE_ID,
            VISUAL_PROCESSING_VERSION,
            ANALYZER_ACOUSTIC_STAGE_ID,
            ACOUSTIC_PROCESSING_VERSION,
            true,
            1000,
            false,
        );
    expect((await backlog()).map((row) => row.seasonId)).not.toContain(season);
    await sql`UPDATE media_files SET file_hash_head='new-episode-bytes' WHERE id=${first.fileId}`;
    expect((await backlog()).find((row) => row.seasonId === season)).toMatchObject({
        visualStale: false,
        acousticStale: true,
    });
});
it('counts unique actual visual+acoustic items and excludes stale rejected cohort completion', async () => {
    const season = randomUUID();
    itemIds.push(season);
    await sql`INSERT INTO media_items(id,title,media_type,status,season_number) VALUES (${season},'Fictional metrics season','season','active',1)`;
    const first = await seed('episode', season);
    await seed('episode', season);
    await sql`UPDATE plugin_settings SET value='true'::jsonb WHERE plugin_id=${PLUGIN} AND key='chromaprintDetection'`;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60 * 60_000);
    const complete = await lumastraIntroAnalyzerTask.execute(
        mockContext({ sql, input: { seasonId: season }, runId: 'dual-metrics' }),
    );
    expect(complete).toMatchObject({
        success: true,
        itemsProcessed: 2,
        result: { itemsAttempted: 2, itemsCompleted: 2, segmentsProduced: 0 },
    });
    expect(
        await sql`SELECT 1 FROM media_segment_analysis_passes WHERE run_id='dual-metrics'`,
    ).toHaveLength(4);
    detectors.chroma.mockImplementationOnce(async () => {
        await sql`UPDATE media_files SET file_hash_head='changed-during-cohort' WHERE id=${first.fileId}`;
        return new Map();
    });
    const rejected = await lumastraIntroAnalyzerTask.execute(
        mockContext({ sql, input: { seasonId: season }, runId: 'rejected-metrics' }),
    );
    expect(rejected).toMatchObject({
        success: false,
        itemsProcessed: 0,
        result: { itemsAttempted: 2, itemsCompleted: 0 },
    });
    expect(
        await sql`SELECT 1 FROM media_segment_analysis_passes WHERE run_id='rejected-metrics'`,
    ).toHaveLength(0);
});

it('abstains when an enumerated episode moved to another season before fingerprint snapshots', async () => {
    const oldSeason = randomUUID(),
        newSeason = randomUUID();
    itemIds.push(oldSeason, newSeason);
    await sql`INSERT INTO media_items(id,title,media_type,status,season_number) VALUES (${oldSeason},'Fictional former season','season','active',1),(${newSeason},'Fictional new season','season','active',2)`;
    const moved = await seed('episode', oldSeason);
    await seed('episode', oldSeason);
    await sql`UPDATE plugin_settings SET value='true'::jsonb WHERE plugin_id=${PLUGIN} AND key='chromaprintDetection'`;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60 * 60_000);
    let changed = false;
    const racing = new Proxy(sql, {
        apply(target, thisArg, args) {
            if (!changed && Array.isArray(args[0]) && args[0].join('').includes('AS "mediaId"')) {
                changed = true;
                return (async () => {
                    await sql`UPDATE media_items SET parent_id=${newSeason} WHERE id=${moved.id}`;
                    return Reflect.apply(target, thisArg, args);
                })();
            }
            return Reflect.apply(target, thisArg, args);
        },
    });
    const { analyzeSingleSeasonChromaprint } = await import('../lumastra-intro-analyzer.js');
    const ctx = mockContext({ sql: racing, input: {} });
    expect(
        await analyzeSingleSeasonChromaprint(
            racing,
            ctx.logger,
            ctx.signal,
            oldSeason,
            directory,
            await readTaskSettings(sql),
        ),
    ).toMatchObject({ unavailable: true, segments: 0 });
    expect(changed).toBe(true);
    expect(detectors.chroma).not.toHaveBeenCalled();
});

it('keeps a current single-episode disabled-policy skip terminal only until its policy changes', async () => {
    const { PipelineTimelineService } =
        await import('../../../../services/pipeline-timeline.service.js');
    const season = randomUUID();
    itemIds.push(season);
    await sql`INSERT INTO media_items(id,title,media_type,status,season_number) VALUES (${season},'Fictional disabled season','season','active',1)`;
    await sql`UPDATE media_items SET media_type='episode',parent_id=${season} WHERE id=${item}`;
    await sql`UPDATE media_files SET created_at=now()-interval '2 hours',updated_at=now()-interval '2 hours',file_mtime=now()-interval '2 hours' WHERE id=${file}`;
    await sql`UPDATE plugin_settings SET value='false'::jsonb WHERE plugin_id=${PLUGIN} AND key IN ('chapterDetection','blackframeDetection')`;
    await sql`INSERT INTO media_item_stage_state(media_item_id,stage_id,processing_version,status,skipped_reason) VALUES (${item},${ANALYZER_VISUAL_STAGE_ID},${VISUAL_PROCESSING_VERSION},'skipped_permanent','single-episode-detection-disabled')`;
    const timeline = new PipelineTimelineService(sql, {
        getValkey: () => null,
        runReader: { getRun: async () => null },
    });
    expect((await timeline.buildTimeline(item)).stages[0]).toMatchObject({
        status: 'skipped_permanent',
        operatorState: 'skipped',
    });
    await seed('episode', season);
    expect((await timeline.buildTimeline(item)).stages[0]).toMatchObject({
        status: 'pending',
        inputScope: 'unverified',
    });
});

it.each(['season', 'tv'])(
    'rejects completion after a live %s ancestor is deleted while the detector awaits',
    async (kind) => {
        const series = randomUUID(),
            season = randomUUID();
        itemIds.push(series, season);
        await sql`INSERT INTO media_items(id,title,media_type,status,parent_id,season_number) VALUES (${series},'Fictional ancestry series','tv','active',NULL,NULL),(${season},'Fictional ancestry season','season','active',${series},1)`;
        await sql`UPDATE media_items SET media_type='episode',parent_id=${season} WHERE id=${item}`;
        const input = (await getAnalyzerInputSnapshot(sql, item))!;
        await recordFailure(
            sql,
            PLUGIN,
            item,
            'retained ancestor error',
            'ancestor-run',
            ANALYZER_VISUAL_STAGE_ID,
            input,
        );
        detectors.chapters.mockImplementationOnce(async () => {
            await sql`UPDATE media_items SET status='deleted' WHERE id=${kind === 'season' ? season : series}`;
            return { chapters: [], durationMs: 1200000 };
        });
        expect((await runSingle()).success).toBe(false);
        expect(await getAnalyzerInputSnapshot(sql, item)).toBeNull();
        expect((await getAnalyzerReadiness(sql, item)).proof).toBeNull();
        expect(
            await sql`SELECT 1 FROM media_segment_analysis_passes WHERE media_id=${item}`,
        ).toHaveLength(0);
        expect((await getFailureTimeline(sql, PLUGIN, item))[0].input_scope).toBe('earlier');
        expect(
            (await sql`SELECT resolved_at FROM plugin_failure_events WHERE item_id=${item}`)[0]
                .resolved_at,
        ).toBeNull();
    },
);

it('drains scoped manual work across multiple season, single-episode and movie batches without full coverage', async () => {
    // The global producer must inspect this fixture, not prior tests' deliberately broken inputs.
    await sql`UPDATE media_items SET status='deleted' WHERE id=ANY(${itemIds}::uuid[]) AND id<>${item}::uuid`;
    const expected = [item];
    for (let index = 0; index < 3; index++) {
        const season = randomUUID();
        itemIds.push(season);
        await sql`INSERT INTO media_items(id,title,media_type,status,season_number) VALUES (${season},'Fictional scoped batch season','season','active',1)`;
        expected.push((await seed('episode', season)).id);
        if (index < 2) expected.push((await seed('episode', season)).id);
        expected.push((await seed()).id);
    }
    await sql`INSERT INTO plugin_settings(plugin_id,key,value) VALUES (${PLUGIN},'batchSize','1')`;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60 * 60_000);
    const outcome = await lumastraIntroAnalyzerTask.execute(
        mockContext({
            sql,
            input: { outroOnly: true, mode: 'manual' },
            runId: 'multi-batch-scoped',
        }),
    );
    expect(outcome.success, JSON.stringify(outcome)).toBe(true);
    const passes =
        await sql`SELECT media_id,coverage_complete FROM media_segment_analysis_passes WHERE run_id='multi-batch-scoped'`;
    for (const id of expected) expect(passes.map((row) => row.media_id)).toContain(id);
    expect(passes.every((row) => row.coverage_complete === false)).toBe(true);
    expect(
        await sql`SELECT 1 FROM media_item_stage_state WHERE media_item_id=ANY(${expected}::uuid[]) AND status='completed'`,
    ).toHaveLength(0);
});

it('keeps old and unknown detector-version history out of current strikes and preserves it after success', async () => {
    const input = (await getAnalyzerInputSnapshot(sql, item))!;
    for (let index = 0; index < 5; index++)
        await recordRawFailure(
            sql,
            PLUGIN,
            item,
            'earlier detector error',
            'old-detector',
            ANALYZER_VISUAL_STAGE_ID,
            {
                ...input,
                analysisStageId: ANALYZER_VISUAL_STAGE_ID,
                processingVersion: VISUAL_PROCESSING_VERSION - 1,
            },
        );
    await recordRawFailure(
        sql,
        PLUGIN,
        item,
        'unknown detector version',
        'unknown-detector',
        ANALYZER_VISUAL_STAGE_ID,
        input,
    );
    expect(
        (await getFailureAggregates(sql, PLUGIN, [item], ANALYZER_VISUAL_STAGE_ID, true)).has(item),
    ).toBe(false);
    const history = await getFailureTimeline(sql, PLUGIN, item);
    expect(history.filter((row) => row.input_scope === 'earlier')).toHaveLength(5);
    expect(history.filter((row) => row.input_scope === 'unverified')).toHaveLength(1);
    detectors.chapters.mockRejectedValueOnce(new Error('current detector transient issue'));
    await runSingle();
    expect(
        (await getFailureAggregates(sql, PLUGIN, [item], ANALYZER_VISUAL_STAGE_ID, true)).get(item)
            ?.failure_count,
    ).toBe(1);
    expect(
        await sql`SELECT 1 FROM media_item_stage_state WHERE media_item_id=${item} AND status='skipped_permanent'`,
    ).toHaveLength(0);
    detectors.chapters.mockResolvedValue({ chapters: [], durationMs: 1200000 });
    expect((await runSingle()).success).toBe(true);
    const retained =
        await sql`SELECT resolved_at FROM plugin_failure_events WHERE item_id=${item} AND run_id IN ('old-detector','unknown-detector')`;
    expect(retained).toHaveLength(6);
    expect(retained.every((row) => row.resolved_at === null)).toBe(true);
});

it('keeps an unadvanced scoped drain partial when the selected input repeatedly disappears before inspection', async () => {
    await sql`UPDATE media_items SET status='deleted' WHERE id=ANY(${itemIds}::uuid[]) AND id<>${item}::uuid`;
    let interruptedReads = 0;
    const racing = new Proxy(sql, {
        apply(target, thisArg, args) {
            const query = Array.isArray(args[0]) ? args[0].join('') : '';
            if (query.includes('SELECT DISTINCT ON (mi.id)') && query.includes('AS "mediaId"')) {
                return (async () => {
                    interruptedReads++;
                    await sql`UPDATE media_files SET duration_seconds=NULL WHERE id=${file}`;
                    try {
                        return await Reflect.apply(target, thisArg, args);
                    } finally {
                        await sql`UPDATE media_files SET duration_seconds=1200 WHERE id=${file}`;
                    }
                })();
            }
            return Reflect.apply(target, thisArg, args);
        },
    });
    const ctx = mockContext({
        sql: racing,
        input: { outroOnly: true as const, mode: 'manual' },
        runId: 'scoped-no-progress',
    });
    const warnings = vi.spyOn(ctx.logger, 'warn');
    const outcome = await lumastraIntroAnalyzerTask.execute(ctx);
    expect(interruptedReads).toBe(1);
    expect(warnings).toHaveBeenCalledWith(
        expect.stringMatching(/drain stalled.*movies.*same slice returned twice/),
    );
    expect(outcome).toMatchObject({
        success: false,
        itemsProcessed: 0,
        result: { analysisOutcome: 'partial', itemsCompleted: 0 },
    });
    expect(detectors.chapters).not.toHaveBeenCalled();
    expect(await getAnalyzerReadiness(sql, item)).toMatchObject({ state: 'ready', proof: null });
    const { getUnanalyzedMovies } = await import('../lumastra-intro-analyzer.js');
    expect(
        (
            await getUnanalyzedMovies(sql, ANALYZER_VISUAL_STAGE_ID, VISUAL_PROCESSING_VERSION, 1)
        ).map((row) => row.mediaId),
    ).toEqual([item]);
});

it('inspects a replacement under the same UUID in a later scoped batch without removing the no-progress guard', async () => {
    await sql`UPDATE media_items SET status='deleted' WHERE id=ANY(${itemIds}::uuid[]) AND id<>${item}::uuid`;
    let movieSelections = 0;
    const racing = new Proxy(sql, {
        apply(target, thisArg, args) {
            const query = Array.isArray(args[0]) ? args[0].join('') : '';
            if (query.includes('SELECT mi.id AS "mediaId"')) {
                movieSelections++;
                if (movieSelections === 2) {
                    return (async () => {
                        await sql`UPDATE media_files SET file_hash_head='within-run-replacement' WHERE id=${file}`;
                        return Reflect.apply(target, thisArg, args);
                    })();
                }
            }
            return Reflect.apply(target, thisArg, args);
        },
    });
    const outcome = await lumastraIntroAnalyzerTask.execute(
        mockContext({
            sql: racing,
            input: { outroOnly: true, mode: 'manual' },
            runId: 'within-run-replacement',
        }),
    );
    expect(outcome).toMatchObject({
        success: true,
        itemsProcessed: 1,
        result: { itemsAttempted: 1, itemsCompleted: 1 },
    });
    // Three drain selections plus the final pending-backlog measurement.
    expect(movieSelections).toBe(4);
    expect(detectors.chapters).toHaveBeenCalledTimes(2);
    const passes =
        await sql`SELECT input_identity,coverage_complete FROM media_segment_analysis_passes
        WHERE media_id=${item} AND run_id='within-run-replacement'`;
    expect(new Set(passes.map((row) => row.input_identity)).size).toBe(2);
    expect(passes.every((row) => row.coverage_complete === false)).toBe(true);
    expect((await getAnalyzerReadiness(sql, item)).proof?.runId).toBe('within-run-replacement');
});

it('uses ordinary acoustic staleness for library Outro refresh and visual-only work for explicit targets', async () => {
    await sql`UPDATE media_items SET status='deleted' WHERE id=ANY(${itemIds}::uuid[])`;
    const season = randomUUID();
    itemIds.push(season);
    await sql`INSERT INTO media_items(id,title,media_type,status,season_number)
        VALUES (${season},'Fictional scope policy season','season','active',1)`;
    const first = await seed('episode', season),
        second = await seed('episode', season);
    await sql`UPDATE plugin_settings SET value='true'::jsonb
        WHERE plugin_id=${PLUGIN} AND key='chromaprintDetection'`;
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60 * 60_000);
    const stale = await lumastraIntroAnalyzerTask.execute(
        mockContext({
            sql,
            input: { outroOnly: true, mode: 'manual' },
            runId: 'scoped-stale-acoustic',
        }),
    );
    expect(stale.success).toBe(true);
    expect(detectors.chroma).toHaveBeenCalledTimes(1);
    expect(detectors.credits).toHaveBeenCalledTimes(1);
    expect(
        await sql`SELECT 1 FROM media_segment_analysis_passes
        WHERE stage_id=${ANALYZER_ACOUSTIC_STAGE_ID} AND run_id='scoped-stale-acoustic'`,
    ).toHaveLength(2);
    const { ACOUSTIC_PROCESSING_VERSION } = await import('../lumastra-intro-analyzer.js');
    for (const id of [first.id, second.id]) {
        const input = (await getAnalyzerInputSnapshot(sql, id))!;
        await markAnalyzed(
            sql,
            [id],
            ANALYZER_ACOUSTIC_STAGE_ID,
            ACOUSTIC_PROCESSING_VERSION,
            new Map([[id, input]]),
        );
    }
    detectors.chroma.mockClear();
    detectors.credits.mockClear();
    detectors.chapters.mockClear();
    expect(
        (
            await lumastraIntroAnalyzerTask.execute(
                mockContext({
                    sql,
                    input: { outroOnly: true, mode: 'manual' },
                    runId: 'scoped-current-acoustic',
                }),
            )
        ).success,
    ).toBe(true);
    expect(detectors.chapters).toHaveBeenCalledTimes(2);
    expect(detectors.chroma).not.toHaveBeenCalled();
    expect(detectors.credits).not.toHaveBeenCalled();
    expect(
        await sql`SELECT 1 FROM media_item_stage_state WHERE media_item_id=ANY(${[first.id, second.id]}::uuid[])
        AND stage_id=${ANALYZER_ACOUSTIC_STAGE_ID} AND status='completed'`,
    ).toHaveLength(2);
    await sql`DELETE FROM media_segment_analysis_passes WHERE media_id=ANY(${[first.id, second.id]}::uuid[])
        AND stage_id=${ANALYZER_ACOUSTIC_STAGE_ID}`;
    await sql`DELETE FROM media_item_stage_state WHERE media_item_id=ANY(${[first.id, second.id]}::uuid[])
        AND stage_id=${ANALYZER_ACOUSTIC_STAGE_ID}`;
    detectors.chapters.mockClear();
    expect(
        (
            await lumastraIntroAnalyzerTask.execute(
                mockContext({
                    sql,
                    input: { seasonId: season, outroOnly: true },
                    runId: 'explicit-visual-scope',
                }),
            )
        ).success,
    ).toBe(true);
    expect(detectors.chapters).toHaveBeenCalledTimes(2);
    expect(detectors.chroma).not.toHaveBeenCalled();
    expect(detectors.credits).not.toHaveBeenCalled();
    expect(
        await sql`SELECT 1 FROM media_segment_analysis_passes
        WHERE run_id='explicit-visual-scope' AND stage_id=${ANALYZER_ACOUSTIC_STAGE_ID}`,
    ).toHaveLength(0);
});

it.each(['self', 'season', 'series'])(
    'excludes a deleted %s before detector reads and rejects its earlier completion input',
    async (deleted) => {
        const series = randomUUID(),
            season = randomUUID();
        itemIds.push(series, season);
        await sql`INSERT INTO media_items(id,title,media_type,status,parent_id,season_number)
            VALUES (${series},'Fictional pre-selection series','tv','active',NULL,NULL),
                   (${season},'Fictional pre-selection season','season','active',${series},1)`;
        await sql`UPDATE media_items SET media_type='episode',parent_id=${season} WHERE id=${item}`;
        await seed('episode', season);
        const before = (await getAnalyzerInputSnapshot(sql, item))!;
        await sql`UPDATE media_items SET status='deleted'
            WHERE id=${deleted === 'self' ? item : deleted === 'season' ? season : series}`;
        expect((await runSingle()).success).toBe(false);
        expect(await getAnalyzerInputSnapshot(sql, item)).toBeNull();
        expect(detectors.chapters).not.toHaveBeenCalled();
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 3 * 60 * 60_000);
        const { analyzeSingleSeasonChromaprint } = await import('../lumastra-intro-analyzer.js');
        const ctx = mockContext({ sql, input: {} });
        expect(
            await analyzeSingleSeasonChromaprint(
                sql,
                ctx.logger,
                ctx.signal,
                season,
                directory,
                await readTaskSettings(sql),
            ),
        ).toMatchObject({ segments: 0, unavailable: true });
        expect(detectors.chroma).not.toHaveBeenCalled();
        expect(detectors.credits).not.toHaveBeenCalled();
        expect(
            await markAnalyzed(
                sql,
                [item],
                ANALYZER_VISUAL_STAGE_ID,
                VISUAL_PROCESSING_VERSION,
                new Map([[item, before]]),
            ),
        ).toEqual([]);
        expect(
            await sql`SELECT 1 FROM media_segment_analysis_passes WHERE media_id=${item}`,
        ).toHaveLength(0);
    },
);
