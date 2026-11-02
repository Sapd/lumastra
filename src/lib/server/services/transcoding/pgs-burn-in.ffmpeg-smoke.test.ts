// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { haveFfmpeg } from '../../../../../tests/helpers/have-ffmpeg';
import { FullTranscodeStrategy } from './full-transcode-strategy';
import type { FullStrategyConfig } from './transcode-strategy';

/** Minimal Blu-ray SUP display set: a white 32×8 bitmap, visible at (100,140). */
function pgsFixture(): Buffer {
    const packet = (type: number, payload: number[], pts = 9000): Buffer => {
        const header = Buffer.alloc(13);
        header.write('PG');
        header.writeUInt32BE(pts, 2);
        header[10] = type;
        header.writeUInt16BE(payload.length, 11);
        return Buffer.concat([header, Buffer.from(payload)]);
    };
    const composition = [1, 64, 0, 180, 0x10, 0, 0, 0x80, 0, 0, 1, 0, 0, 0, 0, 0, 100, 0, 140];
    const rle = Array.from({ length: 8 }, () => [0, 0xa0, 1, 0, 0]).flat();
    return Buffer.concat([
        packet(0x16, composition),
        packet(0x17, [1, 0, 0, 0, 0, 0, 1, 64, 0, 180]),
        packet(0x14, [0, 0, 0, 16, 128, 128, 0, 1, 235, 128, 128, 255]),
        packet(0x15, [0, 0, 0, 0xc0, 0, 0, rle.length + 4, 0, 32, 0, 8, ...rle]),
        packet(0x80, []),
        packet(0x16, [1, 64, 0, 180, 0x10, 0, 1, 0, 0, 0, 0], 330000),
        packet(0x80, [], 330000),
    ]);
}

const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe';
function run(args: string[]): Buffer {
    return execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
        stdio: 'pipe',
        timeout: 60000,
    });
}

const ffmpegSmoke = describe.skipIf(!process.env.LUMASTRA_FFMPEG_SMOKE || !haveFfmpeg());

ffmpegSmoke('PGS burn-in real ffmpeg', () => {
    it('burns PGS into H.264 and decodes a valid first HLS segment with visible captions', () => {
        const dir = mkdtempSync(join(tmpdir(), 'pgs-burn-smoke-'));
        try {
            const sup = join(dir, 'caption.sup');
            const video = join(dir, 'black.mp4');
            const input = join(dir, 'pgs.mkv');
            writeFileSync(sup, pgsFixture());
            run([
                '-f',
                'lavfi',
                '-i',
                'color=black:s=320x180:r=24:d=4',
                '-c:v',
                'libx264',
                '-pix_fmt',
                'yuv420p',
                '-preset',
                'ultrafast',
                video,
            ]);
            run(['-i', video, '-i', sup, '-map', '0:v', '-map', '1:s', '-c', 'copy', input]);
            const config: FullStrategyConfig = {
                localFilePath: input,
                outputDir: dir,
                segmentDuration: 2,
                gpuAcceleration: 'none',
                encodingPreset: 'ultrafast',
                nvencPreset: 'p4',
                h264Crf: 18,
                h265Crf: 28,
                videoBitrateMbps: 0,
                maxWidth: 0,
                maxHeight: 0,
                tonemappingAlgorithm: 'hable',
                deinterlaceMethod: 'yadif',
                audioCodec: 'aac',
                audioBitrateStereo: '128k',
                audioBitrateSurround: '256k',
                audioVbr: false,
                audioBoost: 1,
                audioTracks: [],
                videoInfo: {
                    codec: 'h264',
                    outputCodec: 'h264',
                    width: 320,
                    height: 180,
                    bitDepth: 8,
                    frameRate: 24,
                },
                subtitleBurnIn: { absoluteIndex: 1, codec: 'hdmv_pgs_subtitle' },
                decision: {
                    mode: 'full',
                    reasons: 0,
                    videoAction: 'copy',
                    audioAction: 'copy',
                    useGpu: false,
                    needsTonemapping: false,
                    preserveHdr10: false,
                },
                hlsOutput: { hlsAudioMode: 'muxed', hlsContainer: 'mpegts' },
            };
            const { args } = new FullTranscodeStrategy().buildArgs(config);
            // Run before asserting argv: a red test must expose the real encoder failure.
            run(args);
            const segments = readdirSync(dir)
                .filter((file) => file.endsWith('.ts'))
                .sort();
            expect(segments.length).toBeGreaterThan(0);
            const first = join(dir, segments[0]!);
            const probe = JSON.parse(
                execFileSync(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', first], {
                    encoding: 'utf8',
                }),
            ) as {
                streams: { codec_name: string; pix_fmt: string; width: number; height: number }[];
            };
            expect(probe.streams[0]).toMatchObject({
                codec_name: 'h264',
                pix_fmt: 'yuv420p',
                width: 320,
                height: 180,
            });
            const frame = run([
                '-i',
                first,
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
            expect([...frame].filter((pixel) => pixel > 200).length).toBeGreaterThan(100);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }, 130000);
});
