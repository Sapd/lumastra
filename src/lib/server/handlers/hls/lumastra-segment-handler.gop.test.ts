// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Segment handler in demux copy-video GOP mode (services/hls/gop-grid.ts):
 * every rendition gets the full keyframe grid as its playlist, and a GOP job
 * that can no longer build exact entries fails closed (410: restart from your
 * position) instead of serving anything shifted. Module mocks copied from
 * lumastra-segment-handler.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { sqlTag } = vi.hoisted(() => ({ sqlTag: vi.fn() }));
vi.mock('$lib/server/database/index.js', () => ({
    getDb: () => sqlTag,
}));

const { getPreviewSessionMock } = vi.hoisted(() => ({ getPreviewSessionMock: vi.fn() }));
vi.mock('$lib/server/services/preview-session.service.js', () => ({
    getPreviewSession: getPreviewSessionMock,
}));

// Preview-cache store: only consulted by the serve-time disk-restore fallback
// (when a cache-backed preview's in-memory job is missing). `dirForMock` is set
// per-case to a temp artifact dir.
const { previewCacheStoreMock } = vi.hoisted(() => ({
    previewCacheStoreMock: { dirFor: vi.fn((k: string) => k) },
}));
vi.mock('$lib/server/services/preview-cache.store.js', () => ({
    getPreviewCacheStore: () => previewCacheStoreMock,
}));

// Mock the FFmpeg transcode service + collaborators so handleHlsSegment can be
// driven without a real transcoding pipeline / DB / Valkey. `transcodeServiceMock`
// is a mutable singleton the tests configure per-case; `seekToSegmentMock` is the
// spy that must NEVER fire for a cache-backed session (the bug this guards).
const { transcodeServiceMock, seekToSegmentMock } = vi.hoisted(() => {
    const seekToSegmentMock = vi.fn(async () => false);
    const transcodeServiceMock: Record<string, unknown> = { seekToSegment: seekToSegmentMock };
    return { transcodeServiceMock, seekToSegmentMock };
});
vi.mock('$lib/server/services/ffmpeg-transcode.service.js', () => ({
    getFFmpegTranscodeService: () => transcodeServiceMock,
    // seek-coordinator + handler import these keyframe helpers at module load;
    // no cache-backed test path exercises them, so identity/zero stubs suffice.
    getKeyframeSegmentIndexForTime: () => 0,
    getKeyframeSegmentStartTime: () => 0,
}));
const persistenceMock = vi.hoisted(() => ({
    getJob: vi.fn(),
    updateLastAccessed: vi.fn(async () => {}),
    claimJobForRestoration: vi.fn(async () => true),
    takeOverStaleJob: vi.fn(async () => true),
}));
vi.mock('$lib/server/services/transcode-job-persistence.service.js', () => ({
    getCurrentPodName: () => process.env.HOSTNAME || 'unknown',
    getTranscodeJobPersistenceService: () => persistenceMock,
}));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackHlsSegmentForSession: vi.fn() },
}));
vi.mock('$lib/server/services/playback-telemetry.service.js', () => ({
    playbackTelemetryService: { record: vi.fn(async () => {}) },
}));

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import type { GopGrid } from '$lib/server/services/hls/gop-grid';
import type { PersistedJobMetadata } from '$lib/server/services/transcode-job-persistence.service';
import { handleHlsSegment } from './lumastra-segment-handler';

const PLAY_SESSION_ID = 'ps-gop-1';
const KEYFRAMES = [0, 3.5, 13.25, 14, 27.875, 31, 52, 63.75];
const TOTAL = 70;
// The 10 s keyframe grid of KEYFRAMES (computeSegmentsFromKeyframes), spelled
// out: the transcode service module is mocked in this suite.
const GRID: GopGrid = {
    starts: [0, 13.25, 27.875, 31, 52, 63.75],
    durations: [13.25, 14.625, 3.125, 21, 11.75, 6.25],
    firstKeyframe: [0, 2, 4, 5, 6, 7],
    keyframes: KEYFRAMES,
    count: 6,
    totalSeconds: TOTAL,
};

let outputDir: string;

function makeGopJob(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: 'job-gop',
        outputDir,
        config: {
            itemId: 'item42',
            hlsOutput: { hlsAudioMode: 'demux' },
            audioTracks: [{ index: 1, codec: 'eac3' }],
            totalDurationSeconds: TOTAL,
            deviceId: 'test-device',
            gopSegments: true,
        },
        transcodeDecisionResult: { videoAction: 'copy', audioAction: 'transcode' },
        segmentDurationSeconds: 10,
        segmentsReady: 1,
        segmentOffset: 0,
        status: 'running',
        isSeeking: false,
        generationRole: 'current',
        generationIndex: 1,
        seekCount: 0,
        lastServedSegment: new Map<string, number>(),
        endSegmentCache: new Map(),
        streamTargetDurations: new Map<string, number>(),
        deletedUpTo: new Map<string, number>(),
        syncTraceLoggedStreams: new Set<string>(),
        requestedStartTimeSeconds: 0,
        syncTraceOrigin: 'origin',
        lastSeekTrigger: '',
        lastFFmpegSpawnTime: 0,
        spawnAttempt: 0,
        keyframeData: KEYFRAMES,
        lastAccessedAt: new Date(),
        ...overrides,
    };
}

function install(job: Record<string, unknown>): void {
    Object.assign(transcodeServiceMock, {
        getJob: (id: string) => (id === PLAY_SESSION_ID ? job : undefined),
        getJobByPlaySession: (id: string) => (id === PLAY_SESSION_ID ? job : undefined),
        resolveSegmentRoute: async () => undefined,
        getSegmentOffsetForJob: () => job.segmentOffset,
        getStreamSegmentOffsetForJob: () => job.segmentOffset,
        getStreamTargetDurationForJob: () => undefined,
        canStreamTriggerSeekForJob: (_job: unknown, dir: string) => dir === 'stream_1',
        isSegmentDeletedForJob: () => false,
        getSegmentOffset: () => 0,
        getStreamSegmentOffset: () => 0,
        recordSegmentAccessForJob: () => {},
        recordSegmentRequestForJob: () => {},
        getRetainedJobsByPlaySession: () => [],
        getVodManifestInfo: () => undefined,
        getStreamTargetDuration: () => undefined,
        setStreamTargetDuration: () => {},
        getGopGrid: () => (job.keyframeData ? GRID : null),
    });
}

function get(path: string): Promise<Response> {
    const url = new URL(
        `https://example.test/api/v1/playback/item42/hls/${path}?PlaySessionId=${PLAY_SESSION_ID}`,
    );
    return handleHlsSegment({
        itemId: 'item42',
        internalId: 'item42',
        segmentPath: path,
        url,
        request: new Request(url),
        basePath: '',
    });
}

beforeEach(async () => {
    persistenceMock.getJob.mockReset();
    getPreviewSessionMock.mockReset();
    getPreviewSessionMock.mockResolvedValue(undefined);
    seekToSegmentMock.mockClear();
    outputDir = await mkdtemp(nodePath.join(tmpdir(), 'lumastra-hls-gop-'));
    for (const s of ['stream_0', 'stream_1']) {
        await mkdir(nodePath.join(outputDir, s), { recursive: true });
        await writeFile(nodePath.join(outputDir, s, 'segment_00000.m4s'), Buffer.from(`${s}-0`));
    }
});

afterEach(async () => {
    if (outputDir) await rm(outputDir, { recursive: true, force: true });
});

describe('handleHlsSegment — GOP mode', () => {
    for (const firstRequest of ['playlist', 'segment']) {
        it(`keeps the public timeline and mapping after restart with a ${firstRequest} request`, async () => {
            const job = makeGopJob({
                segmentOffset: 2,
                segmentsReady: 4,
                config: {
                    ...(makeGopJob().config as Record<string, unknown>),
                    keyframeData: KEYFRAMES,
                    segmentDurationSeconds: 10,
                    startTimeSeconds: 28.375,
                },
            });
            install(job);
            const fresh = await (await get('stream_1/index.m3u8')).text();
            // The private assembler playlist begins at entry 2 (source t=27.875),
            // names physical file 0 and contains only the remaining entries.
            const raw = [
                '#EXTM3U',
                '#EXT-X-MEDIA-SEQUENCE:0',
                '#EXT-X-PLAYLIST-TYPE:EVENT',
                '#EXT-X-MAP:URI="init_1.mp4"',
                ...GRID.durations
                    .slice(2)
                    .flatMap((d, i) => [
                        `#EXTINF:${d.toFixed(6)},`,
                        `segment_${String(i).padStart(5, '0')}.m4s`,
                    ]),
                '#EXT-X-ENDLIST',
            ].join('\n');
            await writeFile(nodePath.join(outputDir, 'stream_1/index.m3u8'), raw);
            // A longer completed generation also has physical file 2 on disk.
            // Direct disk serving would mistake it for public entry 2, even
            // though public entry 2 belongs to physical file 0.
            await writeFile(
                nodePath.join(outputDir, 'stream_1/segment_00002.m4s'),
                Buffer.from('wrong-later-entry'),
            );
            await writeFile(
                nodePath.join(outputDir, '.lumastra-output.json'),
                JSON.stringify({ itemId: 'item42', jobId: job.id, podName: 'old-pod' }),
            );
            persistenceMock.getJob.mockResolvedValue({
                play_session_id: PLAY_SESSION_ID,
                job_id: job.id,
                item_id: 'item42',
                config: job.config,
                output_dir: outputDir,
                segment_offset: 2,
                status: 'stopped',
                can_restore: true,
                pod_name: 'old-pod',
                last_accessed_at: new Date(0),
                created_at: new Date(0),
                expires_at: new Date(Date.now() + 3_600_000),
            });
            transcodeServiceMock.getJobByPlaySession = () => undefined;
            transcodeServiceMock.getJob = () => undefined;
            transcodeServiceMock.restoreJob = async (row: PersistedJobMetadata) => {
                const restored = makeGopJob({
                    config: row.config,
                    outputDir: row.output_dir,
                    segmentOffset: row.segment_offset,
                    keyframeData: row.config.keyframeData,
                    segmentDurationSeconds: row.config.segmentDurationSeconds,
                    requestedStartTimeSeconds: row.config.startTimeSeconds,
                    segmentsReady: 4,
                });
                install(restored);
                return restored;
            };

            if (firstRequest === 'segment') {
                const first = await get('stream_1/segment_00002.m4s');
                expect(first.status).toBe(200);
                expect(await first.text()).toBe('stream_1-0');
            }
            const response = await get('stream_1/index.m3u8');
            expect(response.status).toBe(200);
            expect(await response.text()).toBe(fresh);
            // Public entry 2 must keep mapping to physical file 0, rather than
            // advertising physical file 0 as public entry 0 after the restart.
            const segment = await get('stream_1/segment_00002.m4s');
            expect(segment.status).toBe(200);
            expect(await segment.text()).toBe('stream_1-0');
        });
    }

    it('serves the same exact keyframe grid as every rendition playlist', async () => {
        install(makeGopJob());
        const audio = await (await get('stream_0/index.m3u8')).text();
        const video = await (await get('stream_1/index.m3u8')).text();
        const extinf = (m: string) =>
            [...m.matchAll(/#EXTINF:([\d.]+),/g)].map((x) => Number(x[1]));
        expect(extinf(video)).toEqual(GRID.durations.map((d) => Number(d.toFixed(6))));
        expect(extinf(audio)).toEqual(extinf(video));
        expect(video).toContain('init_1.mp4');
        expect(audio).toContain('init_0.mp4');
        expect(video.trim().endsWith('#EXT-X-ENDLIST')).toBe(true);
    });

    it('serves entry N of a seek generation from its file N - offset, untranslated', async () => {
        // Generation started at grid entry 3: entry 3 is its segment_00000.
        await writeFile(
            nodePath.join(outputDir, 'stream_1', 'segment_00001.m4s'),
            Buffer.from('entry-4'),
        );
        install(makeGopJob({ segmentOffset: 3, segmentsReady: 2 }));
        const first = await get('stream_1/segment_00003.m4s');
        expect(first.status).toBe(200);
        expect(await first.text()).toBe('stream_1-0');
        const second = await get('stream_1/segment_00004.m4s');
        expect(await second.text()).toBe('entry-4');
        expect(seekToSegmentMock).not.toHaveBeenCalled();
    });

    it('fails closed with 410 for a missing entry once the generation is broken', async () => {
        install(makeGopJob({ gopBroken: 'stream_1: no part starts on the keyframe of entry 2' }));
        const res = await get('stream_1/segment_00002.m4s');
        expect(res.status).toBe(410);
        expect(seekToSegmentMock).not.toHaveBeenCalled();
    });

    it('keeps serving entries that were assembled before the break', async () => {
        install(makeGopJob({ gopBroken: 'stream_1: later entry' }));
        const res = await get('stream_1/segment_00000.m4s');
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('stream_1-0');
    });

    it('answers the last grid entry from the GOP tail cache, and only that entry', async () => {
        const last = GRID.count - 1;
        install(
            makeGopJob({
                endSegmentCache: new Map([
                    [
                        'stream_1',
                        { kind: 'segment', segmentIndex: last, buffer: Buffer.from('tail-last') },
                    ],
                ]),
            }),
        );
        const hit = await get(`stream_1/segment_${String(last).padStart(5, '0')}.m4s`);
        expect(hit.status).toBe(200);
        expect(await hit.text()).toBe('tail-last');
        expect(seekToSegmentMock).not.toHaveBeenCalled();
    });

    it('fails closed for a GOP-mode job that lost its keyframes (restore)', async () => {
        install(makeGopJob({ keyframeData: undefined }));
        const res = await get('stream_1/segment_00003.m4s');
        expect(res.status).toBe(410);
    });
});
