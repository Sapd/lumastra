// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for FFmpeg Subtitle Extractor
 *
 * Tests subtitle extraction and conversion with real FFmpeg and real media files.
 *
 * Run with: npm run test:integration
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
    extractSubtitleStream,
    batchExtractSubtitles,
    extractSubtitleStreamsBinary,
} from './ffmpeg-subtitle-extractor';
import { spawnFFmpegSafely } from './ffmpeg-spawn';
import { isTextBasedSubtitle } from '../utils/hls-audio-injection';
import * as fs from 'fs/promises';
import * as path from 'path';

// Test file paths
const TEST_DIR = path.join(process.cwd(), 'test-tmp-subtitles');
const TEST_VIDEO_SRT = path.join(TEST_DIR, 'video-with-srt.mkv');
const TEST_VIDEO_ASS = path.join(TEST_DIR, 'video-with-ass.mkv');
const TEST_VIDEO_WEBVTT = path.join(TEST_DIR, 'video-with-webvtt.mkv');
const TEST_SRT_FILE = path.join(TEST_DIR, 'test.srt');
const TEST_ASS_FILE = path.join(TEST_DIR, 'test.ass');
const TEST_WEBVTT_FILE = path.join(TEST_DIR, 'test.vtt');

describe('FFmpeg Subtitle Extractor - Integration Tests', () => {
    beforeAll(async () => {
        // Create test directory
        await fs.mkdir(TEST_DIR, { recursive: true });

        // Create test SRT file
        const srtContent = `1
00:00:00,000 --> 00:00:02,000
First subtitle line in SRT
Second line of text

2
00:00:02,500 --> 00:00:05,000
Another subtitle here
Third line

3
00:00:05,500 --> 00:00:08,000
Final subtitle
`;
        await fs.writeFile(TEST_SRT_FILE, srtContent, 'utf8');

        // Create test ASS file
        const assContent = `[Script Info]
Title: Test Subtitles

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,First subtitle in ASS
Dialogue: 0,0:00:02.50,0:00:05.00,Default,,0,0,0,,Second ASS subtitle
`;
        await fs.writeFile(TEST_ASS_FILE, assContent, 'utf8');

        // Create test WebVTT file
        const webvttContent = `WEBVTT

00:00.000 --> 00:02.000
First WebVTT subtitle

00:02.500 --> 00:05.000
Second WebVTT subtitle
`;
        await fs.writeFile(TEST_WEBVTT_FILE, webvttContent, 'utf8');

        // Generate test video with SRT subtitles
        await spawnFFmpegSafely({
            args: [
                '-f',
                'lavfi',
                '-i',
                'color=c=blue:s=320x240:d=8',
                '-f',
                'lavfi',
                '-i',
                'anullsrc=r=44100:cl=stereo',
                '-i',
                TEST_SRT_FILE,
                '-map',
                '0:v',
                '-map',
                '1:a',
                '-map',
                '2:s',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-c:a',
                'aac',
                '-c:s',
                'srt',
                '-t',
                '8',
                TEST_VIDEO_SRT,
            ],
            timeout: 15000,
            context: { operation: 'test-setup-srt' },
        });

        // Generate test video with ASS subtitles
        await spawnFFmpegSafely({
            args: [
                '-f',
                'lavfi',
                '-i',
                'color=c=green:s=320x240:d=5',
                '-f',
                'lavfi',
                '-i',
                'anullsrc=r=44100:cl=stereo',
                '-i',
                TEST_ASS_FILE,
                '-map',
                '0:v',
                '-map',
                '1:a',
                '-map',
                '2:s',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-c:a',
                'aac',
                '-c:s',
                'ass',
                '-t',
                '5',
                TEST_VIDEO_ASS,
            ],
            timeout: 15000,
            context: { operation: 'test-setup-ass' },
        });

        // Generate test video with WebVTT subtitles
        await spawnFFmpegSafely({
            args: [
                '-f',
                'lavfi',
                '-i',
                'color=c=red:s=320x240:d=5',
                '-f',
                'lavfi',
                '-i',
                'anullsrc=r=44100:cl=stereo',
                '-i',
                TEST_WEBVTT_FILE,
                '-map',
                '0:v',
                '-map',
                '1:a',
                '-map',
                '2:s',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-c:a',
                'aac',
                '-c:s',
                'webvtt',
                '-t',
                '5',
                TEST_VIDEO_WEBVTT,
            ],
            timeout: 15000,
            context: { operation: 'test-setup-webvtt' },
        });
    });

    afterAll(async () => {
        // Cleanup test directory
        try {
            await fs.rm(TEST_DIR, { recursive: true, force: true });
        } catch (error) {
            console.warn('Failed to cleanup test directory:', error);
        }
    });

    describe('SRT to WebVTT Conversion', () => {
        it('should extract SRT subtitles and convert to WebVTT', async () => {
            const webvtt = await extractSubtitleStream({
                filePath: TEST_VIDEO_SRT,
                streamIndex: 2, // Subtitle stream
                codec: 'subrip',
                outputFormat: 'webvtt',
            });

            // Verify WebVTT format
            expect(webvtt).toContain('WEBVTT');
            expect(webvtt).toContain('First subtitle line in SRT');
            expect(webvtt).toContain('Another subtitle here');
            expect(webvtt).toContain('Final subtitle');

            // Verify WebVTT timestamp format (should be 00:00.000 not 00:00:00,000)
            expect(webvtt).toMatch(/\d{2}:\d{2}\.\d{3}/);
            expect(webvtt).not.toMatch(/\d{2}:\d{2}:\d{2},\d{3}/); // SRT format should be converted
        });

        it('should handle multi-line SRT subtitles correctly', async () => {
            const webvtt = await extractSubtitleStream({
                filePath: TEST_VIDEO_SRT,
                streamIndex: 2,
                codec: 'subrip',
                outputFormat: 'webvtt',
            });

            // First subtitle has two lines
            expect(webvtt).toContain('First subtitle line in SRT');
            expect(webvtt).toContain('Second line of text');

            // Second subtitle has two lines
            expect(webvtt).toContain('Another subtitle here');
            expect(webvtt).toContain('Third line');
        });

        it('should preserve subtitle timing during SRT to WebVTT conversion', async () => {
            const webvtt = await extractSubtitleStream({
                filePath: TEST_VIDEO_SRT,
                streamIndex: 2,
                codec: 'subrip',
                outputFormat: 'webvtt',
            });

            // Check that timing cues are present and reasonable
            // WebVTT uses format: 00:00.000 --> 00:02.000
            const timingRegex = /(\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}\.\d{3})/g;
            const timings = webvtt.match(timingRegex);

            expect(timings).toBeTruthy();
            expect(timings!.length).toBeGreaterThanOrEqual(3); // At least 3 subtitle cues
        });
    });

    describe('ASS to WebVTT Conversion', () => {
        it('should extract ASS subtitles and convert to WebVTT', async () => {
            const webvtt = await extractSubtitleStream({
                filePath: TEST_VIDEO_ASS,
                streamIndex: 2,
                codec: 'ass',
                outputFormat: 'webvtt',
            });

            expect(webvtt).toContain('WEBVTT');
            expect(webvtt).toContain('First subtitle in ASS');
            expect(webvtt).toContain('Second ASS subtitle');
        });
    });

    describe('WebVTT Copy (No Conversion)', () => {
        it('should copy WebVTT subtitles without conversion', async () => {
            const webvtt = await extractSubtitleStream({
                filePath: TEST_VIDEO_WEBVTT,
                streamIndex: 2,
                codec: 'webvtt',
                outputFormat: 'webvtt',
            });

            expect(webvtt).toContain('WEBVTT');
            expect(webvtt).toContain('First WebVTT subtitle');
            expect(webvtt).toContain('Second WebVTT subtitle');
        });
    });

    describe('Output Format Variations', () => {
        it('should extract SRT to SRT format (copy)', async () => {
            const srt = await extractSubtitleStream({
                filePath: TEST_VIDEO_SRT,
                streamIndex: 2,
                codec: 'subrip',
                outputFormat: 'srt',
            });

            // SRT format uses commas and HH:MM:SS,mmm
            expect(srt).toMatch(/\d{2}:\d{2}:\d{2},\d{3}/);
            expect(srt).toContain('First subtitle line in SRT');
        });

        it('should extract SRT to ASS format', async () => {
            const ass = await extractSubtitleStream({
                filePath: TEST_VIDEO_SRT,
                streamIndex: 2,
                codec: 'subrip',
                outputFormat: 'ass',
            });

            expect(ass).toContain('[Script Info]');
            expect(ass).toContain('[Events]');
            expect(ass).toContain('Dialogue:');
        });

        it('should extract ASS to ASS format (copy)', async () => {
            const ass = await extractSubtitleStream({
                filePath: TEST_VIDEO_ASS,
                streamIndex: 2,
                codec: 'ass',
                outputFormat: 'ass',
            });

            expect(ass).toContain('[Script Info]');
            expect(ass).toContain('First subtitle in ASS');
        });
    });

    describe('Batch Extraction with Conversion', () => {
        it('should batch extract multiple subtitle streams with SRT to WebVTT conversion', async () => {
            const output1 = path.join(TEST_DIR, 'batch-output-1.vtt');
            const output2 = path.join(TEST_DIR, 'batch-output-2.vtt');

            // Create a video with two SRT subtitle streams
            const twoSubsVideo = path.join(TEST_DIR, 'video-two-subs.mkv');
            await spawnFFmpegSafely({
                args: [
                    '-f',
                    'lavfi',
                    '-i',
                    'color=c=yellow:s=320x240:d=5',
                    '-f',
                    'lavfi',
                    '-i',
                    'anullsrc',
                    '-i',
                    TEST_SRT_FILE,
                    '-i',
                    TEST_SRT_FILE,
                    '-map',
                    '0:v',
                    '-map',
                    '1:a',
                    '-map',
                    '2:s',
                    '-map',
                    '3:s',
                    '-c:v',
                    'libx264',
                    '-preset',
                    'ultrafast',
                    '-c:a',
                    'aac',
                    '-c:s',
                    'srt',
                    '-t',
                    '5',
                    twoSubsVideo,
                ],
                timeout: 15000,
            });

            await batchExtractSubtitles({
                filePath: twoSubsVideo,
                streams: [
                    {
                        streamIndex: 2,
                        codec: 'subrip',
                        outputPath: output1,
                    },
                    {
                        streamIndex: 3,
                        codec: 'subrip',
                        outputPath: output2,
                    },
                ],
            });

            // Verify both outputs
            const content1 = await fs.readFile(output1, 'utf8');
            const content2 = await fs.readFile(output2, 'utf8');

            expect(content1).toContain('WEBVTT');
            expect(content1).toContain('First subtitle line in SRT');

            expect(content2).toContain('WEBVTT');
            expect(content2).toContain('First subtitle line in SRT');
        });
    });

    describe('Error Handling', () => {
        it('should handle non-existent subtitle stream', async () => {
            await expect(
                extractSubtitleStream({
                    filePath: TEST_VIDEO_SRT,
                    streamIndex: 999, // Non-existent stream
                    codec: 'subrip',
                    outputFormat: 'webvtt',
                }),
            ).rejects.toThrow();
        });

        it('should handle invalid file path', async () => {
            await expect(
                extractSubtitleStream({
                    filePath: '/nonexistent/video.mkv',
                    streamIndex: 0,
                    codec: 'subrip',
                    outputFormat: 'webvtt',
                }),
            ).rejects.toThrow();
        });
    });

    describe('Edge Cases', () => {
        it('should handle subtitles with special characters', async () => {
            const specialSrt = path.join(TEST_DIR, 'special.srt');
            const specialSrtContent = `1
00:00:00,000 --> 00:00:02,000
Special chars: äöü ñ € « »

2
00:00:02,500 --> 00:00:05,000
Emoji: 🎬 📺 🎥
`;
            await fs.writeFile(specialSrt, specialSrtContent, 'utf8');

            const specialVideo = path.join(TEST_DIR, 'video-special.mkv');
            await spawnFFmpegSafely({
                args: [
                    '-f',
                    'lavfi',
                    '-i',
                    'color=c=purple:s=320x240:d=5',
                    '-f',
                    'lavfi',
                    '-i',
                    'anullsrc',
                    '-i',
                    specialSrt,
                    '-map',
                    '0:v',
                    '-map',
                    '1:a',
                    '-map',
                    '2:s',
                    '-c:v',
                    'libx264',
                    '-preset',
                    'ultrafast',
                    '-c:a',
                    'aac',
                    '-c:s',
                    'srt',
                    '-t',
                    '5',
                    specialVideo,
                ],
                timeout: 15000,
            });

            const webvtt = await extractSubtitleStream({
                filePath: specialVideo,
                streamIndex: 2,
                codec: 'subrip',
                outputFormat: 'webvtt',
            });

            expect(webvtt).toContain('WEBVTT');
            expect(webvtt).toContain('äöü');
            expect(webvtt).toContain('€');
            expect(webvtt).toContain('🎬');
        });

        it('should handle subtitles with long duration', async () => {
            const longSrt = path.join(TEST_DIR, 'long.srt');
            const longSrtContent = `1
00:00:00,000 --> 00:00:30,000
Very long duration subtitle

2
00:00:35,000 --> 00:01:00,000
Another long one
`;
            await fs.writeFile(longSrt, longSrtContent, 'utf8');

            const longVideo = path.join(TEST_DIR, 'video-long-subs.mkv');
            await spawnFFmpegSafely({
                args: [
                    '-f',
                    'lavfi',
                    '-i',
                    'color=c=black:s=320x240:d=5',
                    '-f',
                    'lavfi',
                    '-i',
                    'anullsrc',
                    '-i',
                    longSrt,
                    '-map',
                    '0:v',
                    '-map',
                    '1:a',
                    '-map',
                    '2:s',
                    '-c:v',
                    'libx264',
                    '-preset',
                    'ultrafast',
                    '-c:a',
                    'aac',
                    '-c:s',
                    'srt',
                    '-t',
                    '5',
                    longVideo,
                ],
                timeout: 10000,
            });

            const webvtt = await extractSubtitleStream({
                filePath: longVideo,
                streamIndex: 2,
                codec: 'subrip',
                outputFormat: 'webvtt',
            });

            expect(webvtt).toContain('WEBVTT');
            expect(webvtt).toContain('Very long duration subtitle');
            // WebVTT should handle long durations (30 seconds+)
            expect(webvtt).toMatch(/00:30\.\d{3}/);
        });
    });

    describe('Subtitle Codec Detection (Allowlist)', () => {
        it('should accept text-based subtitle formats', () => {
            // Primary formats
            expect(isTextBasedSubtitle('srt')).toBe(true);
            expect(isTextBasedSubtitle('subrip')).toBe(true);
            expect(isTextBasedSubtitle('ass')).toBe(true);
            expect(isTextBasedSubtitle('ssa')).toBe(true);
            expect(isTextBasedSubtitle('webvtt')).toBe(true);
            expect(isTextBasedSubtitle('vtt')).toBe(true);

            // Additional text formats
            expect(isTextBasedSubtitle('sami')).toBe(true);
            expect(isTextBasedSubtitle('microdvd')).toBe(true);
            expect(isTextBasedSubtitle('jacosub')).toBe(true);
            expect(isTextBasedSubtitle('mpl2')).toBe(true);
            expect(isTextBasedSubtitle('pjs')).toBe(true);
            expect(isTextBasedSubtitle('realtext')).toBe(true);
            expect(isTextBasedSubtitle('subviewer')).toBe(true);
            expect(isTextBasedSubtitle('vplayer')).toBe(true);
            expect(isTextBasedSubtitle('mov_text')).toBe(true);
        });

        it('should reject image-based subtitle formats', () => {
            // Blu-ray PGS
            expect(isTextBasedSubtitle('pgssub')).toBe(false);
            expect(isTextBasedSubtitle('hdmv_pgs_subtitle')).toBe(false);
            expect(isTextBasedSubtitle('pgs')).toBe(false);

            // DVD VobSub
            expect(isTextBasedSubtitle('dvdsub')).toBe(false);
            expect(isTextBasedSubtitle('dvd_subtitle')).toBe(false);
            expect(isTextBasedSubtitle('vobsub')).toBe(false);

            // DVB
            expect(isTextBasedSubtitle('dvbsub')).toBe(false);
            expect(isTextBasedSubtitle('dvb_subtitle')).toBe(false);

            // Other image formats
            expect(isTextBasedSubtitle('xsub')).toBe(false);
            expect(isTextBasedSubtitle('hdmv_text_subtitle')).toBe(false);
        });

        it('should reject unknown/empty codecs for safety', () => {
            expect(isTextBasedSubtitle(undefined)).toBe(false);
            expect(isTextBasedSubtitle('')).toBe(false);
            expect(isTextBasedSubtitle('unknown')).toBe(false);
            expect(isTextBasedSubtitle('random_codec_name')).toBe(false);
        });

        it('should be case-insensitive', () => {
            expect(isTextBasedSubtitle('SRT')).toBe(true);
            expect(isTextBasedSubtitle('SubRip')).toBe(true);
            expect(isTextBasedSubtitle('WEBVTT')).toBe(true);
            expect(isTextBasedSubtitle('PGS')).toBe(false);
            expect(isTextBasedSubtitle('HDMV_PGS_SUBTITLE')).toBe(false);
        });
    });
});

function segment(type: number, ptsMs: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(13);
    header.write('PG', 0, 'ascii');
    header.writeUInt32BE(Math.round((ptsMs / 1000) * 90_000), 2);
    header.writeUInt32BE(0, 6);
    header[10] = type;
    header.writeUInt16BE(payload.length, 11);
    return Buffer.concat([header, payload]);
}

function pcsOn(x: number, y: number): Buffer {
    const p = Buffer.alloc(19);
    p.writeUInt16BE(1920, 0);
    p.writeUInt16BE(1080, 2);
    p[10] = 1;
    p.writeUInt16BE(0, 11);
    p.writeUInt16BE(x, 15);
    p.writeUInt16BE(y, 17);
    return p;
}

function pcsOff(): Buffer {
    const p = Buffer.alloc(11);
    p.writeUInt16BE(1920, 0);
    p.writeUInt16BE(1080, 2);
    p[10] = 0;
    return p;
}

/** Opaque white at index 1. */
function pds(): Buffer {
    return Buffer.from([0, 0, 1, 235, 128, 128, 255]);
}

function ods(width: number, height: number): Buffer {
    const rle = Buffer.from([0x00, 0x80 | width, 1, 0x00, 0x00]);
    const head = Buffer.alloc(11);
    head.writeUInt16BE(0, 0);
    head[3] = 0x80 | 0x40;
    head.writeUIntBE(rle.length + 4, 4, 3);
    head.writeUInt16BE(width, 7);
    head.writeUInt16BE(height, 9);
    return Buffer.concat([head, rle]);
}

function track(palette: Buffer = pds()): Buffer {
    return Buffer.concat([
        segment(0x16, 1000, pcsOn(100, 900)),
        segment(0x14, 1000, palette),
        segment(0x15, 1000, ods(4, 2)),
        segment(0x80, 1000, Buffer.alloc(0)),
        segment(0x16, 3000, pcsOff()),
        segment(0x80, 3000, Buffer.alloc(0)),
        segment(0x16, 5000, pcsOn(200, 800)),
        segment(0x14, 5000, palette),
        segment(0x15, 5000, ods(6, 2)),
        segment(0x80, 5000, Buffer.alloc(0)),
        segment(0x16, 7000, pcsOff()),
        segment(0x80, 7000, Buffer.alloc(0)),
    ]);
}

it('copies multiple PGS tracks through bounded binary pipes without changing cues', async () => {
    const dir = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'pgs-pipe-'));
    try {
        const sup = path.join(dir, 'input.sup');
        const mkv = path.join(dir, 'input.mkv');
        await fs.writeFile(sup, track());
        await spawnFFmpegSafely({
            args: ['-i', sup, '-map', '0:0', '-map', '0:0', '-c:s', 'copy', mkv],
            timeout: 10000,
        });
        const results = await extractSubtitleStreamsBinary(mkv, [0, 1], 'sup');
        const { parsePgs } = await import('./pgs-parser.js');
        for (const bytes of results.values()) {
            expect(bytes).not.toBeNull();
            const parsed = parsePgs(bytes!);
            expect(parsed.cues).toHaveLength(2);
            expect(parsed.cues[0].rects[0]).toMatchObject({ x: 100, y: 900, width: 4, height: 2 });
        }
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});

/** Minimal valid Matroska VobSub input, independent of the output muxer. */
function vobsubTrack(): Buffer {
    const element = (id: string, data: Buffer): Buffer => {
        const length =
            data.length < 127
                ? Buffer.from([0x80 | data.length])
                : Buffer.from([0x40 | (data.length >> 8), data.length & 255]);
        return Buffer.concat([Buffer.from(id, 'hex'), length, data]);
    };
    const uint = (value: number): Buffer => {
        const bytes = Buffer.alloc(4);
        bytes.writeUInt32BE(value);
        return bytes;
    };
    const privateData = Buffer.from(
        'size: 1920x1080\npalette: 000000, ffffff, ' + Array(14).fill('000000').join(', ') + '\n',
    );
    const spu = Buffer.from(
        '0024000611110000001e03321004fff005064067384385060004000501ff0078001e02ff',
        'hex',
    );
    const blocks = [1000, 5000].map((pts) => {
        const head = Buffer.alloc(4);
        head[0] = 0x81;
        head.writeInt16BE(pts, 1);
        return element(
            'a0',
            Buffer.concat([element('a1', Buffer.concat([head, spu])), element('9b', uint(2000))]),
        );
    });
    return Buffer.concat([
        element(
            '1a45dfa3',
            Buffer.concat([
                element('4286', uint(1)),
                element('42f7', uint(1)),
                element('42f2', uint(4)),
                element('42f3', uint(8)),
                element('4282', Buffer.from('matroska')),
                element('4287', uint(4)),
                element('4285', uint(2)),
            ]),
        ),
        element(
            '18538067',
            Buffer.concat([
                element('1549a966', element('2ad7b1', uint(1_000_000))),
                element(
                    '1654ae6b',
                    element(
                        'ae',
                        Buffer.concat([
                            element('d7', uint(1)),
                            element('73c5', uint(1)),
                            element('83', uint(17)),
                            element('86', Buffer.from('S_VOBSUB')),
                            element('63a2', privateData),
                        ]),
                    ),
                ),
                element('1f43b675', Buffer.concat([element('e7', uint(0)), ...blocks])),
            ]),
        ),
    ]);
}

it('preserves VobSub packets, palette, geometry and timing through Matroska pipes', async () => {
    const dir = await fs.mkdtemp(path.join((await import('node:os')).tmpdir(), 'vobsub-pipe-'));
    try {
        const input = path.join(dir, 'input.mkv');
        await fs.writeFile(input, vobsubTrack());
        const baseline = path.join(dir, 'baseline.mkv');
        await spawnFFmpegSafely({ args: ['-i', input, '-map', '0:0', '-c:s', 'copy', baseline] });
        const results = await extractSubtitleStreamsBinary(input, [0], 'sub');
        const { readMkvSubtitleTrack } = await import('./mkv-subtitle-reader.js');
        const { parseVobSub } = await import('./vobsub-parser.js');
        const data = results.get(0);
        expect(data).not.toBeNull();
        const track = readMkvSubtitleTrack(data!);
        expect(track.packets).toHaveLength(2);
        const parsed = parseVobSub(track.packets, track.codecPrivate);
        const control = readMkvSubtitleTrack(await fs.readFile(baseline));
        expect(parsed).toEqual(parseVobSub(control.packets, control.codecPrivate));
        // This fixture's container starts at zero; its first cue intentionally has a gap.
        expect(parsed.cues.map(({ startMs, endMs }) => ({ startMs, endMs }))).toEqual([
            { startMs: 1000, endMs: 3000 },
            { startMs: 5000, endMs: 7000 },
        ]);
        expect(parsed.cues[0].rects[0]).toMatchObject({ x: 100, y: 900, width: 4, height: 2 });
    } finally {
        await fs.rm(dir, { recursive: true, force: true });
    }
});
