// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, Worker } from 'bullmq';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../../../../tests/integration/setup/test-database.js';
const mocks = vi.hoisted(() => ({
    tails: vi.fn(),
    inventory: vi.fn(),
    measurement: vi.fn(),
    keyframes: vi.fn(),
    probe: vi.fn(),
    fetch: vi.fn(),
}));
vi.mock('$lib/auth-monitor.js', () => ({
    monitoredFetch: mocks.fetch,
    handleAuthExpiration: vi.fn(),
}));
vi.mock('$lib/server/utils/ffprobe.js', async (original) => ({
    ...(await original<typeof import('$lib/server/utils/ffprobe.js')>()),
    probeStreamTails: mocks.tails,
    probeKeyframes: mocks.keyframes,
    probeMediaFile: mocks.probe,
}));
vi.mock('$lib/server/utils/audio-tail-assessment.js', () => ({
    readTailInventory: mocks.inventory,
    measureAudioTail: mocks.measurement,
}));
vi.mock('$lib/server/utils/file-presence.js', () => ({
    assessFilePresence: vi.fn().mockResolvedValue('present'),
}));
import { mediaProbeTask, processPhaseBSlice } from '../media-probe.js';
import { buildAdminContextStub } from '../../../plugin-context.js';
import {
    upsertMediaFile,
    recordDecodeHealthIssue,
} from '$lib/server/database/queries/media-files.queries.js';
import { replaceStreamsForFile } from '$lib/server/database/queries/media-streams.queries.js';
import { config } from '$lib/server/config.js';
import { assessFilePresence } from '$lib/server/utils/file-presence.js';
import { recordFailure } from '$lib/server/database/queries/plugin-failure-events.queries.js';
import type { FileHealthRecheckResult } from '$lib/schemas/file-health-recheck.js';
import type { RequestEvent } from '@sveltejs/kit';
import { TaskRunner } from '../../../runner.js';
import { getQueueConnectionOptions } from '../../../connection.js';
import { PER_TASK_QUEUE_PREFIX } from '../../../queue-naming.js';
import { TaskOrchestrator, orchestrator as facade } from '../../../orchestrator.js';
import { TaskRegistry } from '../../../registry.js';
import { stateMachine } from '../../../state-machine.js';
import { requireClient } from '../../../valkey-types.js';
import { insertTaskHistoryRow } from '../../../task-history.js';
import * as valkey from '$lib/server/cache/valkey.js';
import { mount } from '$lib/server/api/mount.js';
import { getAdminTailAssessments } from '$lib/server/database/queries/file-health-assessment.queries.js';
import { def as healthDef } from '$lib/server/api/defs/admin/media/file-health.js';
import { def as runDetail } from '$lib/server/api/defs/runs/[id].js';
import { adminSession, principalLocals } from '$lib/server/api/principal-locals.test-helpers.js';
import { awaitFileHealthRecheck } from '$lib/api/file-health-recheck.js';
import { fileHealthRecheckMessage } from '$lib/utils/file-health-issue.js';
const sql = getTestDb();
const tailIssue = { type: 'video_ends_early', detected_at: '2026-10-01T00:00:00Z' };
const gap = {
    type: 'video_decode_gaps',
    detected_at: '2026-10-02T00:00:00Z',
    detail: 'decode gap remains',
};
const video = {
    index: 0,
    codec: 'h264',
    width: 1920,
    height: 1080,
    fps: 24,
    pixelFormat: 'yuv420p',
    colorPrimaries: null,
    colorTransfer: null,
    refFrames: null,
    bitrate: null,
    hdr: 'sdr',
    colorSpace: null,
    profile: null,
    level: null,
    masterDisplay: null,
    maxCll: null,
    closedCaptions: false,
    fieldOrder: null,
};
const files: string[] = [];
const physicalDir = mkdtempSync(join(tmpdir(), 'selected-health-'));
const physicalPaths = new Map<string, string>();
async function seed(
    issues: unknown[] | null = [tailIssue],
    probed = true,
    keyframes = true,
): Promise<string> {
    const filePath = join(physicalDir, `${crypto.randomUUID()}.mkv`);
    writeFileSync(filePath, 'controlled source bytes');
    const { id } = await upsertMediaFile(sql, { filePath });
    physicalPaths.set(id, filePath);
    files.push(id);
    await sql`UPDATE media_files SET health_issues = ${sql.json(issues as postgres.JSONValue)}, duration_seconds = 1000,
        keyframes = ${keyframes ? sql.json([0, 990]) : null}, probed_at = ${probed ? new Date() : null}, audit_run_job_id = 'old-run'
        WHERE id = ${id}::uuid`;
    return id;
}
async function check(fileId: string, signal = new AbortController().signal, db = sql) {
    return mediaProbeTask.execute({
        ...buildAdminContextStub('media-probe', { sql: db, signal }),
        input: { fileId },
    });
}
async function issues(fileId: string) {
    const [row] =
        await sql`SELECT health_issues, audit_run_job_id FROM media_files WHERE id = ${fileId}::uuid`;
    return row;
}
beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    mocks.inventory.mockResolvedValue({
        streams: [
            { index: 0, codec_type: 'video' },
            {
                index: 1,
                codec_type: 'audio',
                channels: 2,
                sample_rate: '48000',
                start_time: '0.0',
                time_base: '1/1000',
            },
        ],
        signature: 'inventory-one',
    });
    mocks.measurement.mockImplementation(async (_path, _videoEnd, _audioEnd, source) => ({
        version: 1,
        measuredAt: new Date().toISOString(),
        method: 'ffmpeg-astats-frames-v1',
        thresholdDbfs: -60,
        completeness: 'unverified',
        scope: 'partial',
        observation: 'unknown',
        inventory: [],
        inventorySignature: 'inventory-one',
        source,
        limits: { seconds: 180, streams: 8, concurrency: 2, budgetMs: 90000 },
        reasons: ['no_measurable_post_video_interval'],
        streams: [],
    }));
    mocks.tails.mockResolvedValue({
        success: true,
        videoEnd: 995,
        audioEnd: 999,
        hasAudio: true,
        endedPrematurely: false,
    });
    mocks.keyframes.mockResolvedValue({ success: true, keyframes: [0, 990], lastPacketPts: 999 });
    mocks.probe.mockResolvedValue({
        success: true,
        video: null,
        audioStreams: [],
        subtitleStreams: [],
        duration: 1000,
        container: 'matroska',
        fileSize: 1000000,
        formatBitrate: null,
    });
});
/** Attempt every owned cleanup independently, preserving primary and teardown failures. */
async function settleCleanup(
    actions: Array<() => Promise<unknown>>,
    primary?: unknown,
): Promise<void> {
    const failures: unknown[] = primary === undefined ? [] : [primary];
    for (const action of actions) {
        try {
            await action();
        } catch (error) {
            failures.push(error);
        }
    }
    if (failures.length)
        throw new AggregateError(failures, 'Selected-file integration cleanup/test failed');
}
afterAll(async () => {
    await settleCleanup([
        ...files.flatMap((id) => [
            async () =>
                sql`DELETE FROM plugin_failure_events WHERE plugin_id = 'media-probe' AND item_id = ${id}`,
            async () => sql`DELETE FROM media_files WHERE id = ${id}::uuid`,
        ]),
        async () => {
            rmSync(physicalDir, { recursive: true, force: true });
        },
        closeTestDb,
    ]);
});
it('rechecks exactly one health-only unlinked file and fabricates no failure history', async () => {
    const selected = await seed();
    const other = await seed();
    const result = await check(selected);
    expect(result.result?.recheck?.outcome).toBe('healthy');
    expect((await issues(selected)).health_issues).toBeNull();
    expect((await issues(other)).health_issues).toEqual([tailIssue]);
    expect(mocks.tails).toHaveBeenCalledTimes(1);
    const [count] =
        await sql`SELECT COUNT(*)::int AS n FROM plugin_failure_events WHERE item_id = ${selected}`;
    expect(count.n).toBe(0);
});
it('still measures selected evidence with unusable container duration and preserves its warning', async () => {
    const id = await seed();
    await sql`UPDATE media_files SET duration_seconds = 0 WHERE id = ${id}::uuid`;
    mocks.probe.mockResolvedValue({
        success: true,
        video: null,
        audioStreams: [],
        subtitleStreams: [],
        duration: 0,
        container: 'matroska',
        fileSize: 1000000,
        formatBitrate: null,
    });
    const result = await check(id);
    expect(result.result?.recheck?.outcome).toBe('inconclusive');
    expect(mocks.tails).toHaveBeenCalledTimes(1);
    expect(mocks.measurement).toHaveBeenCalledTimes(1);
    expect((await issues(id)).health_issues).toEqual([tailIssue]);
});

it('fresh damage and inconclusive probes keep both evidence and unresolved history', async () => {
    const id = await seed();
    await recordFailure(sql, 'media-probe', id, 'video_ends_early', null);
    mocks.tails.mockResolvedValueOnce({
        success: true,
        videoEnd: 600,
        audioEnd: 999,
        hasAudio: true,
        endedPrematurely: false,
    });
    expect((await check(id)).result?.recheck?.outcome).toBe('warning');
    mocks.tails.mockResolvedValueOnce({ success: false });
    expect((await check(id)).result?.recheck?.outcome).toBe('inconclusive');
    expect((await issues(id)).health_issues).toEqual([
        expect.objectContaining({ type: tailIssue.type, actual_duration: 600 }),
    ]);
    const [history] =
        await sql`SELECT COUNT(*)::int AS n FROM plugin_failure_events WHERE item_id = ${id} AND resolved_at IS NULL`;
    expect(history.n).toBe(1);
});
it('keeps new same-type and unrelated evidence recorded while the tail probe runs', async () => {
    const id = await seed();
    mocks.tails.mockImplementationOnce(async () => {
        await recordDecodeHealthIssue(sql, {
            fileId: id,
            type: 'video_ends_early',
            detail: 'new tail failure',
        });
        await recordDecodeHealthIssue(sql, {
            fileId: id,
            type: 'video_decode_gaps',
            detail: 'new gap',
        });
        return {
            success: true,
            videoEnd: 995,
            audioEnd: 999,
            hasAudio: true,
            endedPrematurely: false,
        };
    });
    expect((await check(id)).result?.recheck?.outcome).toBe('inconclusive');
    const row = await issues(id);
    expect(row.health_issues).toHaveLength(2);
    expect(row.health_issues[0].detail).toBe('new tail failure');
});
it('selected Phase A probes an unprobed file without starting a library scan', async () => {
    const id = await seed([gap], false, false);
    const result = await check(id);
    expect(mocks.probe).toHaveBeenCalledTimes(1);
    expect(result.result?.recheck?.outcome).toBe('inconclusive');
    expect((await issues(id)).health_issues).toEqual([gap]);
});
it('selected Phase B recovers missing keyframes, preserves unrelated issues and never inserts history', async () => {
    const id = await seed(
        [{ type: 'no_keyframes', detected_at: '2026-10-01T00:00:00Z' }, gap],
        true,
        false,
    );
    await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec) VALUES (${id}::uuid, 'video', 0, 'h264')`;
    expect((await check(id)).result?.recheck?.outcome).toBe('inconclusive');
    expect(mocks.keyframes).toHaveBeenCalledTimes(1);
    expect((await issues(id)).health_issues).toEqual([gap]);
    const [count] =
        await sql`SELECT COUNT(*)::int AS n FROM plugin_failure_events WHERE item_id = ${id}`;
    expect(count.n).toBe(0);
});
it('lets a decode writer record fresh evidence while the selected Phase B tail probe runs', async () => {
    const id = await seed(
        [tailIssue, { type: 'no_keyframes', detected_at: '2026-10-01T00:00:00Z' }],
        true,
        false,
    );
    await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec) VALUES (${id}::uuid, 'video', 0, 'h264')`;
    const writer = postgres(getTestDatabaseUrl(), { max: 1 });
    try {
        await writer`SET lock_timeout = '1s'`;
        mocks.tails.mockImplementationOnce(async () => {
            await recordDecodeHealthIssue(writer, {
                fileId: id,
                type: 'video_decode_gaps',
                detail: 'concurrent Phase B evidence',
            });
            return {
                success: true,
                videoEnd: 995,
                audioEnd: 999,
                hasAudio: true,
                endedPrematurely: false,
            };
        });
        expect((await check(id)).result?.recheck?.outcome).toBe('inconclusive');
        const row = await issues(id);
        expect(row.health_issues).toHaveLength(1);
        expect(row.health_issues[0].detail).toBe('concurrent Phase B evidence');
        expect(row.audit_run_job_id).toBe('old-run');
    } finally {
        await writer.end();
    }
});
it('keeps audit provenance when fresh Phase B damage replaces a disproved keyframe warning', async () => {
    const id = await seed(
        [{ type: 'no_keyframes', detected_at: '2026-10-01T00:00:00Z' }],
        true,
        false,
    );
    await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec) VALUES (${id}::uuid, 'video', 0, 'h264')`;
    mocks.keyframes.mockResolvedValue({ success: true, keyframes: [0, 590], lastPacketPts: 600 });
    mocks.tails.mockResolvedValue({
        success: true,
        videoEnd: 600,
        audioEnd: 999,
        hasAudio: true,
        endedPrematurely: false,
    });
    expect((await check(id)).result?.recheck?.outcome).toBe('warning');
    const row = await issues(id);
    expect(row.health_issues.map((issue: { type: string }) => issue.type)).toEqual([
        'truncated_video',
    ]);
    expect(row.audit_run_job_id).toBe('old-run');
});
it('queued large-file rechecks retain the existing fifteen-minute keyframe budget', async () => {
    const id = await seed(
        [{ type: 'no_keyframes', detected_at: '2026-10-01T00:00:00Z' }],
        true,
        false,
    );
    await sql`UPDATE media_files SET file_size_bytes = 60000000000 WHERE id = ${id}::uuid`;
    await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec) VALUES (${id}::uuid, 'video', 0, 'h264')`;
    expect((await check(id)).result?.recheck?.outcome).toBe('healthy');
    expect(mocks.keyframes).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ timeoutMs: 900000 }),
    );
});
it('resolves existing failure history only after the successful check leaves no warnings', async () => {
    const id = await seed();
    await recordFailure(sql, 'media-probe', id, 'video_ends_early', null);
    expect((await check(id)).result?.recheck?.outcome).toBe('healthy');
    const [history] =
        await sql`SELECT COUNT(*)::int AS n FROM plugin_failure_events WHERE item_id = ${id} AND resolved_at IS NULL`;
    expect(history.n).toBe(0);
});
it('cancellation during probing leaves evidence and history untouched', async () => {
    const id = await seed();
    const controller = new AbortController();
    mocks.tails.mockImplementationOnce(async () => {
        controller.abort();
        return {
            success: true,
            videoEnd: 999,
            audioEnd: 999,
            hasAudio: true,
            endedPrematurely: false,
        };
    });
    await expect(check(id, controller.signal)).rejects.toThrow(/abort/i);
    expect((await issues(id)).health_issues).toEqual([tailIssue]);
});
it('a concurrent historical retry lock prevents the queued recheck from probing', async () => {
    const id = await seed();
    const owner = postgres(getTestDatabaseUrl(), { max: 1 });
    try {
        await owner.begin(async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(hashtext(${'retry:media-probe:' + id}))`;
            expect((await check(id)).result?.recheck?.outcome).toBe('busy');
            expect(mocks.tails).not.toHaveBeenCalled();
        });
    } finally {
        await owner.end();
    }
});

it.each([false, true])(
    'accepts SQL NULL health during fresh Phase A/B work (video=%s)',
    async (withVideo) => {
        const id = await seed(null, !withVideo, false);
        if (withVideo) {
            mocks.probe.mockResolvedValueOnce({
                success: true,
                video,
                audioStreams: [],
                subtitleStreams: [],
                duration: 1000,
                container: 'matroska',
                fileSize: 1000000,
            });
        } else {
            await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec) VALUES (${id}::uuid, 'video', 0, 'h264')`;
        }
        expect((await check(id)).result?.recheck?.outcome).toBe('healthy');
        expect((await issues(id)).health_issues).toBeNull();
    },
);
it('survives a probe wait beyond a production-style pool idle transaction allowance and restores it afterwards', async () => {
    const id = await seed();
    const pool = postgres(getTestDatabaseUrl(), {
        max: 1,
        connection: { idle_in_transaction_session_timeout: 100 },
    });
    try {
        mocks.tails.mockImplementationOnce(async () => {
            await new Promise((resolve) => setTimeout(resolve, 350));
            return {
                success: true,
                videoEnd: 999,
                audioEnd: 999,
                hasAudio: true,
                endedPrematurely: false,
            };
        });
        expect((await check(id, new AbortController().signal, pool)).result?.recheck?.outcome).toBe(
            'healthy',
        );
        const [setting] =
            await pool`SELECT current_setting('idle_in_transaction_session_timeout') AS idle`;
        expect(setting.idle).toBe('100ms');
    } finally {
        await pool.end();
    }
});
it('persists only safe enum evidence while retaining detailed admin evidence in the file row', async () => {
    const id = await seed([{ ...gap, detail: '/private/library/secret.mkv: decoder output' }]);
    const result = await check(id);
    expect(JSON.stringify(result.result)).not.toContain('/private/');
    expect(result.result?.recheck?.issues).toEqual([{ type: gap.type }]);
    expect((await issues(id)).health_issues[0].detail).toContain('/private/');
    mocks.probe.mockResolvedValueOnce({
        success: false,
        error: '/private/library/secret.mkv: ffprobe error',
    });
    await sql`UPDATE media_files SET probed_at = NULL WHERE id = ${id}::uuid`;
    expect(JSON.stringify((await check(id)).result)).not.toContain('/private/');
});

it('disabled operator guard does no physical work and preserves all evidence/history', async () => {
    const id = await seed();
    await recordFailure(sql, 'media-probe', id, tailIssue.type, null);
    vi.spyOn(config, 'DISABLE_MEDIA_PROBE', 'get').mockReturnValue(true);
    expect((await check(id)).result?.recheck).toMatchObject({
        outcome: 'inconclusive',
        reason: 'disabled',
    });
    expect(mocks.tails).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.keyframes).not.toHaveBeenCalled();
    expect((await issues(id)).health_issues).toEqual([tailIssue]);
    const [history] =
        await sql`SELECT resolved_at FROM plugin_failure_events WHERE item_id = ${id}`;
    expect(history.resolved_at).toBeNull();
});
it.each([false, true])(
    'refreshes unchanged same-type observations but preserves concurrent replacement=%s',
    async (concurrent) => {
        const old = { type: 'no_keyframes', detected_at: '2026-10-01T00:00:00Z', attempt_count: 9 };
        const id = await seed([old, gap], true, false);
        await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec) VALUES (${id}::uuid, 'video', 0, 'h264')`;
        mocks.keyframes.mockImplementationOnce(async () => {
            if (concurrent)
                await sql.begin(async (tx) => {
                    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
                    await tx`UPDATE media_files SET health_issues = ${tx.json([{ ...old, detected_at: new Date().toISOString(), detail: 'newer keyframe observer' }, gap])} WHERE id = ${id}::uuid`;
                });
            return { success: true, keyframes: [], lastPacketPts: 0 };
        });
        await check(id);
        const remaining = (await issues(id)).health_issues;
        expect(remaining).toContainEqual(gap);
        const observation = remaining.find(
            (issue: { type: string }) => issue.type === 'no_keyframes',
        );
        if (concurrent) expect(observation.detail).toBe('newer keyframe observer');
        else {
            expect(observation.detected_at).not.toBe(old.detected_at);
            expect(observation.attempt_count).toBeUndefined();
        }
    },
);
it('scheduled Phase B cannot erase a selected observation or concurrent decode evidence', async () => {
    const id = await seed([tailIssue], true, false);
    await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec) VALUES (${id}::uuid, 'video', 0, 'h264')`;
    let first = true;
    mocks.keyframes.mockImplementation(async () => {
        if (first) {
            first = false;
            mocks.tails.mockResolvedValueOnce({
                success: true,
                videoEnd: 600,
                audioEnd: 999,
                hasAudio: true,
                endedPrematurely: false,
            });
            await check(id);
            await recordDecodeHealthIssue(sql, {
                fileId: id,
                type: 'video_decode_gaps',
                detail: 'new decoder evidence',
            });
        }
        return { success: true, keyframes: [0, 990], lastPacketPts: 999 };
    });
    const [file] = await sql<
        { file_path: string }[]
    >`SELECT file_path FROM media_files WHERE id = ${id}::uuid`;
    const context = buildAdminContextStub('media-probe', { sql });
    await processPhaseBSlice(
        sql,
        context.logger,
        context.signal,
        [
            {
                id,
                file_path: file.file_path,
                duration_seconds: 1000,
                file_size_bytes: 1000,
                media_item_ids: [],
            },
        ],
        'scheduled-test',
    );
    const remaining = (await issues(id)).health_issues;
    expect(remaining).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ type: 'video_ends_early', actual_duration: 600 }),
            expect.objectContaining({ type: 'video_decode_gaps', detail: 'new decoder evidence' }),
        ]),
    );
    expect((await issues(id)).audit_run_job_id).toBe('old-run');
});
it('fresh A/B covers current linked files without metadata rewrites, active-owner theft or newer invalidation', async () => {
    const id = await seed(null, false, false);
    const linked: string[] = [];
    for (const title of ['current', 'removed', 'active-owner', 'invalidated']) {
        const [item] = await sql<
            { id: string }[]
        >`INSERT INTO media_items (title, media_type, status, has_files, runtime_seconds, custom_metadata) VALUES (${title}, 'movie', 'active', true, 73, '{"manual":"locked"}'::jsonb) RETURNING id`;
        linked.push(item.id);
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${id}::uuid, ${item.id}::uuid)`;
    }
    const owner = 'run_health_owner_' + crypto.randomUUID();
    const [outboxFlag] = await sql<
        { value: string }[]
    >`SELECT value FROM feature_flags WHERE key = 'event_outbox_enabled'`;
    try {
        await sql`UPDATE feature_flags SET value = 'on' WHERE key = 'event_outbox_enabled'`;
        await sql`INSERT INTO task_history (id, task_id, label, state, input, trigger, actor, processing_version) VALUES (${owner}, 'media-probe', 'Other owner', 'active', '{}'::jsonb, '{"kind":"manual"}'::jsonb, '{"type":"system"}'::jsonb, '1')`;
        await sql`INSERT INTO media_item_stage_state (media_item_id, stage_id, status, last_run_id, processing_version) VALUES (${linked[2]}::uuid, 'media-probe-a', 'pending', ${owner}, 1)`;
        const before =
            await sql`SELECT id, runtime_seconds, custom_metadata FROM media_items WHERE id = ANY(${sql.array(linked)}::uuid[]) ORDER BY id`;
        mocks.probe.mockImplementationOnce(async () => {
            await sql`DELETE FROM media_file_items WHERE file_id = ${id}::uuid AND media_item_id = ${linked[1]}::uuid`;
            await sql`INSERT INTO media_item_stage_state (media_item_id, stage_id, status, invalidated_at, processing_version) VALUES (${linked[3]}::uuid, 'media-probe-a', 'pending', clock_timestamp(), 1)`;
            return {
                success: true,
                video,
                audioStreams: [],
                subtitleStreams: [],
                duration: 1000,
                container: 'matroska',
                fileSize: 1000,
            };
        });
        expect((await check(id)).result?.recheck?.outcome).toBe('healthy');
        const stages =
            await sql`SELECT media_item_id, stage_id, status, last_run_id FROM media_item_stage_state WHERE media_item_id = ANY(${sql.array(linked)}::uuid[])`;
        expect(stages).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    media_item_id: linked[0],
                    stage_id: 'media-probe-a',
                    status: 'completed',
                }),
                expect.objectContaining({
                    media_item_id: linked[0],
                    stage_id: 'media-probe-b',
                    status: 'completed',
                }),
                expect.objectContaining({
                    media_item_id: linked[2],
                    stage_id: 'media-probe-a',
                    status: 'pending',
                    last_run_id: owner,
                }),
                expect.objectContaining({
                    media_item_id: linked[3],
                    stage_id: 'media-probe-a',
                    status: 'pending',
                }),
            ]),
        );
        expect(stages.some((row) => row.media_item_id === linked[1])).toBe(false);
        const events =
            await sql`SELECT media_item_id FROM event_outbox WHERE event_name = 'file.probed' AND payload->>'fileId' = ${id}`;
        expect(events.map((row) => row.media_item_id)).toEqual([linked[0]]);
        expect(
            await sql`SELECT id, runtime_seconds, custom_metadata FROM media_items WHERE id = ANY(${sql.array(linked)}::uuid[]) ORDER BY id`,
        ).toEqual(before);
        const countBefore = stages.length;
        await check(id);
        expect(
            (
                await sql`SELECT id FROM event_outbox WHERE event_name = 'file.probed' AND payload->>'fileId' = ${id}`
            ).length,
        ).toBe(events.length);
        expect(
            (
                await sql`SELECT stage_id FROM media_item_stage_state WHERE media_item_id = ANY(${sql.array(linked)}::uuid[])`
            ).length,
        ).toBe(countBefore);
    } finally {
        await sql`DELETE FROM event_outbox WHERE payload->>'fileId' = ${id}`;
        await sql`DELETE FROM media_items WHERE id = ANY(${sql.array(linked)}::uuid[])`;
        await sql`DELETE FROM task_history WHERE id = ${owner}`;
        await sql`UPDATE feature_flags SET value = ${outboxFlag.value} WHERE key = 'event_outbox_enabled'`;
    }
});

it('scheduled fresh damage records its provenance without replacing an existing audit owner', async () => {
    const id = await seed(null, true, false);
    await sql`UPDATE media_files SET audit_run_job_id = NULL WHERE id = ${id}::uuid`;
    const [file] = await sql<
        { file_path: string }[]
    >`SELECT file_path FROM media_files WHERE id = ${id}::uuid`;
    mocks.keyframes.mockResolvedValueOnce({ success: true, keyframes: [], lastPacketPts: 0 });
    const context = buildAdminContextStub('media-probe', { sql });
    await processPhaseBSlice(
        sql,
        context.logger,
        context.signal,
        [
            {
                id,
                file_path: file.file_path,
                duration_seconds: 1000,
                file_size_bytes: 1000,
                media_item_ids: [],
            },
        ],
        'fresh-scheduled-provenance',
    );
    expect((await issues(id)).audit_run_job_id).toBe('fresh-scheduled-provenance');
    expect((await issues(id)).health_issues).toEqual([
        expect.objectContaining({ type: 'no_keyframes' }),
    ]);
});

// Real BullMQ delivers each job to the real runner's processJob. The native
// execute implementation and its context, state transitions, terminal writer,
// event emitter, row mapper, mounted GET and validating polling client all run.
// Physical probing/presence and the HTTP transport are the only substitutions.
it('runs selected native outcomes through the runner, terminal storage, SSE and mounted polling', async () => {
    const owned: string[] = [];
    let orchestrator: TaskOrchestrator | undefined;
    let runner: TaskRunner | undefined;
    let worker: Worker | undefined;
    let queue: Queue | undefined;
    let failure: unknown;
    // Ownership and finally are established before the first setup operation.
    try {
        await valkey.connectValkey();
        const execute = vi.spyOn(mediaProbeTask, 'execute');
        const publish = vi.spyOn(valkey, 'publishMessage');
        const registry = new TaskRegistry();
        registry.registerTask(mediaProbeTask);
        orchestrator = await TaskOrchestrator.start(['io'], {
            registry,
            stateMachine,
            getSql: () => sql,
            getClient: requireClient,
        });
        runner = TaskRunner.createExecutor({
            registry,
            stateMachine,
            getSql: () => sql,
            getClient: requireClient,
            subscribe: async () => null,
        });
        const executor = runner;
        const connection = getQueueConnectionOptions();
        if (!connection) throw new Error('Queue connection required');
        const queueName = 'selected-envelope-' + crypto.randomUUID();
        queue = new Queue(queueName, { connection, prefix: PER_TASK_QUEUE_PREFIX });
        worker = new Worker(queueName, (job, token) => executor.processJob(job, token), {
            connection,
            prefix: PER_TASK_QUEUE_PREFIX,
            concurrency: 1,
        });
        await worker.waitUntilReady();
        const reader = orchestrator;
        vi.spyOn(facade, 'getRun').mockImplementation((id) => reader.getRun(id));
        const privateText = '/private/selected.mkv ffmpeg password=sentinel';
        for (const outcome of [
            'warning',
            'healthy',
            'inconclusive',
            'busy',
            'disabled',
            'error',
            'failed',
            'cancelled',
        ] as const) {
            const fileId = await seed([tailIssue], outcome !== 'error');
            await recordFailure(sql, 'media-probe', fileId, tailIssue.type, null);
            await sql`UPDATE media_files SET duration_seconds = 1503 WHERE id = ${fileId}::uuid`;
            const beforeExecutions = execute.mock.calls.length;
            const runId = 'run_envelope_' + crypto.randomUUID();
            owned.push(runId);
            mocks.tails.mockResolvedValue({
                success: true,
                videoEnd: outcome === 'warning' ? 1420 : 1500,
                audioEnd: 1503,
                hasAudio: true,
                endedPrematurely: false,
            });
            if (outcome === 'inconclusive') mocks.tails.mockResolvedValue({ success: false });
            if (outcome === 'error')
                mocks.probe.mockResolvedValueOnce({ success: false, error: privateText });
            if (outcome === 'cancelled')
                mocks.tails.mockImplementationOnce(async () => {
                    executor.cancelExecution(runId);
                    throw new Error(privateText);
                });
            const disabled = vi.spyOn(config, 'DISABLE_MEDIA_PROBE', 'get');
            if (outcome === 'failed')
                disabled.mockImplementation(() => {
                    throw new Error(privateText);
                });
            else disabled.mockReturnValue(outcome === 'disabled');
            await insertTaskHistoryRow(sql, {
                id: runId,
                taskId: 'media-probe',
                parentRunId: null,
                label: 'Media Probe',
                state: 'pending',
                input: { fileId },
                scope: null,
                trigger: { kind: 'manual' },
                actor: { type: 'system' },
                startedAt: new Date(),
                processingVersion: mediaProbeTask.processingVersion,
                ownerInstanceId: 'envelope-test',
                retentionPolicy: 'standard',
                stages: [],
            });
            const outer = outcome === 'failed' || outcome === 'cancelled' ? outcome : 'completed';
            const complete = async (): Promise<void> => {
                const job = await queue!.add(
                    'media-probe',
                    { runId, input: { fileId } },
                    { jobId: runId, attempts: 1 },
                );
                await vi.waitFor(
                    async () => {
                        expect(await job.getState()).toBe(
                            outer === 'completed' ? 'completed' : 'failed',
                        );
                        expect(executor.isExecutionQuiescent()).toBe(true);
                    },
                    { timeout: 15000, interval: 25 },
                );
            };
            if (outcome === 'busy')
                await sql.begin(async (tx) => {
                    await tx`SELECT pg_advisory_xact_lock(hashtext(${'retry:media-probe:' + fileId}))`;
                    await complete();
                });
            else await complete();
            disabled.mockRestore();
            const [stored] =
                await sql`SELECT state, result, error, jsonb_typeof(result) AS shape FROM task_history WHERE id = ${runId}`;
            expect(stored.state).toBe(outer);
            expect(execute).toHaveBeenCalledTimes(beforeExecutions + 1);
            expect(execute.mock.calls.at(-1)?.[0].input).toEqual({ fileId });
            const frames = publish.mock.calls.flatMap(([channel, payload]) => {
                if (!channel.startsWith('task:events:')) return [];
                const frame = JSON.parse(payload);
                return frame.data?.id === runId && frame.data?.state === outer ? [frame] : [];
            });
            expect(frames).toHaveLength(1);
            expect(frames[0].data).not.toHaveProperty('input');
            expect(frames[0].data).not.toHaveProperty('result');
            expect(JSON.stringify(frames[0])).not.toContain(privateText);
            let expected: FileHealthRecheckResult | undefined;
            if (outer === 'completed') {
                const native = await execute.mock.results.at(-1)!.value;
                expected = native.result?.recheck;
                expect(expected?.outcome).toBe(outcome === 'disabled' ? 'inconclusive' : outcome);
                expect(native.itemsProcessed).toBe(
                    outcome === 'busy' || outcome === 'disabled' ? 0 : 1,
                );
                expect(stored.shape).toBe('object');
                expect(stored.result).toEqual(native);
                expect(stored.result.result.recheck).toEqual(expected);
                expect(stored.result.recheck).toBeUndefined();
            } else {
                expected = {
                    fileId,
                    outcome: outer === 'cancelled' ? 'cancelled' : 'error',
                    issues: [],
                };
                expect(stored.result).toBeNull();
                expect(stored.error).toBeTruthy();
                if (outer === 'failed') expect(stored.error.message).toBe(privateText);
                expect(frames[0].data.error.message).toBe('Selected-file recheck did not complete');
            }
            for (const surface of ['v1', 'internal'] as const) {
                mocks.fetch.mockImplementation(async (endpoint: string) => {
                    expect(endpoint).toBe(`/api/runs/${runId}`);
                    const url = new URL(
                        `http://localhost/api/${surface === 'v1' ? 'v1/' : ''}runs/${runId}`,
                    );
                    const response = await mount(runDetail, { surface }).GET!({
                        url,
                        request: new Request(url),
                        params: { id: runId },
                        route: { id: surface === 'v1' ? '/api/v1/runs/[id]' : '/api/runs/[id]' },
                        locals:
                            surface === 'internal'
                                ? adminSession()
                                : principalLocals({
                                      kind: 'pat',
                                      ownerIsAdmin: true,
                                      tokenScopes: ['runs:read'],
                                  }),
                        getClientAddress: () => '127.0.0.1',
                        setHeaders: vi.fn(),
                    } as unknown as RequestEvent);
                    expect(await response.clone().text()).not.toContain(privateText);
                    return response;
                });
                const tracked = await awaitFileHealthRecheck(
                    fileId,
                    runId,
                    new AbortController().signal,
                );
                expect(tracked).toMatchObject({ data: expected, error: null, status: 200 });
                if (outcome === 'warning')
                    expect(fileHealthRecheckMessage(tracked.data!)).toContain('warnings remain');
            }
            const [history] =
                await sql`SELECT resolved_at FROM plugin_failure_events WHERE item_id = ${fileId}`;
            expect(history.resolved_at === null).toBe(outcome !== 'healthy');
            if (outcome === 'warning')
                expect((await issues(fileId)).health_issues).toEqual([
                    expect.objectContaining({
                        type: 'video_ends_early',
                        actual_duration: 1420,
                        expected_duration: 1503,
                    }),
                ]);
            if (outer !== 'completed')
                expect((await issues(fileId)).health_issues).toEqual([tailIssue]);
        }
    } catch (error) {
        failure = error;
    } finally {
        await settleCleanup(
            [
                async () => runner?.stop(),
                async () => worker?.close(),
                async () => queue?.obliterate({ force: true }),
                async () => queue?.close(),
                async () => orchestrator?.stop(),
                ...owned.flatMap((id) => [
                    async () => sql`DELETE FROM task_history WHERE id = ${id}`,
                    async () =>
                        requireClient().customCommand([
                            'DEL',
                            `task:run:active:${id}`,
                            `task:run:terminal:${id}`,
                            `task:log:${id}`,
                        ]),
                ]),
                async () => {
                    vi.restoreAllMocks();
                },
                valkey.disconnectValkey,
            ],
            failure,
        );
    }
}, 60000);

it.each(['content', 'physical', 'inventory', 'issues'] as const)(
    'rolls back every selected write when %s changes during measurement',
    async (change) => {
        const id = await seed(
            [tailIssue, { type: 'no_keyframes', detected_at: '2026-10-01T00:00:00Z' }],
            false,
            false,
        );
        mocks.probe.mockResolvedValueOnce({
            success: true,
            video,
            audioStreams: [],
            subtitleStreams: [],
            duration: 1000,
            container: 'matroska',
            fileSize: 1000000,
        });
        await recordFailure(sql, 'media-probe', id, 'video_ends_early', null);
        const implementation = mocks.measurement.getMockImplementation()!;
        mocks.measurement.mockImplementationOnce(async (...args) => {
            if (change === 'content')
                await sql`UPDATE media_files SET file_hash_head = 'replacement' WHERE id = ${id}::uuid`;
            if (change === 'physical') appendFileSync(physicalPaths.get(id)!, 'replacement');
            if (change === 'inventory')
                mocks.inventory.mockResolvedValue({ streams: [], signature: 'replacement' });
            if (change === 'issues')
                await recordDecodeHealthIssue(sql, {
                    fileId: id,
                    type: 'video_ends_early',
                    detail: 'replacement issue',
                });
            return implementation(...args);
        });
        expect((await check(id)).result?.recheck?.outcome).toBe('inconclusive');
        const [row] =
            await sql`SELECT probed_at, keyframes, health_tail_assessment FROM media_files WHERE id = ${id}::uuid`;
        expect(row.probed_at).toBeNull();
        expect(row.keyframes).toBeNull();
        expect(row.health_tail_assessment).toBeNull();
        const [history] =
            await sql`SELECT resolved_at FROM plugin_failure_events WHERE item_id = ${id}`;
        expect(history.resolved_at).toBeNull();
    },
);
it('preserves newer unrelated warnings and atomically stores dated assessment', async () => {
    const id = await seed();
    const implementation = mocks.measurement.getMockImplementation()!;
    mocks.measurement.mockImplementationOnce(async (...args) => {
        await recordDecodeHealthIssue(sql, {
            fileId: id,
            type: 'video_decode_gaps',
            detail: 'new unrelated warning',
        });
        return implementation(...args);
    });
    expect((await check(id)).result?.recheck?.outcome).toBe('inconclusive');
    const [row] =
        await sql`SELECT health_issues, health_tail_assessment FROM media_files WHERE id = ${id}::uuid`;
    expect(row.health_issues).toHaveLength(1);
    expect(row.health_issues[0].detail).toBe('new unrelated warning');
    expect(row.health_tail_assessment.version).toBe(1);
});
it('cancellation after measurement rolls back probe, stages, assessment and history', async () => {
    const id = await seed([tailIssue], false, false);
    await recordFailure(sql, 'media-probe', id, 'video_ends_early', null);
    const controller = new AbortController();
    const implementation = mocks.measurement.getMockImplementation()!;
    mocks.measurement.mockImplementationOnce(async (...args) => {
        const result = await implementation(...args);
        controller.abort();
        return result;
    });
    await expect(check(id, controller.signal)).rejects.toThrow();
    const [row] =
        await sql`SELECT probed_at, health_tail_assessment, health_issues FROM media_files WHERE id = ${id}::uuid`;
    expect(row.probed_at).toBeNull();
    expect(row.health_tail_assessment).toBeNull();
    expect(row.health_issues).toEqual([tailIssue]);
});
it.each(['stat', 'probe', 'stream'] as const)(
    'invalidates an existing assessment atomically on %s replacement',
    async (change) => {
        const id = await seed();
        await check(id);
        const [before] =
            await sql`SELECT health_tail_assessment FROM media_files WHERE id = ${id}::uuid`;
        expect(before.health_tail_assessment).not.toBeNull();
        if (change === 'stat')
            await sql`UPDATE media_files SET file_mtime = NOW() WHERE id = ${id}::uuid`;
        if (change === 'probe')
            await sql`UPDATE media_files SET probed_at = NOW() WHERE id = ${id}::uuid`;
        if (change === 'stream')
            await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec) VALUES (${id}::uuid, 'audio', 1, 'aac')`;
        const [after] =
            await sql`SELECT health_tail_assessment FROM media_files WHERE id = ${id}::uuid`;
        expect(after.health_tail_assessment).toBeNull();
    },
);

it('projects full observations only through the authenticated admin Health endpoint', async () => {
    const id = await seed();
    mocks.tails.mockResolvedValueOnce({
        success: true,
        videoEnd: 600,
        audioEnd: 999,
        hasAudio: true,
        endedPrematurely: false,
    });
    await check(id);
    const url = new URL('http://localhost/api/admin/media/file-health');
    const event = {
        request: new Request(url),
        url,
        params: {},
        route: { id: '/api/admin/media/file-health' },
        locals: adminSession(),
        cookies: { get: vi.fn(), set: vi.fn() },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
        fetch: vi.fn(),
    } as unknown as RequestEvent;
    const response = await mount(healthDef, { surface: 'internal' }).GET!(event);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(
        body.files.find((file: { file_id: string }) => file.file_id === id).tailAssessment
            .reviewedIssues,
    ).toEqual([tailIssue]);
    expect((await getAdminTailAssessments(sql, [id])).get(id)?.completeness).toBe('unverified');
    const denied = await mount(healthDef, { surface: 'internal' }).GET!({
        ...event,
        locals: {},
    } as RequestEvent);
    expect(denied.status).toBe(403);
});

it('rolls back pending writes when bytes change during the locked inventory validation', async () => {
    const id = await seed([tailIssue], false, false);
    const inventory = await mocks.inventory();
    let calls = 0;
    mocks.inventory.mockImplementation(async () => {
        calls++;
        if (calls === 3) appendFileSync(physicalPaths.get(id)!, 'changed under commit lock');
        return inventory;
    });
    expect((await check(id)).result?.recheck?.outcome).toBe('inconclusive');
    const [row] =
        await sql`SELECT probed_at, health_tail_assessment, health_issues FROM media_files WHERE id = ${id}::uuid`;
    expect(row.probed_at).toBeNull();
    expect(row.health_tail_assessment).toBeNull();
    expect(row.health_issues).toEqual([tailIssue]);
});

it('rejects a source replacement between the initial database read and physical probing', async () => {
    const id = await seed();
    vi.mocked(assessFilePresence).mockImplementationOnce(async () => {
        await sql`UPDATE media_files SET file_hash_head = 'changed-before-stat' WHERE id = ${id}::uuid`;
        return 'present';
    });
    expect((await check(id)).result?.recheck?.outcome).toBe('inconclusive');
    expect(mocks.measurement).not.toHaveBeenCalled();
    expect((await issues(id)).health_issues).toEqual([tailIssue]);
});
it('preserves the original warning when decoded audio coverage is partial', async () => {
    const id = await seed();
    const implementation = mocks.measurement.getMockImplementation()!;
    mocks.measurement.mockImplementationOnce(async (...args) => ({
        ...(await implementation(...args)),
        requested: { start: 995, end: 999 },
        scope: 'partial',
        reasons: ['incomplete_or_discontinuous_timestamps'],
    }));
    expect((await check(id)).result?.recheck?.outcome).toBe('inconclusive');
    expect((await issues(id)).health_issues).toEqual([tailIssue]);
});
it('rolls back linked stages, outbox events and failure resolution after a last-moment byte replacement', async () => {
    const id = await seed([tailIssue], false, false);
    const [media] = await sql<
        { id: string }[]
    >`INSERT INTO media_items (title, media_type, status, has_files) VALUES ('Controlled rollback fixture', 'movie', 'active', true) RETURNING id`;
    const [flag] = await sql<
        { value: string }[]
    >`SELECT value FROM feature_flags WHERE key = 'event_outbox_enabled'`;
    try {
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${id}::uuid, ${media.id}::uuid)`;
        await sql`UPDATE feature_flags SET value = 'on' WHERE key = 'event_outbox_enabled'`;
        await recordFailure(sql, 'media-probe', id, 'video_ends_early', null);
        const inventory = await mocks.inventory();
        let calls = 0;
        mocks.inventory.mockImplementation(async () => {
            if (++calls === 3) appendFileSync(physicalPaths.get(id)!, 'commit-time replacement');
            return inventory;
        });
        expect((await check(id)).result?.recheck?.outcome).toBe('inconclusive');
        expect(
            await sql`SELECT stage_id FROM media_item_stage_state WHERE media_item_id = ${media.id}::uuid`,
        ).toHaveLength(0);
        expect(
            await sql`SELECT id FROM event_outbox WHERE payload->>'fileId' = ${id}`,
        ).toHaveLength(0);
        const [history] =
            await sql`SELECT resolved_at FROM plugin_failure_events WHERE item_id = ${id}`;
        expect(history.resolved_at).toBeNull();
    } finally {
        await sql`DELETE FROM event_outbox WHERE payload->>'fileId' = ${id}`;
        await sql`DELETE FROM media_items WHERE id = ${media.id}::uuid`;
        await sql`UPDATE feature_flags SET value = ${flag.value} WHERE key = 'event_outbox_enabled'`;
    }
});

it('clears a stored assessment when the real stream replacement removes every stream', async () => {
    const id = await seed();
    await sql`INSERT INTO media_streams (file_id, stream_type, stream_index, codec) VALUES
        (${id}::uuid, 'video', 0, 'h264'), (${id}::uuid, 'audio', 1, 'pcm_s16le')`;
    await check(id);
    const [before] =
        await sql`SELECT health_tail_assessment FROM media_files WHERE id = ${id}::uuid`;
    expect(before.health_tail_assessment).not.toBeNull();
    expect(await sql`SELECT id FROM media_streams WHERE file_id = ${id}::uuid`).toHaveLength(2);
    await replaceStreamsForFile(sql, id, []);
    const [after] =
        await sql`SELECT health_tail_assessment FROM media_files WHERE id = ${id}::uuid`;
    expect(after.health_tail_assessment).toBeNull();
    expect(await sql`SELECT id FROM media_streams WHERE file_id = ${id}::uuid`).toHaveLength(0);
});

it.each(['near_silent', 'inconclusive'] as const)(
    'never clears duration warnings from %s evidence alone',
    async (evidence) => {
        const id = await seed();
        await recordFailure(sql, 'media-probe', id, 'video_ends_early', null);
        // Both packet scans succeed; the second has aligned tails but inconclusive measurement.
        mocks.tails.mockResolvedValue({
            success: true,
            videoEnd: evidence === 'near_silent' ? 600 : 995,
            audioEnd: 999,
            hasAudio: true,
            endedPrematurely: false,
        });
        mocks.measurement.mockImplementation(async (_path, _videoEnd, _audioEnd, source) => ({
            version: 1,
            measuredAt: new Date().toISOString(),
            method: 'ffmpeg-astats-frames-v2',
            thresholdDbfs: -60,
            completeness: 'unverified',
            scope: evidence === 'near_silent' ? 'measured' : 'inconclusive',
            observation: evidence === 'near_silent' ? 'near_silent' : 'unknown',
            inventory: [],
            inventorySignature: 'inventory-one',
            source,
            limits: { seconds: 180, streams: 8, concurrency: 2, budgetMs: 90000 },
            reasons: [],
            streams: [],
        }));
        const result = await check(id);
        expect(result.result?.recheck?.outcome).toBe(
            evidence === 'near_silent' ? 'warning' : 'inconclusive',
        );
        expect((await issues(id)).health_issues).toEqual([
            expect.objectContaining({ type: 'video_ends_early' }),
        ]);
        const [row] = await sql`SELECT health_tail_assessment FROM media_files WHERE id=${id}`;
        expect(row.health_tail_assessment.completeness).toBe('unverified');
        expect(row.health_tail_assessment.packetTail.success).toBe(true);
        expect(
            (
                await sql`SELECT count(*)::int AS n FROM plugin_failure_events WHERE item_id=${id} AND resolved_at IS NULL`
            )[0].n,
        ).toBe(1);
    },
);
