// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Real native execute, queue/runner and PostgreSQL serialization; detector I/O is controlled. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { requireClient } from './valkey-types.js';
import { TaskRegistry } from './registry.js';
import { TaskOrchestrator } from './orchestrator.js';
import { TaskRunner } from './runner.js';
import { stateMachine } from './state-machine.js';
import { config } from '$lib/server/config.js';
import type { EpisodeWithFile } from './builtin/native/intro-analyzer/types.js';
import { FFmpegTimeoutError } from '$lib/server/utils/ffmpeg-spawn.js';

const mocks = vi.hoisted(() => ({
    timing: vi.fn(),
    blackframe: vi.fn(),
    fingerprint: vi.fn(),
    credits: vi.fn(),
    cohortRead: vi.fn(),
}));
vi.mock('$lib/server/utils/ffprobe-video-timing.js', async (original) => ({
    ...(await original<typeof import('$lib/server/utils/ffprobe-video-timing.js')>()),
    probeVideoTiming: mocks.timing,
}));
vi.mock('./builtin/native/intro-analyzer/blackframe.js', async (original) => ({
    ...(await original<typeof import('./builtin/native/intro-analyzer/blackframe.js')>()),
    analyzeBlackFrames: mocks.blackframe,
}));
vi.mock('./builtin/native/intro-analyzer/chromaprint.js', async (original) => ({
    ...(await original<typeof import('./builtin/native/intro-analyzer/chromaprint.js')>()),
    analyzeSeasonFingerprints: mocks.fingerprint,
    analyzeSeasonCreditsFingerprints: mocks.credits,
}));
vi.mock('$lib/server/database/queries/media-segment-candidates.queries.js', async (original) => {
    const queries =
        await original<
            typeof import('$lib/server/database/queries/media-segment-candidates.queries.js')
        >();
    return {
        ...queries,
        getCandidatesForSeason: async (
            ...args: Parameters<typeof queries.getCandidatesForSeason>
        ) => {
            const rows = await queries.getCandidatesForSeason(...args);
            await mocks.cohortRead();
            return rows;
        },
    };
});
import {
    lumastraIntroAnalyzerTask,
    ANALYZER_VISUAL_STAGE_ID,
    VISUAL_PROCESSING_VERSION,
} from './builtin/native/lumastra-intro-analyzer.js';
import { getAnalyzerInputSnapshot } from '$lib/server/database/queries/media-segment-input.queries.js';
import { toPublicRun } from './run-event.js';
import { RunSchema } from '$lib/schemas/run.schema.js';

const sql = postgres(getTestDatabaseUrl(), { max: 5 });
const TITLE = 'targeted-intro-recovery-fixture';
let mediaId: string;
let fileId: string;
let fixtureDir: string;
function fixturePath(id: string): string {
    return join(fixtureDir, TITLE + '-' + id + '.mkv');
}
let savedRows: { candidates: unknown[]; segments: unknown[] };
async function evidence(): Promise<{ candidates: unknown[]; segments: unknown[] }> {
    return {
        candidates: Array.from(
            await sql`SELECT * FROM media_segment_candidates WHERE media_id = ${mediaId}::uuid ORDER BY id`,
        ),
        segments: Array.from(
            await sql`SELECT * FROM media_segments WHERE media_id = ${mediaId}::uuid ORDER BY id`,
        ),
    };
}
async function seed(): Promise<void> {
    mediaId = randomUUID();
    fileId = randomUUID();
    await writeFile(fixturePath(fileId), 'controlled native detector fixture');
    await sql`INSERT INTO media_items (id, title, media_type, status, is_dismissed) VALUES (${mediaId}::uuid, ${TITLE}, 'movie', 'active', false)`;
    await sql`INSERT INTO media_files (id, file_path, duration_seconds, health_issues) VALUES (${fileId}::uuid, ${fixturePath(fileId)}, 3600, '[{"type":"video_ends_early"}]'::jsonb)`;
    await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default, sort_order) VALUES (${fileId}::uuid, ${mediaId}::uuid, true, 0)`;
    await sql`INSERT INTO media_streams (file_id, stream_type, stream_index) VALUES (${fileId}::uuid, 'video', 0)`;
    await sql`INSERT INTO media_segment_candidates (media_id, type, method, start_time, end_time, confidence, detector_version) VALUES
        (${mediaId}::uuid, 'Intro', 'manual', 10, 40, 1, 1),
        (${mediaId}::uuid, 'Outro', 'cohort', 3500, 3600, .95, 1),
        (${mediaId}::uuid, 'Outro', 'chapter-title', 3480, 3600, .8, 1),
        (${mediaId}::uuid, 'Outro', 'blackframe', 3490, 3600, .7, 1)`;
    await sql`INSERT INTO media_segments (media_id, type, source, start_time, end_time) VALUES (${mediaId}::uuid, 'Intro', 'lumastra-intro-analyzer', 10, 40), (${mediaId}::uuid, 'Outro', 'lumastra-intro-analyzer', 3500, 3600)`;
    await sql`INSERT INTO plugin_failure_events (plugin_id, item_id, stage_id, reason) VALUES ('lumastra-intro-analyzer', ${mediaId}, ${ANALYZER_VISUAL_STAGE_ID}, 'prior decoder failure')`;
}
async function native(
    signal = new AbortController().signal,
    input: Record<string, unknown> = { mediaId },
): Promise<unknown> {
    return lumastraIntroAnalyzerTask.execute(mockContext({ sql, signal, input }));
}
async function unresolved(): Promise<number> {
    const [row] = await sql<
        { count: number }[]
    >`SELECT count(*)::int AS count FROM plugin_failure_events WHERE plugin_id = 'lumastra-intro-analyzer' AND item_id = ${mediaId} AND resolved_at IS NULL`;
    return row.count;
}
async function preserved(allowDetectorUpdates = false): Promise<void> {
    if (!allowDetectorUpdates) expect(await evidence()).toEqual(savedRows);
    const candidates = await sql<
        { method: string }[]
    >`SELECT method FROM media_segment_candidates WHERE media_id = ${mediaId}::uuid ORDER BY method`;
    expect(
        candidates.filter((c) => ['cohort', 'manual'].includes(c.method)).map((c) => c.method),
    ).toEqual(['cohort', 'manual']);
    const [file] = await sql<
        { health_issues: unknown }[]
    >`SELECT health_issues FROM media_files WHERE id = ${fileId}::uuid`;
    expect(file.health_issues).toEqual([{ type: 'video_ends_early' }]);
    const [segment] = await sql<
        { start_time: number; end_time: number }[]
    >`SELECT start_time, end_time FROM media_segments WHERE media_id = ${mediaId}::uuid AND type = 'Intro'`;
    expect(segment).toEqual({ start_time: 10, end_time: 40 });
}

beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'intro-recovery-files-'));
    await connectValkey();
    vi.spyOn(config, 'PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED', 'get').mockReturnValue(true);
    for (const key of ['chapterDetection', 'chromaprintDetection']) {
        await sql`INSERT INTO plugin_settings (plugin_id, key, value) VALUES ('lumastra-intro-analyzer', ${key}, 'false'::jsonb) ON CONFLICT (plugin_id, key) DO UPDATE SET value = EXCLUDED.value`;
    }
});
beforeEach(async () => {
    mocks.timing.mockReset();
    mocks.blackframe.mockReset();
    mocks.timing.mockResolvedValue('inconclusive');
    mocks.blackframe.mockResolvedValue({ kind: 'abstain', reason: 'no-detection' });
    mocks.cohortRead.mockReset().mockResolvedValue(undefined);
    mocks.fingerprint.mockReset().mockResolvedValue(new Map());
    mocks.credits.mockReset().mockResolvedValue(new Map());
    for (const [key, value] of [
        ['chapterDetection', false],
        ['blackframeDetection', true],
        ['chromaprintDetection', false],
    ] as const)
        await sql`INSERT INTO plugin_settings (plugin_id, key, value) VALUES ('lumastra-intro-analyzer', ${key}, ${sql.json(value)}) ON CONFLICT (plugin_id, key) DO UPDATE SET value = EXCLUDED.value`;
    await seed();
    savedRows = await evidence();
});
afterAll(async () => {
    vi.restoreAllMocks();
    await sql`DELETE FROM plugin_settings WHERE plugin_id = 'lumastra-intro-analyzer' AND key IN ('chapterDetection', 'blackframeDetection', 'chromaprintDetection')`;
    await sql`DELETE FROM plugin_failure_events WHERE item_id IN (SELECT id::text FROM media_items WHERE title = ${TITLE})`;
    await sql`DELETE FROM media_items WHERE title = ${TITLE}`;
    await sql`DELETE FROM media_files WHERE file_path LIKE ${fixtureDir + '/%'}`;
    await disconnectValkey();
    await sql.end();
    await rm(fixtureDir, { recursive: true, force: true });
});

describe('selected analysis uses actual persistence', () => {
    it('keeps warnings, manual/cohort markers and prior failure on definite nonadvancing input; no decoder', async () => {
        mocks.timing.mockResolvedValue('nonadvancing');
        expect(await native()).toMatchObject({ success: false, itemsProcessed: 0 });
        expect(mocks.blackframe).not.toHaveBeenCalled();
        expect(mocks.timing).toHaveBeenCalledWith(
            fixturePath(fileId),
            3600,
            expect.any(AbortSignal),
            expect.anything(),
        );
        expect(await unresolved()).toBe(2);
        await preserved();
    });
    it('fails honestly for an ineligible local input without a permanent strike or decoder work', async () => {
        await sql`DELETE FROM media_streams WHERE file_id = ${fileId}::uuid`;
        expect(await native()).toMatchObject({ success: false, itemsProcessed: 0 });
        expect(mocks.timing).not.toHaveBeenCalled();
        expect(mocks.blackframe).not.toHaveBeenCalled();
        expect(await unresolved()).toBe(2);
        const rows = await sql<{ stage_id: string | null }[]>`
            SELECT stage_id FROM plugin_failure_events
            WHERE item_id = ${mediaId} AND reason LIKE 'No eligible local video file%'
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0].stage_id).toBeNull();
        await preserved();
    });

    it('does not resolve history or spend a strike on abort during preflight', async () => {
        const controller = new AbortController();
        mocks.timing.mockImplementation(async () => {
            controller.abort();
            return 'nonadvancing';
        });
        expect(await native(controller.signal)).toMatchObject({ success: false });
        expect(await unresolved()).toBe(1);
        expect(mocks.blackframe).not.toHaveBeenCalled();
        await preserved();
    });
    it('ignores stale DB snapshot evidence without decoder work or failure strike', async () => {
        mocks.timing.mockImplementation(async () => {
            await sql`UPDATE media_files SET file_hash_head = 'replacement-content' WHERE id = ${fileId}::uuid`;
            return 'nonadvancing';
        });
        expect(await native()).toMatchObject({ success: false });
        expect(await unresolved()).toBe(1);
        expect(mocks.blackframe).not.toHaveBeenCalled();
        await preserved();
    });
    it('keeps timeout history uncounted and resolves only after a full successful retry with current content', async () => {
        const unrelatedId = randomUUID();
        await sql`INSERT INTO media_items (id, title, media_type, status, is_dismissed) VALUES (${unrelatedId}::uuid, ${TITLE}, 'movie', 'active', false)`;
        await sql`INSERT INTO plugin_failure_events (plugin_id, item_id, stage_id, reason) VALUES ('lumastra-intro-analyzer', ${unrelatedId}, ${ANALYZER_VISUAL_STAGE_ID}, 'unrelated input failure')`;
        const input = (await getAnalyzerInputSnapshot(sql, mediaId))!;
        await sql`INSERT INTO plugin_failure_events
            (plugin_id, item_id, stage_id, analysis_stage_id, processing_version, input_identity, file_id, reason)
            VALUES ('lumastra-intro-analyzer', ${mediaId}, ${ANALYZER_VISUAL_STAGE_ID},
                ${ANALYZER_VISUAL_STAGE_ID}, ${VISUAL_PROCESSING_VERSION}, ${input.inputIdentity},
                ${fileId}::uuid, 'attributed prior decoder failure')`;
        mocks.blackframe.mockRejectedValueOnce(new FFmpegTimeoutError(1_800_000, ''));
        expect(await native()).toMatchObject({ success: false });
        const [counted] = await sql<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM plugin_failure_events WHERE item_id = ${mediaId} AND stage_id = ${ANALYZER_VISUAL_STAGE_ID} AND resolved_at IS NULL`;
        expect(counted.count).toBe(2); // prior failures only; timeout has no strike stage
        await preserved();
        await sql`UPDATE media_files SET updated_at = now() + interval '1 second' WHERE id = ${fileId}::uuid`;
        await sql`UPDATE media_item_stage_state SET next_eligible_at = now() - interval '1 second' WHERE media_item_id = ${mediaId}::uuid`;
        expect(await native()).toMatchObject({ success: true });
        // d046376876: resolve only attributed failures for the successful input/version.
        // The unverified legacy row remains forensic history.
        expect(await unresolved()).toBe(1);
        const history = await sql`SELECT reason, resolved_at, stage_id, input_identity
            FROM plugin_failure_events WHERE item_id = ${mediaId}`;
        expect(history.filter((row) => row.resolved_at === null).map((row) => row.reason)).toEqual([
            'prior decoder failure',
        ]);
        expect(history.filter((row) => row.input_identity === input.inputIdentity)).toHaveLength(2);
        expect(
            history
                .filter((row) => row.input_identity === input.inputIdentity)
                .every((row) => row.resolved_at !== null),
        ).toBe(true);
        const untouched = await sql<{ resolved_at: Date | null }[]>`
            SELECT resolved_at FROM plugin_failure_events
            WHERE item_id = ${unrelatedId} AND reason = 'unrelated input failure'
        `;
        expect(untouched).toEqual([{ resolved_at: null }]);
        await preserved(true);
    });
});

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for real task lifecycle');
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
}
it.each([true, false, 'skipped'] as const)(
    'serializes the exact native terminal result through TaskRunner (outcome=%s)',
    async (outcome) => {
        const succeeds = outcome === true;
        await sql`DELETE FROM media_segments WHERE media_id = ${mediaId}::uuid`;
        await sql`DELETE FROM media_segment_candidates WHERE media_id = ${mediaId}::uuid`;
        const taskId = `intro-recovery-${randomUUID()}`;
        const registry = new TaskRegistry();
        registry.registerTask(
            defineTask({
                id: taskId,
                name: 'Intro recovery serialization',
                version: '1.0.0',
                processingVersion: 1,
                minAppVersion: '1.0.0',
                resourceClass: 'io',
                capabilities: { database: true },
                inputSchema: z.object({ mediaId: z.string() }).passthrough(),
                identityFor: (input) => input.mediaId,
                execute: (ctx) => lumastraIntroAnalyzerTask.execute(ctx),
            }),
        );
        if (outcome === false) mocks.timing.mockResolvedValue('nonadvancing');
        if (outcome === 'skipped')
            await sql`UPDATE plugin_settings SET value = 'false'::jsonb WHERE plugin_id = 'lumastra-intro-analyzer' AND key = 'blackframeDetection'`;
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
            bootId: randomUUID(),
        });
        let runId: string | undefined;
        try {
            runId = (
                await orch.startRun(
                    taskId,
                    { mediaId },
                    { subject: { type: 'mediaItem', id: mediaId } },
                )
            ).runId;
            await until(async () => (await orch.getRun(runId!))?.state === 'completed');
            const stored = await orch.getRun(runId);
            expect(stored?.result).toMatchObject({
                success: succeeds,
                // d046376876: a committed no-detection pass is processed work.
                itemsProcessed: succeeds ? 1 : 0,
                result: { seasonsProcessed: 0, segmentsProduced: 0 },
            });
            // Use the same serialization and parser as GET /api/runs/{id} and the UI.
            const parsed = RunSchema.parse(JSON.parse(JSON.stringify(toPublicRun(stored!))));
            expect(parsed.result).toEqual(stored?.result);
            if (outcome === 'skipped') {
                expect(parsed.result).toMatchObject({
                    result: { analysisOutcome: 'skipped', skipReason: 'no-methods' },
                });
                expect(await unresolved()).toBe(1);
                expect(mocks.blackframe).not.toHaveBeenCalled();
            }
            expect(parsed.scope).toMatchObject({ subjectType: 'mediaItem', subjectId: mediaId });
        } finally {
            await runner.stop();
            await orch.stop();
            if (runId) await sql`DELETE FROM task_history WHERE id = ${runId}`;
        }
    },
    45_000,
);

it('cancellation during the final catchup slice outranks normal completion and resolves no warning', async () => {
    const controller = new AbortController();
    const result = await lumastraIntroAnalyzerTask.execute(
        mockContext({
            sql,
            input: { mode: 'catchup' },
            signal: controller.signal,
            onProgress: () => {
                controller.abort();
            },
        }),
    );
    expect(result).toMatchObject({ success: false });
    expect(await unresolved()).toBe(1);
    // Progress arrives after valid item work may have committed; preserve that
    // partial work rather than asserting a whole-run rollback. The real runner
    // cancellation-during-detector test below still checks every original row.
    await preserved(true);
});

it('a real runner cancellation aborts native analysis without failure strikes or warning resolution', async () => {
    const taskId = `intro-cancel-${randomUUID()}`;
    const registry = new TaskRegistry();
    let decoding = false;
    let observedAbort = false;
    mocks.blackframe.mockImplementation(
        async (
            _path: string,
            _duration: number,
            _config: unknown,
            _threads: number,
            signal: AbortSignal,
        ) => {
            decoding = true;
            await new Promise<void>((resolve) => {
                signal.addEventListener(
                    'abort',
                    () => {
                        observedAbort = true;
                        resolve();
                    },
                    { once: true },
                );
            });
            return { kind: 'abstain', reason: 'no-detection' };
        },
    );
    registry.registerTask(
        defineTask({
            id: taskId,
            name: 'Native intro cancellation',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            resourceClass: 'io',
            capabilities: { database: true },
            inputSchema: z.object({ mediaId: z.string() }).passthrough(),
            identityFor: (input) => input.mediaId,
            execute: (ctx) => lumastraIntroAnalyzerTask.execute(ctx),
        }),
    );
    const options = { registry, stateMachine, getSql: () => sql, getClient: () => requireClient() };
    const orch = await TaskOrchestrator.start(['io'], options);
    const runner = await TaskRunner.start(['io'], {
        ...options,
        instanceId: taskId,
        bootId: randomUUID(),
    });
    let runId: string | undefined;
    try {
        runId = (
            await orch.startRun(
                taskId,
                { mediaId },
                { subject: { type: 'mediaItem', id: mediaId } },
            )
        ).runId;
        await until(() => decoding);
        await orch.cancelRun(runId, { reason: 'native integration cancellation' });
        await until(() => observedAbort);
        await until(async () => {
            const candidate = await orch.getRun(runId!);
            return !!candidate && ['cancelled', 'failed', 'completed'].includes(candidate.state);
        });
        const stored = await orch.getRun(runId);
        const [persisted] = await sql<
            { state: string; result: unknown }[]
        >`SELECT state, result FROM task_history WHERE id = ${runId}`;
        expect(persisted.state).toBe('completed');
        expect(persisted.result).toMatchObject({ success: false });
        // Generic runner terminal conventions are preserved; none may report a
        // successful native analysis. A completed envelope must retain false.
        if (stored!.state === 'completed') expect(stored!.result).toMatchObject({ success: false });
        const nativeResult = stored!.result;
        expect(
            typeof nativeResult === 'object' &&
                nativeResult !== null &&
                'success' in nativeResult &&
                nativeResult.success === true,
        ).toBe(false);
        expect(await unresolved()).toBe(1);
        await preserved();
    } finally {
        await runner.stop();
        await orch.stop();
        if (runId) await sql`DELETE FROM task_history WHERE id = ${runId}`;
    }
}, 45_000);

async function assertNotCompleted(): Promise<void> {
    const stages =
        await sql`SELECT status FROM media_item_stage_state WHERE media_item_id = ${mediaId}::uuid`;
    expect(stages.every((row) => row.status !== 'completed')).toBe(true);
}
// d046376876 fences content fields, not probe/health bookkeeping in updated_at.
it.each([true, false])('fences generation changed during detector (throws=%s)', async (throws) => {
    mocks.blackframe.mockImplementationOnce(async () => {
        await sql`UPDATE media_files SET file_hash_head = 'replacement-content' WHERE id = ${fileId}::uuid`;
        if (throws) throw new Error('decoder failed after input changed');
        return { kind: 'abstain', reason: 'no-detection' };
    });
    expect(await native()).toMatchObject({ success: false });
    expect(await unresolved()).toBe(1);
    await assertNotCompleted();
    await preserved();
});
it('records a decoder failure against the unchanged input generation', async () => {
    mocks.blackframe.mockRejectedValueOnce(new Error('unchanged bad decoder input'));
    expect(await native()).toMatchObject({ success: false });
    expect(await unresolved()).toBe(2);
    await assertNotCompleted();
    await preserved();
});
it.each(['disabled', 'no-methods', 'no-eligible-targets'])(
    'serializes honest skipped outcome for %s without resolving prior failure',
    async (reason) => {
        let input: Record<string, unknown> = { mediaId };
        if (reason === 'disabled')
            vi.spyOn(config, 'PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED', 'get').mockReturnValueOnce(
                false,
            );
        if (reason === 'no-methods')
            await sql`UPDATE plugin_settings SET value = 'false'::jsonb WHERE plugin_id = 'lumastra-intro-analyzer' AND key = 'blackframeDetection'`;
        if (reason === 'no-eligible-targets') input = { seriesId: randomUUID() };
        const output = JSON.parse(JSON.stringify(await native(undefined, input)));
        expect(output).toMatchObject({
            success: false,
            result: { analysisOutcome: 'skipped', skipReason: reason },
        });
        expect(mocks.blackframe).not.toHaveBeenCalled();
        expect(await unresolved()).toBe(1);
        await preserved();
    },
);
async function parentFixture(): Promise<{ seasonId: string; ids: string[] }> {
    const seriesId = randomUUID();
    const seasonId = randomUUID();
    await sql`INSERT INTO media_items (id, title, media_type, status, is_dismissed) VALUES (${seriesId}::uuid, ${TITLE}, 'tv', 'active', false)`;
    await sql`INSERT INTO media_items (id, title, media_type, parent_id, season_number, status, is_dismissed) VALUES (${seasonId}::uuid, ${TITLE}, 'season', ${seriesId}::uuid, 1, 'active', false)`;
    const ids = [mediaId];
    await seed();
    ids.push(mediaId);
    await sql`UPDATE media_items SET media_type = 'episode', parent_id = ${seasonId}::uuid, runtime_seconds = 3600, episode_number = CASE WHEN id = ${ids[0]}::uuid THEN 1 ELSE 2 END WHERE id = ANY(${ids}::uuid[])`;
    return { seasonId, ids };
}
it.each(['all-failed', 'partial', 'deferred', 'chroma-failed'])(
    'reports actual targeted parent %s outcome and preserves committed partial work',
    async (mode) => {
        const { seasonId, ids } = await parentFixture();
        if (mode === 'all-failed') mocks.blackframe.mockRejectedValue(new Error('decoder failed'));
        if (mode === 'partial')
            mocks.blackframe.mockRejectedValueOnce(new Error('one decoder failed'));
        if (mode === 'deferred' || mode === 'chroma-failed') {
            await sql`UPDATE plugin_settings SET value = 'true'::jsonb WHERE plugin_id = 'lumastra-intro-analyzer' AND key = 'chromaprintDetection'`;
            if (mode === 'chroma-failed') {
                await sql`UPDATE media_files SET created_at = now() - interval '1 day', updated_at = now() - interval '1 day' WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ANY(${ids}::uuid[]))`;
                mocks.fingerprint.mockRejectedValueOnce(new Error('chromaprint failed'));
            }
        }
        const result = JSON.parse(JSON.stringify(await native(undefined, { seasonId })));
        expect(result).toMatchObject({
            success: false,
            result: { analysisOutcome: mode === 'deferred' ? 'deferred' : 'partial' },
        });
        const states =
            await sql`SELECT media_item_id, stage_id, status FROM media_item_stage_state WHERE media_item_id = ANY(${ids}::uuid[])`;
        if (mode === 'all-failed' || mode === 'deferred')
            expect(states.some((row) => row.status === 'completed')).toBe(false);
        else
            expect(
                states.some(
                    (row) =>
                        row.stage_id === ANALYZER_VISUAL_STAGE_ID && row.status === 'completed',
                ),
            ).toBe(true);
        const manual =
            await sql`SELECT start_time, end_time FROM media_segment_candidates WHERE media_id = ANY(${ids}::uuid[]) AND method = 'manual'`;
        expect(manual).toHaveLength(2);
        expect(manual.every((row) => row.start_time === 10 && row.end_time === 40)).toBe(true);
    },
);

it.each(['replaced', 'disappeared', 'unchanged'])(
    'routes decoder failure against a %s physical input generation',
    async (change) => {
        const dir = await mkdtemp(join(tmpdir(), 'intro-recovery-generation-'));
        const path = join(dir, 'input.mkv');
        try {
            await writeFile(path, 'original input generation');
            await sql`UPDATE media_files SET file_path = ${path} WHERE id = ${fileId}::uuid`;
            mocks.blackframe.mockImplementationOnce(async () => {
                if (change === 'disappeared') await rm(path);
                else if (change === 'replaced')
                    await writeFile(path, 'replacement media generation with different payload');
                throw new Error('decoder failed while input changed');
            });
            expect(await native()).toMatchObject({ success: false });
            expect(await unresolved()).toBe(change === 'unchanged' ? 2 : 1);
            await assertNotCompleted();
            await preserved();
        } finally {
            // Restore the fixture cleanup prefix without pretending the physical replacement was analysed.
            await sql`UPDATE media_files SET file_path = ${fixturePath(fileId)} WHERE id = ${fileId}::uuid`;
            await rm(dir, { recursive: true, force: true });
        }
    },
);

it.each(['db', 'physical-replacement', 'physical-removal', 'unchanged'])(
    'routes acoustic failure with %s cohort provenance',
    async (change) => {
        const { seasonId, ids } = await parentFixture();
        await sql`UPDATE plugin_settings SET value = 'true'::jsonb WHERE plugin_id = 'lumastra-intro-analyzer' AND key = 'chromaprintDetection'`;
        await sql`UPDATE plugin_settings SET value = 'false'::jsonb WHERE plugin_id = 'lumastra-intro-analyzer' AND key = 'blackframeDetection'`;
        await sql`UPDATE media_files SET created_at = now() - interval '1 day', updated_at = now() - interval '1 day' WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ANY(${ids}::uuid[]))`;
        mocks.fingerprint.mockImplementationOnce(async () => {
            if (change === 'db')
                await sql`UPDATE media_files SET file_hash_head = 'replacement-content' WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ANY(${ids}::uuid[]))`;
            if (change === 'physical-replacement')
                await writeFile(fixturePath(fileId), 'replacement acoustic input bytes');
            if (change === 'physical-removal') await rm(fixturePath(fileId));
            throw new Error('old cohort decode failed');
        });
        expect(await native(undefined, { seasonId })).toMatchObject({ success: false });
        const failures =
            await sql`SELECT stage_id, resolved_at FROM plugin_failure_events WHERE item_id = ANY(${ids}::text[])`;
        expect(failures).toHaveLength(change === 'unchanged' ? 4 : 2);
        expect(failures.every((row) => row.resolved_at === null)).toBe(true);
        const stages =
            await sql`SELECT status FROM media_item_stage_state WHERE media_item_id = ANY(${ids}::uuid[])`;
        expect(stages.every((row) => row.status !== 'completed')).toBe(true);
    },
);

it.each(['detector', 'cohort'])(
    'does not complete a parent after a successful acoustic %s reaches a stale input fence',
    async (stage) => {
        const { seasonId, ids } = await parentFixture();
        await sql`UPDATE plugin_settings SET value = 'true'::jsonb WHERE plugin_id = 'lumastra-intro-analyzer' AND key = 'chromaprintDetection'`;
        await sql`UPDATE media_files SET created_at = now() - interval '1 day', updated_at = now() - interval '1 day' WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ANY(${ids}::uuid[]))`;
        let changedId = '';
        let firstId = '';
        let beforeChanged: { candidates: unknown[]; segments: unknown[] } | undefined;
        const replaceSelectedInput = async (): Promise<void> => {
            beforeChanged = {
                candidates: Array.from(
                    await sql`SELECT * FROM media_segment_candidates WHERE media_id = ${changedId}::uuid ORDER BY id`,
                ),
                segments: Array.from(
                    await sql`SELECT * FROM media_segments WHERE media_id = ${changedId}::uuid ORDER BY id`,
                ),
            };
            await sql`UPDATE media_files SET file_hash_head = 'replacement-content' WHERE id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ${changedId}::uuid)`;
        };
        mocks.fingerprint.mockImplementationOnce(async (episodes: EpisodeWithFile[]) => {
            firstId = episodes[0].episodeId;
            changedId = episodes[episodes.length - 1].episodeId;
            if (stage === 'detector') await replaceSelectedInput();
            return new Map(
                episodes.map((episode) => [
                    episode.episodeId,
                    {
                        type: 'Intro',
                        method: 'chromaprint',
                        startTime: 20,
                        endTime: 60,
                        confidence: 0.95,
                    },
                ]),
            );
        });
        if (stage === 'cohort') mocks.cohortRead.mockImplementationOnce(replaceSelectedInput);
        expect(await native(undefined, { seasonId })).toMatchObject({ success: false });
        expect(beforeChanged).toBeDefined();
        const afterChanged = {
            candidates: Array.from(
                await sql`SELECT * FROM media_segment_candidates WHERE media_id = ${changedId}::uuid ORDER BY id`,
            ),
            segments: Array.from(
                await sql`SELECT * FROM media_segments WHERE media_id = ${changedId}::uuid ORDER BY id`,
            ),
        };
        expect(afterChanged).toEqual(beforeChanged);
        const failures =
            await sql`SELECT stage_id, resolved_at FROM plugin_failure_events WHERE item_id = ANY(${ids}::text[])`;
        expect(failures).toHaveLength(2);
        expect(failures.every((row) => row.resolved_at === null)).toBe(true);
        const replacementStages =
            await sql`SELECT status FROM media_item_stage_state WHERE media_item_id = ${changedId}::uuid`;
        expect(replacementStages.every((row) => row.status !== 'completed')).toBe(true);
        const committed =
            await sql`SELECT start_time, end_time FROM media_segment_candidates WHERE media_id = ${firstId}::uuid AND method = 'chromaprint'`;
        expect(committed).toEqual([{ start_time: 20, end_time: 60 }]);
    },
);
