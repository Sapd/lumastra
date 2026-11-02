// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { haveFfmpeg } from '../../../../../tests/helpers/have-ffmpeg.js';
import { FullTranscodeStrategy } from '../transcoding/full-transcode-strategy.js';
import type { FullStrategyConfig } from '../transcoding/transcode-strategy.js';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
describe.skipIf(!haveFfmpeg())('negotiated subtitle output (real FFmpeg)', () => {
    let directory: string;
    let source: string;
    beforeAll(() => {
        directory = mkdtempSync(join(tmpdir(), "negotiated 'subtitles',-"));
        source = join(directory, 'source.mkv');
        const subtitle = join(directory, 'source.srt');
        writeFileSync(subtitle, '1\n00:00:00,000 --> 00:00:02,000\nVISIBLE SUBTITLES\n');
        execFileSync(
            ffmpeg,
            [
                '-v',
                'error',
                '-f',
                'lavfi',
                '-i',
                'color=black:size=320x180:rate=25:duration=2',
                '-i',
                subtitle,
                '-map',
                '0:v',
                '-map',
                '1:s',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-c:s',
                'srt',
                '-t',
                '2',
                source,
            ],
            { timeout: 30_000, stdio: 'pipe' },
        );
    });
    afterAll(() => {
        if (directory) rmSync(directory, { recursive: true, force: true });
    });
    it.each([false, true])(
        'burnIn=%s changes the encoded picture, remux keeps it untouched',
        (burnIn) => {
            const outputDir = join(directory, burnIn ? 'burn' : 'remux');
            mkdirSync(outputDir);
            const config: FullStrategyConfig = {
                outputDir,
                localFilePath: source,
                segmentDuration: 1,
                audioTracks: [],
                videoInfo: { codec: 'h264', width: 320, height: 180, frameRate: 25 },
                hlsOutput: { hlsAudioMode: 'muxed', hlsContainer: 'fmp4', hlsPlaylistType: 'vod' },
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: burnIn ? 'transcode' : 'copy',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                    targetCodec: { video: 'h264', audio: 'aac' },
                },
                gpuAcceleration: 'none',
                encodingPreset: 'ultrafast',
                nvencPreset: 'p4',
                h264Crf: 23,
                h265Crf: 28,
                videoBitrateMbps: 0,
                maxWidth: 0,
                maxHeight: 0,
                tonemappingAlgorithm: 'hable',
                deinterlaceMethod: 'none',
                audioCodec: 'aac',
                audioBitrateStereo: '128k',
                audioBitrateSurround: '256k',
                audioVbr: false,
                audioBoost: 1,
                subtitleBurnIn: burnIn
                    ? {
                          absoluteIndex: 1,
                          codec: 'subrip',
                          text: { filePath: source, relativeIndex: 0 },
                      }
                    : undefined,
            };
            const { args } = new FullTranscodeStrategy().buildArgs(config);
            execFileSync(ffmpeg, ['-v', 'error', ...args], { timeout: 30_000, stdio: 'pipe' });
            const playlist = join(outputDir, 'index.m3u8');
            const codec = execFileSync(
                ffprobe,
                [
                    '-v',
                    'error',
                    '-select_streams',
                    'v:0',
                    '-show_entries',
                    'stream=codec_name',
                    '-of',
                    'csv=p=0',
                    playlist,
                ],
                { encoding: 'utf8' },
            ).trim();
            expect(codec.split(/\s+/).every((value) => value === 'h264')).toBe(true);
            const frame = execFileSync(ffmpeg, [
                '-v',
                'error',
                '-i',
                playlist,
                '-ss',
                '0.5',
                '-frames:v',
                '1',
                '-pix_fmt',
                'gray',
                '-f',
                'rawvideo',
                'pipe:1',
            ]);
            expect(frame.length).toBe(320 * 180);
            const brightPixels = frame.filter((value) => value > 200).length;
            expect(brightPixels > 5).toBe(burnIn);
        },
    );
});
