// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for FFprobe utilities
 */

import { describe, it, expect } from 'vitest';
import {
    probeMediaFile,
    probeStreamCounts,
    probeChapters,
    extractMasterDisplay,
    extractMaxCll,
    containerFromExtension,
    deriveBitDepthFromPixelFormat,
    normalizeColorTag,
    detectHdr,
    selectPrimaryVideoStream,
    parseKeyframePacketLine,
    type ChapterInfo,
    inferForcedSubtitleIndexes,
} from './ffprobe';

describe('selectPrimaryVideoStream', () => {
    it('ignores embedded cover art (attached_pic) on a music file', () => {
        // A .flac with embedded album art: ffprobe reports the artwork as an
        // mjpeg "video" stream with disposition.attached_pic=1. It must NOT be
        // treated as real video, or media-probe falsely flags `no_keyframes`.
        const streams = [
            { codec_type: 'audio', codec_name: 'flac' },
            {
                codec_type: 'video',
                codec_name: 'mjpeg',
                disposition: { attached_pic: 1 },
            },
        ];
        expect(selectPrimaryVideoStream(streams)).toBeUndefined();
    });

    it('selects a real video stream and skips a trailing attached-pic thumbnail', () => {
        const streams = [
            {
                codec_type: 'video',
                codec_name: 'h264',
                disposition: { attached_pic: 0 },
            },
            { codec_type: 'audio', codec_name: 'aac' },
            {
                codec_type: 'video',
                codec_name: 'mjpeg',
                disposition: { attached_pic: 1 },
            },
        ];
        expect(selectPrimaryVideoStream(streams)?.codec_name).toBe('h264');
    });

    it('skips a leading attached-pic thumbnail to find the real video', () => {
        const streams = [
            {
                codec_type: 'video',
                codec_name: 'png',
                disposition: { attached_pic: 1 },
            },
            { codec_type: 'video', codec_name: 'hevc' },
        ];
        expect(selectPrimaryVideoStream(streams)?.codec_name).toBe('hevc');
    });

    it('treats a video stream with no disposition as real video', () => {
        const streams = [{ codec_type: 'video', codec_name: 'h264' }];
        expect(selectPrimaryVideoStream(streams)?.codec_name).toBe('h264');
    });
});

describe('parseKeyframePacketLine', () => {
    // ffprobe CSV is "pts_time,dts_time,flags"
    it('uses pts_time for a normal keyframe packet', () => {
        expect(parseKeyframePacketLine('1.500000,1.500000,K__')).toEqual({
            time: 1.5,
            isKeyframe: true,
        });
    });

    it('falls back to dts_time when pts_time is N/A (AVI/mpeg4 keyframe)', () => {
        // Regression: AVI packets report pts_time=N/A but a usable dts_time.
        // Dropping these made DivX/Xvid files look like they had zero keyframes
        // → bogus `no_keyframes` health issue (908 false positives).
        expect(parseKeyframePacketLine('N/A,0.000000,K__')).toEqual({
            time: 0,
            isKeyframe: true,
        });
        expect(parseKeyframePacketLine('N/A,1.560000,K__')).toEqual({
            time: 1.56,
            isKeyframe: true,
        });
    });

    it('marks non-keyframe packets (no K flag) as not keyframes', () => {
        expect(parseKeyframePacketLine('N/A,2.000000,___')).toEqual({
            time: 2,
            isKeyframe: false,
        });
    });

    it('returns null when neither pts nor dts is usable', () => {
        expect(parseKeyframePacketLine('N/A,N/A,K__')).toBeNull();
    });

    it('returns null for a malformed line', () => {
        expect(parseKeyframePacketLine('1.5')).toBeNull();
        expect(parseKeyframePacketLine('')).toBeNull();
    });
});

describe('probeChapters', () => {
    it('exports probeChapters function', () => {
        expect(typeof probeChapters).toBe('function');
    });

    it('should parse ChapterInfo structure correctly', () => {
        const chapter: ChapterInfo = {
            index: 0,
            title: 'Der Einbruch',
            startTimeMs: 60894,
            endTimeMs: 690273,
        };
        expect(chapter.title).toBe('Der Einbruch');
        expect(chapter.startTimeMs).toBeLessThan(chapter.endTimeMs);
    });

    it('returns empty result for non-existent file', async () => {
        const result = await probeChapters('/nonexistent/file.mkv');
        expect(result.chapters).toHaveLength(0);
        expect(result.durationMs).toBe(0);
    });
});

describe('extractMasterDisplay', () => {
    it('formats mastering display metadata from ffprobe side_data', () => {
        const sideData = [
            {
                side_data_type: 'Mastering display metadata',
                red_x: '34000/50000',
                red_y: '16000/50000',
                green_x: '13250/50000',
                green_y: '34500/50000',
                blue_x: '7500/50000',
                blue_y: '3000/50000',
                white_point_x: '15635/50000',
                white_point_y: '16450/50000',
                min_luminance: '50/10000',
                max_luminance: '10000000/10000',
            },
        ];

        const result = extractMasterDisplay(sideData);
        expect(result).toBe(
            'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)',
        );
    });

    it('returns null when no mastering display entry exists', () => {
        const sideData = [
            {
                side_data_type: 'Content light level metadata',
                max_content: 1000,
                max_average: 400,
            },
        ];
        expect(extractMasterDisplay(sideData)).toBeNull();
    });

    it('returns null when side_data_list is undefined', () => {
        expect(extractMasterDisplay(undefined)).toBeNull();
    });

    it('returns null when a required field is missing', () => {
        const sideData = [
            {
                side_data_type: 'Mastering display metadata',
                red_x: '34000/50000',
                red_y: '16000/50000',
                // missing green, blue, white_point, luminance
            },
        ];
        expect(extractMasterDisplay(sideData)).toBeNull();
    });

    it('handles integer luminance values correctly', () => {
        const sideData = [
            {
                side_data_type: 'Mastering display metadata',
                red_x: '34000/50000',
                red_y: '16000/50000',
                green_x: '13250/50000',
                green_y: '34500/50000',
                blue_x: '7500/50000',
                blue_y: '3000/50000',
                white_point_x: '15635/50000',
                white_point_y: '16450/50000',
                min_luminance: '1/10000',
                max_luminance: '40000000/10000',
            },
        ];

        const result = extractMasterDisplay(sideData);
        expect(result).toBe('G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(40000000,1)');
    });
});

describe('extractMaxCll', () => {
    it('formats content light level metadata from ffprobe side_data', () => {
        const sideData = [
            {
                side_data_type: 'Content light level metadata',
                max_content: 1000,
                max_average: 400,
            },
        ];

        expect(extractMaxCll(sideData)).toBe('1000,400');
    });

    it('returns null when no content light level entry exists', () => {
        const sideData = [{ side_data_type: 'Mastering display metadata' }];
        expect(extractMaxCll(sideData)).toBeNull();
    });

    it('returns null when side_data_list is undefined', () => {
        expect(extractMaxCll(undefined)).toBeNull();
    });

    it('accepts string-typed numbers (ffprobe version variance)', () => {
        const sideData = [
            {
                side_data_type: 'Content light level metadata',
                max_content: '1000',
                max_average: '400',
            },
        ];
        expect(extractMaxCll(sideData)).toBe('1000,400');
    });

    it('returns null when values are non-numeric', () => {
        const sideData = [
            {
                side_data_type: 'Content light level metadata',
                max_content: 'abc',
                max_average: 400,
            },
        ];
        expect(extractMaxCll(sideData)).toBeNull();
    });
});

describe('containerFromExtension', () => {
    it('maps .mkv to mkv — NOT matroska or webm', () => {
        // Regression: ffprobe reports format_name="matroska,webm" for MKV files.
        // This function must return 'mkv' so checkCompatibility never matches the
        // 'webm' part against browser caps and incorrectly recommends direct play.
        expect(containerFromExtension('/media/show.mkv')).toBe('mkv');
    });

    it('maps .webm to webm (real WebM, not MKV)', () => {
        expect(containerFromExtension('/media/clip.webm')).toBe('webm');
    });

    it('maps .mp4 to mp4', () => {
        expect(containerFromExtension('/media/movie.mp4')).toBe('mp4');
    });

    it('maps .m4v to mp4 (alias)', () => {
        expect(containerFromExtension('/media/movie.m4v')).toBe('mp4');
    });

    it('maps .mov to mov', () => {
        expect(containerFromExtension('/media/clip.mov')).toBe('mov');
    });

    it('maps .ts to ts', () => {
        expect(containerFromExtension('/media/live.ts')).toBe('ts');
    });

    it('maps .m2ts to ts (alias)', () => {
        expect(containerFromExtension('/media/disc.m2ts')).toBe('ts');
    });

    it('maps .avi to avi', () => {
        expect(containerFromExtension('/media/old.avi')).toBe('avi');
    });

    it('is case-insensitive for extensions', () => {
        expect(containerFromExtension('/media/MOVIE.MKV')).toBe('mkv');
        expect(containerFromExtension('/media/Movie.MP4')).toBe('mp4');
    });

    it('returns null for unknown extensions', () => {
        expect(containerFromExtension('/media/file.xyz')).toBeNull();
        expect(containerFromExtension('/media/file.flac')).toBeNull();
    });

    it('returns null for no extension', () => {
        expect(containerFromExtension('/media/noextension')).toBeNull();
    });

    it('handles paths with dots in directory names', () => {
        expect(containerFromExtension('/media/2024.show/episode.mkv')).toBe('mkv');
    });
});

describe('probeMediaFile', () => {
    it('exports probeMediaFile function', () => {
        expect(typeof probeMediaFile).toBe('function');
    });

    it('returns error result for non-existent file', async () => {
        const result = await probeMediaFile('/nonexistent/file.mkv');
        expect(result.success).toBe(false);
        expect(result.error).toBeTruthy();
        expect(result.video).toBeNull();
        expect(result.audioStreams).toHaveLength(0);
        expect(result.subtitleStreams).toHaveLength(0);
    });
});

describe('probeStreamCounts', () => {
    it('exports probeStreamCounts function', () => {
        expect(typeof probeStreamCounts).toBe('function');
    });

    it('returns null for non-existent file', async () => {
        const result = await probeStreamCounts('/nonexistent/file.mkv');
        // Tight check: ffprobe should fail loudly on a missing file and
        // probeStreamCounts must translate that into null. Returning
        // zero-counts here would be misleading (looks like a valid empty
        // file) — if a refactor ever silently produces that, fail the test.
        expect(result).toBeNull();
    });

    it('respects AbortSignal — aborted call returns null', async () => {
        const controller = new AbortController();
        controller.abort();
        const result = await probeStreamCounts('/nonexistent/file.mkv', 5000, controller.signal);
        expect(result).toBeNull();
    });
});

describe('normalizeColorTag', () => {
    it('returns the tag unchanged for valid values', () => {
        expect(normalizeColorTag('bt2020')).toBe('bt2020');
        expect(normalizeColorTag('smpte2084')).toBe('smpte2084');
        expect(normalizeColorTag('bt709')).toBe('bt709');
    });

    it('returns null for unknown sentinel', () => {
        expect(normalizeColorTag('unknown')).toBeNull();
        expect(normalizeColorTag('UNKNOWN')).toBeNull();
    });

    it('returns null for reserved sentinel', () => {
        expect(normalizeColorTag('reserved')).toBeNull();
    });

    it('returns null for N/A sentinel', () => {
        expect(normalizeColorTag('N/A')).toBeNull();
        expect(normalizeColorTag('n/a')).toBeNull();
    });

    it('returns null for empty string', () => {
        expect(normalizeColorTag('')).toBeNull();
    });

    it('returns null for undefined input', () => {
        expect(normalizeColorTag(undefined)).toBeNull();
    });

    it('trims whitespace before checking', () => {
        expect(normalizeColorTag('  unknown  ')).toBeNull();
        expect(normalizeColorTag('  bt2020  ')).toBe('bt2020');
    });

    it('returns lowercased value for mixed-case input', () => {
        expect(normalizeColorTag('BT2020')).toBe('bt2020');
        expect(normalizeColorTag('YUV420P10LE')).toBe('yuv420p10le');
        expect(normalizeColorTag('SMPTE2084')).toBe('smpte2084');
    });

    it('returns null for unspecified sentinel', () => {
        expect(normalizeColorTag('unspecified')).toBeNull();
        expect(normalizeColorTag('UNSPECIFIED')).toBeNull();
    });

    it('returns null for und sentinel', () => {
        expect(normalizeColorTag('und')).toBeNull();
        expect(normalizeColorTag('UND')).toBeNull();
    });
});

describe('deriveBitDepthFromPixelFormat', () => {
    it('derives 10-bit from planar formats', () => {
        expect(deriveBitDepthFromPixelFormat('yuv420p10le')).toBe(10);
        expect(deriveBitDepthFromPixelFormat('yuv422p10le')).toBe(10);
        expect(deriveBitDepthFromPixelFormat('yuv444p10be')).toBe(10);
        expect(deriveBitDepthFromPixelFormat('gbrp10le')).toBe(10);
    });

    it('derives 10-bit from hardware formats', () => {
        expect(deriveBitDepthFromPixelFormat('p010le')).toBe(10);
        expect(deriveBitDepthFromPixelFormat('p210le')).toBe(10);
    });

    it('derives 12-bit formats', () => {
        expect(deriveBitDepthFromPixelFormat('yuv420p12le')).toBe(12);
        expect(deriveBitDepthFromPixelFormat('p012le')).toBe(12);
    });

    it('returns 8 for 8-bit formats', () => {
        expect(deriveBitDepthFromPixelFormat('yuv420p')).toBe(8);
        expect(deriveBitDepthFromPixelFormat('yuv444p')).toBe(8);
        expect(deriveBitDepthFromPixelFormat('nv12')).toBe(8);
    });

    it('does not misread subsampling digits as depth', () => {
        expect(deriveBitDepthFromPixelFormat('yuv410p')).toBe(8);
        expect(deriveBitDepthFromPixelFormat('yuv411p')).toBe(8);
    });

    it('returns undefined for missing input', () => {
        expect(deriveBitDepthFromPixelFormat(null)).toBeUndefined();
        expect(deriveBitDepthFromPixelFormat(undefined)).toBeUndefined();
        expect(deriveBitDepthFromPixelFormat('')).toBeUndefined();
    });
});

describe('detectHdr — Dolby Vision base-layer classification', () => {
    const dovi = (dvProfile: number, dvBlSignalCompatibilityId: number) => [
        {
            side_data_type: 'DOVI configuration record',
            dv_profile: dvProfile,
            dv_level: 6,
            dv_bl_signal_compatibility_id: dvBlSignalCompatibilityId,
        },
    ];

    // Whether DV can degrade gracefully is decided by the base-layer compatibility
    // id, not the profile number. Our remux never carries DV (ffmpeg's mov muxer
    // writes no dvvC box), so 'dovi_hdr10' means "safe to copy, degrades to the base
    // layer" and 'dovi' means "must be re-encoded".

    it('classifies DV profile 8.1 (HDR10 base) as degradable', () => {
        expect(detectHdr('smpte2084', 'Main 10', dovi(8, 1))).toBe('dovi_hdr10');
    });

    // Regression: keying on `dvProfile === 8` alone sent DV over AV1 into a needless
    // full re-encode, despite it having exactly as usable an HDR10 base layer.
    it('classifies DV profile 10 with an HDR10 base as degradable, not pure DV', () => {
        expect(detectHdr('smpte2084', 'Main', dovi(10, 1))).toBe('dovi_hdr10');
    });

    it('classifies DV profile 5 (no base layer) as pure DV', () => {
        expect(detectHdr(undefined, 'dvhe.05.06', dovi(5, 0))).toBe('dovi');
    });

    it('classifies DV profile 10 with no base layer as pure DV', () => {
        expect(detectHdr('smpte2084', 'Main', dovi(10, 0))).toBe('dovi');
    });

    // 8.2's base layer is SDR. Treating it as an HDR base would stamp an HDR10 tone
    // curve onto SDR content, so it takes the re-encode path instead.
    it('classifies DV 8.2 (SDR base) as pure DV, not as an HDR base layer', () => {
        expect(detectHdr('smpte2084', 'Main 10', dovi(8, 2))).toBe('dovi');
    });

    it('classifies DV 8.4 (HLG base) as degradable', () => {
        expect(detectHdr('arib-std-b67', 'Main 10', dovi(8, 4))).toBe('dovi_hdr10');
    });

    // Profile 8 is cross-compatible by definition, so it stays degradable even when
    // the probe did not record a compatibility id (extractDoviInfo defaults it to 0).
    it('keeps DV profile 8 degradable when the compatibility id is missing', () => {
        expect(
            detectHdr('smpte2084', 'Main 10', [
                { side_data_type: 'DOVI configuration record', dv_profile: 8 },
            ]),
        ).toBe('dovi_hdr10');
    });

    it('still classifies plain HDR10 and HLG correctly', () => {
        expect(detectHdr('smpte2084', 'Main 10')).toBe('hdr10');
        expect(detectHdr('arib-std-b67', 'Main 10')).toBe('hlg');
        expect(detectHdr('bt709', 'Main')).toBe('sdr');
    });
});

describe('inferForcedSubtitleIndexes', () => {
    // The `forced` disposition flag is authoritative but often unset. Real case:
    // The Handmaiden ships two PGS German tracks, neither flagged forced and
    // neither titled — index 3 is the signs track (36 cues over 2h47m), index 4
    // the full one (2336). Indistinguishable in a picker, so burning in index 3
    // looked exactly like "subtitles are broken".
    function track(
        index: number,
        cues: number | undefined,
        language = 'ger',
        extra: Record<string, unknown> = {},
    ): Parameters<typeof inferForcedSubtitleIndexes>[0][number] {
        return {
            index,
            codec_name: 'hdmv_pgs_subtitle',
            codec_type: 'subtitle',
            tags: cues === undefined ? { language } : { language, NUMBER_OF_FRAMES: String(cues) },
            ...extra,
        };
    }

    it('flags the signs track from real container statistics tags', () => {
        const inferred = inferForcedSubtitleIndexes([track(3, 36), track(4, 2336)]);

        expect(inferred.has(3)).toBe(true);
        expect(inferred.has(4)).toBe(false);
    });

    it('reads language-suffixed NUMBER_OF_FRAMES tags', () => {
        const inferred = inferForcedSubtitleIndexes([
            { index: 3, tags: { language: 'eng', 'NUMBER_OF_FRAMES-eng': '40' } },
            { index: 4, tags: { language: 'eng', 'NUMBER_OF_FRAMES-eng': '1900' } },
        ]);

        expect(inferred.has(3)).toBe(true);
    });

    it('never infers from a lone track — nothing to compare against', () => {
        expect(inferForcedSubtitleIndexes([track(3, 36)]).size).toBe(0);
    });

    it('does not confuse a full track with an SDH sibling', () => {
        // SDH carries somewhat more cues, nowhere near the 5x a signs track shows.
        expect(inferForcedSubtitleIndexes([track(3, 1800), track(4, 2336)]).size).toBe(0);
    });

    it('compares only within the same language', () => {
        // A small German track next to a large English one proves nothing.
        const inferred = inferForcedSubtitleIndexes([track(3, 40, 'ger'), track(4, 2336, 'eng')]);

        expect(inferred.size).toBe(0);
    });

    it('ignores tracks with no statistics tags (non-mkvmerge containers)', () => {
        expect(inferForcedSubtitleIndexes([track(3, undefined), track(4, undefined)]).size).toBe(0);
    });

    it('flags only ONE track per language when several are sparse', () => {
        // isForced also drives DEFAULT=YES on the HLS rendition, and two DEFAULT=YES
        // members in one group is invalid. Anime "Signs" + "Signs & Songs" is the
        // common shape.
        const inferred = inferForcedSubtitleIndexes([track(3, 30), track(4, 40), track(5, 2000)]);

        expect([...inferred]).toEqual([3]);
    });

    it('infers nothing when two tracks tie for smallest (ambiguous)', () => {
        expect(inferForcedSubtitleIndexes([track(3, 40), track(4, 40), track(5, 2000)]).size).toBe(
            0,
        );
    });

    it('ignores untagged tracks rather than bucketing them together', () => {
        // Two unrelated untagged subtitle sets are not siblings.
        const inferred = inferForcedSubtitleIndexes([
            { index: 3, tags: { NUMBER_OF_FRAMES: '36' } },
            { index: 4, tags: { NUMBER_OF_FRAMES: '2336' } },
        ]);

        expect(inferred.size).toBe(0);
    });

    it('rejects locale-formatted counts instead of silently truncating them', () => {
        // Number.parseInt('1,234') yields 1, which would look like a signs track.
        const inferred = inferForcedSubtitleIndexes([
            { index: 3, tags: { language: 'ger', NUMBER_OF_FRAMES: '1,234' } },
            { index: 4, tags: { language: 'ger', NUMBER_OF_FRAMES: '2336' } },
        ]);

        expect(inferred.size).toBe(0);
    });

    it('does not flag a large track even when dwarfed by a huge sibling', () => {
        // Ratio holds (300 * 5 <= 3000) but 300 exceeds the absolute cue ceiling,
        // so it is a real subtitle track, not signs.
        expect(inferForcedSubtitleIndexes([track(3, 300), track(4, 3000)]).size).toBe(0);
    });
});
