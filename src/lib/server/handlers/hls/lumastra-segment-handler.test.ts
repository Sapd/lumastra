// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as shutdown from '$lib/server/lifecycle/web-shutdown.js';
import { ShutdownInterruptedError } from '$lib/server/lifecycle/shutdown-interrupted.js';
import type { EndSegmentCacheEntry } from '$lib/server/services/hls/end-segment-cache';

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
vi.mock('$lib/server/services/transcode-job-persistence.service.js', () => ({
    getCurrentPodName: () => process.env.HOSTNAME || 'unknown',
    getTranscodeJobPersistenceService: () => ({}),
}));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { trackHlsSegmentForSession: vi.fn() },
}));
vi.mock('$lib/server/services/playback-telemetry.service.js', () => ({
    playbackTelemetryService: { record: vi.fn(async () => {}) },
}));

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as nodePath from 'node:path';

import {
    generateVodPlaylist,
    verifyPlaySessionOwnership,
    __resetSessionOwnerCacheForTests,
    resolveJobPlaySessionId,
    handleHlsSegment,
    serveMasterPlaylist,
    type HlsSegmentContext,
} from './lumastra-segment-handler';

describe('generateVodPlaylist', () => {
    const defaults = {
        itemId: 'test-item-123',
        segmentDuration: 6,
        playSessionId: 'session-abc',
        runtimeSeconds: 60,
    };

    it('generates correct number of segments from runtime', () => {
        // 90 minute movie, 6 second segments = 900 segments
        const playlist = generateVodPlaylist({
            ...defaults,
            runtimeSeconds: 5400,
        });
        expect(playlist.match(/#EXTINF/g)?.length).toBe(900);
    });

    it('includes VOD type and ENDLIST', () => {
        const playlist = generateVodPlaylist(defaults);
        expect(playlist).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
        expect(playlist).toContain('#EXT-X-ENDLIST');
    });

    it('includes HLS version 3 and proper header', () => {
        const playlist = generateVodPlaylist(defaults);
        expect(playlist).toContain('#EXTM3U');
        expect(playlist).toContain('#EXT-X-VERSION:3');
        expect(playlist).toContain('#EXT-X-MEDIA-SEQUENCE:0');
    });

    it('sets target duration to segmentDuration + 1', () => {
        const playlist = generateVodPlaylist(defaults);
        expect(playlist).toContain('#EXT-X-TARGETDURATION:7');
    });

    it('uses FFmpeg segment naming format (segment_XXXXX.ts)', () => {
        const playlist = generateVodPlaylist(defaults);
        expect(playlist).toContain('segment_00000.ts');
        expect(playlist).toContain('segment_00001.ts');
        expect(playlist).toContain('segment_00009.ts');
    });

    it('includes runtimeTicks in each segment URL', () => {
        const playlist = generateVodPlaylist({
            ...defaults,
            runtimeSeconds: 18,
        });
        expect(playlist).toContain('runtimeTicks=0');
        expect(playlist).toContain('runtimeTicks=60000000'); // 6s * 10M
        expect(playlist).toContain('runtimeTicks=120000000'); // 12s * 10M
    });

    it('includes PlaySessionId in each segment URL', () => {
        const playlist = generateVodPlaylist(defaults);
        expect(playlist).toContain('PlaySessionId=session-abc');
    });

    it('includes item ID in segment URLs', () => {
        const playlist = generateVodPlaylist(defaults);
        expect(playlist).toContain('/j/Videos/test-item-123/hls/');
    });

    it('last segment duration is correct for non-divisible runtime', () => {
        const playlist = generateVodPlaylist({
            ...defaults,
            runtimeSeconds: 16,
        });
        // 3 segments: 6s, 6s, 4s
        const extinfs = playlist.match(/#EXTINF:[\d.]+/g);
        expect(extinfs).toHaveLength(3);
        expect(extinfs![0]).toBe('#EXTINF:6.000000');
        expect(extinfs![1]).toBe('#EXTINF:6.000000');
        expect(extinfs![2]).toBe('#EXTINF:4.000000');
    });

    it('handles exact divisible runtime', () => {
        const playlist = generateVodPlaylist({
            ...defaults,
            runtimeSeconds: 12,
        });
        // Exactly 2 segments of 6s each
        const extinfs = playlist.match(/#EXTINF:[\d.]+/g);
        expect(extinfs).toHaveLength(2);
        expect(extinfs![0]).toBe('#EXTINF:6.000000');
        expect(extinfs![1]).toBe('#EXTINF:6.000000');
    });

    it('includes api_key when provided', () => {
        const playlist = generateVodPlaylist({
            ...defaults,
            apiKey: 'test123',
        });
        expect(playlist).toContain('api_key=test123');
    });

    it('excludes api_key when not provided', () => {
        const playlist = generateVodPlaylist(defaults);
        expect(playlist).not.toContain('api_key=');
    });

    it('handles very short runtime (< 1 segment)', () => {
        const playlist = generateVodPlaylist({
            ...defaults,
            runtimeSeconds: 3,
        });
        const extinfs = playlist.match(/#EXTINF:[\d.]+/g);
        expect(extinfs).toHaveLength(1);
        expect(extinfs![0]).toBe('#EXTINF:3.000000');
    });

    it('handles very long runtime', () => {
        // 3 hour movie (10800 seconds), 6 second segments = 1800 segments
        const playlist = generateVodPlaylist({
            ...defaults,
            runtimeSeconds: 10800,
        });
        expect(playlist.match(/#EXTINF/g)?.length).toBe(1800);
        // Verify last segment
        expect(playlist).toContain('segment_01799.ts');
    });

    it('zero-pads segment numbers to 5 digits', () => {
        const playlist = generateVodPlaylist({
            ...defaults,
            runtimeSeconds: 6,
        });
        // Single segment should be segment_00000.ts
        expect(playlist).toContain('segment_00000.ts');
        expect(playlist).not.toContain('segment_0.ts');
    });

    it('generates valid HLS playlist structure', () => {
        const playlist = generateVodPlaylist(defaults);
        const lines = playlist.split('\n').filter((l) => l.length > 0);

        // First line must be #EXTM3U
        expect(lines[0]).toBe('#EXTM3U');

        // Segments come in pairs: #EXTINF line + URL line
        const segmentLines = lines.filter((l) => !l.startsWith('#'));
        const extinfLines = lines.filter((l) => l.startsWith('#EXTINF'));
        expect(segmentLines.length).toBe(extinfLines.length);

        // Last non-empty line should be #EXT-X-ENDLIST
        expect(lines[lines.length - 1]).toBe('#EXT-X-ENDLIST');
    });

    it('uses different segment durations', () => {
        const playlist = generateVodPlaylist({
            ...defaults,
            runtimeSeconds: 20,
            segmentDuration: 10,
        });
        const extinfs = playlist.match(/#EXTINF:[\d.]+/g);
        expect(extinfs).toHaveLength(2);
        expect(extinfs![0]).toBe('#EXTINF:10.000000');
        expect(extinfs![1]).toBe('#EXTINF:10.000000');
        expect(playlist).toContain('#EXT-X-TARGETDURATION:11');
    });

    // Edge case guards
    describe('edge cases', () => {
        it('returns empty valid playlist for NaN runtimeSeconds', () => {
            const playlist = generateVodPlaylist({
                ...defaults,
                runtimeSeconds: NaN,
            });
            expect(playlist).toContain('#EXTM3U');
            expect(playlist).toContain('#EXT-X-ENDLIST');
            expect(playlist).not.toContain('#EXTINF');
        });

        it('returns empty valid playlist for Infinity runtimeSeconds', () => {
            const playlist = generateVodPlaylist({
                ...defaults,
                runtimeSeconds: Infinity,
            });
            expect(playlist).toContain('#EXTM3U');
            expect(playlist).toContain('#EXT-X-ENDLIST');
            expect(playlist).not.toContain('#EXTINF');
        });

        it('returns empty valid playlist for zero runtimeSeconds', () => {
            const playlist = generateVodPlaylist({
                ...defaults,
                runtimeSeconds: 0,
            });
            expect(playlist).toContain('#EXTM3U');
            expect(playlist).toContain('#EXT-X-ENDLIST');
            expect(playlist).not.toContain('#EXTINF');
        });

        it('returns empty valid playlist for negative runtimeSeconds', () => {
            const playlist = generateVodPlaylist({
                ...defaults,
                runtimeSeconds: -10,
            });
            expect(playlist).toContain('#EXTM3U');
            expect(playlist).toContain('#EXT-X-ENDLIST');
            expect(playlist).not.toContain('#EXTINF');
        });

        it('clamps runtime to 24 hours maximum', () => {
            const playlist = generateVodPlaylist({
                ...defaults,
                runtimeSeconds: 200000, // > 86400
            });
            // Should clamp to 86400 / 6 = 14400 segments
            const segmentCount = (playlist.match(/#EXTINF/g) || []).length;
            expect(segmentCount).toBe(14400);
        });

        it('falls back to 6s when segmentDuration is zero', () => {
            const playlist = generateVodPlaylist({
                ...defaults,
                runtimeSeconds: 12,
                segmentDuration: 0,
            });
            // With fallback 6s: 12/6 = 2 segments
            const segmentCount = (playlist.match(/#EXTINF/g) || []).length;
            expect(segmentCount).toBe(2);
        });

        it('falls back to 6s when segmentDuration is negative', () => {
            const playlist = generateVodPlaylist({
                ...defaults,
                runtimeSeconds: 12,
                segmentDuration: -3,
            });
            const segmentCount = (playlist.match(/#EXTINF/g) || []).length;
            expect(segmentCount).toBe(2);
        });

        it('last segment duration is never negative (float drift)', () => {
            // Use values that could cause float drift
            const playlist = generateVodPlaylist({
                ...defaults,
                runtimeSeconds: 6.000000000000001,
                segmentDuration: 6,
            });
            const extinfs = playlist.match(/#EXTINF:([\d.]+)/g);
            expect(extinfs).toBeTruthy();
            for (const extinf of extinfs!) {
                const duration = parseFloat(extinf.replace('#EXTINF:', ''));
                expect(duration).toBeGreaterThan(0);
            }
        });
    });
});

describe('verifyPlaySessionOwnership', () => {
    beforeEach(() => {
        sqlTag.mockReset();
        __resetSessionOwnerCacheForTests();
    });

    it('preview sessions bypass the DB entirely', async () => {
        const ok = await verifyPlaySessionOwnership('preview-xyz', 'alice');
        expect(ok).toBe(true);
        expect(sqlTag).not.toHaveBeenCalled();
    });

    it('allows when the session belongs to the user', async () => {
        sqlTag.mockResolvedValueOnce([{ username: 'alice' }]);
        const ok = await verifyPlaySessionOwnership('sess-owned', 'alice');
        expect(ok).toBe(true);
    });

    it('denies when the row is owned by a different user', async () => {
        sqlTag.mockResolvedValueOnce([{ username: 'bob' }]);
        const ok = await verifyPlaySessionOwnership('sess-other', 'alice');
        expect(ok).toBe(false);
    });

    it('caches a resolved owner — second call hits memory, not the DB', async () => {
        sqlTag.mockResolvedValueOnce([{ username: 'alice' }]);
        await verifyPlaySessionOwnership('sess-cached', 'alice');
        await verifyPlaySessionOwnership('sess-cached', 'alice');
        expect(sqlTag).toHaveBeenCalledTimes(1);
    });

    // The regression guard: the warm-up window. The player requests HLS
    // playlists the instant it has a PlaySessionId, before the play_sessions row
    // is written. An absent row must ALLOW (not 404) and must NOT be cached, so
    // the very next request re-checks and picks up the row once it lands.
    it('allows when the row does not exist yet (warm-up window)', async () => {
        sqlTag.mockResolvedValue([]);
        const ok = await verifyPlaySessionOwnership('sess-warmup', 'alice');
        expect(ok).toBe(true);
    });

    it('does NOT cache an absent row — re-queries on the next request', async () => {
        sqlTag.mockResolvedValueOnce([]); // first request: row not written yet
        const first = await verifyPlaySessionOwnership('sess-race', 'alice');
        expect(first).toBe(true);

        sqlTag.mockResolvedValueOnce([{ username: 'alice' }]); // row has landed
        const second = await verifyPlaySessionOwnership('sess-race', 'alice');
        expect(second).toBe(true);

        // Both calls hit the DB — the absent result was never cached.
        expect(sqlTag).toHaveBeenCalledTimes(2);
    });

    it('fails open (allows) when the ownership query throws', async () => {
        sqlTag.mockRejectedValueOnce(new Error('db down'));
        const ok = await verifyPlaySessionOwnership('sess-error', 'alice');
        expect(ok).toBe(true);
    });
});

// Task 6 (Coordinated Preview Subsystem): a cache-backed preview's FFmpeg job
// runs under `preview-cache-<cacheKey>`, not the viewer's own PlaySessionId —
// every transcode-job/dir/warming/offset lookup must resolve through this
// helper instead of using the raw PlaySessionId directly.
describe('resolveJobPlaySessionId', () => {
    beforeEach(() => {
        getPreviewSessionMock.mockReset();
    });

    it('resolves a cache-backed preview session to the shared artifact job id', async () => {
        getPreviewSessionMock.mockResolvedValueOnce({
            playSessionId: 'preview-item123-1700000000000',
            itemId: 'item123',
            cacheKey: 'abc123',
        });

        const resolved = await resolveJobPlaySessionId('preview-item123-1700000000000', true);

        expect(resolved.jobPlaySessionId).toBe('preview-cache-abc123');
        expect(resolved.previewSession?.itemId).toBe('item123');
        expect(getPreviewSessionMock).toHaveBeenCalledWith('preview-item123-1700000000000');
    });

    it('leaves a non-cache preview session on its own viewer id', async () => {
        getPreviewSessionMock.mockResolvedValueOnce({
            playSessionId: 'preview-item123-1700000000000',
            itemId: 'item123',
            // no cacheKey — session-owned job, not cache-backed
        });

        const resolved = await resolveJobPlaySessionId('preview-item123-1700000000000', true);

        expect(resolved.jobPlaySessionId).toBe('preview-item123-1700000000000');
        expect(resolved.previewSession?.itemId).toBe('item123');
    });

    it('leaves a preview session with no session record at all unchanged', async () => {
        getPreviewSessionMock.mockResolvedValueOnce(undefined);

        const resolved = await resolveJobPlaySessionId('preview-item123-1700000000000', true);

        expect(resolved.jobPlaySessionId).toBe('preview-item123-1700000000000');
        expect(resolved.previewSession).toBeUndefined();
    });

    it('does not consult preview sessions for real (non-preview) playback', async () => {
        const resolved = await resolveJobPlaySessionId('real-session-abc', false);

        expect(resolved.jobPlaySessionId).toBe('real-session-abc');
        expect(resolved.previewSession).toBeUndefined();
        expect(getPreviewSessionMock).not.toHaveBeenCalled();
    });
});

// Regression guard for the reviewer-found "cache-backed viewer + backward-seek →
// hard 503" bug. A cache-backed preview artifact is a FIXED single-generation VOD
// window; the segment handler must NOT route such a request into the seek-trigger
// path (which would call seekToSegment(viewerId) → false → 503). Instead it serves
// the requested segment from the artifact dir.
describe('handleHlsSegment — cache-backed preview bypasses seek triggers', () => {
    const ARTIFACT_ID = 'preview-cache-cachekey123';
    const VIEWER_ID = 'preview-item42-1700000000000';
    let outputDir: string;

    // A cache-backed job whose backward-seek is exercised: segmentOffset=5 with a
    // request for segment 0 classifies as a backward seek (requested < offset), and
    // canSeek=true means the seek-trigger path WOULD fire without the fix.
    function makeCacheBackedJob(dir: string): Record<string, unknown> {
        return {
            id: 'job-artifact',
            outputDir: dir,
            config: {
                itemId: 'item42',
                hlsOutput: { hlsAudioMode: 'demux' },
                audioTracks: [{ index: 0, codec: 'aac' }],
                totalDurationSeconds: undefined,
                deviceId: 'preview-player',
            },
            transcodeDecisionResult: { videoAction: 'transcode', audioAction: 'transcode' },
            segmentDurationSeconds: 6,
            segmentsReady: 10,
            segmentOffset: 5,
            status: 'running',
            isSeeking: false,
            generationRole: 'current',
            generationIndex: 0,
            seekCount: 0,
            lastServedSegment: new Map<string, number>(),
            endSegmentCache: new Map<string, Buffer>(),
            streamTargetDurations: new Map<string, number>(),
            deletedUpTo: new Map<string, number>(),
            syncTraceLoggedStreams: new Set<string>(),
            requestedStartTimeSeconds: 0,
            syncTraceOrigin: 'origin',
            lastSeekTrigger: '',
            lastFFmpegSpawnTime: 0,
            spawnAttempt: 0,
            keyframeData: undefined,
            lastAccessedAt: new Date(),
        };
    }

    beforeEach(async () => {
        getPreviewSessionMock.mockReset();
        seekToSegmentMock.mockClear();
        outputDir = await mkdtemp(nodePath.join(tmpdir(), 'lumastra-hls-test-'));
        // Write the real segment the viewer requests so the serve path returns 200.
        await mkdir(nodePath.join(outputDir, 'stream_0'), { recursive: true });
        await writeFile(
            nodePath.join(outputDir, 'stream_0', 'segment_00000.m4s'),
            Buffer.from('fake-m4s-bytes'),
        );

        const job = makeCacheBackedJob(outputDir);
        Object.assign(transcodeServiceMock, {
            getJob: (id: string) => (id === ARTIFACT_ID ? job : undefined),
            getJobByPlaySession: (id: string) => (id === ARTIFACT_ID ? job : undefined),
            resolveSegmentRoute: async () => undefined,
            getSegmentOffsetForJob: () => 5,
            getStreamSegmentOffsetForJob: () => 5,
            getStreamTargetDurationForJob: () => undefined,
            canStreamTriggerSeekForJob: () => true,
            isSegmentDeletedForJob: () => false,
            getSegmentOffset: () => 5,
            getStreamSegmentOffset: () => 5,
            recordSegmentAccessForJob: () => {},
            recordSegmentRequestForJob: () => {},
            getRetainedJobsByPlaySession: () => [],
            getVodManifestInfo: () => undefined,
            getStreamTargetDuration: () => undefined,
            setStreamTargetDuration: () => {},
        });
    });

    afterEach(async () => {
        if (outputDir) await rm(outputDir, { recursive: true, force: true });
    });

    function buildCtx(): HlsSegmentContext {
        const url = new URL(
            `https://example.test/api/v1/playback/item42/hls/stream_0/segment_00000.m4s?PlaySessionId=${encodeURIComponent(VIEWER_ID)}`,
        );
        return {
            itemId: 'item42',
            internalId: 'item42',
            segmentPath: 'stream_0/segment_00000.m4s',
            url,
            request: new Request(url),
            basePath: '',
            // no username → skip ownership check
        };
    }

    it('serves a would-be-backward-seek segment from the artifact dir (no 503, no seek)', async () => {
        // Cache-backed: resolves the viewer id to the shared artifact id.
        getPreviewSessionMock.mockResolvedValue({
            playSessionId: VIEWER_ID,
            itemId: 'item42',
            cacheKey: 'cachekey123',
        });

        const response = await handleHlsSegment(buildCtx());

        // The core regression assertions: NOT the 503 the seek path would produce…
        expect(response.status).not.toBe(503);
        // …and the seek was never even attempted for a cache-backed session.
        expect(seekToSegmentMock).not.toHaveBeenCalled();
        // It actually served the artifact bytes.
        expect(response.status).toBe(200);
        expect(response.headers.get('Content-Type')).toBe('video/mp4');
    });

    it('never seeks a non-cache preview outside its generated clip', async () => {
        const job = makeCacheBackedJob(outputDir);
        Object.assign(transcodeServiceMock, {
            getJob: (id: string) => (id === VIEWER_ID ? job : undefined),
            getJobByPlaySession: (id: string) => (id === VIEWER_ID ? job : undefined),
        });
        getPreviewSessionMock.mockResolvedValue({ playSessionId: VIEWER_ID, itemId: 'item42' });
        // Missing segment behind the origin would otherwise restart FFmpeg on the full input.
        await rm(nodePath.join(outputDir, 'stream_0', 'segment_00000.m4s'));
        const response = await handleHlsSegment(buildCtx());
        expect(seekToSegmentMock).not.toHaveBeenCalled();
        expect(response.status).not.toBe(200);
    });

    it('serves a complete cached media playlist as VOD even when the artifact job is not stopped', async () => {
        // Regression: a cache-backed preview whose in-memory job is 'running'
        // (reaped/re-warmed/startup-scanned) but whose on-disk manifest is already
        // complete (#EXT-X-ENDLIST) must be served as PLAYLIST-TYPE:VOD, not EVENT.
        // Served as EVENT, Safari/AVPlayer treat the finished clip as live (jump to
        // the live edge → play ~a frame → revert to backdrop) and hls.js won't load
        // a fragment from the start — the hover-preview "flashes then backdrop" bug.
        getPreviewSessionMock.mockResolvedValue({
            playSessionId: VIEWER_ID,
            itemId: 'item42',
            cacheKey: 'cachekey123',
        });

        // FFmpeg writes complete clips as PLAYLIST-TYPE:EVENT terminated by ENDLIST.
        const completeEventManifest = [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            '#EXT-X-TARGETDURATION:2',
            '#EXT-X-MEDIA-SEQUENCE:0',
            '#EXT-X-PLAYLIST-TYPE:EVENT',
            '#EXT-X-MAP:URI="init_0.mp4"',
            '#EXTINF:2.005333,',
            'segment_00000.m4s',
            '#EXTINF:2.005333,',
            'segment_00001.m4s',
            '#EXT-X-ENDLIST',
            '',
        ].join('\n');
        await writeFile(nodePath.join(outputDir, 'stream_0', 'index.m3u8'), completeEventManifest);

        const url = new URL(
            `https://example.test/api/v1/playback/item42/hls/stream_0/index.m3u8?PlaySessionId=${encodeURIComponent(VIEWER_ID)}`,
        );
        const response = await handleHlsSegment({
            itemId: 'item42',
            internalId: 'item42',
            segmentPath: 'stream_0/index.m3u8',
            url,
            request: new Request(url),
            basePath: '',
        });

        expect(response.status).toBe(200);
        const body = await response.text();
        // Converted to VOD so players load it from the start…
        expect(body).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
        expect(body).not.toContain('#EXT-X-PLAYLIST-TYPE:EVENT');
        // …and it stays complete.
        expect(body).toContain('#EXT-X-ENDLIST');
    });
});

// Security review follow-up I1: a RESIDENT job with no persisted
// `play_sessions` row (`/j` dashless ids, the showcase principal) was gated
// only by `verifyPlaySessionOwnership`, which ALLOWS a row-absent session
// through (the warm-up-window allowance) — permanently, for an id that will
// never get a row. A caller who can merely access the item could ride
// someone else's dashless session id and reach the backward/forward seek
// trigger below, which kills and restarts the OWNER's FFmpeg at the
// CALLER's position. lumastra-segment-handler.ts now refuses (404) a
// resident job owned by a DIFFERENT username before any seek is attempted.
describe('handleHlsSegment — I1: resident-job ownership blocks a non-owner seek trigger', () => {
    const ITEM_X = 'item-i1-x';
    const DASHLESS_S = 'i1dashless00000000000000000000ab';

    let outputDir: string;
    let job: Record<string, unknown>;

    // segmentOffset=5 with a request for segment 0 is a backward seek
    // (requested < offset); canStreamTriggerSeekForJob=true means the
    // seek-trigger path WOULD fire without the ownership check.
    function makeOwnedJob(dir: string, username: string): Record<string, unknown> {
        return {
            id: 'job-owner-1',
            outputDir: dir,
            config: {
                itemId: ITEM_X,
                username,
                hlsOutput: { hlsAudioMode: 'demux' },
                audioTracks: [{ index: 0, codec: 'aac' }],
                totalDurationSeconds: undefined,
                deviceId: 'test-device',
            },
            transcodeDecisionResult: { videoAction: 'transcode', audioAction: 'transcode' },
            segmentDurationSeconds: 6,
            segmentsReady: 10,
            segmentOffset: 5,
            status: 'running',
            isSeeking: false,
            generationRole: 'current',
            generationIndex: 0,
            seekCount: 0,
            lastServedSegment: new Map<string, number>(),
            endSegmentCache: new Map<string, Buffer>(),
            streamTargetDurations: new Map<string, number>(),
            deletedUpTo: new Map<string, number>(),
            syncTraceLoggedStreams: new Set<string>(),
            requestedStartTimeSeconds: 0,
            syncTraceOrigin: 'origin',
            lastSeekTrigger: '',
            lastFFmpegSpawnTime: 0,
            spawnAttempt: 0,
            keyframeData: undefined,
            lastAccessedAt: new Date(),
        };
    }

    function buildCtx(username: string | undefined): HlsSegmentContext {
        const url = new URL(
            `https://example.test/j/Videos/${ITEM_X}/hls/stream_0/segment_00000.m4s?PlaySessionId=${DASHLESS_S}`,
        );
        return {
            itemId: ITEM_X,
            internalId: ITEM_X,
            segmentPath: 'stream_0/segment_00000.m4s',
            url,
            request: new Request(url),
            basePath: '',
            username,
            mount: 'j',
        };
    }

    beforeEach(async () => {
        getPreviewSessionMock.mockReset();
        getPreviewSessionMock.mockResolvedValue(undefined);
        seekToSegmentMock.mockClear();
        seekToSegmentMock.mockResolvedValue(false); // outcome is irrelevant — only whether it's reached
        sqlTag.mockReset();
        // Dashless id: never gets a play_sessions row (isPersistable is
        // UUID-only) — the row-absent "allow" is what this test proves is
        // NOT sufficient on its own.
        sqlTag.mockResolvedValue([]);
        __resetSessionOwnerCacheForTests();

        // No segment written to disk on purpose: with segmentOffset=5 and a
        // request for segment 0, a PRESENT file would short-circuit straight
        // to a disk-serve (fileExists check runs before the seek decision) —
        // the point of these two positive cases is that the seek trigger
        // itself is reached, so the file must be genuinely missing.
        outputDir = await mkdtemp(nodePath.join(tmpdir(), 'lumastra-i1-test-'));

        job = makeOwnedJob(outputDir, 'alice');
        Object.assign(transcodeServiceMock, {
            getJob: (id: string) => (id === DASHLESS_S ? job : undefined),
            getJobByPlaySession: (id: string) => (id === DASHLESS_S ? job : undefined),
            resolveSegmentRoute: async () => undefined,
            getSegmentOffsetForJob: () => 5,
            getStreamSegmentOffsetForJob: () => 5,
            getStreamTargetDurationForJob: () => undefined,
            canStreamTriggerSeekForJob: () => true,
            isSegmentDeletedForJob: () => false,
            getSegmentOffset: () => 5,
            getStreamSegmentOffset: () => 5,
            recordSegmentAccessForJob: () => {},
            recordSegmentRequestForJob: () => {},
            getRetainedJobsByPlaySession: () => [],
            getVodManifestInfo: () => undefined,
            getStreamTargetDuration: () => undefined,
            setStreamTargetDuration: () => {},
        });
    });

    afterEach(async () => {
        if (outputDir) await rm(outputDir, { recursive: true, force: true });
    });

    it("refuses a non-owner's far-segment request (404) before any seek; the owner's job is untouched", async () => {
        const jobBeforeId = job.id;

        const response = await handleHlsSegment(buildCtx('bob'));

        expect(response.status).toBe(404);
        expect(seekToSegmentMock).not.toHaveBeenCalled();
        expect(
            (transcodeServiceMock.getJobByPlaySession as (id: string) => Record<string, unknown>)(
                DASHLESS_S,
            ).id,
        ).toBe(jobBeforeId);
    });

    it("the OWNER's own far-segment request proceeds to the seek trigger (not blocked)", async () => {
        await handleHlsSegment(buildCtx('alice'));

        expect(seekToSegmentMock).toHaveBeenCalled();
    });

    it('the showcase mount (no username) is unaffected by this check — falls through to the seek trigger', async () => {
        await handleHlsSegment(buildCtx(undefined));

        expect(seekToSegmentMock).toHaveBeenCalled();
    });
});

describe('handleHlsSegment — cache-backed preview restores from complete disk artifact on job miss', () => {
    const VIEWER_ID = 'preview-item42-1700000000000';
    let artifactDir: string;

    beforeEach(async () => {
        getPreviewSessionMock.mockReset();
        artifactDir = await mkdtemp(nodePath.join(tmpdir(), 'lumastra-preview-artifact-'));
        // Complete artifact: .ready marker + a video segment + a media playlist.
        await writeFile(nodePath.join(artifactDir, '.ready'), '');
        await mkdir(nodePath.join(artifactDir, 'stream_1'), { recursive: true });
        await writeFile(
            nodePath.join(artifactDir, 'stream_1', 'segment_00006.m4s'),
            Buffer.from('disk-video-segment-6'),
        );
        await writeFile(
            nodePath.join(artifactDir, 'stream_1', 'index.m3u8'),
            [
                '#EXTM3U',
                '#EXT-X-VERSION:7',
                '#EXT-X-TARGETDURATION:2',
                '#EXT-X-PLAYLIST-TYPE:EVENT',
                '#EXT-X-MAP:URI="init_1.mp4"',
                '#EXTINF:2.0,',
                'segment_00000.m4s',
                '#EXT-X-ENDLIST',
                '',
            ].join('\n'),
        );
        previewCacheStoreMock.dirFor.mockReturnValue(artifactDir);

        // The in-memory artifact job is GONE — this is the reaped / not-re-warmed
        // case that used to 410. resolveJobPlaySessionId maps the viewer to
        // `preview-cache-<key>`; getJob returns undefined for it.
        Object.assign(transcodeServiceMock, {
            getJob: () => undefined,
            getJobByPlaySession: () => undefined,
        });
        getPreviewSessionMock.mockResolvedValue({
            playSessionId: VIEWER_ID,
            itemId: 'item42',
            cacheKey: 'cachekey123',
        });
    });

    afterEach(async () => {
        if (artifactDir) await rm(artifactDir, { recursive: true, force: true });
    });

    it('serves a segment from the complete artifact instead of 410 when the job is missing', async () => {
        const url = new URL(
            `https://example.test/api/v1/playback/item42/hls/stream_1/segment_00006.m4s?PlaySessionId=${encodeURIComponent(VIEWER_ID)}`,
        );
        const response = await handleHlsSegment({
            itemId: 'item42',
            internalId: 'item42',
            segmentPath: 'stream_1/segment_00006.m4s',
            url,
            request: new Request(url),
            basePath: '',
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('X-Lumastra-Preview-Static')).toBe('segment');
        expect(response.headers.get('Content-Type')).toBe('video/mp4');
        expect(await response.text()).toBe('disk-video-segment-6');
    });

    it('serves a VOD media playlist from the complete artifact when the job is missing', async () => {
        const url = new URL(
            `https://example.test/api/v1/playback/item42/hls/stream_1/index.m3u8?PlaySessionId=${encodeURIComponent(VIEWER_ID)}`,
        );
        const response = await handleHlsSegment({
            itemId: 'item42',
            internalId: 'item42',
            segmentPath: 'stream_1/index.m3u8',
            url,
            request: new Request(url),
            basePath: '',
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('X-Lumastra-Preview-Static')).toBe('playlist');
        const body = await response.text();
        expect(body).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
        expect(body).toContain('#EXT-X-ENDLIST');
    });

    it('serves the master playlist from the complete artifact with the viewer PlaySessionId appended', async () => {
        // FFmpeg's on-disk master: bare relative URIs, no query params.
        await writeFile(
            nodePath.join(artifactDir, 'master.m3u8'),
            [
                '#EXTM3U',
                '#EXT-X-VERSION:7',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_audio",NAME="audio_0",DEFAULT=YES,URI="stream_0/index.m3u8"',
                '#EXT-X-STREAM-INF:BANDWIDTH=2748558,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_audio"',
                'stream_1/index.m3u8',
                '',
            ].join('\n'),
        );
        const url = new URL(
            `https://example.test/api/v1/playback/item42/hls/master.m3u8?PlaySessionId=${encodeURIComponent(VIEWER_ID)}`,
        );
        const response = await handleHlsSegment({
            itemId: 'item42',
            internalId: 'item42',
            segmentPath: 'master.m3u8',
            url,
            request: new Request(url),
            basePath: '',
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('X-Lumastra-Preview-Static')).toBe('master');
        const body = await response.text();
        // Both the audio rendition URI attribute and the variant URI line carry the session.
        expect(body).toContain(
            `URI="stream_0/index.m3u8?PlaySessionId=${encodeURIComponent(VIEWER_ID)}"`,
        );
        expect(body).toContain(
            `stream_1/index.m3u8?PlaySessionId=${encodeURIComponent(VIEWER_ID)}`,
        );
    });

    it('does not propagate account query credentials into child URIs of the disk-served master', async () => {
        // Regression: native AVPlayer (tvOS) can't set HTTP headers on HLS
        // fetches — it authenticates via ?grant= — and it DROPS the master's
        // query string when resolving relative child URIs. If the disk-served
        // master emits child URIs without the token, the child playlists and
        // segments 401. Every child URI must carry both PlaySessionId and the
        // caller's grant. (serveMasterPlaylist already does this for the
        // resident-job path; this covers the reaped/complete-artifact path.)
        await writeFile(
            nodePath.join(artifactDir, 'master.m3u8'),
            [
                '#EXTM3U',
                '#EXT-X-VERSION:7',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_audio",NAME="audio_0",DEFAULT=YES,URI="stream_0/index.m3u8"',
                '#EXT-X-STREAM-INF:BANDWIDTH=2748558,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_audio"',
                'stream_1/index.m3u8',
                '',
            ].join('\n'),
        );
        const url = new URL(
            `https://example.test/api/v1/playback/item42/hls/master.m3u8?PlaySessionId=${encodeURIComponent(VIEWER_ID)}&api_key=pat_secret_token`,
        );
        const response = await handleHlsSegment({
            itemId: 'item42',
            internalId: 'item42',
            segmentPath: 'master.m3u8',
            url,
            request: new Request(url),
            basePath: '',
        });

        expect(response.status).toBe(200);
        expect(response.headers.get('X-Lumastra-Preview-Static')).toBe('master');
        const body = await response.text();
        // Audio rendition URI attribute carries session AND token.
        expect(body).toContain(
            `URI="stream_0/index.m3u8?PlaySessionId=${encodeURIComponent(VIEWER_ID)}"`,
        );
        // Variant URI line carries session AND token.
        expect(body).toContain(
            `stream_1/index.m3u8?PlaySessionId=${encodeURIComponent(VIEWER_ID)}`,
        );
        expect(body).not.toContain('pat_secret_token');
        expect(body).not.toContain('api_key=');
    });

    it('propagates a grant into every child URI of the disk-served master', async () => {
        await writeFile(
            nodePath.join(artifactDir, 'master.m3u8'),
            [
                '#EXTM3U',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_audio",NAME="audio_0",DEFAULT=YES,URI="stream_0/index.m3u8"',
                '#EXT-X-STREAM-INF:BANDWIDTH=2748558,AUDIO="group_audio"',
                'stream_1/index.m3u8',
                '',
            ].join('\n'),
        );
        const url = new URL(
            `https://example.test/api/v1/playback/item42/hls/master.m3u8?PlaySessionId=${encodeURIComponent(VIEWER_ID)}&grant=st_abc123`,
        );
        const response = await handleHlsSegment({
            itemId: 'item42',
            internalId: 'item42',
            segmentPath: 'master.m3u8',
            url,
            request: new Request(url),
            basePath: '',
        });

        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toContain(
            `URI="stream_0/index.m3u8?PlaySessionId=${encodeURIComponent(VIEWER_ID)}&grant=st_abc123"`,
        );
        expect(body).toContain(
            `stream_1/index.m3u8?PlaySessionId=${encodeURIComponent(VIEWER_ID)}&grant=st_abc123`,
        );
        // grant takes precedence — grant must not also be appended.
        expect(body).not.toContain('api_key=');
    });

    it('answers master.m3u8 of a FLAT (muxed) artifact with its root media playlist', async () => {
        // Previews are muxed since 2026-08-26: no master.m3u8, no stream_N/ dirs.
        await writeFile(
            nodePath.join(artifactDir, 'index.m3u8'),
            [
                '#EXTM3U',
                '#EXT-X-VERSION:7',
                '#EXT-X-TARGETDURATION:2',
                '#EXT-X-PLAYLIST-TYPE:EVENT',
                '#EXT-X-MAP:URI="init_0.mp4"',
                '#EXTINF:2.000000,',
                'segment_00000.m4s',
                '#EXT-X-ENDLIST',
                '',
            ].join('\n'),
        );
        const url = new URL(
            `https://example.test/api/v1/playback/item42/hls/master.m3u8?PlaySessionId=${encodeURIComponent(VIEWER_ID)}&grant=pat_x`,
        );
        const response = await handleHlsSegment({
            itemId: 'item42',
            internalId: 'item42',
            segmentPath: 'master.m3u8',
            url,
            request: new Request(url),
            basePath: '',
        });

        expect(response.status).toBe(200);
        const body = await response.text();
        const q = `PlaySessionId=${encodeURIComponent(VIEWER_ID)}&grant=pat_x`;
        expect(body).toContain(`#EXT-X-MAP:URI="init_0.mp4?${q}"`);
        expect(body).toContain(`segment_00000.m4s?${q}`);
        expect(body).toContain('#EXT-X-PLAYLIST-TYPE:VOD');
        expect(body).not.toContain('stream_');
    });

    it('falls through (no static serve) when the artifact is not yet complete (.ready absent)', async () => {
        await rm(nodePath.join(artifactDir, '.ready'), { force: true });
        const url = new URL(
            `https://example.test/api/v1/playback/item42/hls/stream_1/segment_00006.m4s?PlaySessionId=${encodeURIComponent(VIEWER_ID)}`,
        );
        const response = await handleHlsSegment({
            itemId: 'item42',
            internalId: 'item42',
            segmentPath: 'stream_1/segment_00006.m4s',
            url,
            request: new Request(url),
            basePath: '',
        });

        // Not statically served — falls through to the normal (missing-job) path.
        expect(response.headers.get('X-Lumastra-Preview-Static')).toBeNull();
    });

    it('marks the disk-served segment private so shared caches cannot store it', async () => {
        // These responses are ACAO:* on a forward-auth-authenticated surface.
        // `private` still permits BROWSER caching -- which is the entire win of
        // the client session memo -- while excluding shared proxies.
        const url = new URL(
            `https://example.test/api/v1/playback/item42/hls/stream_1/segment_00006.m4s?PlaySessionId=${encodeURIComponent(VIEWER_ID)}`,
        );
        const response = await handleHlsSegment({
            itemId: 'item42',
            internalId: 'item42',
            segmentPath: 'stream_1/segment_00006.m4s',
            url,
            request: new Request(url),
            basePath: '',
        });

        expect(response.headers.get('X-Lumastra-Preview-Static')).toBe('segment');
        const cacheControl = response.headers.get('Cache-Control') ?? '';
        expect(cacheControl).toContain('private');
        // Keep the win: still cacheable by the browser for a year, immutably.
        expect(cacheControl).toContain('max-age=31536000');
        expect(cacheControl).toContain('immutable');
    });

    it('marks the disk-served media playlist private', async () => {
        const url = new URL(
            `https://example.test/api/v1/playback/item42/hls/stream_1/index.m3u8?PlaySessionId=${encodeURIComponent(VIEWER_ID)}`,
        );
        const response = await handleHlsSegment({
            itemId: 'item42',
            internalId: 'item42',
            segmentPath: 'stream_1/index.m3u8',
            url,
            request: new Request(url),
            basePath: '',
        });

        expect(response.headers.get('X-Lumastra-Preview-Static')).toBe('playlist');
        expect(response.headers.get('Cache-Control') ?? '').toContain('private');
    });

    it('marks the disk-served master playlist private', async () => {
        await writeFile(
            nodePath.join(artifactDir, 'master.m3u8'),
            [
                '#EXTM3U',
                '#EXT-X-VERSION:7',
                '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="group_audio",NAME="audio_0",DEFAULT=YES,URI="stream_0/index.m3u8"',
                '#EXT-X-STREAM-INF:BANDWIDTH=2748558,CODECS="avc1.640028,mp4a.40.2",AUDIO="group_audio"',
                'stream_1/index.m3u8',
                '',
            ].join('\n'),
        );
        const url = new URL(
            `https://example.test/api/v1/playback/item42/hls/master.m3u8?PlaySessionId=${encodeURIComponent(VIEWER_ID)}`,
        );
        const response = await handleHlsSegment({
            itemId: 'item42',
            internalId: 'item42',
            segmentPath: 'master.m3u8',
            url,
            request: new Request(url),
            basePath: '',
        });

        expect(response.headers.get('X-Lumastra-Preview-Static')).toBe('master');
        expect(response.headers.get('Cache-Control') ?? '').toContain('private');
    });
});

describe('handleHlsSegment — media playlist during transcode startup (AVFoundation 404 trap)', () => {
    // Regression: a burn-in (SubtitleMethod=Encode) session whose job was just
    // recreated has no VOD manifest info yet, so the playlist request falls back
    // to reading FFmpeg's on-disk manifest — which FFmpeg writes only after the
    // first segment is encoded (~2s for a PGS burn-in). Answering 404 in that
    // window is fatal on tvOS: AVFoundation reads 404 as "resource does not
    // exist" (CoreMediaErrorDomain -12938), penalty-boxes the variant and never
    // retries, leaving a permanent spinner. A live job must answer 503 +
    // Retry-After so the player comes back.
    const PLAY_SESSION_ID = 'ps-burnin-1';
    let outputDir: string;

    function makeStartingJob(dir: string, status: string): Record<string, unknown> {
        return {
            id: 'job-burnin',
            outputDir: dir,
            config: {
                itemId: 'item42',
                hlsOutput: { hlsAudioMode: 'demux' },
                audioTracks: [
                    { index: 0, codec: 'aac' },
                    { index: 1, codec: 'aac' },
                ],
                totalDurationSeconds: 10055,
                subtitleBurnIn: { absoluteIndex: 3, codec: 'hdmv_pgs_subtitle' },
            },
            transcodeDecisionResult: { videoAction: 'copy', audioAction: 'copy' },
            segmentDurationSeconds: 6,
            segmentsReady: 0,
            segmentOffset: 0,
            status,
            isSeeking: false,
            generationRole: 'current',
            generationIndex: 1,
            seekCount: 0,
            lastServedSegment: new Map<string, number>(),
            endSegmentCache: new Map<string, Buffer>(),
            streamTargetDurations: new Map<string, number>(),
            deletedUpTo: new Map<string, number>(),
            syncTraceLoggedStreams: new Set<string>(),
            requestedStartTimeSeconds: 0,
            syncTraceOrigin: 'origin',
            lastSeekTrigger: '',
            lastFFmpegSpawnTime: Date.now(),
            spawnAttempt: 0,
            keyframeData: undefined,
            lastAccessedAt: new Date(),
        };
    }

    function installJob(job: Record<string, unknown>): void {
        Object.assign(transcodeServiceMock, {
            getJob: (id: string) => (id === PLAY_SESSION_ID ? job : undefined),
            getJobByPlaySession: (id: string) => (id === PLAY_SESSION_ID ? job : undefined),
            resolveSegmentRoute: async () => undefined,
            getSegmentOffsetForJob: () => 0,
            getStreamSegmentOffsetForJob: () => 0,
            getStreamTargetDurationForJob: () => undefined,
            canStreamTriggerSeekForJob: () => false,
            isSegmentDeletedForJob: () => false,
            getSegmentOffset: () => 0,
            getStreamSegmentOffset: () => 0,
            recordSegmentAccessForJob: () => {},
            recordSegmentRequestForJob: () => {},
            getRetainedJobsByPlaySession: () => [],
            // No VOD manifest info yet — the freshly recreated job hasn't got any.
            getVodManifestInfo: () => undefined,
            getStreamTargetDuration: () => undefined,
            setStreamTargetDuration: () => {},
        });
    }

    beforeEach(async () => {
        getPreviewSessionMock.mockReset();
        getPreviewSessionMock.mockResolvedValue(undefined);
        outputDir = await mkdtemp(nodePath.join(tmpdir(), 'lumastra-hls-burnin-'));
        // stream_2 exists (FFmpeg created the dir) but index.m3u8 is NOT written yet.
        await mkdir(nodePath.join(outputDir, 'stream_2'), { recursive: true });
    });

    afterEach(async () => {
        if (outputDir) await rm(outputDir, { recursive: true, force: true });
    });

    function buildPlaylistCtx(): HlsSegmentContext {
        const url = new URL(
            `https://example.test/api/v1/playback/item42/hls/stream_2/index.m3u8?PlaySessionId=${PLAY_SESSION_ID}`,
        );
        return {
            itemId: 'item42',
            internalId: 'item42',
            segmentPath: 'stream_2/index.m3u8',
            url,
            request: new Request(url),
            basePath: '',
        };
    }

    it('answers 503 + Retry-After (never 404) while the transcode is still starting', async () => {
        installJob(makeStartingJob(outputDir, 'running'));

        const response = await handleHlsSegment(buildPlaylistCtx());

        // The regression assertion: a 404 here permanently kills the variant on tvOS.
        expect(response.status).not.toBe(404);
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('1');
    });

    it('still answers 404 once the job is gone (manifest really is unavailable)', async () => {
        installJob(makeStartingJob(outputDir, 'stopped'));

        const response = await handleHlsSegment(buildPlaylistCtx());

        expect(response.status).toBe(404);
    });
});

describe('handleHlsSegment — demux master audio codec', () => {
    // The two demux master generators (this handler and
    // hls/playback.service.ts) describe the SAME stream, so they have to
    // derive CODECS the same way. generateMasterPlaylist stamps DEFAULT=YES on
    // `track.isDefault`, so the rendition AVFoundation actually picks is the
    // file's default track — not `audioTracks[0]`.
    const ENGLISH_AAC_FIRST_GERMAN_EAC3_DEFAULT = [
        {
            index: 1,
            codec: 'aac',
            channels: 2,
            language: 'eng',
            displayTitle: 'English',
            isDefault: false,
        },
        {
            index: 2,
            codec: 'eac3',
            channels: 6,
            language: 'ger',
            displayTitle: 'German',
            isDefault: true,
        },
    ];

    let outputDir: string;

    beforeEach(async () => {
        getPreviewSessionMock.mockReset();
        getPreviewSessionMock.mockResolvedValue(undefined);
        outputDir = await mkdtemp(nodePath.join(tmpdir(), 'lumastra-hls-master-'));

        const job = {
            id: 'job-master',
            outputDir,
            config: {
                itemId: 'item42',
                hlsOutput: { hlsAudioMode: 'demux', hlsContainer: 'fmp4' },
                audioTracks: ENGLISH_AAC_FIRST_GERMAN_EAC3_DEFAULT,
                subtitleTracks: [],
                videoInfo: { codec: 'h264', width: 1920, height: 1080, bitrate: 5_000_000 },
                deviceId: 'test-device',
            },
            // Audio COPY: only then does the manifest describe the source codec
            // rather than the transcoder's aac.
            transcodeDecisionResult: { videoAction: 'copy', audioAction: 'copy' },
            segmentDurationSeconds: 6,
            segmentsReady: 10,
            segmentOffset: 0,
            status: 'running',
            isSeeking: false,
            seekCount: 0,
            lastServedSegment: new Map<string, number>(),
            endSegmentCache: new Map<string, Buffer>(),
            streamTargetDurations: new Map<string, number>(),
            deletedUpTo: new Map<string, number>(),
            syncTraceLoggedStreams: new Set<string>(),
            lastAccessedAt: new Date(),
        };

        Object.assign(transcodeServiceMock, {
            getJob: () => job,
            getJobByPlaySession: () => job,
            resolveSegmentRoute: async () => undefined,
            getSegmentOffsetForJob: () => 0,
            getStreamSegmentOffsetForJob: () => 0,
            getStreamTargetDurationForJob: () => undefined,
            canStreamTriggerSeekForJob: () => false,
            isSegmentDeletedForJob: () => false,
            getSegmentOffset: () => 0,
            getStreamSegmentOffset: () => 0,
            recordSegmentAccessForJob: () => {},
            recordSegmentRequestForJob: () => {},
            getRetainedJobsByPlaySession: () => [],
            getVodManifestInfo: () => undefined,
            getStreamTargetDuration: () => undefined,
            setStreamTargetDuration: () => {},
        });
    });

    afterEach(async () => {
        if (outputDir) await rm(outputDir, { recursive: true, force: true });
    });

    it('advertises the DEFAULT track codec, not the first track in the container', async () => {
        const url = new URL(
            'https://example.test/api/v1/playback/item42/hls/master.m3u8?PlaySessionId=session-1',
        );

        const response = await handleHlsSegment({
            itemId: 'item42',
            internalId: 'item42',
            segmentPath: 'master.m3u8',
            url,
            request: new Request(url),
            basePath: '',
        });

        expect(response.status).toBe(200);
        const body = await response.text();
        // German (eac3) carries DEFAULT=YES, so it is the rendition that plays and
        // leads CODECS; the English AAC rendition is copied too, so it is listed
        // after it (CODECS must name every rendition's format).
        expect(body).toMatch(/CODECS="[^",]+,ec-3,mp4a\.40\.2"/);
    });
});

describe('handleHlsSegment — muxed job master', () => {
    let outputDir: string;
    let job: Record<string, unknown>;

    beforeEach(async () => {
        getPreviewSessionMock.mockReset();
        getPreviewSessionMock.mockResolvedValue(undefined);
        outputDir = await mkdtemp(nodePath.join(tmpdir(), 'lumastra-hls-muxed-'));
        job = {
            id: 'job-muxed',
            outputDir,
            config: {
                itemId: 'item42',
                hlsOutput: { hlsAudioMode: 'muxed', hlsContainer: 'fmp4' },
                audioTracks: [
                    { index: 1, codec: 'aac', channels: 2, language: 'eng', isDefault: true },
                ],
                subtitleTracks: [],
                videoInfo: { codec: 'h264', width: 1280, height: 720, bitrate: 3_000_000 },
                deviceId: 'test-device',
            },
            transcodeDecisionResult: { videoAction: 'transcode', audioAction: 'transcode' },
            segmentDurationSeconds: 2,
            segmentsReady: 15,
            segmentOffset: 0,
            status: 'ready',
            isSeeking: false,
            seekCount: 0,
            lastServedSegment: new Map<string, number>(),
            endSegmentCache: new Map<string, Buffer>(),
            streamTargetDurations: new Map<string, number>(),
            deletedUpTo: new Map<string, number>(),
            syncTraceLoggedStreams: new Set<string>(),
            lastAccessedAt: new Date(),
        };
        Object.assign(transcodeServiceMock, {
            getJob: () => job,
            getJobByPlaySession: () => job,
            resolveSegmentRoute: async () => undefined,
            getSegmentOffsetForJob: () => 0,
            getStreamSegmentOffsetForJob: () => 0,
            getStreamTargetDurationForJob: () => undefined,
            canStreamTriggerSeekForJob: () => false,
            isSegmentDeletedForJob: () => false,
            getSegmentOffset: () => 0,
            getStreamSegmentOffset: () => 0,
            recordSegmentAccessForJob: () => {},
            recordSegmentRequestForJob: () => {},
            getRetainedJobsByPlaySession: () => [],
            getVodManifestInfo: () => undefined,
            getStreamTargetDuration: () => undefined,
            setStreamTargetDuration: () => {},
        });
    });

    afterEach(async () => {
        if (outputDir) await rm(outputDir, { recursive: true, force: true });
    });

    const request = (): Promise<Response> => {
        const url = new URL(
            'https://example.test/api/v1/playback/item42/hls/master.m3u8?PlaySessionId=session-1&hlsAudioMode=muxed',
        );
        return handleHlsSegment({
            itemId: 'item42',
            internalId: 'item42',
            segmentPath: 'master.m3u8',
            url,
            request: new Request(url),
            basePath: '',
        });
    };

    it('serves the flat root media playlist, never a demux master of stream_N renditions', async () => {
        await writeFile(
            nodePath.join(outputDir, 'index.m3u8'),
            [
                '#EXTM3U',
                '#EXT-X-TARGETDURATION:2',
                '#EXT-X-PLAYLIST-TYPE:EVENT',
                '#EXT-X-MAP:URI="init_0.mp4"',
                '#EXTINF:2.000000,',
                'segment_00000.m4s',
                '#EXT-X-ENDLIST',
                '',
            ].join('\n'),
        );

        const response = await request();

        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toContain('#EXT-X-MAP:URI="init_0.mp4?PlaySessionId=session-1"');
        expect(body).toContain('segment_00000.m4s?PlaySessionId=session-1');
        expect(body).not.toContain('stream_');
        expect(body).not.toContain('#EXT-X-STREAM-INF');
    });

    it('answers 503 + Retry-After while a dead/unstarted job has no playlist yet', async () => {
        job.status = 'error';

        const response = await request();

        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('1');
    });
});

// GPU hw test 2026-10-01: a forward seek 15 segments ahead on a 4.5x transcode
// (CPU tonemap) waited out the 10 s segment wait and got a 404 — terminal for
// hls.js and our player. Guards the WIRING: the planner must see the job's
// speed + segment duration (speed-aware seek), and the missing-file response
// must see current progress (503 for a segment the live job will still write).
describe('handleHlsSegment — slow transcode forward seek', () => {
    const PLAY_SESSION_ID = 'ps-slow-seek-1';
    let outputDir: string;

    function makeSlowJob(dir: string): Record<string, unknown> {
        return {
            id: 'job-slow',
            outputDir: dir,
            config: {
                itemId: 'item42',
                hlsOutput: { hlsAudioMode: 'demux' },
                audioTracks: [{ index: 0, codec: 'aac' }],
                totalDurationSeconds: 600,
            },
            transcodeDecisionResult: { videoAction: 'transcode', audioAction: 'transcode' },
            segmentDurationSeconds: 6,
            segmentsReady: 9,
            segmentOffset: 0,
            transcodeSpeed: 4.5,
            status: 'running',
            isSeeking: false,
            generationRole: 'current',
            generationIndex: 0,
            seekCount: 0,
            lastServedSegment: new Map<string, number>([['stream_0', 8]]),
            endSegmentCache: new Map<string, Buffer>(),
            streamTargetDurations: new Map<string, number>(),
            deletedUpTo: new Map<string, number>(),
            syncTraceLoggedStreams: new Set<string>(),
            requestedStartTimeSeconds: 0,
            syncTraceOrigin: 'origin',
            lastSeekTrigger: '',
            lastFFmpegSpawnTime: Date.now(),
            spawnAttempt: 0,
            keyframeData: undefined,
            lastAccessedAt: new Date(),
        };
    }

    beforeEach(async () => {
        getPreviewSessionMock.mockReset();
        getPreviewSessionMock.mockResolvedValue(undefined);
        seekToSegmentMock.mockClear();
        outputDir = await mkdtemp(nodePath.join(tmpdir(), 'lumastra-hls-slow-seek-'));
        await mkdir(nodePath.join(outputDir, 'stream_0'), { recursive: true });

        const job = makeSlowJob(outputDir);
        Object.assign(transcodeServiceMock, {
            getJob: (id: string) => (id === PLAY_SESSION_ID ? job : undefined),
            getJobByPlaySession: (id: string) => (id === PLAY_SESSION_ID ? job : undefined),
            resolveSegmentRoute: async () => undefined,
            getSegmentOffsetForJob: () => 0,
            getStreamSegmentOffsetForJob: () => 0,
            getStreamTargetDurationForJob: () => undefined,
            canStreamTriggerSeekForJob: () => true,
            isSegmentDeletedForJob: () => false,
            getSegmentOffset: () => 0,
            getStreamSegmentOffset: () => 0,
            recordSegmentAccessForJob: () => {},
            recordSegmentRequestForJob: () => {},
            getRetainedJobsByPlaySession: () => [],
            getVodManifestInfo: () => undefined,
            getStreamTargetDuration: () => undefined,
            setStreamTargetDuration: () => {},
        });
    });

    afterEach(async () => {
        if (outputDir) await rm(outputDir, { recursive: true, force: true });
    });

    it.each([false, true])(
        'maps only an explicit shutdown interruption to a retry (interrupted=%s)',
        async (interrupted) => {
            const draining = vi.spyOn(shutdown, 'isShuttingDown').mockReturnValue(false);
            sqlTag.mockResolvedValue([]);
            __resetSessionOwnerCacheForTests();
            Object.assign(transcodeServiceMock, {
                getJob: () => {
                    draining.mockReturnValue(true);
                    throw interrupted
                        ? new ShutdownInterruptedError()
                        : new Error('real segment bug');
                },
            });
            try {
                const url = new URL(
                    `https://example.test/api/v1/playback/item42/hls/stream_0/segment_00024.m4s?PlaySessionId=${PLAY_SESSION_ID}`,
                );
                const response = await handleHlsSegment({
                    itemId: 'item42',
                    internalId: 'item42',
                    segmentPath: 'stream_0/segment_00024.m4s',
                    url,
                    request: new Request(url),
                    basePath: '',
                });
                expect(response.status).toBe(interrupted ? 503 : 500);
                expect(response.headers.get('Retry-After')).toBe(interrupted ? '2' : null);
            } finally {
                draining.mockRestore();
            }
        },
    );

    it('restarts at the target instead of waiting, and answers 503 (not 404) if that fails', async () => {
        const url = new URL(
            `https://example.test/api/v1/playback/item42/hls/stream_0/segment_00024.m4s?PlaySessionId=${PLAY_SESSION_ID}`,
        );

        const response = await handleHlsSegment({
            itemId: 'item42',
            internalId: 'item42',
            segmentPath: 'stream_0/segment_00024.m4s',
            url,
            request: new Request(url),
            basePath: '',
        });

        expect(seekToSegmentMock).toHaveBeenCalled();
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('1');
        expect(response.headers.get('X-Lumastra-Branch')).toBe('segment_not_ready');
    });
    // The transcode throttle continues a paused FFmpeg the moment a request has
    // to wait for it — which only works if the handler reports the request
    // BEFORE it waits, with the file's real presence.
    it('reports each segment request to the transcode throttle before waiting or serving', async () => {
        const recordRequest = vi.fn();
        Object.assign(transcodeServiceMock, { recordSegmentRequestForJob: recordRequest });
        await writeFile(nodePath.join(outputDir, 'stream_0', 'segment_00005.m4s'), 'x');

        for (const segment of ['segment_00005.m4s', 'segment_00024.m4s']) {
            const url = new URL(
                `https://example.test/api/v1/playback/item42/hls/stream_0/${segment}?PlaySessionId=${PLAY_SESSION_ID}`,
            );
            await handleHlsSegment({
                itemId: 'item42',
                internalId: 'item42',
                segmentPath: `stream_0/${segment}`,
                url,
                request: new Request(url),
                basePath: '',
            });
        }

        expect(recordRequest.mock.calls.map((c) => c.slice(1))).toEqual([
            ['stream_0', 5, 6, true],
            ['stream_0', 24, 6, false],
        ]);
    });
});

describe('handleHlsSegment — transcode tail: no phantom last segment, no borrowed bytes', () => {
    // Found by the reverse-proxy e2e 2026-10-06: a transcoded playlist ended with
    // a 0.021 s entry (container 12.021 s, video 12.000 s at 24 fps). FFmpeg
    // never writes that video segment — its last frame starts before the cut —
    // so the request fell through to the tail cache, which holds the PREVIOUS
    // segment, and the end of the video repeated. Shape measured with the app's
    // real args (hls-tail-ffmpeg-smoke.test.ts): audio 3 files, video 2.
    const PLAY_SESSION_ID = 'ps-tail-1';
    let outputDir: string;

    function makeFinishedTranscode(
        dir: string,
        totalDurationSeconds: number,
        reachedEndOfInput: boolean,
        videoAction: 'transcode' | 'copy' = 'transcode',
    ) {
        return {
            id: 'job-tail',
            outputDir: dir,
            config: {
                itemId: 'item42',
                hlsOutput: { hlsAudioMode: 'demux' },
                audioTracks: [{ index: 0, codec: 'aac' }],
                totalDurationSeconds,
                deviceId: 'test-device',
            },
            transcodeDecisionResult: { videoAction, audioAction: videoAction },
            segmentDurationSeconds: 6,
            segmentsReady: 2,
            segmentOffset: 0,
            // FFmpeg exited 0 on its own: status stays 'ready' (handleExit).
            status: 'ready',
            reachedEndOfInput,
            isSeeking: false,
            generationRole: 'current',
            generationIndex: 0,
            seekCount: 0,
            lastServedSegment: new Map<string, number>([['stream_1', 1]]),
            // What the responder caches after serving the real last video file.
            endSegmentCache: new Map<string, EndSegmentCacheEntry>([
                [
                    'stream_1',
                    {
                        kind: 'segment',
                        segmentIndex: 1,
                        buffer: Buffer.from('video-seg-1'),
                    },
                ],
            ]),
            streamTargetDurations: new Map<string, number>(),
            deletedUpTo: new Map<string, number>(),
            syncTraceLoggedStreams: new Set<string>(),
            requestedStartTimeSeconds: 0,
            syncTraceOrigin: 'origin',
            lastSeekTrigger: '',
            lastFFmpegSpawnTime: 0,
            spawnAttempt: 0,
            keyframeData: undefined,
            lastAccessedAt: new Date(),
        };
    }

    function closedManifest(files: number[]): string {
        return [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            '#EXT-X-TARGETDURATION:6',
            '#EXT-X-MEDIA-SEQUENCE:0',
            '#EXT-X-PLAYLIST-TYPE:EVENT',
            '#EXT-X-MAP:URI="init_0.mp4"',
            ...files.flatMap((i) => [
                '#EXTINF:6.000000,',
                `segment_${String(i).padStart(5, '0')}.m4s`,
            ]),
            '#EXT-X-ENDLIST',
            '',
        ].join('\n');
    }

    async function install(
        totalDurationSeconds: number,
        reachedEndOfInput = true,
        videoAction: 'transcode' | 'copy' = 'transcode',
    ): Promise<ReturnType<typeof makeFinishedTranscode>> {
        const job = makeFinishedTranscode(
            outputDir,
            totalDurationSeconds,
            reachedEndOfInput,
            videoAction,
        );
        Object.assign(transcodeServiceMock, {
            getJob: (id: string) => (id === PLAY_SESSION_ID ? job : undefined),
            getJobByPlaySession: (id: string) => (id === PLAY_SESSION_ID ? job : undefined),
            resolveSegmentRoute: async () => undefined,
            getSegmentOffsetForJob: () => 0,
            getStreamSegmentOffsetForJob: () => 0,
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
        });
        return job;
    }

    function request(stream: string, index: number): Promise<Response> {
        const segmentPath = `${stream}/segment_${String(index).padStart(5, '0')}.m4s`;
        const url = new URL(
            `https://example.test/api/v1/playback/item42/hls/${segmentPath}?PlaySessionId=${PLAY_SESSION_ID}`,
        );
        return handleHlsSegment({
            itemId: 'item42',
            internalId: 'item42',
            segmentPath,
            url,
            request: new Request(url),
            basePath: '',
        });
    }

    beforeEach(async () => {
        getPreviewSessionMock.mockReset();
        getPreviewSessionMock.mockResolvedValue(undefined);
        seekToSegmentMock.mockClear();
        outputDir = await mkdtemp(nodePath.join(tmpdir(), 'lumastra-hls-tail-'));
        for (const stream of ['stream_0', 'stream_1']) {
            await mkdir(nodePath.join(outputDir, stream), { recursive: true });
        }
        for (const i of [0, 1, 2]) {
            await writeFile(
                nodePath.join(outputDir, 'stream_0', `segment_0000${i}.m4s`),
                Buffer.from(`audio-seg-${i}`),
            );
        }
        for (const i of [0, 1]) {
            await writeFile(
                nodePath.join(outputDir, 'stream_1', `segment_0000${i}.m4s`),
                Buffer.from(`video-seg-${i}`),
            );
        }
        await writeFile(
            nodePath.join(outputDir, 'stream_0', 'index.m3u8'),
            closedManifest([0, 1, 2]),
        );
        await writeFile(nodePath.join(outputDir, 'stream_1', 'index.m3u8'), closedManifest([0, 1]));
    });

    afterEach(async () => {
        if (outputDir) await rm(outputDir, { recursive: true, force: true });
    });

    it('a 0.021 s remainder: the index past the folded grid is 404 on every rendition', async () => {
        await install(12.021);

        const video = await request('stream_1', 2);
        expect(video.status).toBe(404);
        expect(await video.text()).not.toBe('video-seg-1');
        // Audio did write the sliver, but the playlist never lists it.
        expect((await request('stream_0', 2)).status).toBe(404);
        expect(seekToSegmentMock).not.toHaveBeenCalled();
    });

    it('the real last segment is still served with its own bytes', async () => {
        await install(12.021);

        const video = await request('stream_1', 1);
        expect(video.status).toBe(200);
        expect(await video.text()).toBe('video-seg-1');
    });

    it('a long overhang the grid keeps (0.7 s): FFmpeg closed video one short, 404 not the cache', async () => {
        await install(12.7);

        const video = await request('stream_1', 2);
        expect(video.status).toBe(404);
        expect(seekToSegmentMock).not.toHaveBeenCalled();
        // Audio has that segment, so it serves its own bytes.
        const audio = await request('stream_0', 2);
        expect(audio.status).toBe(200);
        expect(await audio.text()).toBe('audio-seg-2');
    });

    it('a closed manifest from a stop WE caused is not proof: the last segment is not refused', async () => {
        // SIGTERM flushes and writes ENDLIST too. That generation never read
        // to the end, so segment 2 can still be produced and must not 404.
        await install(12.7, false);

        // It waits for the real file (the tail cache holds index 1 and must not
        // answer index 2 with those bytes), so produce it while it waits.
        const pending = request('stream_1', 2);
        await new Promise((resolve) => setTimeout(resolve, 300));
        await writeFile(
            nodePath.join(outputDir, 'stream_1', 'segment_00002.m4s'),
            Buffer.from('video-seg-2'),
        );
        const video = await pending;
        expect(video.status).toBe(200);
        expect(await video.text()).toBe('video-seg-2');
    });

    // Copy audio ending >= 0.5 s before the container: the grid keeps a last
    // entry the audio rendition never writes. The tail cache holds the audio's
    // real last segment (1) and used to answer ANY tail index with it.
    it('copy mode: a tail index the cache does not hold misses instead of borrowing its bytes', async () => {
        const job = await install(12.7, true, 'copy');
        await rm(nodePath.join(outputDir, 'stream_0', 'segment_00002.m4s'));
        job.status = 'stopped';
        job.endSegmentCache.set('stream_0', {
            kind: 'segment',
            segmentIndex: 1,
            buffer: Buffer.from('audio-seg-1'),
        });

        const audio = await request('stream_0', 2);
        expect(audio.status).toBe(404);
        expect(await audio.text()).not.toBe('audio-seg-1');
        expect(seekToSegmentMock).not.toHaveBeenCalled();
    });

    it('copy mode: the cache still answers the index it holds', async () => {
        const job = await install(12.7, true, 'copy');
        await rm(nodePath.join(outputDir, 'stream_0', 'segment_00002.m4s'));
        job.endSegmentCache.set('stream_0', {
            kind: 'segment',
            segmentIndex: 2,
            buffer: Buffer.from('cached-audio-2'),
        });

        const audio = await request('stream_0', 2);
        expect(audio.status).toBe(200);
        expect(await audio.text()).toBe('cached-audio-2');
    });

    it('copy mode: a tail-run entry answers only the last entry, and only if its stream reaches it', async () => {
        const job = await install(12.7, true, 'copy');
        await rm(nodePath.join(outputDir, 'stream_0', 'segment_00002.m4s'));
        await rm(nodePath.join(outputDir, 'stream_0', 'segment_00001.m4s'));
        job.status = 'stopped';
        // Grid of 12.7 s at 6 s: entries 0..2, the last starts at 12 s.
        job.endSegmentCache.set('stream_0', {
            kind: 'tail_run',
            mediaEndSeconds: 12.7,
            buffer: Buffer.from('tail-run-audio'),
        });
        const hit = await request('stream_0', 2);
        expect(hit.status).toBe(200);
        expect(await hit.text()).toBe('tail-run-audio');
        // Index 1 is in the tail window too, but the buffer is not its bytes.
        expect((await request('stream_0', 1)).status).toBe(404);

        // Audio that ends 1.2 s early never reaches the last entry.
        job.endSegmentCache.set('stream_0', {
            kind: 'tail_run',
            mediaEndSeconds: 11.5,
            buffer: Buffer.from('tail-run-audio'),
        });
        expect((await request('stream_0', 2)).status).toBe(404);
    });

    it("a tail-run entry resolves on the stream's own cadence, not the job's", async () => {
        const job = await install(12.7, true, 'copy');
        job.status = 'stopped';
        // stream_0 runs on 4 s: entries 0..3, the last [12, 12.7]. On the job's
        // 6 s grid the last entry would be 2.
        Object.assign(transcodeServiceMock, {
            getStreamTargetDurationForJob: (_job: unknown, dir: string) =>
                dir === 'stream_0' ? 4 : undefined,
        });
        job.endSegmentCache.set('stream_0', {
            kind: 'tail_run',
            mediaEndSeconds: 12.7,
            buffer: Buffer.from('tail-run-audio'),
        });

        const hit = await request('stream_0', 3);
        expect(hit.status).toBe(200);
        expect(await hit.text()).toBe('tail-run-audio');
        await rm(nodePath.join(outputDir, 'stream_0', 'segment_00002.m4s'));
        const other = await request('stream_0', 2);
        expect(await other.text()).not.toBe('tail-run-audio');
    });

    it('copy mode is left alone: its video lists keyframe entries, not this grid', async () => {
        await install(12.021, true, 'copy');

        const audio = await request('stream_0', 2);
        // The audio file exists; copy mode serves it rather than a past_end 404.
        expect(audio.status).toBe(200);
        expect(await audio.text()).toBe('audio-seg-2');
    });
});

describe('serveMasterPlaylist — session-path master (web route vs native routes)', () => {
    const job = (hlsAudioTrackIndex?: number) => ({
        config: {
            fileId: 'file-1',
            audioTracks: [
                {
                    index: 1,
                    displayTitle: 'English',
                    language: 'eng',
                    channels: 6,
                    codec: 'ac3',
                    isDefault: true,
                },
                {
                    index: 2,
                    displayTitle: 'German',
                    language: 'ger',
                    channels: 6,
                    codec: 'ac3',
                    isDefault: false,
                },
            ],
            subtitleTracks: [
                {
                    index: 3,
                    displayTitle: 'English',
                    language: 'eng',
                    codec: 'subrip',
                    isDefault: false,
                    isForced: false,
                    isTextBased: true,
                },
            ],
            videoInfo: { width: 1920, height: 1080, codec: 'h264', bitrate: 5_000_000 },
            hlsOutput: { hlsAudioMode: 'demux', hlsAudioTrackIndex },
        },
        transcodeDecisionResult: { audioAction: 'copy' },
    });
    const serve = async (path: string, query = '', hlsAudioTrackIndex?: number) =>
        serveMasterPlaylist(
            job(hlsAudioTrackIndex),
            'item42',
            'sess-1',
            new URL(`https://example.test${path}/master.m3u8?PlaySessionId=sess-1${query}`),
            '',
        ).text();

    it('web route (/api/playback) carries no SUBTITLES rendition', async () => {
        const body = await serve('/api/playback/item42/hls');
        expect(body).not.toContain('TYPE=SUBTITLES');
        expect(body).not.toContain('SUBTITLES="');
    });

    it('/api/v1 and /j keep their SUBTITLES renditions', async () => {
        expect(await serve('/api/v1/playback/item42/hls')).toContain('TYPE=SUBTITLES');
        expect(await serve('/j/Videos/item42/hls')).toContain('TYPE=SUBTITLES');
    });

    it('marks the request hlsAudioTrack DEFAULT, else the job track, else the file default', async () => {
        const defaults = (body: string) =>
            body
                .split('\n')
                .filter((l) => l.includes('TYPE=AUDIO'))
                .map((l) => /DEFAULT=(YES|NO)/.exec(l)![1]);
        expect(defaults(await serve('/api/playback/item42/hls', '&hlsAudioTrack=2'))).toEqual([
            'NO',
            'YES',
        ]);
        expect(defaults(await serve('/api/playback/item42/hls', '', 2))).toEqual(['NO', 'YES']);
        expect(defaults(await serve('/api/playback/item42/hls'))).toEqual(['YES', 'NO']);
    });
});
