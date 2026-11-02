// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { probeForTranscode } from './media-probe.service.js';
import { asAbsoluteStreamIndex, asAudioRelativeIndex } from '$lib/shared/stream-index';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('$lib/server/database/queries/media-streams.queries.js', () => ({
    getStreamsForMediaItem: vi.fn(),
    getStreamsForFile: vi.fn(),
    replaceStreamsForFile: vi.fn(),
}));

vi.mock('$lib/server/database/queries/media-lookup.queries.js', () => ({
    getMediaItemRuntime: vi.fn(),
    getMediaFileDuration: vi.fn(),
    getMediaFileTotalBitrate: vi.fn(),
}));

vi.mock('$lib/server/utils/ffprobe.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/ffprobe.js')>();
    return {
        ...actual,
        probeMediaFile: vi.fn(),
        probeStreamCounts: vi.fn(),
    };
});

vi.mock('$lib/server/utils/media-stream-mapper.js', () => ({
    dbRowToAudioTrackInfo: vi.fn((row) => ({
        index: row.stream_index,
        displayTitle: row.display_title || `Audio ${row.stream_index}`,
        language: row.language ?? undefined,
        channels: row.channels ?? 2,
        codec: row.codec,
        bitrate: row.bitrate ?? undefined,
        isDefault: row.is_default,
    })),
    mapFFprobeToDbRows: vi.fn(() => []),
}));

vi.mock('$lib/server/database/with-tx.js', () => ({
    withTx: vi.fn(async (_sql, fn) => fn({} as never)),
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

import {
    getStreamsForMediaItem,
    getStreamsForFile,
    replaceStreamsForFile,
} from '$lib/server/database/queries/media-streams.queries.js';
import type { MediaStreamRow } from '$lib/server/database/queries/media-streams.queries.js';
import {
    getMediaItemRuntime,
    getMediaFileDuration,
} from '$lib/server/database/queries/media-lookup.queries.js';
import { probeMediaFile, probeStreamCounts } from '$lib/server/utils/ffprobe.js';
import type { MediaProbeResult } from '$lib/server/utils/ffprobe.js';
import { mapFFprobeToDbRows } from '$lib/server/utils/media-stream-mapper.js';

// ============================================================================
// Fixtures
// ============================================================================

const mockSql = {} as Parameters<typeof probeForTranscode>[0];
const INTERNAL_ID = 'test-uuid-1234';
const CONTAINER_PATH = '/media/movie.mkv';

function makeVideoRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'stream-1',
        file_id: INTERNAL_ID,
        stream_type: 'video',
        stream_index: 0,
        codec: 'hevc',
        codec_tag: null,
        profile: null,
        level: null,
        language: null,
        display_title: null,
        title: null,
        channels: null,
        channel_layout: null,
        sample_rate: null,
        width: 3840,
        height: 2160,
        bit_depth: null,
        video_range: 'HDR10',
        video_range_type: null,
        color_space: null,
        aspect_ratio: null,
        average_frame_rate: null,
        is_anamorphic: null,
        is_external: null,
        is_text_subtitle: null,
        bitrate: 15000000,
        is_default: true,
        is_forced: false,
        created_at: new Date(),
        ...overrides,
    };
}

function makeAudioRow(overrides: Record<string, unknown> = {}) {
    return {
        id: 'stream-2',
        file_id: INTERNAL_ID,
        stream_type: 'audio',
        stream_index: 1,
        codec: 'eac3',
        codec_tag: null,
        profile: null,
        level: null,
        language: 'eng',
        display_title: 'English',
        title: 'English',
        channels: 6,
        channel_layout: '5.1',
        sample_rate: 48000,
        width: null,
        height: null,
        bit_depth: null,
        video_range: null,
        video_range_type: null,
        color_space: null,
        aspect_ratio: null,
        average_frame_rate: null,
        is_anamorphic: null,
        is_external: null,
        is_text_subtitle: null,
        bitrate: 640000,
        is_default: true,
        is_forced: false,
        created_at: new Date(),
        ...overrides,
    };
}

// ============================================================================
// Tests: DB path
// ============================================================================

describe('probeForTranscode — DB path', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getMediaItemRuntime).mockResolvedValue(7200);
        vi.mocked(getMediaFileDuration).mockResolvedValue(null);
        vi.mocked(getStreamsForMediaItem).mockResolvedValue([
            makeVideoRow(),
            makeAudioRow(),
        ] as unknown as MediaStreamRow[]);
    });

    it('returns source=db when DB streams are present', async () => {
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.source).toBe('db');
    });

    it('maps video stream properties correctly', async () => {
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.videoCodec).toBe('hevc');
        expect(result.videoWidth).toBe(3840);
        expect(result.videoHeight).toBe(2160);
        expect(result.videoBitrate).toBe(15000000);
        expect(result.videoRange).toBe('HDR10');
    });

    it('maps audio tracks correctly', async () => {
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.audioTracks).toHaveLength(1);
        expect(result.audioTracks[0].codec).toBe('eac3');
        expect(result.audioTracks[0].isDefault).toBe(true);
    });

    it('includes both video and audio in streams array', async () => {
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.streams).toHaveLength(2);
        expect(result.streams[0].type).toBe('Video');
        expect(result.streams[1].type).toBe('Audio');
    });

    it('uses DB runtime for duration', async () => {
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.durationSeconds).toBe(7200);
    });

    it('respects durationOverride — skips getMediaItemRuntime', async () => {
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH, 5400);
        expect(result.durationSeconds).toBe(5400);
        expect(getMediaItemRuntime).not.toHaveBeenCalled();
    });

    it('does not call probeMediaFile when DB streams exist', async () => {
        await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(probeMediaFile).not.toHaveBeenCalled();
    });

    it('derives bitDepth from pixel_format when bit_depth is NULL (Hi10P)', async () => {
        // Regression: prod scanner never populated bit_depth, so a genuine
        // Hi10P (H.264 High 10) decode-gap lesson was keyed as bare "h264",
        // poisoning hardware decode for ALL H.264 sources for 30 days.
        vi.mocked(getStreamsForMediaItem).mockResolvedValue([
            makeVideoRow({ codec: 'h264', bit_depth: null, pixel_format: 'yuv420p10le' }),
            makeAudioRow(),
        ] as unknown as MediaStreamRow[]);
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.bitDepth).toBe(10);
        expect(result.streams.find((s) => s.type === 'Video')?.bitDepth).toBe(10);
    });

    it('prefers stored bit_depth over pixel_format derivation', async () => {
        vi.mocked(getStreamsForMediaItem).mockResolvedValue([
            makeVideoRow({ bit_depth: 12, pixel_format: 'yuv420p10le' }),
            makeAudioRow(),
        ] as unknown as MediaStreamRow[]);
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.bitDepth).toBe(12);
    });

    it('leaves bitDepth undefined when neither bit_depth nor pixel_format is stored', async () => {
        vi.mocked(getStreamsForMediaItem).mockResolvedValue([
            makeVideoRow({ bit_depth: null, pixel_format: null }),
            makeAudioRow(),
        ] as unknown as MediaStreamRow[]);
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.bitDepth).toBeUndefined();
    });

    it('uses defaults when video row is absent', async () => {
        vi.mocked(getStreamsForMediaItem).mockResolvedValue([
            makeAudioRow(),
        ] as unknown as MediaStreamRow[]);
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.videoCodec).toBe('h264');
        expect(result.videoWidth).toBe(1920);
        expect(result.videoHeight).toBe(1080);
        expect(result.videoBitrate).toBeUndefined();
        expect(result.videoRange).toBeUndefined();
    });
});

// ============================================================================
// Tests: Consistency check (DB vs file stream counts)
// ============================================================================

describe('probeForTranscode — consistency check', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getMediaItemRuntime).mockResolvedValue(7200);
        vi.mocked(getMediaFileDuration).mockResolvedValue(null);
        vi.mocked(getStreamsForMediaItem).mockResolvedValue([
            makeVideoRow(),
            makeAudioRow(),
        ] as unknown as MediaStreamRow[]);
    });

    it('uses DB data when probeStreamCounts matches DB counts', async () => {
        vi.mocked(probeStreamCounts).mockResolvedValue({
            video: 1,
            audio: 1,
            subtitle: 0,
        });
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.source).toBe('db');
        expect(probeMediaFile).not.toHaveBeenCalled();
    });

    it('uses DB data when probeStreamCounts returns null (transient error)', async () => {
        vi.mocked(probeStreamCounts).mockResolvedValue(null);
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.source).toBe('db');
        expect(probeMediaFile).not.toHaveBeenCalled();
    });

    it('falls back to ffprobe when audio count differs from file', async () => {
        // DB says 1 audio, file actually has 2 → mismatch detected
        vi.mocked(probeStreamCounts).mockResolvedValue({
            video: 1,
            audio: 2,
            subtitle: 0,
        });
        vi.mocked(probeMediaFile).mockResolvedValue({
            success: true,
            video: {
                index: 0,
                codec: 'h264',
                width: 1920,
                height: 1080,
                hdr: 'sdr',
                fps: 24,
                profile: 'main',
                level: 40,
            },
            audioStreams: [
                {
                    index: 0,
                    absoluteIndex: 1,
                    codec: 'ac3',
                    channels: 6,
                    isDefault: true,
                },
                {
                    index: 1,
                    absoluteIndex: 2,
                    codec: 'ac3',
                    channels: 6,
                    isDefault: false,
                },
            ],
            subtitleStreams: [],
            container: 'matroska',
            duration: 7200,
            formatBitrate: undefined,
            fileSize: undefined,
        } as unknown as MediaProbeResult);

        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.source).toBe('ffprobe');
        expect(probeMediaFile).toHaveBeenCalledWith(CONTAINER_PATH);
        expect(result.audioTracks).toHaveLength(2);
    });

    it('heals media_streams when inconsistency detected (with fileId)', async () => {
        const FILE_ID = 'file-uuid-9001';
        // probeForTranscode uses file-scoped lookup when fileId is provided
        vi.mocked(getStreamsForFile).mockResolvedValue([
            makeVideoRow(),
            makeAudioRow(),
        ] as unknown as MediaStreamRow[]);
        vi.mocked(probeStreamCounts).mockResolvedValue({
            video: 1,
            audio: 2,
            subtitle: 0,
        });
        vi.mocked(probeMediaFile).mockResolvedValue({
            success: true,
            video: {
                index: 0,
                codec: 'h264',
                width: 1920,
                height: 1080,
                hdr: 'sdr',
            },
            audioStreams: [
                {
                    index: 0,
                    absoluteIndex: 1,
                    codec: 'ac3',
                    channels: 6,
                    isDefault: true,
                },
                {
                    index: 1,
                    absoluteIndex: 2,
                    codec: 'ac3',
                    channels: 6,
                    isDefault: false,
                },
            ],
            subtitleStreams: [],
            container: 'matroska',
            duration: 7200,
        } as unknown as MediaProbeResult);
        // mapFFprobeToDbRows is mocked to return [] by default; override
        // so heal has actual rows to write
        vi.mocked(mapFFprobeToDbRows).mockReturnValue([
            { file_id: FILE_ID, stream_type: 'audio', stream_index: 1 } as never,
        ]);

        await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH, undefined, {
            fileId: FILE_ID,
        });

        // Heal is fire-and-forget; give the microtask queue a tick so the
        // void-awaited promise has a chance to run replaceStreamsForFile.
        await new Promise((resolve) => setImmediate(resolve));
        expect(replaceStreamsForFile).toHaveBeenCalled();
    });

    it("prefers the file's own duration over the item runtime when fileId is provided", async () => {
        // Regression: a multi-file combined episode (each file one physical
        // segment shorter than the item's combined runtime) had its transcode
        // job built around the ITEM's runtime_seconds regardless of which file
        // was actually playing — FFmpeg then hit real EOF far short of the
        // advertised segment count/duration and the early-exit path
        // misreported the (short but genuinely complete) job as a failed
        // start. getMediaItemRuntime here stays 7200 (the beforeEach default);
        // the file's own probed duration must win.
        vi.mocked(getMediaFileDuration).mockResolvedValue(401);
        vi.mocked(probeStreamCounts).mockResolvedValue({ video: 1, audio: 1, subtitle: 0 });
        vi.mocked(getStreamsForFile).mockResolvedValue([
            makeVideoRow(),
            makeAudioRow(),
        ] as unknown as MediaStreamRow[]);

        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH, undefined, {
            fileId: 'file-uuid-9001',
        });

        expect(result.durationSeconds).toBe(401);
        expect(getMediaFileDuration).toHaveBeenCalledWith(mockSql, 'file-uuid-9001');
    });

    it('falls back to item runtime when the file has no probed duration yet', async () => {
        vi.mocked(getMediaFileDuration).mockResolvedValue(null);
        vi.mocked(probeStreamCounts).mockResolvedValue({ video: 1, audio: 1, subtitle: 0 });
        vi.mocked(getStreamsForFile).mockResolvedValue([
            makeVideoRow(),
            makeAudioRow(),
        ] as unknown as MediaStreamRow[]);

        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH, undefined, {
            fileId: 'file-uuid-9001',
        });

        expect(result.durationSeconds).toBe(7200);
    });

    it('does not heal when no fileId is provided (cannot identify file)', async () => {
        vi.mocked(probeStreamCounts).mockResolvedValue({
            video: 1,
            audio: 2,
            subtitle: 0,
        });
        vi.mocked(probeMediaFile).mockResolvedValue({
            success: true,
            video: {
                index: 0,
                codec: 'h264',
                width: 1920,
                height: 1080,
                hdr: 'sdr',
            },
            audioStreams: [
                {
                    index: 0,
                    absoluteIndex: 1,
                    codec: 'ac3',
                    channels: 6,
                    isDefault: true,
                },
                {
                    index: 1,
                    absoluteIndex: 2,
                    codec: 'ac3',
                    channels: 6,
                    isDefault: false,
                },
            ],
            subtitleStreams: [],
            container: 'matroska',
            duration: 7200,
        } as unknown as MediaProbeResult);

        await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        await new Promise((resolve) => setImmediate(resolve));
        expect(replaceStreamsForFile).not.toHaveBeenCalled();
    });

    it('falls back to ffprobe when video count differs from file', async () => {
        vi.mocked(probeStreamCounts).mockResolvedValue({
            video: 2,
            audio: 1,
            subtitle: 0,
        });
        vi.mocked(probeMediaFile).mockResolvedValue({
            success: true,
            video: {
                index: 0,
                codec: 'h264',
                width: 1920,
                height: 1080,
                hdr: 'sdr',
            },
            audioStreams: [
                {
                    index: 0,
                    absoluteIndex: 1,
                    codec: 'ac3',
                    channels: 2,
                    isDefault: true,
                },
            ],
            subtitleStreams: [],
            container: 'matroska',
            duration: 7200,
        } as unknown as MediaProbeResult);

        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.source).toBe('ffprobe');
    });

    it('skips consistency check when forceFileProbe is true', async () => {
        vi.mocked(probeStreamCounts).mockResolvedValue({
            video: 1,
            audio: 1,
            subtitle: 0,
        });
        vi.mocked(probeMediaFile).mockResolvedValue({
            success: true,
            video: {
                index: 0,
                codec: 'h264',
                width: 1920,
                height: 1080,
                hdr: 'sdr',
            },
            audioStreams: [
                {
                    index: 0,
                    absoluteIndex: 1,
                    codec: 'ac3',
                    channels: 2,
                    isDefault: true,
                },
            ],
            subtitleStreams: [],
            container: 'matroska',
            duration: 7200,
        } as unknown as MediaProbeResult);

        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH, undefined, {
            forceFileProbe: true,
        });
        expect(result.source).toBe('ffprobe');
        expect(probeStreamCounts).not.toHaveBeenCalled();
    });
});

// ============================================================================
// Tests: FFprobe fallback path
// ============================================================================

describe('probeForTranscode — FFprobe fallback', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getMediaItemRuntime).mockResolvedValue(null);
        vi.mocked(getMediaFileDuration).mockResolvedValue(null);
        vi.mocked(getStreamsForMediaItem).mockResolvedValue([]);
        vi.mocked(probeMediaFile).mockResolvedValue({
            success: true,
            audioStreams: [
                {
                    audioRelativeIndex: asAudioRelativeIndex(0),
                    absoluteIndex: asAbsoluteStreamIndex(1),
                    codec: 'aac',
                    channels: 2,
                    isDefault: true,
                    isVisualImpaired: false,
                    language: 'eng',
                    title: 'English',
                    bitRate: 128000,
                },
            ],
            video: {
                index: 0,
                codec: 'h264',
                width: 1920,
                height: 1080,
                bitrate: 5000000,
                hdr: 'sdr',
                profile: 'High',
                fps: 23.976,
                pixelFormat: null,
                colorSpace: null,
                level: null,
                masterDisplay: null,
                maxCll: null,
                colorPrimaries: null,
                colorTransfer: null,
                refFrames: null,
                closedCaptions: false,
            },
            subtitleStreams: [],
            duration: 3600,
            container: 'matroska',
            fileSize: null,
            formatBitrate: null,
        } as MediaProbeResult);
    });

    it('returns source=ffprobe when no DB streams', async () => {
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.source).toBe('ffprobe');
    });

    it('maps video from probe correctly', async () => {
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.videoCodec).toBe('h264');
        expect(result.videoWidth).toBe(1920);
        expect(result.videoHeight).toBe(1080);
        expect(result.videoBitrate).toBe(5000000);
    });

    it('maps audio tracks from probe correctly', async () => {
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.audioTracks).toHaveLength(1);
        expect(result.audioTracks[0].index).toBe(1);
        expect(result.audioTracks[0].codec).toBe('aac');
        expect(result.audioTracks[0].displayTitle).toBe('English');
    });

    it('uses probe duration when DB runtime is null', async () => {
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.durationSeconds).toBe(3600);
    });

    it('durationOverride takes precedence over probe duration', async () => {
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH, 1800);
        expect(result.durationSeconds).toBe(1800);
    });

    it('throws when probe fails', async () => {
        vi.mocked(probeMediaFile).mockResolvedValue({
            success: false,
            audioStreams: [],
            subtitleStreams: [],
            video: null,
            duration: null,
            container: null,
            fileSize: null,
            formatBitrate: null,
            error: 'ffprobe not found',
        } as MediaProbeResult);
        await expect(probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH)).rejects.toThrow(
            'Failed to probe media file: ffprobe not found',
        );
    });

    it('videoRange is undefined from ffprobe path', async () => {
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.videoRange).toBeUndefined();
    });

    it('uses defaults when probe has no video stream', async () => {
        vi.mocked(probeMediaFile).mockResolvedValue({
            success: true,
            audioStreams: [],
            subtitleStreams: [],
            video: null,
            duration: 1200,
            container: 'mp4',
            fileSize: null,
            formatBitrate: null,
        } as MediaProbeResult);
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.videoCodec).toBe('h264');
        expect(result.videoWidth).toBe(1920);
        expect(result.videoHeight).toBe(1080);
    });
});

// ============================================================================
// Tests: interlace detection (field_order → isInterlaced)
// ============================================================================

// media_streams stores no field order, so a DVD rip / TV recording in a native
// library reached the transcoder as progressive and was never deinterlaced.
describe('probeForTranscode — interlace detection', () => {
    const videoStream = (r: Awaited<ReturnType<typeof probeForTranscode>>) =>
        r.streams.find((s) => s.type === 'Video');

    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(getMediaItemRuntime).mockResolvedValue(7200);
        vi.mocked(getMediaFileDuration).mockResolvedValue(null);
    });

    describe('DB path (field order from the stream-count probe)', () => {
        beforeEach(() => {
            vi.mocked(getStreamsForMediaItem).mockResolvedValue([
                makeVideoRow({ codec: 'mpeg2video', width: 720, height: 576, video_range: 'SDR' }),
                makeAudioRow(),
            ] as unknown as MediaStreamRow[]);
        });

        it.each(['tt', 'bb', 'tb', 'bt', 'TB'])('field_order %s → interlaced', async (fo) => {
            vi.mocked(probeStreamCounts).mockResolvedValue({
                video: 1,
                audio: 1,
                subtitle: 0,
                videoFieldOrder: fo,
            });
            const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
            expect(result.source).toBe('db');
            expect(videoStream(result)?.isInterlaced).toBe(true);
        });

        it.each(['progressive', 'unknown', null, undefined])(
            'field_order %s → not interlaced',
            async (fo) => {
                vi.mocked(probeStreamCounts).mockResolvedValue({
                    video: 1,
                    audio: 1,
                    subtitle: 0,
                    videoFieldOrder: fo,
                });
                const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
                expect(result.source).toBe('db');
                expect(videoStream(result)?.isInterlaced).toBe(false);
            },
        );

        it('a failed count probe never claims interlaced', async () => {
            vi.mocked(probeStreamCounts).mockResolvedValue(null);
            const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
            expect(videoStream(result)?.isInterlaced).toBe(false);
        });
    });

    it.each([
        ['tb', true],
        ['progressive', false],
        [null, false],
    ] as const)('FFprobe fallback: field_order %s → isInterlaced %s', async (fo, expected) => {
        vi.mocked(getStreamsForMediaItem).mockResolvedValue([]);
        vi.mocked(probeMediaFile).mockResolvedValue({
            success: true,
            audioStreams: [],
            subtitleStreams: [],
            video: {
                index: 0,
                codec: 'mpeg2video',
                width: 720,
                height: 576,
                bitrate: null,
                hdr: 'sdr',
                profile: 'Main',
                fps: 25,
                pixelFormat: 'yuv420p',
                colorSpace: null,
                level: null,
                masterDisplay: null,
                maxCll: null,
                colorPrimaries: null,
                colorTransfer: null,
                refFrames: null,
                closedCaptions: false,
                fieldOrder: fo,
            },
            duration: 60,
            container: 'mpeg',
            fileSize: null,
            formatBitrate: null,
        } as MediaProbeResult);
        const result = await probeForTranscode(mockSql, INTERNAL_ID, CONTAINER_PATH);
        expect(result.source).toBe('ffprobe');
        expect(videoStream(result)?.isInterlaced).toBe(expected);
    });
});
