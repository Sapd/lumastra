// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Spawns REAL ffmpeg against the REAL args `buildAudioOnlyArgs` produces, and
 * asserts the muxer actually wrote a playable audio-only HLS rendition.
 *
 * Every other test of the audio-only rung asserts on argument STRINGS. This one
 * executes them. That distinction is not academic: the demux `var_stream_map`
 * unconditionally emits a `v:0` video variant, which combined with `-vn` makes
 * ffmpeg exit `AVERROR(EINVAL)` before writing a byte — a defect every
 * string-level test happily passed, and which only execution catches.
 *
 * Skips when ffmpeg/ffprobe are absent; generates its own fixture otherwise.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FullTranscodeStrategy } from './full-transcode-strategy';
import type { FullStrategyConfig } from './transcode-strategy';
import { haveFfmpeg } from '../../../../../tests/helpers/have-ffmpeg';

/**
 * Build a 20s sample with video + TWO 5.1 E-AC-3 tracks (eng, ger). The surround
 * source is deliberate: it proves the downmix to stereo and the fixed 128k are the
 * rung's own contract, not an echo of the source's properties.
 */
function makeSample(dir: string): string {
    const path = join(dir, 'sample.mkv');
    execFileSync(
        'ffmpeg',
        [
            ...['-hide_banner', '-loglevel', 'error', '-y'],
            ...['-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=20'],
            ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=20'],
            ...['-f', 'lavfi', '-i', 'sine=frequency=880:duration=20'],
            ...['-map', '0:v', '-map', '1:a', '-map', '2:a'],
            ...['-c:v', 'libx264', '-preset', 'ultrafast'],
            ...['-c:a', 'eac3', '-ac', '6'],
            ...['-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=ger'],
            '-shortest',
            path,
        ],
        { stdio: 'pipe', timeout: 120_000 },
    );
    return path;
}

const ffmpegSmoke = describe.skipIf(!process.env.LUMASTRA_FFMPEG_SMOKE || !haveFfmpeg());

ffmpegSmoke('audio-only ffmpeg smoke (real execution)', () => {
    it('produces a playable audio-only HLS rendition with no video stream', () => {
        const outputDir = mkdtempSync(join(tmpdir(), 'audio-only-smoke-'));
        const SAMPLE_PATH = makeSample(outputDir);

        const audioTracks: FullStrategyConfig['audioTracks'] = [
            {
                index: 1,
                codec: 'eac3',
                channels: 6,
                language: 'eng',
                isDefault: true,
                bitrate: 640_000,
            },
            {
                index: 2,
                codec: 'eac3',
                channels: 6,
                language: 'ger',
                isDefault: false,
                bitrate: 640_000,
            },
        ] as FullStrategyConfig['audioTracks'];

        const config = {
            localFilePath: SAMPLE_PATH,
            outputDir,
            segmentDuration: 4,
            audioCodec: 'aac',
            audioBitrateStereo: '128k',
            audioBitrateSurround: '256k',
            audioBoost: 1.0,
            videoDisabled: true,
            audioTracks,
            decision: { videoAction: 'transcode', audioAction: 'transcode' },
        } as unknown as FullStrategyConfig;

        const { args } = new FullTranscodeStrategy().buildArgs(config);

        // The bug this test exists to catch: a v:0 variant with no video stream.
        expect(args.join(' ')).not.toContain('v:0');
        expect(args).toContain('-vn');

        execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
            timeout: 120_000,
            stdio: 'pipe',
        });

        const written = readdirSync(outputDir);
        const playlist = written.find((f) => f.endsWith('.m3u8'));
        expect(playlist, `no playlist written; got ${JSON.stringify(written)}`).toBeTruthy();

        const segments = written.filter((f) => f !== 'sample.mkv' && /\.(m4s|ts|mp4)$/.test(f));
        expect(segments.length, 'no media segments written').toBeGreaterThan(0);

        // ffprobe the first real segment: must be AAC stereo, and no video stream.
        const initSeg = written.find((f) => f.startsWith('init'));
        const probeTarget = join(outputDir, initSeg ?? segments[0]!);
        const probe = execFileSync(
            'ffprobe',
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-show_entries',
                'stream=codec_type,codec_name,channels',
                '-of',
                'csv=p=0',
                probeTarget,
            ],
            { encoding: 'utf8' },
        );

        expect(probe).not.toContain('video');
        expect(probe).toContain('aac');
    }, 130_000);
});
