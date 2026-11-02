// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    resolveSubtitle,
    clearSubtitleCache,
    findSubtitleFormatMismatch,
    describeSubtitleFormatMismatch,
} from './subtitle-resolver.service.js';
import type { Stats } from 'node:fs';
import type { MediaStreamRow } from '$lib/server/database/queries/media-streams.queries.js';
import type { ExternalSubtitleRow } from '$lib/server/database/queries/external-subtitles.queries.js';
import type { MediaFileRow } from '$lib/server/database/queries/media-files.queries.js';

vi.mock('$lib/server/database/queries/media-streams.queries', () => ({
    getStreamsForMediaItem: vi.fn(),
    getStreamsForFile: vi.fn(),
}));
vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getFilesForMediaItem: vi.fn(),
}));
vi.mock('$lib/server/database/queries/external-subtitles.queries', () => ({
    getExternalSubtitlesForMediaItem: vi.fn(),
    getExternalSubtitlesForFile: vi.fn(),
}));
vi.mock('$lib/server/database/queries/media-file-resolution.queries.js', () => ({
    resolvePlaybackSelection: vi.fn(),
}));
vi.mock('$lib/server/utils/ffmpeg-subtitle-extractor', () => ({
    extractSubtitleStream: vi.fn(),
    extractSubtitleStreamBinary: vi.fn(),
    extractSubtitleStreamsBinary: vi.fn(),
    FFmpegTimeoutError: class FFmpegTimeoutError extends Error {},
}));
vi.mock('./cache/subtitle-file-cache.service', () => ({
    SubtitleFileCacheService: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue(undefined),
        getBinary: vi.fn().mockResolvedValue(null),
        setBinary: vi.fn().mockResolvedValue(undefined),
        hasFreshBinary: vi.fn().mockResolvedValue(false),
    },
}));
// Containment has its own tests (contained-fs.test.ts); here the paths are fake,
// so pass them through and read via the mocked fs readFile.
vi.mock('$lib/server/utils/contained-fs', async () => {
    const fsp = await import('node:fs/promises');
    return {
        resolveContainedFile: vi.fn(async (p: string) => p),
        readContainedFile: vi.fn(async (p: string) => fsp.readFile(p)),
    };
});

vi.mock('node:fs/promises', () => ({
    readFile: vi.fn(),
    stat: vi.fn(),
}));
vi.mock('node:fs', () => ({
    existsSync: vi.fn(),
}));
vi.mock('$lib/server/utils/safe-fs', () => ({
    safeExists: vi.fn().mockResolvedValue(true),
}));
vi.mock('$lib/server/utils/media-path-resolver', () => ({
    isPathWithinLibraryRoots: vi.fn().mockResolvedValue(true),
    isPathWithinMediaStore: vi.fn().mockResolvedValue(true),
}));

import {
    getStreamsForMediaItem,
    getStreamsForFile,
} from '$lib/server/database/queries/media-streams.queries.js';
import { getFilesForMediaItem } from '$lib/server/database/queries/media-files.queries.js';
import {
    getExternalSubtitlesForMediaItem,
    getExternalSubtitlesForFile,
} from '$lib/server/database/queries/external-subtitles.queries.js';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries.js';
import {
    extractSubtitleStream,
    extractSubtitleStreamBinary,
    extractSubtitleStreamsBinary,
    FFmpegTimeoutError,
} from '$lib/server/utils/ffmpeg-subtitle-extractor.js';
import { SubtitleFileCacheService } from './cache/subtitle-file-cache.service.js';
import { readFile, stat } from 'node:fs/promises';
import { safeExists } from '$lib/server/utils/safe-fs.js';

const mockGetStreams = vi.mocked(getStreamsForMediaItem);
const mockGetStreamsForFile = vi.mocked(getStreamsForFile);
const mockGetFiles = vi.mocked(getFilesForMediaItem);
const mockGetExternalSubs = vi.mocked(getExternalSubtitlesForMediaItem);
const mockGetExternalSubsForFile = vi.mocked(getExternalSubtitlesForFile);
const mockResolvePlaybackSelection = vi.mocked(resolvePlaybackSelection);
const mockExtractSubtitleStream = vi.mocked(extractSubtitleStream);
const mockExtractSubtitleStreamBinary = vi.mocked(extractSubtitleStreamBinary);
const mockExtractSubtitleStreamsBinary = vi.mocked(extractSubtitleStreamsBinary);
const mockHasFreshBinary = vi.mocked(SubtitleFileCacheService.hasFreshBinary);
const mockSetBinary = vi.mocked(SubtitleFileCacheService.setBinary);
const mockGetBinary = vi.mocked(SubtitleFileCacheService.getBinary);
const mockReadFile = vi.mocked(readFile);
const mockStat = vi.mocked(stat);
const mockSafeExists = vi.mocked(safeExists);

// Minimal stub for postgres.Sql — queries are fully mocked
import type { Sql } from 'postgres';
const sql = {} as Sql;

const MEDIA_ITEM_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const FIXED_DATE = new Date('2025-01-15T12:00:00Z');

function makeStreamRow(overrides: Partial<MediaStreamRow> = {}): MediaStreamRow {
    return {
        id: 'stream-1',
        file_id: 'file-1',
        stream_type: 'subtitle',
        stream_index: 2,
        codec: 'subrip',
        codec_tag: null,
        profile: null,
        level: null,
        language: 'en',
        display_title: 'English',
        title: null,
        channels: null,
        channel_layout: null,
        sample_rate: null,
        width: null,
        height: null,
        bit_depth: null,
        video_range: null,
        video_range_type: null,
        color_space: null,
        aspect_ratio: null,
        average_frame_rate: null,
        is_anamorphic: null,
        is_external: false,
        is_text_subtitle: true,
        bitrate: null,
        is_default: false,
        is_forced: false,
        is_hearing_impaired: false,
        is_visual_impaired: false,
        has_closed_captions: false,
        dv_profile: null,
        dv_level: null,
        dv_bl_signal_compatibility_id: null,
        master_display: null,
        max_cll: null,
        pixel_format: null,
        ref_frames: null,
        color_primaries: null,
        color_transfer: null,
        created_at: new Date(),
        ...overrides,
    };
}

function makeExternalSubRow(overrides: Partial<ExternalSubtitleRow> = {}): ExternalSubtitleRow {
    return {
        id: 'sub-1',
        file_id: 'file-1',
        subtitle_path: '/media/movies/Film/Film.en.srt',
        language: 'en',
        format: 'srt',
        is_forced: false,
        is_sdh: false,
        created_at: new Date(),
        updated_at: new Date(),
        ...overrides,
    };
}

function makeFileRow(overrides: Partial<MediaFileRow> = {}): MediaFileRow {
    return {
        id: 'file-1',
        file_path: '/media/movies/Film/Film.mkv',
        edition: null,
        part_number: null,
        library_group_id: null,
        container_format: 'matroska',
        duration_seconds: 7200,
        total_bitrate: 10_000_000,
        file_size_bytes: 9_000_000_000,
        file_mtime: FIXED_DATE,
        file_hash_head: null,
        probed_at: FIXED_DATE,
        keyframes: null,
        health_issues: null,
        created_at: FIXED_DATE,
        updated_at: FIXED_DATE,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    clearSubtitleCache();
    mockGetStreamsForFile.mockResolvedValue([]);
    mockGetExternalSubsForFile.mockResolvedValue([]);
    mockHasFreshBinary.mockResolvedValue(false);
});

describe('resolveSubtitle', () => {
    it('returns null when the requested stream index is not found', async () => {
        mockGetStreams.mockResolvedValue([makeStreamRow({ stream_index: 2 })]);

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 99);

        expect(result).toBeNull();
    });

    it('resolves an external SRT subtitle by reading the file via FFmpeg conversion', async () => {
        mockGetStreams.mockResolvedValue([
            makeStreamRow({
                stream_index: 2,
                is_external: true,
                is_text_subtitle: null,
            }),
        ]);
        mockGetExternalSubs.mockResolvedValue([
            makeExternalSubRow({
                subtitle_path: '/media/movies/Film/Film.en.srt',
                format: 'srt',
            }),
        ]);
        mockGetFiles.mockResolvedValue([makeFileRow()]);
        mockSafeExists.mockResolvedValue(true);
        mockStat.mockResolvedValue({ size: 50_000 } as Stats);
        mockExtractSubtitleStream.mockResolvedValue(
            'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello world',
        );

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 2);

        expect(result).not.toBeNull();
        expect(result?.contentType).toBe('text/vtt; charset=utf-8');
        expect(mockExtractSubtitleStream).toHaveBeenCalledWith(
            expect.objectContaining({
                streamIndex: 0,
                codec: 'srt',
                outputFormat: 'webvtt',
            }),
        );
    });

    it('resolves an external VTT subtitle by returning the file as-is without FFmpeg', async () => {
        mockGetStreams.mockResolvedValue([
            makeStreamRow({
                stream_index: 2,
                is_external: true,
                is_text_subtitle: null,
            }),
        ]);
        mockGetExternalSubs.mockResolvedValue([
            makeExternalSubRow({
                subtitle_path: '/media/movies/Film/Film.en.vtt',
                format: 'vtt',
            }),
        ]);
        mockSafeExists.mockResolvedValue(true);
        mockStat.mockResolvedValue({ size: 30_000 } as Stats);
        const vttBuffer = Buffer.from('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello');
        mockReadFile.mockResolvedValue(vttBuffer);

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 2);

        expect(result).not.toBeNull();
        expect(result?.content).toBe(vttBuffer);
        expect(result?.contentType).toBe('text/vtt; charset=utf-8');
        expect(mockExtractSubtitleStream).not.toHaveBeenCalled();
    });

    it('resolves an embedded SRT subtitle by calling extractSubtitleStream', async () => {
        mockGetStreams.mockResolvedValue([
            makeStreamRow({
                stream_index: 2,
                is_external: false,
                is_text_subtitle: true,
                codec: 'subrip',
            }),
        ]);
        mockGetFiles.mockResolvedValue([makeFileRow()]);
        mockExtractSubtitleStream.mockResolvedValue(
            'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello',
        );

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 2);

        expect(result).not.toBeNull();
        expect(result?.contentType).toBe('text/vtt; charset=utf-8');
        expect(mockExtractSubtitleStream).toHaveBeenCalledWith({
            filePath: '/media/movies/Film/Film.mkv',
            streamIndex: 2,
            codec: 'subrip',
            outputFormat: 'webvtt',
        });
    });

    it('uses the selected version file and requested text format when fileId is provided', async () => {
        mockResolvePlaybackSelection.mockResolvedValue({
            files: [
                makeFileRow({
                    id: 'file-2',
                    file_path: '/media/movies/Film/Film.directors-cut.mkv',
                }),
            ],
            fileId: 'file-2',
        });
        mockGetStreamsForFile.mockResolvedValue([
            makeStreamRow({
                file_id: 'file-2',
                stream_index: 2,
                codec: 'ass',
                is_text_subtitle: true,
            }),
        ]);
        mockExtractSubtitleStream.mockResolvedValue('[Script Info]');

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 2, {
            fileId: 'file-2',
            format: 'ass',
        });

        expect(result?.contentType).toBe('text/x-ssa; charset=utf-8');
        expect(mockExtractSubtitleStream).toHaveBeenCalledWith({
            filePath: '/media/movies/Film/Film.directors-cut.mkv',
            streamIndex: 2,
            codec: 'ass',
            outputFormat: 'ass',
        });
    });

    it('resolves an embedded ASS subtitle by calling extractSubtitleStream', async () => {
        mockGetStreams.mockResolvedValue([
            makeStreamRow({
                stream_index: 3,
                is_external: false,
                is_text_subtitle: true,
                codec: 'ass',
            }),
        ]);
        mockGetFiles.mockResolvedValue([makeFileRow()]);
        mockExtractSubtitleStream.mockResolvedValue(
            'WEBVTT\n\n00:00:05.000 --> 00:00:07.000\n{\\an8}Styled text',
        );

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 3);

        expect(result).not.toBeNull();
        expect(result?.contentType).toBe('text/vtt; charset=utf-8');
        expect(mockExtractSubtitleStream).toHaveBeenCalledWith({
            filePath: '/media/movies/Film/Film.mkv',
            streamIndex: 3,
            codec: 'ass',
            outputFormat: 'webvtt',
        });
    });

    it('returns null when no media files are linked to the item', async () => {
        mockGetStreams.mockResolvedValue([
            makeStreamRow({
                stream_index: 2,
                is_external: false,
                is_text_subtitle: true,
            }),
        ]);
        mockGetFiles.mockResolvedValue([]);

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 2);

        expect(result).toBeNull();
        expect(mockExtractSubtitleStream).not.toHaveBeenCalled();
    });

    it('resolves virtual index for external subtitle files appended by PlaybackInfo', async () => {
        // Streams in media_streams have indices 0 (video), 1 (audio), 2 (subtitle)
        // External subtitle files get virtual indices starting at max+1 = 3
        mockGetStreams.mockResolvedValue([
            makeStreamRow({
                stream_type: 'video',
                stream_index: 0,
                is_external: false,
                is_text_subtitle: false,
            }),
            makeStreamRow({
                stream_type: 'audio',
                stream_index: 1,
                is_external: false,
                is_text_subtitle: false,
            }),
            makeStreamRow({
                stream_index: 2,
                is_external: false,
                is_text_subtitle: true,
            }),
        ]);
        mockGetExternalSubs.mockResolvedValue([
            makeExternalSubRow({
                subtitle_path: '/media/movies/Film/Film.en.srt',
                format: 'srt',
            }),
            makeExternalSubRow({
                subtitle_path: '/media/movies/Film/Film.de.srt',
                format: 'srt',
            }),
        ]);
        mockSafeExists.mockResolvedValue(true);
        mockStat.mockResolvedValue({ size: 5000 } as Stats);
        mockExtractSubtitleStream.mockResolvedValue(
            'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHallo Welt',
        );

        // Virtual index 4 = second external sub (position 1)
        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 4);

        expect(result).not.toBeNull();
        expect(result?.contentType).toBe('text/vtt; charset=utf-8');
        // Should extract from the second external sub file (Film.de.srt)
        expect(mockExtractSubtitleStream).toHaveBeenCalledWith({
            filePath: '/media/movies/Film/Film.de.srt',
            streamIndex: 0,
            codec: 'srt',
            outputFormat: 'webvtt',
        });
    });

    it('returns null for virtual index beyond available external subs', async () => {
        mockGetStreams.mockResolvedValue([
            makeStreamRow({
                stream_index: 0,
                is_external: false,
                is_text_subtitle: true,
            }),
        ]);
        mockGetExternalSubs.mockResolvedValue([
            makeExternalSubRow({
                subtitle_path: '/media/Film.en.srt',
                format: 'srt',
            }),
        ]);

        // Virtual index 2 would be external position 1, but only 1 external sub exists
        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 2);

        expect(result).toBeNull();
    });

    it('resolves embedded PGS subtitle as binary via extractSubtitleStreamBinary', async () => {
        mockGetStreams.mockResolvedValue([
            makeStreamRow({
                stream_index: 2,
                is_external: false,
                is_text_subtitle: false,
                codec: 'hdmv_pgs_subtitle',
            }),
        ]);
        mockGetFiles.mockResolvedValue([makeFileRow({ file_path: '/media/Film.mkv' })]);
        const fakePgsBuffer = Buffer.from([0x50, 0x47, 0x00, 0x01]);
        mockExtractSubtitleStreamBinary.mockResolvedValue(fakePgsBuffer);

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 2);

        expect(result).not.toBeNull();
        expect(result?.content).toBe(fakePgsBuffer);
        expect(result?.contentType).toBe('application/octet-stream');
        expect(mockExtractSubtitleStreamBinary).toHaveBeenCalledWith('/media/Film.mkv', 2, 'sup');
        expect(mockExtractSubtitleStream).not.toHaveBeenCalled();
    });

    it('returns null when binary subtitle extraction fails', async () => {
        mockGetStreams.mockResolvedValue([
            makeStreamRow({
                stream_index: 2,
                is_external: false,
                is_text_subtitle: false,
                codec: 'hdmv_pgs_subtitle',
            }),
        ]);
        mockGetFiles.mockResolvedValue([makeFileRow({ file_path: '/media/Film.mkv' })]);
        mockExtractSubtitleStreamBinary.mockResolvedValue(null);

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 2);

        expect(result).toBeNull();
    });

    it('resolves embedded VobSub subtitle as binary with correct format', async () => {
        mockGetStreams.mockResolvedValue([
            makeStreamRow({
                stream_index: 3,
                is_external: false,
                is_text_subtitle: false,
                codec: 'dvd_subtitle',
            }),
        ]);
        mockGetFiles.mockResolvedValue([makeFileRow({ file_path: '/media/Film.mkv' })]);
        const fakeVobSubBuffer = Buffer.from([0x00, 0x00, 0x01, 0xba]);
        mockExtractSubtitleStreamBinary.mockResolvedValue(fakeVobSubBuffer);

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 3);

        expect(result).not.toBeNull();
        expect(result?.content).toBe(fakeVobSubBuffer);
        expect(result?.contentType).toBe('application/x-vobsub');
        expect(mockExtractSubtitleStreamBinary).toHaveBeenCalledWith('/media/Film.mkv', 3, 'sub');
    });

    it('serves an embedded text subtitle from the shared disk tier without FFmpeg', async () => {
        mockGetStreams.mockResolvedValue([
            makeStreamRow({
                stream_index: 4,
                is_external: false,
                is_text_subtitle: true,
                codec: 'ass',
            }),
        ]);
        const file = makeFileRow({ file_path: '/media/Show/E02.mkv' });
        mockGetFiles.mockResolvedValue([file]);
        vi.mocked(SubtitleFileCacheService.get).mockResolvedValueOnce('[Script Info]\nwarm');

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 4, { format: 'ass' });

        expect(result?.content).toBe('[Script Info]\nwarm');
        expect(mockExtractSubtitleStream).not.toHaveBeenCalled();
        expect(SubtitleFileCacheService.get).toHaveBeenCalledWith(
            file.id,
            4,
            file.probed_at,
            'ass',
        );
    });

    it('skips the disk tier for a file whose probe was invalidated (probed_at NULL)', async () => {
        mockGetStreams.mockResolvedValue([
            makeStreamRow({
                stream_index: 6,
                is_external: false,
                is_text_subtitle: true,
                codec: 'ass',
            }),
        ]);
        mockGetFiles.mockResolvedValue([
            makeFileRow({ file_path: '/media/Show/E04.mkv', probed_at: null }),
        ]);
        mockExtractSubtitleStream.mockResolvedValue('[Script Info]\nnew file');

        await resolveSubtitle(sql, MEDIA_ITEM_ID, 6, { format: 'ass' });

        expect(SubtitleFileCacheService.get).not.toHaveBeenCalled();
        expect(SubtitleFileCacheService.set).not.toHaveBeenCalled();
    });

    it('writes a fresh ASS extraction to the disk tier under its own extension', async () => {
        mockGetStreams.mockResolvedValue([
            makeStreamRow({
                stream_index: 5,
                is_external: false,
                is_text_subtitle: true,
                codec: 'ass',
            }),
        ]);
        const file = makeFileRow({ file_path: '/media/Show/E03.mkv' });
        mockGetFiles.mockResolvedValue([file]);
        mockExtractSubtitleStream.mockResolvedValue('[Script Info]\nfresh');

        await resolveSubtitle(sql, MEDIA_ITEM_ID, 5, { format: 'ass' });

        expect(SubtitleFileCacheService.set).toHaveBeenCalledWith(
            file.id,
            5,
            '[Script Info]\nfresh',
            'ass',
        );
    });

    it('caches embedded subtitle extraction results', async () => {
        mockGetStreams.mockResolvedValue([
            makeStreamRow({
                stream_index: 2,
                is_external: false,
                is_text_subtitle: true,
                codec: 'subrip',
            }),
        ]);
        mockGetFiles.mockResolvedValue([makeFileRow({ file_path: '/media/Film.mkv' })]);
        mockExtractSubtitleStream.mockResolvedValue(
            'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nHello',
        );

        // First call — extracts via FFmpeg
        const result1 = await resolveSubtitle(sql, MEDIA_ITEM_ID, 2);
        expect(result1).not.toBeNull();
        expect(mockExtractSubtitleStream).toHaveBeenCalledTimes(1);

        // Second call — should serve from cache, no additional FFmpeg call
        const result2 = await resolveSubtitle(sql, MEDIA_ITEM_ID, 2);
        expect(result2).not.toBeNull();
        expect(result2?.content).toBe(result1?.content);
        expect(mockExtractSubtitleStream).toHaveBeenCalledTimes(1); // still 1
    });

    it('uses the correct file for subtitle extraction in multi-file items', async () => {
        // Regression: when no fileId is provided and the item has multiple files,
        // the subtitle stream's file_id should determine which file to extract from.
        const FILE_A = 'file-aaaa';
        const FILE_B = 'file-bbbb';

        // Stream belongs to file B, not file A
        mockGetStreams.mockResolvedValue([
            makeStreamRow({
                id: 'stream-on-b',
                file_id: FILE_B,
                stream_index: 2,
                is_external: false,
                is_text_subtitle: true,
                codec: 'subrip',
            }),
        ]);
        // Item has two files — file A comes first (the default)
        mockGetFiles.mockResolvedValue([
            makeFileRow({ id: FILE_A, file_path: '/media/FileA.mkv' }),
            makeFileRow({ id: FILE_B, file_path: '/media/FileB.mkv' }),
        ]);
        mockExtractSubtitleStream.mockResolvedValue(
            'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nFrom file B',
        );

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 2);

        expect(result).not.toBeNull();
        // FFmpeg should be called with file B's path, not file A's
        expect(mockExtractSubtitleStream).toHaveBeenCalledWith(
            expect.objectContaining({
                filePath: '/media/FileB.mkv',
                streamIndex: 2,
            }),
        );
    });

    it('returns null when the external subtitle file does not exist on disk', async () => {
        mockGetStreams.mockResolvedValue([
            makeStreamRow({
                stream_index: 2,
                is_external: true,
                is_text_subtitle: null,
            }),
        ]);
        mockGetExternalSubs.mockResolvedValue([
            makeExternalSubRow({
                subtitle_path: '/media/movies/Film/Film.en.srt',
                format: 'srt',
            }),
        ]);
        mockSafeExists.mockResolvedValue(false);

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 2);

        expect(result).toBeNull();
        expect(mockExtractSubtitleStream).not.toHaveBeenCalled();
    });
});

describe('resolveSubtitle — external subtitle index scheme (1000 + position)', () => {
    const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHallo';

    beforeEach(() => {
        mockSafeExists.mockResolvedValue(true);
        mockStat.mockResolvedValue({ size: 100 } as Stats);
        mockReadFile.mockResolvedValue(Buffer.from(VTT) as never);
        mockResolvePlaybackSelection.mockResolvedValue({
            files: [makeFileRow({ id: 'file-1' })],
            fileId: 'file-1',
        });
        // Embedded streams 0..3: the old max+1 numbering would have put the
        // first sidecar at 4.
        mockGetStreamsForFile.mockResolvedValue([
            makeStreamRow({ stream_type: 'video', stream_index: 0, codec: 'h264' }),
            makeStreamRow({ stream_type: 'audio', stream_index: 1, codec: 'aac' }),
            makeStreamRow({ stream_index: 2, codec: 'subrip' }),
            makeStreamRow({ stream_index: 3, codec: 'ass' }),
        ]);
        mockGetExternalSubsForFile.mockResolvedValue([
            makeExternalSubRow({
                subtitle_path: '/media/movies/Film/Film.de.vtt',
                format: 'vtt',
                language: 'de',
            }),
            makeExternalSubRow({ subtitle_path: '/media/movies/Film/Film.en.vtt', format: 'vtt' }),
        ]);
    });

    it('with a fileId, 1000 + n serves the n-th sidecar of that file', async () => {
        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 1001, { fileId: 'file-1' });

        expect(result?.content.toString()).toBe(VTT);
        expect(mockGetExternalSubsForFile).toHaveBeenCalledWith(sql, 'file-1');
        expect(mockReadFile).toHaveBeenCalledWith('/media/movies/Film/Film.en.vtt');
        expect(mockExtractSubtitleStream).not.toHaveBeenCalled();
    });

    it('with a fileId, an index past the embedded streams is not a sidecar', async () => {
        // The old PlaybackInfo index for the first sidecar: treated as an
        // (unprobed) embedded stream, never as a sidecar file.
        mockExtractSubtitleStream.mockResolvedValue(null as never);
        await resolveSubtitle(sql, MEDIA_ITEM_ID, 4, { fileId: 'file-1' });

        expect(mockReadFile).not.toHaveBeenCalled();
        expect(mockExtractSubtitleStream).toHaveBeenCalledWith(
            expect.objectContaining({ filePath: '/media/movies/Film/Film.mkv', streamIndex: 4 }),
        );
    });

    it('with a fileId, a media_streams row marked external serves its language sidecar, not FFmpeg on the video', async () => {
        mockGetStreamsForFile.mockResolvedValue([
            makeStreamRow({ stream_type: 'video', stream_index: 0, codec: 'h264' }),
            makeStreamRow({ stream_index: 2, codec: 'subrip', is_external: true, language: 'en' }),
        ]);
        mockGetExternalSubsForFile.mockResolvedValue([
            makeExternalSubRow({
                subtitle_path: '/media/movies/Film/Film.de.vtt',
                format: 'vtt',
                language: 'de',
            }),
            makeExternalSubRow({
                subtitle_path: '/media/movies/Film/Film.en.vtt',
                format: 'vtt',
                language: 'en',
            }),
        ]);

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 2, { fileId: 'file-1' });

        expect(result?.content.toString()).toBe(VTT);
        expect(mockReadFile).toHaveBeenCalledWith('/media/movies/Film/Film.en.vtt');
        expect(mockExtractSubtitleStream).not.toHaveBeenCalled();
    });

    it('with a fileId, an external row with no sidecar of its language and forced flag is not served', async () => {
        mockGetStreamsForFile.mockResolvedValue([
            makeStreamRow({ stream_index: 2, codec: 'subrip', is_external: true, language: 'ja' }),
            makeStreamRow({
                stream_index: 3,
                codec: 'subrip',
                is_external: true,
                language: 'de',
                is_forced: true,
            }),
        ]);

        expect(await resolveSubtitle(sql, MEDIA_ITEM_ID, 2, { fileId: 'file-1' })).toBeNull();
        expect(await resolveSubtitle(sql, MEDIA_ITEM_ID, 3, { fileId: 'file-1' })).toBeNull();
        expect(mockReadFile).not.toHaveBeenCalled();
        expect(mockExtractSubtitleStream).not.toHaveBeenCalled();
    });

    it('with a fileId, external rows pair with sidecars by normalised language, in order', async () => {
        mockGetStreamsForFile.mockResolvedValue([
            makeStreamRow({ stream_index: 4, codec: 'subrip', is_external: true, language: 'ger' }),
            makeStreamRow({ stream_index: 5, codec: 'subrip', is_external: true, language: 'eng' }),
        ]);

        await resolveSubtitle(sql, MEDIA_ITEM_ID, 5, { fileId: 'file-1' });
        expect(mockReadFile).toHaveBeenLastCalledWith('/media/movies/Film/Film.en.vtt');
        clearSubtitleCache();
        await resolveSubtitle(sql, MEDIA_ITEM_ID, 4, { fileId: 'file-1' });
        expect(mockReadFile).toHaveBeenLastCalledWith('/media/movies/Film/Film.de.vtt');
    });

    it('without a fileId, 1000 + n serves the n-th sidecar of the item', async () => {
        mockGetExternalSubs.mockResolvedValue([
            makeExternalSubRow({ subtitle_path: '/media/movies/Film/Film.de.vtt', format: 'vtt' }),
        ]);

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 1000);

        expect(result?.content.toString()).toBe(VTT);
        expect(mockReadFile).toHaveBeenCalledWith('/media/movies/Film/Film.de.vtt');
        expect(mockGetStreams).not.toHaveBeenCalled();
    });
});

describe('resolveSubtitle — one FFmpeg pass per file for bitmap tracks', () => {
    const bitmap = (stream_index: number, codec: string) =>
        makeStreamRow({
            id: `stream-${stream_index}`,
            stream_index,
            codec,
            is_external: false,
            is_text_subtitle: false,
        });

    // PGS 2 (requested), PGS 4, PGS 5 (already cached), VobSub 6, text 7, PGS 8.
    const streams = [
        bitmap(2, 'hdmv_pgs_subtitle'),
        bitmap(4, 'hdmv_pgs_subtitle'),
        bitmap(5, 'hdmv_pgs_subtitle'),
        bitmap(6, 'dvd_subtitle'),
        makeStreamRow({ stream_index: 7, codec: 'subrip', is_text_subtitle: true }),
        bitmap(8, 'hdmv_pgs_subtitle'),
    ];

    beforeEach(() => {
        mockGetStreams.mockResolvedValue(streams);
        mockGetStreamsForFile.mockResolvedValue(streams);
        mockGetFiles.mockResolvedValue([makeFileRow({ file_path: '/media/Film.mkv' })]);
        mockHasFreshBinary.mockImplementation(async (_id, index) => index === 5);
    });

    it('extracts the uncached same-format siblings in the same pass and caches each', async () => {
        const two = Buffer.from([0x50, 0x47, 2]);
        const four = Buffer.from([0x50, 0x47, 4]);
        mockExtractSubtitleStreamsBinary.mockResolvedValue(
            new Map([
                [2, two],
                [4, four],
            ]),
        );

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 2);

        expect(result?.content).toBe(two);
        // 5 is cached, 6 is VobSub (opposite -copyts), 7 is text: none join.
        expect(mockExtractSubtitleStreamsBinary).toHaveBeenCalledTimes(1);
        expect(mockExtractSubtitleStreamsBinary).toHaveBeenCalledWith(
            '/media/Film.mkv',
            [2, 4, 8],
            'sup',
        );
        expect(mockExtractSubtitleStreamBinary).not.toHaveBeenCalled();
        expect(mockSetBinary).toHaveBeenCalledWith(
            expect.any(String),
            2,
            'sup',
            two,
            '/media/Film.mkv',
        );
        expect(mockSetBinary).toHaveBeenCalledWith(
            expect.any(String),
            4,
            'sup',
            four,
            '/media/Film.mkv',
        );
    });

    it('caps a pass at three tracks — extra outputs slow a long file down', async () => {
        const many = [2, 4, 8, 9, 10].map((i) => bitmap(i, 'hdmv_pgs_subtitle'));
        mockGetStreams.mockResolvedValue(many);
        mockGetStreamsForFile.mockResolvedValue(many);
        mockExtractSubtitleStreamsBinary.mockResolvedValue(
            new Map([[2, Buffer.from([0x50, 0x47])]]),
        );

        await resolveSubtitle(sql, MEDIA_ITEM_ID, 2);

        expect(mockExtractSubtitleStreamsBinary).toHaveBeenCalledWith(
            '/media/Film.mkv',
            [2, 4, 8],
            'sup',
        );
    });

    it('a request for a sibling while the pass runs joins it instead of reading the file again', async () => {
        const four = Buffer.from([0x50, 0x47, 4]);
        let finish!: (value: Map<number, Buffer | null>) => void;
        mockExtractSubtitleStreamsBinary.mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );

        const first = resolveSubtitle(sql, MEDIA_ITEM_ID, 2);
        await vi.waitFor(() => expect(mockExtractSubtitleStreamsBinary).toHaveBeenCalled());
        const sibling = resolveSubtitle(sql, MEDIA_ITEM_ID, 4);
        // Past its cache miss, so it is at the in-flight check when the pass ends.
        await vi.waitFor(() =>
            expect(mockGetBinary).toHaveBeenCalledWith(
                expect.any(String),
                4,
                'sup',
                expect.anything(),
                expect.anything(),
            ),
        );

        finish(
            new Map([
                [2, Buffer.from([0x50, 0x47, 2])],
                [4, four],
            ]),
        );

        expect((await sibling)?.content).toBe(four);
        await first;
        expect(mockExtractSubtitleStreamsBinary).toHaveBeenCalledTimes(1);
        expect(mockExtractSubtitleStreamBinary).not.toHaveBeenCalled();
    });

    // A request that JOINED a failed pass must not rebuild the sibling set: that
    // reruns the very multi-track read that just failed, once per joined request.
    async function joinThenFail(error: Error) {
        let fail!: (e: Error) => void;
        mockExtractSubtitleStreamsBinary.mockReturnValueOnce(
            new Promise((_, reject) => {
                fail = reject;
            }),
        );
        const first = resolveSubtitle(sql, MEDIA_ITEM_ID, 2);
        await vi.waitFor(() => expect(mockExtractSubtitleStreamsBinary).toHaveBeenCalled());
        const joined = resolveSubtitle(sql, MEDIA_ITEM_ID, 4);
        await vi.waitFor(() =>
            expect(mockGetBinary).toHaveBeenCalledWith(
                expect.any(String),
                4,
                'sup',
                expect.anything(),
                expect.anything(),
            ),
        );
        fail(error);
        return { first, joined };
    }

    it('a joined request retries alone, without the siblings, after a mux failure', async () => {
        const four = Buffer.from([0x50, 0x47, 4]);
        mockExtractSubtitleStreamBinary.mockImplementation(async (_p, index) =>
            index === 4 ? four : Buffer.from([0x50, 0x47, 2]),
        );

        const { first, joined } = await joinThenFail(new Error('mux failed'));

        expect((await joined)?.content).toBe(four);
        await first;
        expect(mockExtractSubtitleStreamsBinary).toHaveBeenCalledTimes(1);
        expect(mockExtractSubtitleStreamBinary).toHaveBeenCalledWith('/media/Film.mkv', 4, 'sup');
    });

    it('a joined request gives up after a timeout instead of reading the file again', async () => {
        const { first, joined } = await joinThenFail(new FFmpegTimeoutError(120_000, ''));

        expect(await joined).toBeNull();
        expect(await first).toBeNull();
        expect(mockExtractSubtitleStreamsBinary).toHaveBeenCalledTimes(1);
        expect(mockExtractSubtitleStreamBinary).not.toHaveBeenCalled();
    });

    it('falls back to the requested track alone when the shared pass fails', async () => {
        const two = Buffer.from([0x50, 0x47, 2]);
        mockExtractSubtitleStreamsBinary.mockRejectedValue(new Error('mux failed'));
        mockExtractSubtitleStreamBinary.mockResolvedValue(two);

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 2);

        expect(result?.content).toBe(two);
        expect(mockExtractSubtitleStreamBinary).toHaveBeenCalledWith('/media/Film.mkv', 2, 'sup');
    });

    it('does not retry alone after a timeout — the read would be just as slow', async () => {
        mockExtractSubtitleStreamsBinary.mockRejectedValue(new FFmpegTimeoutError(120_000, ''));

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 2);

        expect(result).toBeNull();
        expect(mockExtractSubtitleStreamBinary).not.toHaveBeenCalled();
    });
});

describe('findSubtitleFormatMismatch — a track is delivered only in a format it can carry', () => {
    const pgs = makeStreamRow({
        stream_index: 2,
        codec: 'hdmv_pgs_subtitle',
        is_text_subtitle: false,
    });
    const vobsub = makeStreamRow({
        stream_index: 3,
        codec: 'dvd_subtitle',
        is_text_subtitle: false,
    });
    const subrip = makeStreamRow({ stream_index: 4, codec: 'subrip', is_text_subtitle: true });

    beforeEach(() => {
        mockGetStreams.mockResolvedValue([pgs, vobsub, subrip]);
        mockGetStreamsForFile.mockResolvedValue([pgs, vobsub, subrip]);
        mockResolvePlaybackSelection.mockResolvedValue({
            files: [makeFileRow({ id: 'file-1' })],
            fileId: 'file-1',
        });
    });

    it('refuses a text format for a PGS track and names pgssub as the valid format', async () => {
        for (const format of ['vtt', 'srt', 'ass'] as const) {
            const mismatch = await findSubtitleFormatMismatch(sql, MEDIA_ITEM_ID, 2, { format });
            expect(mismatch).toEqual({ trackKind: 'pgs', validFormats: ['pgssub'] });
        }
    });

    it('refuses the default vtt format for a PGS track when no format is given', async () => {
        const mismatch = await findSubtitleFormatMismatch(sql, MEDIA_ITEM_ID, 2);
        expect(mismatch?.validFormats).toEqual(['pgssub']);
    });

    it('accepts pgssub for a PGS track', async () => {
        expect(
            await findSubtitleFormatMismatch(sql, MEDIA_ITEM_ID, 2, { format: 'pgssub' }),
        ).toBeNull();
    });

    it('refuses a text format for a VobSub track and names sub as the valid format', async () => {
        const mismatch = await findSubtitleFormatMismatch(sql, MEDIA_ITEM_ID, 3, { format: 'srt' });
        expect(mismatch).toEqual({ trackKind: 'vobsub', validFormats: ['sub'] });
    });

    it('refuses pgssub for a VobSub track, and sub for a PGS track', async () => {
        expect(
            (await findSubtitleFormatMismatch(sql, MEDIA_ITEM_ID, 3, { format: 'pgssub' }))
                ?.validFormats,
        ).toEqual(['sub']);
        expect(
            (await findSubtitleFormatMismatch(sql, MEDIA_ITEM_ID, 2, { format: 'sub' }))
                ?.validFormats,
        ).toEqual(['pgssub']);
    });

    it('accepts sub for a VobSub track', async () => {
        expect(
            await findSubtitleFormatMismatch(sql, MEDIA_ITEM_ID, 3, { format: 'sub' }),
        ).toBeNull();
    });

    it('refuses pgssub and sub for a text track', async () => {
        for (const format of ['pgssub', 'sub'] as const) {
            const mismatch = await findSubtitleFormatMismatch(sql, MEDIA_ITEM_ID, 4, { format });
            expect(mismatch).toEqual({
                trackKind: 'text',
                validFormats: ['vtt', 'srt', 'ass'],
            });
        }
    });

    it('accepts text formats for a text track', async () => {
        for (const format of ['vtt', 'srt', 'ass'] as const) {
            expect(await findSubtitleFormatMismatch(sql, MEDIA_ITEM_ID, 4, { format })).toBeNull();
        }
    });

    it('classifies the track of the selected file when fileId is given', async () => {
        mockGetStreamsForFile.mockResolvedValue([pgs]);

        const mismatch = await findSubtitleFormatMismatch(sql, MEDIA_ITEM_ID, 2, {
            fileId: 'file-1',
            format: 'vtt',
        });

        expect(mismatch?.validFormats).toEqual(['pgssub']);
        expect(mockGetStreamsForFile).toHaveBeenCalledWith(sql, 'file-1');
    });

    it('does not refuse when the track is unknown', async () => {
        // No media_streams row for index 9: resolveSubtitle keeps its own fallback.
        expect(
            await findSubtitleFormatMismatch(sql, MEDIA_ITEM_ID, 9, { format: 'vtt' }),
        ).toBeNull();
        // The requested file cannot be resolved: resolveSubtitle answers 404.
        mockResolvePlaybackSelection.mockResolvedValue({ files: [], fileId: null } as never);
        expect(
            await findSubtitleFormatMismatch(sql, MEDIA_ITEM_ID, 2, {
                fileId: 'missing',
                format: 'vtt',
            }),
        ).toBeNull();
    });

    it('still serves PGS bytes for a text format to internal callers', async () => {
        mockGetStreams.mockResolvedValue([pgs]);
        mockGetFiles.mockResolvedValue([makeFileRow({ file_path: '/media/Film.mkv' })]);
        const fakePgsBuffer = Buffer.from([0x50, 0x47, 0x00, 0x01]);
        mockExtractSubtitleStreamBinary.mockResolvedValue(fakePgsBuffer);

        const result = await resolveSubtitle(sql, MEDIA_ITEM_ID, 2);

        expect(result?.content).toBe(fakePgsBuffer);
    });

    it('describes the valid formats in the client message', () => {
        expect(
            describeSubtitleFormatMismatch({ trackKind: 'pgs', validFormats: ['pgssub'] }, 'vtt'),
        ).toContain('Valid formats: pgssub');
        expect(
            describeSubtitleFormatMismatch({ trackKind: 'vobsub', validFormats: ['sub'] }, 'srt'),
        ).toContain('VobSub bitmap track');
        expect(
            describeSubtitleFormatMismatch(
                { trackKind: 'text', validFormats: ['vtt', 'srt', 'ass'] },
                'pgssub',
            ),
        ).toContain('Valid formats: vtt, srt, ass');
    });
});
