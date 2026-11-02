// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
    handleSubtitlePlaylist,
    handleSubtitleSegment,
    parseSubtitlePath,
} from './subtitle-handler.js';

// ============================================================================
// Mocks (vi.hoisted so they can be used in vi.mock factories)
// ============================================================================

const {
    mockGetJob,
    mockGetDb,
    mockResolveSubtitle,
    mockFileCacheGet,
    mockFileCacheSet,
    mockGetDbConn,
    mockResolvePlaybackSelection,
} = vi.hoisted(() => ({
    mockGetJob: vi.fn(),
    mockGetDb: vi.fn(),
    mockResolveSubtitle: vi.fn(),
    mockFileCacheGet: vi.fn(),
    mockFileCacheSet: vi.fn(),
    mockGetDbConn: vi.fn(),
    mockResolvePlaybackSelection: vi.fn(),
}));

vi.mock('$lib/server/services/ffmpeg-transcode.service.js', () => ({
    getFFmpegTranscodeService: () => ({
        getJob: mockGetJob,
    }),
}));

vi.mock('$lib/server/config.js', () => ({
    config: { DEBUG_SUBTITLES: false },
}));

vi.mock('$lib/server/database/index.js', () => ({
    getDb: () => mockGetDb(),
}));

vi.mock('$lib/server/services/subtitle-cache.service.js', () => ({
    subtitleCacheService: {
        getCues: vi.fn().mockResolvedValue([]),
    },
}));

vi.mock('$lib/server/services/cache/subtitle-file-cache.service.js', () => ({
    SubtitleFileCacheService: {
        get: mockFileCacheGet,
        set: mockFileCacheSet,
    },
}));

vi.mock('$lib/server/services/subtitle-resolver.service.js', () => ({
    resolveSubtitle: mockResolveSubtitle,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

// `handleSubtitleSegment` now imports `resolveFileScopedToItem` from
// file-scope.js (fix plan 6, C1 sibling of the 2026-09-13 fix plan's C27 —
// see its doc comment there): the same fileId->item DB scoping check the
// trickplay/I-frame handlers use, reused rather than forked. These two
// modules are its only real dependencies for that check.
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDbConn(...args),
}));

vi.mock('$lib/server/database/queries/media-file-resolution.queries.js', () => ({
    resolvePlaybackSelection: (...args: unknown[]) => mockResolvePlaybackSelection(...args),
}));

// ============================================================================
// Helpers
// ============================================================================

const UUID_ITEM_ID = 'ef98c9ad-5970-48e6-ae30-81e1837d6e45';
const FILE_ID = '8739461e-1234-5678-9abc-def012345678';
/** The gated item's resolved internal id — distinct from UUID_ITEM_ID so the
 *  fixture proves the scoping check uses `internalId`, not the raw URL id. */
const INTERNAL_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
/** A file that belongs only to a DIFFERENT item — never resolvable under
 *  INTERNAL_ID. */
const FOREIGN_FILE_ID = 'bbbbbbbb-4444-5555-6666-777777777777';

/** Default: FILE_ID resolves under INTERNAL_ID (the common, legitimate case
 *  every pre-existing test in this file exercises). Individual scoping tests
 *  override this per case. */
function mockFileScopedToItem(probedAt: Date | null = null): void {
    mockGetDbConn.mockReturnValue({});
    mockResolvePlaybackSelection.mockImplementation(
        (_sql: unknown, mediaItemId: string, options?: { fileId?: string | null }) => {
            if (mediaItemId === INTERNAL_ID && options?.fileId === FILE_ID) {
                return Promise.resolve({
                    files: [
                        {
                            id: FILE_ID,
                            file_path: '/media/movie.mkv',
                            is_default: true,
                            probed_at: probedAt,
                        },
                    ],
                    fileId: FILE_ID,
                });
            }
            return Promise.resolve({ files: [], fileId: null });
        },
    );
}

function makeUrl(subtitleIndex: number, segNum: number): URL {
    return new URL(
        `http://localhost/api/playback/${UUID_ITEM_ID}/hls/subs_${subtitleIndex}/seg_${String(segNum).padStart(5, '0')}.vtt?SubtitleIndex=${subtitleIndex}&fileId=${FILE_ID}`,
    );
}

function jobWith(
    subtitleTracks?: Array<{
        index: number;
        isTextBased: boolean;
        codec: string;
    }>,
    startTimeSeconds = 0,
): object {
    return {
        config: {
            totalDurationSeconds: 7200,
            startTimeSeconds,
            subtitleTracks: subtitleTracks?.map((t) => ({
                ...t,
                displayTitle: 'Test',
                isDefault: false,
                isForced: false,
            })),
        },
    };
}

// ============================================================================
// parseSubtitlePath
// ============================================================================

describe('parseSubtitlePath', () => {
    it('parses playlist request', () => {
        const result = parseSubtitlePath('subs_2/index.m3u8');
        expect(result).toEqual({
            subtitleTrackIndex: 2,
            fileName: 'index.m3u8',
            segmentNumber: null,
        });
    });

    it('parses segment request', () => {
        const result = parseSubtitlePath('subs_0/seg_00042.vtt');
        expect(result).toEqual({
            subtitleTrackIndex: 0,
            fileName: 'seg_00042.vtt',
            segmentNumber: 42,
        });
    });

    it('returns null for non-subtitle paths', () => {
        expect(parseSubtitlePath('stream_0/segment_00010.m4s')).toBeNull();
        expect(parseSubtitlePath('trickplay.m3u8')).toBeNull();
    });
});

// ============================================================================
// handleSubtitleSegment — bitmap fast-path
// ============================================================================

describe('handleSubtitleSegment bitmap fast-path', () => {
    beforeEach(() => {
        mockGetJob.mockReset();
        mockGetDb.mockReset();
        mockResolveSubtitle.mockReset();
        mockFileCacheGet.mockReset();
        mockFileCacheSet.mockReset();
        mockGetDbConn.mockReset();
        mockResolvePlaybackSelection.mockReset();
        mockGetDb.mockReturnValue(null);
        mockFileCacheGet.mockResolvedValue(null);
        mockFileCacheSet.mockResolvedValue(undefined);
        mockFileScopedToItem();
    });

    it('returns empty VTT immediately for bitmap (PGS) subtitle tracks', async () => {
        mockGetJob.mockReturnValue(
            jobWith([
                { index: 3, isTextBased: false, codec: 'pgssub' },
                { index: 4, isTextBased: true, codec: 'subrip' },
            ]),
        );

        const response = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            3,
            FILE_ID,
            9,
            makeUrl(3, 9),
            INTERNAL_ID,
        );

        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain('WEBVTT');
        expect(text).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d{3} --> /);
        expect(response.headers.get('Cache-Control')).toBe('max-age=86400');
        // Should NOT have called resolveSubtitle or file cache
        expect(mockResolveSubtitle).not.toHaveBeenCalled();
        expect(mockFileCacheGet).not.toHaveBeenCalled();
    });

    it('does not short-circuit text-based subtitle tracks', async () => {
        mockGetJob.mockReturnValue(jobWith([{ index: 4, isTextBased: true, codec: 'subrip' }]));

        const response = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            4,
            FILE_ID,
            0,
            makeUrl(4, 0),
            INTERNAL_ID,
        );

        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain('WEBVTT');
    });

    it('proceeds normally when job has no subtitle track info', async () => {
        mockGetJob.mockReturnValue(jobWith());

        const response = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            0,
            FILE_ID,
            0,
            makeUrl(0, 0),
            INTERNAL_ID,
        );

        expect(response.status).toBe(200);
    });
});

// ============================================================================
// handleSubtitleSegment — disk cache for UUID items
// ============================================================================

describe('handleSubtitleSegment disk cache', () => {
    beforeEach(() => {
        mockGetJob.mockReset();
        mockGetDb.mockReset();
        mockResolveSubtitle.mockReset();
        mockFileCacheGet.mockReset();
        mockFileCacheSet.mockReset();
        mockGetDbConn.mockReset();
        mockResolvePlaybackSelection.mockReset();
        mockGetDb.mockReturnValue(null);
        mockFileCacheGet.mockResolvedValue(null);
        mockFileCacheSet.mockResolvedValue(undefined);
        mockFileScopedToItem();
    });

    it('serves from disk cache on hit (UUID path)', async () => {
        mockGetJob.mockReturnValue(jobWith([{ index: 2, isTextBased: true, codec: 'subrip' }]));
        mockFileCacheGet.mockResolvedValue('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n');

        const response = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            2,
            FILE_ID,
            0,
            makeUrl(2, 0),
            INTERNAL_ID,
        );

        expect(response.status).toBe(200);
        expect(mockFileCacheGet).toHaveBeenCalledWith(FILE_ID, 2, null);
        // Should NOT call resolveSubtitle since disk cache hit
        expect(mockResolveSubtitle).not.toHaveBeenCalled();
    });

    it('rejects disk text older than the current probe', async () => {
        const probedAt = new Date('2026-10-21T10:00:00Z');
        mockFileScopedToItem(probedAt);
        mockGetDb.mockReturnValue({});
        mockFileCacheGet.mockImplementation(async (_fileId, _index, notBefore) =>
            notBefore?.getTime() === probedAt.getTime()
                ? null
                : 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nOld text\n',
        );
        mockResolveSubtitle.mockResolvedValue({
            content: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nReplacement text\n',
            contentType: 'text/vtt',
        });
        const response = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            41,
            FILE_ID,
            0,
            makeUrl(41, 0),
            INTERNAL_ID,
        );
        const text = await response.text();
        expect(text).toContain('Replacement text');
        expect(text).not.toContain('Old text');
        expect(mockFileCacheGet).toHaveBeenCalledWith(FILE_ID, 41, probedAt);
    });

    it('rotates parsed cues when the same file row is re-probed', async () => {
        mockFileScopedToItem(new Date('2026-10-21T10:00:00.001Z'));
        mockFileCacheGet.mockResolvedValue(
            'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nFirst version\n',
        );
        const first = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            42,
            FILE_ID,
            0,
            makeUrl(42, 0),
            INTERNAL_ID,
        );
        expect(await first.text()).toContain('First version');
        // Even two probes in one second describe different source versions.
        mockFileScopedToItem(new Date('2026-10-21T10:00:00.002Z'));
        mockFileCacheGet.mockResolvedValue(
            'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nSecond version\n',
        );
        const second = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            42,
            FILE_ID,
            0,
            makeUrl(42, 0),
            INTERNAL_ID,
        );
        const text = await second.text();
        expect(text).toContain('Second version');
        expect(text).not.toContain('First version');
    });

    it('writes to disk cache after resolving subtitle (UUID path)', async () => {
        const fakeDb = {};
        mockGetDb.mockReturnValue(fakeDb);
        // Use index 5 to avoid in-memory parsedCueCache hit from prior test
        mockGetJob.mockReturnValue(jobWith([{ index: 5, isTextBased: true, codec: 'subrip' }]));
        mockFileCacheGet.mockResolvedValue(null);
        mockResolveSubtitle.mockResolvedValue({
            content: 'WEBVTT\n\n00:00:05.000 --> 00:00:08.000\nWorld\n',
            contentType: 'text/vtt',
        });

        const response = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            5,
            FILE_ID,
            0,
            makeUrl(5, 0),
            INTERNAL_ID,
        );

        expect(response.status).toBe(200);
        expect(mockResolveSubtitle).toHaveBeenCalled();
        // Should write raw content to disk cache
        expect(mockFileCacheSet).toHaveBeenCalledWith(
            FILE_ID,
            5,
            'WEBVTT\n\n00:00:05.000 --> 00:00:08.000\nWorld\n',
        );
    });
});

describe('handleSubtitleSegment while extraction is running', () => {
    beforeEach(() => {
        mockGetJob.mockReset();
        mockGetDb.mockReset();
        mockResolveSubtitle.mockReset();
        mockFileCacheGet.mockReset();
        mockFileCacheSet.mockReset();
        mockGetDbConn.mockReset();
        mockResolvePlaybackSelection.mockReset();
        mockGetDb.mockReturnValue({});
        mockFileCacheGet.mockResolvedValue(null);
        mockFileCacheSet.mockResolvedValue(undefined);
        mockFileScopedToItem();
    });

    it('serves the real cues when extraction finishes within the wait', async () => {
        // Index 7: no other test warms the in-memory cue cache for it.
        mockGetJob.mockReturnValue(jobWith([{ index: 7, isTextBased: true, codec: 'subrip' }]));
        mockResolveSubtitle.mockImplementation(
            () =>
                new Promise((resolve) =>
                    setTimeout(
                        () =>
                            resolve({
                                content: 'WEBVTT\n\n00:00:05.000 --> 00:00:08.000\nQuick\n',
                                contentType: 'text/vtt',
                            }),
                        50,
                    ),
                ),
        );

        const response = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            7,
            FILE_ID,
            0,
            makeUrl(7, 0),
            INTERNAL_ID,
        );

        expect(await response.text()).toContain('Quick');
        expect(response.headers.get('Cache-Control')).toBe('max-age=86400');
    });

    it('serves an empty, uncacheable segment when extraction takes longer', async () => {
        vi.useFakeTimers();
        try {
            mockGetJob.mockReturnValue(jobWith([{ index: 8, isTextBased: true, codec: 'subrip' }]));
            mockResolveSubtitle.mockImplementation(() => new Promise(() => {}));

            const pending = handleSubtitleSegment(
                UUID_ITEM_ID,
                'play-session',
                8,
                FILE_ID,
                0,
                makeUrl(8, 0),
                INTERNAL_ID,
            );
            await vi.advanceTimersByTimeAsync(5000);
            const response = await pending;

            expect(await response.text()).not.toContain('-->');
            expect(response.headers.get('Cache-Control')).toBe('no-store');
        } finally {
            vi.useRealTimers();
        }
    });
});

// ============================================================================
// Cue timing vs the transcode's seek position
// ============================================================================

describe('handleSubtitleSegment cue timing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockFileScopedToItem();
    });

    /**
     * Serve segment `segNum` for a job that started at `startTimeSeconds`.
     *
     * `subtitleIndex` must be unique per case: the handler's parsed-cue cache is
     * module-level and keyed on itemId:index:fileId, so reusing an index would
     * answer from a previous case's cues.
     */
    async function cueTextFor(
        startTimeSeconds: number,
        segNum: number,
        subtitleIndex: number,
    ): Promise<string> {
        mockGetJob.mockReturnValue(jobWith(undefined, startTimeSeconds));
        // One cue at an absolute 1805s — 5s into the segment covering 1800-1860s.
        mockFileCacheGet.mockResolvedValue(
            'WEBVTT\n\n00:30:05.000 --> 00:30:07.000\nResumed line\n',
        );

        const response = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            subtitleIndex,
            FILE_ID,
            segNum,
            makeUrl(subtitleIndex, segNum),
            INTERNAL_ID,
        );
        return response.text();
    }

    // Regression. The handler used to subtract job.config.startTimeSeconds from
    // every cue, on the belief that seeking resets output PTS to zero. It does
    // not: the seeking path runs FFmpeg with -copyts and the muxer writes
    // ABSOLUTE source timestamps (measured on real media at a 1800s seek —
    // transcode 1800.0, copy 1798.0). Subtracting therefore put every cue early
    // by exactly the resume offset, which is invisible from a cold start and
    // grows with how far in the viewer resumed.
    it('keeps cue times absolute when the job started mid-title', async () => {
        const body = await cueTextFor(1800, 30, 21);

        expect(body).toContain('00:30:05.000');
        expect(body).not.toContain('00:00:05.000');
    });

    it('emits identical cue times whether or not the job seeked', async () => {
        const resumed = await cueTextFor(1800, 30, 22);
        const fromStart = await cueTextFor(0, 30, 23);

        expect(resumed).toBe(fromStart);
    });

    // The diagnostic knob still works, and is now measured from zero rather than
    // from the seek position.
    it('applies the sub_offset diagnostic relative to absolute time', async () => {
        mockGetJob.mockReturnValue(jobWith(undefined, 1800));
        mockFileCacheGet.mockResolvedValue(
            'WEBVTT\n\n00:30:05.000 --> 00:30:07.000\nResumed line\n',
        );

        const url = makeUrl(24, 30);
        url.searchParams.set('sub_offset', '5');

        const response = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            24,
            FILE_ID,
            30,
            url,
            INTERNAL_ID,
        );

        // 1805s - 5s = 1800s exactly.
        expect(await response.text()).toContain('00:30:00.000');
    });
});

// ============================================================================
// fileId scoped to the gated item (fix plan 6, C1 sibling of the 2026-09-13
// fix plan's Task 12, C27)
//
// A caller permitted for the gated item (INTERNAL_ID) must not be able to
// read another item's cached subtitle by passing that OTHER item's fileId —
// the job->item binding check in lumastra-segment-handler.ts does not close
// this: it verifies the PlaySessionId's job/session, never this query param,
// and a disk-cache hit needs no job at all.
// ============================================================================

describe('handleSubtitleSegment fileId scoping', () => {
    beforeEach(() => {
        mockGetJob.mockReset();
        mockGetDb.mockReset();
        mockResolveSubtitle.mockReset();
        mockFileCacheGet.mockReset();
        mockFileCacheSet.mockReset();
        mockGetDbConn.mockReset();
        mockResolvePlaybackSelection.mockReset();
        mockGetDb.mockReturnValue(null);
        mockFileCacheGet.mockResolvedValue(null);
        mockFileCacheSet.mockResolvedValue(undefined);
        mockFileScopedToItem();
        mockGetJob.mockReturnValue(jobWith([{ index: 6, isTextBased: true, codec: 'subrip' }]));
        mockFileCacheGet.mockResolvedValue('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello\n');
    });

    it('404s a fileId that belongs only to a different item (control: own fileId serves 200)', async () => {
        // Attack: caller permitted for INTERNAL_ID requests a file that only
        // resolves under some OTHER item — mockFileScopedToItem's default
        // implementation returns no match for anything but
        // (INTERNAL_ID, FILE_ID).
        const attack = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            6,
            FOREIGN_FILE_ID,
            0,
            makeUrl(6, 0),
            INTERNAL_ID,
        );

        expect(attack.status).toBe(404);
        // The disk cache must never be read for an unscoped fileId — serving
        // its bytes IS the vulnerability this test pins.
        expect(mockFileCacheGet).not.toHaveBeenCalled();
        expect(mockResolvePlaybackSelection).toHaveBeenCalledWith(expect.anything(), INTERNAL_ID, {
            fileId: FOREIGN_FILE_ID,
        });

        // Control: the SAME item + session, requesting its OWN fileId, still
        // serves normally.
        const control = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            6,
            FILE_ID,
            0,
            makeUrl(6, 0),
            INTERNAL_ID,
        );

        expect(control.status).toBe(200);
        expect(mockFileCacheGet).toHaveBeenCalledWith(FILE_ID, 6, null);
    });

    it('rejects a malformed (non-UUID) fileId with 400 before touching the DB', async () => {
        const response = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            6,
            '../../etc/passwd',
            0,
            makeUrl(6, 0),
            INTERNAL_ID,
        );

        expect(response.status).toBe(400);
        expect(mockResolvePlaybackSelection).not.toHaveBeenCalled();
        expect(mockFileCacheGet).not.toHaveBeenCalled();
    });

    it('fails closed (404) when internalId is missing, even for the request’s own fileId', async () => {
        // Mirrors resolveFileScopedToItem's fail-closed contract for the
        // trickplay/I-frame handlers (research §7): omitting internalId must
        // not skip the check.
        const response = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            6,
            FILE_ID,
            0,
            makeUrl(6, 0),
            // internalId intentionally omitted
        );

        expect(response.status).toBe(404);
        expect(mockFileCacheGet).not.toHaveBeenCalled();
    });

    it('fails closed with a valid empty-WebVTT body (not a bare 500) when the scoping DB call throws', async () => {
        mockResolvePlaybackSelection.mockRejectedValue(new Error('connection reset'));

        const response = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            6,
            FILE_ID,
            0,
            makeUrl(6, 0),
            INTERNAL_ID,
        );

        expect(response.status).toBe(404);
        expect(response.headers.get('Content-Type')).toContain('text/vtt');
        const text = await response.text();
        expect(text).toContain('WEBVTT');
        expect(mockFileCacheGet).not.toHaveBeenCalled();
    });
});

// ============================================================================
// Folded tail (hls-segment-grid.ts): the subtitle playlist ends on the same
// grid as the video playlists, and its last segment carries the folded cues.
// ============================================================================

describe('subtitle playlist and segments on a folded tail', () => {
    const TAIL_TOTAL = 7200.3; // 120 × 60 s plus a 0.3 s sliver

    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockFileScopedToItem();
        mockGetJob.mockReturnValue({
            config: { totalDurationSeconds: TAIL_TOTAL, startTimeSeconds: 0 },
        });
    });

    it('carries the grant in every WebVTT segment URI', async () => {
        const url = makeUrl(31, 0);
        url.searchParams.set('grant', 'stream_subtitles');
        const response = await handleSubtitlePlaylist(UUID_ITEM_ID, 'play-session', 31, url);
        expect(response.status).toBe(200);
        const uris = (await response.text())
            .split('\n')
            .filter((line) => line && !line.startsWith('#'));
        expect(uris.length).toBeGreaterThan(0);
        for (const uri of uris) {
            expect(new URL(uri, url).searchParams.get('grant')).toBe('stream_subtitles');
        }
    });

    it('lists no sliver entry; the last entry is 60.3 s', async () => {
        const response = await handleSubtitlePlaylist(
            UUID_ITEM_ID,
            'play-session',
            31,
            makeUrl(31, 0),
        );
        const body = await response.text();
        const extinfs = [...body.matchAll(/#EXTINF:([\d.]+)/g)].map((m) => Number(m[1]));
        expect(extinfs).toHaveLength(120);
        expect(extinfs.at(-1)).toBeCloseTo(60.3, 6);
        expect(body).not.toContain('seg_00120');
    });

    it('the last segment carries a cue that starts in the folded tail', async () => {
        mockFileCacheGet.mockResolvedValue('WEBVTT\n\n02:00:00.100 --> 02:00:00.250\nLast words\n');
        const response = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            32,
            FILE_ID,
            119,
            makeUrl(32, 119),
            INTERNAL_ID,
        );
        expect(await response.text()).toContain('Last words');
    });

    it('the unlisted index past the folded end repeats no cues', async () => {
        mockFileCacheGet.mockResolvedValue('WEBVTT\n\n02:00:00.100 --> 02:00:00.250\nLast words\n');
        const response = await handleSubtitleSegment(
            UUID_ITEM_ID,
            'play-session',
            33,
            FILE_ID,
            120,
            makeUrl(33, 120),
            INTERNAL_ID,
        );
        expect(await response.text()).not.toContain('Last words');
    });
});
