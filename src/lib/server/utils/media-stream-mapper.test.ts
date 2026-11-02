// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    mapJellyfinStreamsToDbRows,
    mapFFprobeToDbRows,
    dbRowToAudioStreamInfo,
    dbRowToAudioTrackInfo,
    dbRowToVideoStreamInfo,
    isTextCodec,
    type RawJellyfinStream,
} from './media-stream-mapper';
import type { MediaStreamRow } from '../database/queries/media-streams.queries';
import type { MediaProbeResult, VideoStreamInfo as FFprobeVideoStreamInfo } from './ffprobe';
import { asAbsoluteStreamIndex, asAudioRelativeIndex } from '$lib/shared/stream-index';

// ============================================================================
// Helpers
// ============================================================================

const ITEM_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function makeStreamRow(overrides: Partial<MediaStreamRow> = {}): MediaStreamRow {
    return {
        id: 'row-id',
        file_id: ITEM_ID,
        stream_type: 'audio',
        stream_index: 1,
        codec: 'aac',
        codec_tag: null,
        profile: null,
        level: null,
        language: null,
        display_title: null,
        title: null,
        channels: 2,
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
        is_external: null,
        is_text_subtitle: null,
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

function makeProbe(overrides: Partial<MediaProbeResult> = {}): MediaProbeResult {
    return {
        success: true,
        video: null,
        audioStreams: [],
        subtitleStreams: [],
        duration: null,
        container: null,
        fileSize: null,
        formatBitrate: null,
        ...overrides,
    };
}

// ============================================================================
// mapJellyfinStreamsToDbRows
// ============================================================================

describe('mapJellyfinStreamsToDbRows', () => {
    it('maps a video stream correctly', () => {
        const streams: RawJellyfinStream[] = [
            {
                Index: 0,
                Type: 'Video',
                Codec: 'hevc',
                Profile: 'Main 10',
                Width: 1920,
                Height: 1080,
                BitRate: 8000000,
                BitDepth: 10,
                VideoRange: 'HDR',
                VideoRangeType: 'HDR10',
                ColorSpace: 'bt2020nc',
                AverageFrameRate: 23.976,
                IsDefault: true,
            },
        ];
        const rows = mapJellyfinStreamsToDbRows(ITEM_ID, streams);
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.stream_type).toBe('video');
        expect(row.stream_index).toBe(0);
        expect(row.codec).toBe('hevc');
        expect(row.profile).toBe('Main 10');
        expect(row.width).toBe(1920);
        expect(row.height).toBe(1080);
        expect(row.bitrate).toBe(8000000);
        expect(row.bit_depth).toBe(10);
        expect(row.video_range).toBe('HDR');
        expect(row.video_range_type).toBe('HDR10');
        expect(row.color_space).toBe('bt2020nc');
        expect(row.average_frame_rate).toBe(23.976);
        expect(row.is_default).toBe(true);
    });

    it('maps an audio stream correctly', () => {
        const streams: RawJellyfinStream[] = [
            {
                Index: 1,
                Type: 'Audio',
                Codec: 'dts',
                Language: 'eng',
                DisplayTitle: 'English DTS-HD MA 7.1',
                Channels: 8,
                ChannelLayout: '7.1',
                BitRate: 4000000,
                SampleRate: 48000,
                IsDefault: true,
            },
        ];
        const rows = mapJellyfinStreamsToDbRows(ITEM_ID, streams);
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.stream_type).toBe('audio');
        expect(row.stream_index).toBe(1);
        expect(row.codec).toBe('dts');
        expect(row.language).toBe('eng');
        expect(row.display_title).toBe('English DTS-HD MA 7.1');
        expect(row.channels).toBe(8);
        expect(row.channel_layout).toBe('7.1');
        expect(row.bitrate).toBe(4000000);
        expect(row.sample_rate).toBe(48000);
        expect(row.is_default).toBe(true);
    });

    it('maps a subtitle stream correctly', () => {
        const streams: RawJellyfinStream[] = [
            {
                Index: 3,
                Type: 'Subtitle',
                Codec: 'PGSSUB',
                Language: 'deu',
                IsDefault: false,
                IsForced: true,
                IsExternal: false,
                IsTextSubtitleStream: false,
            },
        ];
        const rows = mapJellyfinStreamsToDbRows(ITEM_ID, streams);
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.stream_type).toBe('subtitle');
        expect(row.codec).toBe('PGSSUB');
        expect(row.language).toBe('deu');
        expect(row.is_forced).toBe(true);
        expect(row.is_default).toBe(false);
    });

    it('filters out unsupported stream types', () => {
        const streams: RawJellyfinStream[] = [
            { Index: 0, Type: 'Data' },
            { Index: 1, Type: 'EmbeddedImage' },
            { Index: 2, Type: 'Audio', Codec: 'aac' },
        ];
        const rows = mapJellyfinStreamsToDbRows(ITEM_ID, streams);
        expect(rows).toHaveLength(1);
        expect(rows[0].stream_type).toBe('audio');
    });

    it('handles case-insensitive Type field', () => {
        const streams: RawJellyfinStream[] = [
            { Index: 0, Type: 'VIDEO', Codec: 'h264' },
            { Index: 1, Type: 'audio', Codec: 'aac' },
        ];
        const rows = mapJellyfinStreamsToDbRows(ITEM_ID, streams);
        expect(rows).toHaveLength(2);
        expect(rows[0].stream_type).toBe('video');
        expect(rows[1].stream_type).toBe('audio');
    });

    it('falls back to "unknown" when Codec is missing', () => {
        const streams: RawJellyfinStream[] = [{ Index: 0, Type: 'Audio' }];
        const rows = mapJellyfinStreamsToDbRows(ITEM_ID, streams);
        expect(rows[0].codec).toBe('unknown');
    });

    it('defaults IsDefault and IsForced to false when absent', () => {
        const streams: RawJellyfinStream[] = [{ Index: 0, Type: 'Audio', Codec: 'aac' }];
        const rows = mapJellyfinStreamsToDbRows(ITEM_ID, streams);
        expect(rows[0].is_default).toBe(false);
        expect(rows[0].is_forced).toBe(false);
    });

    it('returns empty array for empty input', () => {
        expect(mapJellyfinStreamsToDbRows(ITEM_ID, [])).toEqual([]);
    });

    it('maps PixelFormat/RefFrames/ColorPrimaries/ColorTransfer for video streams', () => {
        const streams: RawJellyfinStream[] = [
            {
                Index: 0,
                Type: 'Video',
                Codec: 'hevc',
                PixelFormat: 'yuv420p10le',
                RefFrames: 1,
                ColorPrimaries: 'bt2020',
                ColorTransfer: 'smpte2084',
                ColorSpace: 'bt2020nc',
            },
        ];
        const rows = mapJellyfinStreamsToDbRows(ITEM_ID, streams);
        expect(rows[0].pixel_format).toBe('yuv420p10le');
        expect(rows[0].ref_frames).toBe(1);
        expect(rows[0].color_primaries).toBe('bt2020');
        expect(rows[0].color_transfer).toBe('smpte2084');
        expect(rows[0].color_space).toBe('bt2020nc');
    });

    it('normalizes Jellyfin color sentinels (unknown/reserved/empty) to null', () => {
        const streams: RawJellyfinStream[] = [
            {
                Index: 0,
                Type: 'Video',
                Codec: 'h264',
                ColorSpace: 'unknown',
                ColorPrimaries: 'reserved',
                ColorTransfer: '',
            },
        ];
        const rows = mapJellyfinStreamsToDbRows(ITEM_ID, streams);
        expect(rows[0].color_space).toBeNull();
        expect(rows[0].color_primaries).toBeNull();
        expect(rows[0].color_transfer).toBeNull();
    });

    it('drops RefFrames=0 (meaningless)', () => {
        const streams: RawJellyfinStream[] = [
            { Index: 0, Type: 'Video', Codec: 'h264', RefFrames: 0 },
        ];
        const rows = mapJellyfinStreamsToDbRows(ITEM_ID, streams);
        expect(rows[0].ref_frames).toBeNull();
    });
});

// ============================================================================
// mapFFprobeToDbRows
// ============================================================================

describe('mapJellyfinStreamsToDbRows bit depth', () => {
    // Jellyfin omits BitDepth for some containers while still reporting
    // PixelFormat. Storing NULL there loses the one fact that scopes a GPU
    // decode-capability lesson to the right sources.
    it('derives bit_depth from PixelFormat when Jellyfin omits BitDepth', () => {
        const rows = mapJellyfinStreamsToDbRows(ITEM_ID, [
            { Index: 0, Type: 'Video', Codec: 'h264', PixelFormat: 'yuv420p10le' },
        ]);
        expect(rows[0].bit_depth).toBe(10);
    });

    it('prefers Jellyfin BitDepth over the PixelFormat derivation', () => {
        const rows = mapJellyfinStreamsToDbRows(ITEM_ID, [
            { Index: 0, Type: 'Video', Codec: 'h264', BitDepth: 12, PixelFormat: 'yuv420p10le' },
        ]);
        expect(rows[0].bit_depth).toBe(12);
    });

    it('stores null when neither BitDepth nor PixelFormat is reported', () => {
        const rows = mapJellyfinStreamsToDbRows(ITEM_ID, [
            { Index: 0, Type: 'Video', Codec: 'h264' },
        ]);
        expect(rows[0].bit_depth).toBeNull();
    });
});

describe('mapFFprobeToDbRows', () => {
    it('maps a video stream with HDR10', () => {
        const probe = makeProbe({
            video: {
                index: 0,
                codec: 'hevc',
                width: 3840,
                height: 2160,
                bitrate: 20000000,
                fps: null,
                pixelFormat: null,
                hdr: 'hdr10',
                colorSpace: 'bt2020nc',
                profile: 'Main 10',
                level: null,
                masterDisplay: null,
                maxCll: null,
                colorPrimaries: null,
                colorTransfer: null,
                refFrames: null,
                closedCaptions: false,
            },
        });
        const rows = mapFFprobeToDbRows(ITEM_ID, probe);
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.stream_type).toBe('video');
        expect(row.codec).toBe('hevc');
        expect(row.width).toBe(3840);
        expect(row.height).toBe(2160);
        expect(row.bitrate).toBe(20000000);
        expect(row.video_range).toBe('HDR10');
        expect(row.color_space).toBe('bt2020nc');
        expect(row.profile).toBe('Main 10');
        expect(row.is_default).toBe(true);
        expect(row.is_forced).toBe(false);
    });

    it('derives bit_depth from pixelFormat (scanner must persist depth for decode-capability keying)', () => {
        // Regression: bit_depth was never written by the native scanner, so
        // learn-on-failure keyed Hi10P lessons as bare "h264" and poisoned
        // hardware decode for all H.264 sources.
        const base = {
            index: 0,
            codec: 'h264',
            width: 960,
            height: 720,
            bitrate: null,
            fps: null,
            hdr: 'sdr' as const,
            colorSpace: null,
            profile: 'High 10',
            level: null,
            masterDisplay: null,
            maxCll: null,
            colorPrimaries: null,
            colorTransfer: null,
            refFrames: null,
            closedCaptions: false,
        };
        const hi10 = mapFFprobeToDbRows(
            ITEM_ID,
            makeProbe({ video: { ...base, pixelFormat: 'yuv420p10le' } }),
        )[0];
        expect(hi10.bit_depth).toBe(10);
        const sdr8 = mapFFprobeToDbRows(
            ITEM_ID,
            makeProbe({ video: { ...base, pixelFormat: 'yuv420p' } }),
        )[0];
        expect(sdr8.bit_depth).toBe(8);
        const unknown = mapFFprobeToDbRows(
            ITEM_ID,
            makeProbe({ video: { ...base, pixelFormat: null } }),
        )[0];
        expect(unknown.bit_depth).toBeNull();
    });

    it('maps HDR variants correctly (coarse video_range + fine video_range_type)', () => {
        // [hdr enum, coarse video_range, fine video_range_type]. The fine type
        // preserves the HDR10+ distinction the coarse range collapses.
        const hdrCases: Array<[FFprobeVideoStreamInfo['hdr'], string, string]> = [
            ['hdr10', 'HDR10', 'HDR10'],
            ['hdr10plus', 'HDR10', 'HDR10Plus'],
            ['hlg', 'HLG', 'HLG'],
            ['dovi', 'Dolby Vision', 'DOVI'],
            ['dovi_hdr10', 'DOVIWithHDR10', 'DOVIWithHDR10'],
            ['sdr', 'SDR', 'SDR'],
        ];
        for (const [hdr, expectedRange, expectedType] of hdrCases) {
            const probe = makeProbe({
                video: {
                    index: 0,
                    codec: 'h264',
                    width: 1920,
                    height: 1080,
                    bitrate: null,
                    fps: null,
                    pixelFormat: null,
                    hdr,
                    colorSpace: null,
                    profile: null,
                    level: null,
                    masterDisplay: null,
                    maxCll: null,
                    colorPrimaries: null,
                    colorTransfer: null,
                    refFrames: null,
                    closedCaptions: false,
                },
            });
            const rows = mapFFprobeToDbRows(ITEM_ID, probe);
            expect(rows[0].video_range, `video_range for ${hdr}`).toBe(expectedRange);
            expect(rows[0].video_range_type, `video_range_type for ${hdr}`).toBe(expectedType);
        }
    });

    it('maps audio streams using absoluteIndex as stream_index', () => {
        const probe = makeProbe({
            audioStreams: [
                {
                    audioRelativeIndex: asAudioRelativeIndex(0),
                    absoluteIndex: asAbsoluteStreamIndex(1),
                    codec: 'dts',
                    channels: 6,
                    channelLayout: '5.1',
                    sampleRate: 48000,
                    bitRate: 1500000,
                    language: 'eng',
                    title: 'English DTS',
                    isDefault: true,
                    isVisualImpaired: false,
                },
                {
                    audioRelativeIndex: asAudioRelativeIndex(1),
                    absoluteIndex: asAbsoluteStreamIndex(2),
                    codec: 'aac',
                    channels: 2,
                    channelLayout: 'stereo',
                    sampleRate: 48000,
                    bitRate: undefined,
                    language: 'ger',
                    title: undefined,
                    isDefault: false,
                    isVisualImpaired: false,
                },
            ],
        });
        const rows = mapFFprobeToDbRows(ITEM_ID, probe);
        expect(rows).toHaveLength(2);

        expect(rows[0].stream_index).toBe(1); // absoluteIndex
        expect(rows[0].codec).toBe('dts');
        expect(rows[0].channels).toBe(6);
        expect(rows[0].language).toBe('eng');
        expect(rows[0].display_title).toBe('English DTS');
        expect(rows[0].is_default).toBe(true);
        expect(rows[0].bitrate).toBe(1500000);

        expect(rows[1].stream_index).toBe(2);
        expect(rows[1].codec).toBe('aac');
        expect(rows[1].language).toBe('ger');
        expect(rows[1].display_title).toBe('ger'); // falls back to language
        expect(rows[1].bitrate).toBeNull();
    });

    it('generates display_title fallback hierarchy for audio', () => {
        // title → language → "Audio {absoluteIndex}"
        const makeAudio = (
            title: string | undefined,
            language: string | undefined,
            absoluteIndex: number,
        ) => ({
            audioRelativeIndex: asAudioRelativeIndex(0),
            absoluteIndex: asAbsoluteStreamIndex(absoluteIndex),
            codec: 'aac',
            channels: 2,
            isDefault: false,
            isVisualImpaired: false,
            title,
            language,
        });

        const probe1 = makeProbe({
            audioStreams: [makeAudio('Commentary', 'eng', 3)],
        });
        expect(mapFFprobeToDbRows(ITEM_ID, probe1)[0].display_title).toBe('Commentary');

        const probe2 = makeProbe({
            audioStreams: [makeAudio(undefined, 'fra', 3)],
        });
        expect(mapFFprobeToDbRows(ITEM_ID, probe2)[0].display_title).toBe('fra');

        const probe3 = makeProbe({
            audioStreams: [makeAudio(undefined, undefined, 3)],
        });
        expect(mapFFprobeToDbRows(ITEM_ID, probe3)[0].display_title).toBe('Audio 3');
    });

    it('maps subtitle streams', () => {
        const probe = makeProbe({
            subtitleStreams: [
                {
                    index: 4,
                    codec: 'subrip',
                    language: 'eng',
                    title: 'English SDH',
                    isDefault: false,
                    isForced: false,
                    isHearingImpaired: false,
                },
                {
                    index: 5,
                    codec: 'ass',
                    language: null,
                    title: null,
                    isDefault: false,
                    isForced: true,
                    isHearingImpaired: false,
                },
            ],
        });
        const rows = mapFFprobeToDbRows(ITEM_ID, probe);
        expect(rows).toHaveLength(2);

        expect(rows[0].stream_type).toBe('subtitle');
        expect(rows[0].stream_index).toBe(4);
        expect(rows[0].codec).toBe('subrip');
        expect(rows[0].language).toBe('eng');
        expect(rows[0].display_title).toBe('English SDH');
        expect(rows[0].is_forced).toBe(false);

        expect(rows[1].stream_index).toBe(5);
        expect(rows[1].display_title).toBe('Subtitle 5'); // fallback
        expect(rows[1].is_forced).toBe(true);
    });

    it('returns correct order: video first, then audio, then subtitle', () => {
        const probe = makeProbe({
            video: {
                index: 0,
                codec: 'h264',
                width: 1920,
                height: 1080,
                bitrate: null,
                fps: null,
                pixelFormat: null,
                hdr: 'sdr',
                colorSpace: null,
                profile: null,
                level: null,
                masterDisplay: null,
                maxCll: null,
                colorPrimaries: null,
                colorTransfer: null,
                refFrames: null,
                closedCaptions: false,
            },
            audioStreams: [
                {
                    audioRelativeIndex: asAudioRelativeIndex(0),
                    absoluteIndex: asAbsoluteStreamIndex(1),
                    codec: 'aac',
                    channels: 2,
                    isDefault: true,
                    isVisualImpaired: false,
                },
            ],
            subtitleStreams: [
                {
                    index: 2,
                    codec: 'subrip',
                    language: 'eng',
                    title: null,
                    isDefault: false,
                    isForced: false,
                    isHearingImpaired: false,
                },
            ],
        });
        const rows = mapFFprobeToDbRows(ITEM_ID, probe);
        expect(rows).toHaveLength(3);
        expect(rows[0].stream_type).toBe('video');
        expect(rows[1].stream_type).toBe('audio');
        expect(rows[2].stream_type).toBe('subtitle');
    });

    it('sets file_id on all rows', () => {
        const probe = makeProbe({
            video: {
                index: 0,
                codec: 'h264',
                width: 1920,
                height: 1080,
                bitrate: null,
                fps: null,
                pixelFormat: null,
                hdr: 'sdr',
                colorSpace: null,
                profile: null,
                level: null,
                masterDisplay: null,
                maxCll: null,
                colorPrimaries: null,
                colorTransfer: null,
                refFrames: null,
                closedCaptions: false,
            },
            audioStreams: [
                {
                    audioRelativeIndex: asAudioRelativeIndex(0),
                    absoluteIndex: asAbsoluteStreamIndex(1),
                    codec: 'aac',
                    channels: 2,
                    isDefault: false,
                    isVisualImpaired: false,
                },
            ],
        });
        const rows = mapFFprobeToDbRows(ITEM_ID, probe);
        expect(rows.every((r) => r.file_id === ITEM_ID)).toBe(true);
    });

    it('returns empty array when probe has no streams', () => {
        expect(mapFFprobeToDbRows(ITEM_ID, makeProbe())).toEqual([]);
    });

    it('sets is_text_subtitle=true for text codecs', () => {
        const textCodecs = [
            'subrip',
            'ass',
            'webvtt',
            'srt',
            'ssa',
            'vtt',
            'mov_text',
            'ttml',
            'dfxp',
            'sami',
            'microdvd',
            'text',
        ];
        for (const codec of textCodecs) {
            const probe = makeProbe({
                subtitleStreams: [
                    {
                        index: 0,
                        codec,
                        language: null,
                        title: null,
                        isDefault: false,
                        isForced: false,
                        isHearingImpaired: false,
                    },
                ],
            });
            const rows = mapFFprobeToDbRows(ITEM_ID, probe);
            expect(rows[0].is_text_subtitle).toBe(true);
        }
    });

    it('sets is_text_subtitle=false for bitmap codecs', () => {
        const bitmapCodecs = ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvbsub', 'pgssub'];
        for (const codec of bitmapCodecs) {
            const probe = makeProbe({
                subtitleStreams: [
                    {
                        index: 0,
                        codec,
                        language: null,
                        title: null,
                        isDefault: false,
                        isForced: false,
                        isHearingImpaired: false,
                    },
                ],
            });
            const rows = mapFFprobeToDbRows(ITEM_ID, probe);
            expect(rows[0].is_text_subtitle).toBe(false);
        }
    });

    it('sets is_external=false for all embedded subtitle streams', () => {
        const probe = makeProbe({
            subtitleStreams: [
                {
                    index: 3,
                    codec: 'subrip',
                    language: 'eng',
                    title: null,
                    isDefault: true,
                    isForced: false,
                    isHearingImpaired: false,
                },
                {
                    index: 4,
                    codec: 'hdmv_pgs_subtitle',
                    language: 'fra',
                    title: null,
                    isDefault: false,
                    isForced: false,
                    isHearingImpaired: false,
                },
            ],
        });
        const rows = mapFFprobeToDbRows(ITEM_ID, probe);
        expect(rows.every((r) => r.is_external === false)).toBe(true);
    });

    it('writes pixel_format/ref_frames/color_primaries/color_transfer for video', () => {
        const probe: MediaProbeResult = {
            success: true,
            video: {
                index: 0,
                codec: 'hevc',
                width: 3840,
                height: 2160,
                fps: 23.976,
                pixelFormat: 'yuv420p10le',
                bitrate: 50_000_000,
                hdr: 'hdr10',
                colorSpace: 'bt2020nc',
                colorPrimaries: 'bt2020',
                colorTransfer: 'smpte2084',
                refFrames: 1,
                profile: 'Main 10',
                level: 153,
                masterDisplay: null,
                maxCll: null,
                closedCaptions: false,
            } as FFprobeVideoStreamInfo,
            audioStreams: [],
            subtitleStreams: [],
            duration: 7200,
            container: 'matroska,webm',
            fileSize: 25_000_000_000,
            formatBitrate: 50_000_000,
        };
        const rows = mapFFprobeToDbRows('file-uuid', probe);
        const videoRow = rows.find((r) => r.stream_type === 'video');
        expect(videoRow).toBeDefined();
        expect(videoRow!.pixel_format).toBe('yuv420p10le');
        expect(videoRow!.ref_frames).toBe(1);
        expect(videoRow!.color_primaries).toBe('bt2020');
        expect(videoRow!.color_transfer).toBe('smpte2084');
    });
});

// ============================================================================
// isTextCodec
// ============================================================================

describe('isTextCodec', () => {
    it('returns true for known text subtitle codecs', () => {
        expect(isTextCodec('subrip')).toBe(true);
        expect(isTextCodec('ass')).toBe(true);
        expect(isTextCodec('webvtt')).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(isTextCodec('SUBRIP')).toBe(true);
        expect(isTextCodec('WebVTT')).toBe(true);
    });

    it('returns false for bitmap codecs', () => {
        expect(isTextCodec('hdmv_pgs_subtitle')).toBe(false);
        expect(isTextCodec('dvd_subtitle')).toBe(false);
    });
});

// ============================================================================
// dbRowToAudioStreamInfo
// ============================================================================

describe('dbRowToAudioStreamInfo', () => {
    it('maps all fields correctly', () => {
        const row = makeStreamRow({
            stream_type: 'audio',
            stream_index: 2,
            codec: 'dts',
            codec_tag: 'DTS',
            language: 'eng',
            display_title: 'English DTS-HD MA 5.1',
            title: 'Commentary',
            channels: 6,
            channel_layout: '5.1',
            bitrate: 4000000,
            sample_rate: 48000,
            is_default: true,
            is_forced: false,
        });
        const info = dbRowToAudioStreamInfo(row, 1);
        expect(info.index).toBe(1);
        expect(info.absoluteIndex).toBe(2);
        expect(info.codec).toBe('dts');
        expect(info.codecTag).toBe('DTS');
        expect(info.language).toBe('eng');
        expect(info.languageCode).toBe('eng');
        expect(info.displayTitle).toBe('English DTS-HD MA 5.1');
        expect(info.title).toBe('Commentary');
        expect(info.channels).toBe(6);
        expect(info.channelLayout).toBe('5.1');
        expect(info.bitrate).toBe(4000000);
        expect(info.sampleRate).toBe(48000);
        expect(info.isDefault).toBe(true);
        expect(info.isForced).toBe(false);
    });

    it('falls back to title when display_title is null', () => {
        const row = makeStreamRow({
            display_title: null,
            title: 'Commentary',
            stream_index: 1,
        });
        expect(dbRowToAudioStreamInfo(row, 0).displayTitle).toBe('Commentary');
    });

    it('falls back to "Audio {index}" when both display_title and title are null', () => {
        const row = makeStreamRow({
            display_title: null,
            title: null,
            stream_index: 3,
        });
        expect(dbRowToAudioStreamInfo(row, 0).displayTitle).toBe('Audio 3');
    });

    it('defaults channels to 2 when null', () => {
        const row = makeStreamRow({ channels: null });
        expect(dbRowToAudioStreamInfo(row, 0).channels).toBe(2);
    });

    it('converts null optional fields to undefined', () => {
        const row = makeStreamRow({
            codec_tag: null,
            language: null,
            bitrate: null,
            sample_rate: null,
            channel_layout: null,
        });
        const info = dbRowToAudioStreamInfo(row, 0);
        expect(info.codecTag).toBeUndefined();
        expect(info.language).toBeUndefined();
        expect(info.bitrate).toBeUndefined();
        expect(info.sampleRate).toBeUndefined();
        expect(info.channelLayout).toBeUndefined();
    });

    // D13: the Zod schema documents `index` as 0-based audio-relative and
    // `absoluteIndex` as the wire/selection value. Before this, the mapper put
    // the ABSOLUTE stream index into `index` and left `absoluteIndex` undefined
    // — the annotation and the values disagreed, invisibly.
    it('puts the audio-relative ordinal in index and the absolute index in absoluteIndex', () => {
        // 1 video + 2 audio: audio streams are absolute 1 and 2, relative 0 and 1.
        const rows = [
            makeStreamRow({ stream_type: 'audio', stream_index: 1, language: 'eng' }),
            makeStreamRow({ stream_type: 'audio', stream_index: 2, language: 'ger' }),
        ];
        const infos = rows.map((row, i) => dbRowToAudioStreamInfo(row, i));

        expect(infos.map((a) => a.index)).toEqual([0, 1]);
        expect(infos.map((a) => a.absoluteIndex)).toEqual([1, 2]);
    });

    it('never reports absoluteIndex as undefined', () => {
        const info = dbRowToAudioStreamInfo(makeStreamRow({ stream_index: 4 }), 2);
        expect(info.absoluteIndex).toBe(4);
    });
});

// ============================================================================
// dbRowToAudioTrackInfo
// ============================================================================

describe('dbRowToAudioTrackInfo', () => {
    // The transcoding pipeline's AudioTrackInfo uses the OPPOSITE convention on
    // `.index` (absolute) from AudioStreamInfo (audio-relative). Giving each
    // type its own DB producer is what stops the two from being confused —
    // AudioStreamInfo is structurally assignable to AudioTrackInfo, so the
    // compiler cannot catch the mix-up on its own.
    it('puts the ABSOLUTE stream index in index', () => {
        const rows = [
            makeStreamRow({ stream_type: 'audio', stream_index: 1, language: 'eng' }),
            makeStreamRow({ stream_type: 'audio', stream_index: 2, language: 'ger' }),
        ];
        expect(rows.map(dbRowToAudioTrackInfo).map((t) => t.index)).toEqual([1, 2]);
    });

    it('carries the fields the HLS master playlist and encoder need', () => {
        const track = dbRowToAudioTrackInfo(
            makeStreamRow({
                stream_type: 'audio',
                stream_index: 3,
                codec: 'eac3',
                language: 'ger',
                display_title: 'German EAC3 5.1',
                channels: 6,
                bitrate: 640000,
                is_default: true,
            }),
        );
        expect(track).toEqual({
            index: 3,
            displayTitle: 'German EAC3 5.1',
            language: 'ger',
            channels: 6,
            codec: 'eac3',
            bitrate: 640000,
            isDefault: true,
        });
    });

    it('falls back to title then "Audio {absolute index}" for the display title', () => {
        expect(
            dbRowToAudioTrackInfo(
                makeStreamRow({ display_title: null, title: 'Commentary', stream_index: 1 }),
            ).displayTitle,
        ).toBe('Commentary');
        expect(
            dbRowToAudioTrackInfo(
                makeStreamRow({ display_title: null, title: null, stream_index: 3 }),
            ).displayTitle,
        ).toBe('Audio 3');
    });
});

// ============================================================================
// dbRowToVideoStreamInfo
// ============================================================================

describe('mapFFprobeToDbRows accessibility', () => {
    it('threads CC / AD / SDH into inserts', () => {
        const probe: MediaProbeResult = {
            success: true,
            duration: 60,
            container: 'matroska',
            fileSize: 1,
            formatBitrate: 1,
            video: {
                index: 0,
                codec: 'hevc',
                width: 1920,
                height: 1080,
                fps: 24,
                pixelFormat: 'yuv420p10le',
                bitrate: null,
                hdr: 'sdr',
                colorSpace: null,
                colorPrimaries: null,
                colorTransfer: null,
                refFrames: null,
                profile: null,
                level: null,
                masterDisplay: null,
                maxCll: null,
                closedCaptions: true,
            },
            audioStreams: [
                {
                    audioRelativeIndex: 0,
                    absoluteIndex: 1,
                    codec: 'eac3',
                    channels: 6,
                    channelLayout: '5.1',
                    sampleRate: 48000,
                    bitRate: 640000,
                    language: 'eng',
                    title: 'AD',
                    profile: undefined,
                    isDefault: false,
                    isVisualImpaired: true,
                } as MediaProbeResult['audioStreams'][number],
            ],
            subtitleStreams: [
                {
                    index: 2,
                    codec: 'subrip',
                    language: 'eng',
                    title: 'SDH',
                    isDefault: false,
                    isForced: false,
                    isHearingImpaired: true,
                } as MediaProbeResult['subtitleStreams'][number],
            ],
        };
        const rows = mapFFprobeToDbRows('file-1', probe);
        expect(rows.find((r) => r.stream_type === 'video')?.has_closed_captions).toBe(true);
        expect(rows.find((r) => r.stream_type === 'audio')?.is_visual_impaired).toBe(true);
        expect(rows.find((r) => r.stream_type === 'subtitle')?.is_hearing_impaired).toBe(true);
    });
});

describe('dbRowToVideoStreamInfo', () => {
    it('maps all fields correctly', () => {
        const row = makeStreamRow({
            stream_type: 'video',
            stream_index: 0,
            codec: 'hevc',
            codec_tag: 'hvc1',
            profile: 'Main 10',
            level: 150,
            width: 3840,
            height: 2160,
            bitrate: 20000000,
            bit_depth: 10,
            video_range: 'HDR10',
            video_range_type: 'HDR10',
            color_space: 'bt2020nc',
            aspect_ratio: '16:9',
            average_frame_rate: 23.976,
            is_default: true,
            is_anamorphic: false,
        });
        const info = dbRowToVideoStreamInfo(row);
        expect(info.index).toBe(0);
        expect(info.codec).toBe('hevc');
        expect(info.codecTag).toBe('hvc1');
        expect(info.profile).toBe('Main 10');
        expect(info.level).toBe(150);
        expect(info.width).toBe(3840);
        expect(info.height).toBe(2160);
        expect(info.bitrate).toBe(20000000);
        expect(info.bitDepth).toBe(10);
        expect(info.videoRange).toBe('HDR10');
        expect(info.videoRangeType).toBe('HDR10');
        expect(info.colorSpace).toBe('bt2020nc');
        expect(info.aspectRatio).toBe('16:9');
        expect(info.averageFrameRate).toBe(23.976);
        expect(info.isDefault).toBe(true);
        expect(info.isAnamorphic).toBe(false);
    });

    it('falls back to "SDR" when video_range is null', () => {
        const row = makeStreamRow({ video_range: null });
        expect(dbRowToVideoStreamInfo(row).videoRange).toBe('SDR');
    });

    // A NULL bit_depth is not "8-bit" — it is "unknown", and an unknown depth
    // makes a GPU decode-capability lesson un-keyable. pixel_format carries the
    // answer on every row written before bit_depth was populated.
    it('derives bitDepth from pixel_format when bit_depth is null', () => {
        expect(
            dbRowToVideoStreamInfo(makeStreamRow({ bit_depth: null, pixel_format: 'yuv420p10le' }))
                .bitDepth,
        ).toBe(10);
        expect(
            dbRowToVideoStreamInfo(makeStreamRow({ bit_depth: null, pixel_format: 'yuv420p' }))
                .bitDepth,
        ).toBe(8);
    });

    it('prefers a stored bit_depth over the pixel_format derivation', () => {
        const row = makeStreamRow({ bit_depth: 12, pixel_format: 'yuv420p10le' });
        expect(dbRowToVideoStreamInfo(row).bitDepth).toBe(12);
    });

    it('leaves bitDepth undefined when neither depth nor pixel_format is known', () => {
        const row = makeStreamRow({ bit_depth: null, pixel_format: null });
        expect(dbRowToVideoStreamInfo(row).bitDepth).toBeUndefined();
    });

    it('falls back to 0 for width/height when null', () => {
        const row = makeStreamRow({ width: null, height: null });
        const info = dbRowToVideoStreamInfo(row);
        expect(info.width).toBe(0);
        expect(info.height).toBe(0);
    });

    it('converts null optional fields to undefined', () => {
        const row = makeStreamRow({
            codec_tag: null,
            profile: null,
            level: null,
            bitrate: null,
            bit_depth: null,
            video_range_type: null,
            color_space: null,
            aspect_ratio: null,
            average_frame_rate: null,
            is_anamorphic: null,
        });
        const info = dbRowToVideoStreamInfo(row);
        expect(info.codecTag).toBeUndefined();
        expect(info.profile).toBeUndefined();
        expect(info.level).toBeUndefined();
        expect(info.bitrate).toBeUndefined();
        expect(info.bitDepth).toBeUndefined();
        expect(info.videoRangeType).toBeUndefined();
        expect(info.colorSpace).toBeUndefined();
        expect(info.aspectRatio).toBeUndefined();
        expect(info.averageFrameRate).toBeUndefined();
        expect(info.isAnamorphic).toBeUndefined();
    });
});
