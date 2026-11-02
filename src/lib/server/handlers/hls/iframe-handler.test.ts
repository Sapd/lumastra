// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The synthetic I-frame handlers (iframe_XXXXX.ts, iframe.m3u8?synthetic=true)
 * received only `itemId` — the route middleware (withIdResolution +
 * withMediaAccess) gates the PATH item, but the trickplay `fileId` query
 * param was passed straight to getSpriteSheet / embedded into every segment
 * URL with no check that it actually belongs to the requested item. So
 * `GET .../{itemA}/hls/iframe_00000.ts?...&fileId={itemB's file}` served
 * item B's thumbnail regardless of item A's access grant, and
 * `fileId=../../x` was joined straight into a filesystem path.
 *
 * These tests pin the fix: `internalId` (threaded from
 * locals.resolvedIds.internalId) + `resolvePlaybackSelection` scope fileId to
 * the requested item before it's ever used.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetDb = vi.fn();
const mockResolvePlaybackSelection = vi.fn();
const mockGetSpriteSheet = vi.fn();
const mockGetJellyfinDiskSpriteSheet = vi.fn();
const mockGenerateSyntheticIFrame = vi.fn();
const mockGetMediaItemRuntime = vi.fn();
const mockGetJob = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/media-file-resolution.queries.js', () => ({
    resolvePlaybackSelection: (...args: unknown[]) => mockResolvePlaybackSelection(...args),
}));

vi.mock('$lib/server/services/trickplay-storage.service.js', () => ({
    getSpriteSheet: (...args: unknown[]) => mockGetSpriteSheet(...args),
}));

vi.mock('$lib/server/tasks/builtin/native/trickplay-providers/jellyfin-disk.js', () => ({
    getJellyfinDiskSpriteSheet: (...args: unknown[]) => mockGetJellyfinDiskSpriteSheet(...args),
}));

vi.mock('$lib/server/database/queries/media-lookup.queries.js', () => ({
    getMediaItemRuntime: (...args: unknown[]) => mockGetMediaItemRuntime(...args),
}));

vi.mock('$lib/server/services/ffmpeg-transcode.service.js', () => ({
    getFFmpegTranscodeService: () => ({ getJob: (...args: unknown[]) => mockGetJob(...args) }),
}));

const jellyfinGate = vi.hoisted(() => ({ callable: true }));
vi.mock('$lib/server/jellyfin/runtime-gate.js', () => ({
    canCallJellyfin: () => jellyfinGate.callable,
}));

vi.mock('$lib/server/jellyfin.js', () => ({
    jellyfinMediaService: { getItemInfo: vi.fn() },
}));

// calculateSpritePosition / generateSyntheticIFramePlaylist are pure — kept
// real. generateSyntheticIFrame spawns ffmpeg, so it's stubbed.
vi.mock('$lib/server/utils/synthetic-iframe.js', async () => {
    const actual = await vi.importActual<typeof import('$lib/server/utils/synthetic-iframe.js')>(
        '$lib/server/utils/synthetic-iframe.js',
    );
    return {
        ...actual,
        generateSyntheticIFrame: (...args: unknown[]) => mockGenerateSyntheticIFrame(...args),
    };
});

// Caches are real (in-memory LRU, no side effects) but module-singleton —
// use distinct itemId/iframeIndex per test to avoid cross-test cache hits.

const ITEM_A = 'item-a';
const FILE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const INTERNAL_A = 'internal-a';
const FILE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // belongs to a different item

function segmentUrl(iframeIndex: number, fileId: string | null, extra = ''): URL {
    const qs = new URLSearchParams({
        trickplay_width: '320',
        trickplay_interval: '10000',
        trickplay_count: '100',
        trickplay_tile_width: '10',
        trickplay_tile_height: '10',
    });
    if (fileId !== null) qs.set('fileId', fileId);
    return new URL(
        `http://localhost/api/v1/playback/${ITEM_A}/hls/iframe_${String(iframeIndex).padStart(5, '0')}.ts?${qs.toString()}${extra}`,
    );
}

describe('handleSyntheticIFrameSegment — fileId item scoping', () => {
    beforeEach(async () => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockGenerateSyntheticIFrame.mockResolvedValue(Buffer.from('ts-segment'));
        mockGetJellyfinDiskSpriteSheet.mockResolvedValue(null);
    });

    it('404s and never calls getSpriteSheet when fileId belongs to a different item', async () => {
        // resolvePlaybackSelection scopes to internalId — a foreign fileId
        // (item B's file) resolves to no match for item A.
        mockResolvePlaybackSelection.mockResolvedValue({ files: [], fileId: null });

        const { handleSyntheticIFrameSegment } = await import('./iframe-handler.js');
        const res = await handleSyntheticIFrameSegment(
            ITEM_A,
            1,
            segmentUrl(1, FILE_B),
            INTERNAL_A,
        );

        expect(res.status).toBe(404);
        expect(mockResolvePlaybackSelection).toHaveBeenCalledWith(expect.anything(), INTERNAL_A, {
            fileId: FILE_B,
        });
        expect(mockGetSpriteSheet).not.toHaveBeenCalled();
    });

    it('serves the segment when fileId belongs to the requested item', async () => {
        mockResolvePlaybackSelection.mockResolvedValue({
            files: [{ id: FILE_A, file_path: '/data/media/a.mkv' }],
            fileId: FILE_A,
        });
        mockGetSpriteSheet.mockResolvedValue(Buffer.from('sprite-sheet-bytes'));

        const { handleSyntheticIFrameSegment } = await import('./iframe-handler.js');
        const res = await handleSyntheticIFrameSegment(
            ITEM_A,
            2,
            segmentUrl(2, FILE_A),
            INTERNAL_A,
        );

        expect(res.status).toBe(200);
        // Resolved fileId + the file's own path (not just the raw fileId) reach
        // getSpriteSheet — this also fixes the alongside-layout miss the tile
        // route already handles.
        expect(mockGetSpriteSheet).toHaveBeenCalledWith(
            FILE_A,
            320,
            expect.any(Number),
            '/data/media/a.mkv',
        );
    });

    it('400s a path-traversal fileId before any DB or filesystem access', async () => {
        const { handleSyntheticIFrameSegment } = await import('./iframe-handler.js');
        const res = await handleSyntheticIFrameSegment(
            ITEM_A,
            3,
            segmentUrl(3, '../../etc/passwd'),
            INTERNAL_A,
        );

        expect(res.status).toBe(400);
        expect(mockResolvePlaybackSelection).not.toHaveBeenCalled();
        expect(mockGetSpriteSheet).not.toHaveBeenCalled();
    });

    it('404s when internalId is unresolved (id-resolution middleware found nothing) rather than trusting the raw fileId', async () => {
        const { handleSyntheticIFrameSegment } = await import('./iframe-handler.js');
        const res = await handleSyntheticIFrameSegment(ITEM_A, 4, segmentUrl(4, FILE_A), undefined);

        expect(res.status).toBe(404);
        expect(mockResolvePlaybackSelection).not.toHaveBeenCalled();
        expect(mockGetSpriteSheet).not.toHaveBeenCalled();
    });
});

describe('handleIFramePlaylist (synthetic) — fileId item scoping', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockGetJob.mockReturnValue(undefined);
        mockGetMediaItemRuntime.mockResolvedValue(3600);
    });

    function playlistUrl(fileId: string | null): URL {
        const qs = new URLSearchParams({
            synthetic: 'true',
            trickplay_width: '320',
            trickplay_interval: '10000',
            trickplay_count: '100',
            trickplay_tile_width: '10',
            trickplay_tile_height: '10',
        });
        if (fileId !== null) qs.set('fileId', fileId);
        return new URL(
            `http://localhost/api/v1/playback/${ITEM_A}/hls/iframe.m3u8?${qs.toString()}`,
        );
    }

    it('404s the playlist when fileId belongs to a different item, before embedding it in any segment URL', async () => {
        mockResolvePlaybackSelection.mockResolvedValue({ files: [], fileId: null });

        const { handleIFramePlaylist } = await import('./iframe-handler.js');
        const res = await handleIFramePlaylist(
            ITEM_A,
            'session-1',
            playlistUrl(FILE_B),
            INTERNAL_A,
        );

        expect(res.status).toBe(404);
        const body = await res.text();
        expect(body).not.toContain(FILE_B);
    });

    it('no DB runtime + Jellyfin unavailable: 503 without asking Jellyfin', async () => {
        mockGetMediaItemRuntime.mockResolvedValue(null);
        mockResolvePlaybackSelection.mockResolvedValue({
            files: [{ id: FILE_A, file_path: '/data/media/a.mkv' }],
            fileId: FILE_A,
        });
        jellyfinGate.callable = false;

        const { jellyfinMediaService } = await import('$lib/server/jellyfin.js');
        const { handleIFramePlaylist } = await import('./iframe-handler.js');
        const res = await handleIFramePlaylist(
            ITEM_A,
            'session-1',
            playlistUrl(FILE_A),
            INTERNAL_A,
        );

        expect(res.status).toBe(503);
        expect(jellyfinMediaService.getItemInfo).not.toHaveBeenCalled();
        jellyfinGate.callable = true;
    });

    it('no DB runtime + Jellyfin reachable: falls back to its duration as before', async () => {
        mockGetMediaItemRuntime.mockResolvedValue(null);
        mockResolvePlaybackSelection.mockResolvedValue({
            files: [{ id: FILE_A, file_path: '/data/media/a.mkv' }],
            fileId: FILE_A,
        });
        const { jellyfinMediaService } = await import('$lib/server/jellyfin.js');
        vi.mocked(jellyfinMediaService.getItemInfo).mockResolvedValue({
            RunTimeTicks: 3600 * 10_000_000,
        } as never);

        const { handleIFramePlaylist } = await import('./iframe-handler.js');
        const res = await handleIFramePlaylist(
            ITEM_A,
            'session-1',
            playlistUrl(FILE_A),
            INTERNAL_A,
        );

        expect(res.status).toBe(200);
        expect(jellyfinMediaService.getItemInfo).toHaveBeenCalledWith(ITEM_A);
    });

    it('builds the playlist with the resolved fileId when it belongs to the item', async () => {
        mockResolvePlaybackSelection.mockResolvedValue({
            files: [{ id: FILE_A, file_path: '/data/media/a.mkv' }],
            fileId: FILE_A,
        });

        const { handleIFramePlaylist } = await import('./iframe-handler.js');
        const res = await handleIFramePlaylist(
            ITEM_A,
            'session-1',
            playlistUrl(FILE_A),
            INTERNAL_A,
        );

        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain(`fileId=${FILE_A}`);
    });
});

describe('generateAnalyzedIFramePlaylist — target duration', () => {
    const entry = (i: number, duration: number) => ({
        segmentIndex: i,
        segmentUri: `stream_0/segment_${i}.m4s`,
        byteOffset: 0,
        byteSize: 1000,
        duration,
        timestamp: i * 2,
    });

    it('is the longest I-frame interval, never under 6 s', async () => {
        const { generateAnalyzedIFramePlaylist } = await import('./iframe-handler.js');
        const short = generateAnalyzedIFramePlaylist(
            { iframeData: [entry(0, 2), entry(1, 4)], iframeAnalysisComplete: true },
            0,
            '/hls',
        );
        expect(short).toContain('#EXT-X-TARGETDURATION:6');
        const long = generateAnalyzedIFramePlaylist(
            { iframeData: [entry(0, 2), entry(1, 9.5)], iframeAnalysisComplete: true },
            0,
            '/hls',
        );
        expect(long).toContain('#EXT-X-TARGETDURATION:10');
    });

    // GPU transcode tests 2026-10-02: Math.max(...spread) over one entry per
    // keyframe overflows the call stack on a long timeline.
    it('survives hundreds of thousands of I-frames', async () => {
        const { generateAnalyzedIFramePlaylist } = await import('./iframe-handler.js');
        const iframeData = Array.from({ length: 300_000 }, (_v, i) => entry(i, 2));
        const playlist = generateAnalyzedIFramePlaylist(
            { iframeData, iframeAnalysisComplete: true },
            0,
            '/hls',
        );
        expect(playlist).toContain('#EXT-X-TARGETDURATION:6');
        expect(playlist).toContain('#EXT-X-ENDLIST');
    });
});

describe('I-frame playlist credentials', () => {
    it.each([false, true])(
        'carries grant in every init and I-frame URI (synthetic=%s)',
        async (synthetic) => {
            vi.clearAllMocks();
            mockGetDb.mockReturnValue({});
            mockGetJob.mockReturnValue(null);
            mockGetMediaItemRuntime.mockResolvedValue(60);
            mockResolvePlaybackSelection.mockResolvedValue({
                files: [{ id: FILE_A, file_path: '/data/media/a.mkv' }],
                fileId: FILE_A,
            });
            const url = segmentUrl(0, FILE_A, '&grant=stream_iframe');
            url.searchParams.set('synthetic', String(synthetic));
            const { handleIFramePlaylist } = await import('./iframe-handler.js');
            const response = await handleIFramePlaylist(ITEM_A, 'session', url, INTERNAL_A);
            expect(response.status).toBe(200);
            const uris = (await response.text())
                .split('\n')
                .flatMap((line) =>
                    line.startsWith('#')
                        ? Array.from(line.matchAll(/URI="([^"]+)"/g), (match) => match[1])
                        : line
                          ? [line]
                          : [],
                );
            expect(uris.length).toBeGreaterThan(0);
            for (const uri of uris)
                expect(new URL(uri, url).searchParams.get('grant')).toBe('stream_iframe');
        },
    );
});
