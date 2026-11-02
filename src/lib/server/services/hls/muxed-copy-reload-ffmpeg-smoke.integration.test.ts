// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { haveFfmpeg } from '../../../../../tests/helpers/have-ffmpeg.js';
import { FullTranscodeStrategy } from '../transcoding/full-transcode-strategy.js';
import type { FullStrategyConfig } from '../transcoding/transcode-strategy.js';
import {
    alignToKeyframeSegmentStart,
    getKeyframeSegmentIndexForTime,
} from '../ffmpeg-transcode.service.js';
import { buildMuxedVodPlaylist } from './muxed-vod-playlist.js';
import { keyframes as episodeKeyframes } from './__fixtures__/irregular-copy-keyframes.js';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobe = process.env.FFPROBE_PATH || 'ffprobe';
function durations(playlist: string): number[] {
    return [...playlist.matchAll(/#EXTINF:([\d.]+)/g)].map((match) => Number(match[1]));
}

// A tiny generated picture with the regression episode's first 90 seconds of GOP cadence.
// Execute the production argument builder, then compare its actual fragments
// against the NEW source's server-owned timeline, including audio reselection.
describe.skipIf(!haveFfmpeg())('native muxed copy source reload (real FFmpeg)', () => {
    let directory: string;
    let source: string;
    let keyframes: number[];
    let duration: number;
    beforeAll(() => {
        directory = mkdtempSync(join(tmpdir(), 'copy-reload-'));
        source = join(directory, 'source.mkv');
        execFileSync(
            ffmpeg,
            [
                '-v',
                'error',
                '-f',
                'lavfi',
                '-i',
                'testsrc2=size=128x72:rate=25:duration=90',
                '-f',
                'lavfi',
                '-i',
                'sine=frequency=440:sample_rate=48000:duration=90',
                '-f',
                'lavfi',
                '-i',
                'sine=frequency=880:sample_rate=48000:duration=90',
                '-map',
                '0:v',
                '-map',
                '1:a',
                '-map',
                '2:a',
                '-c:v',
                'libx264',
                '-preset',
                'ultrafast',
                '-g',
                '1000',
                '-sc_threshold',
                '0',
                '-force_key_frames',
                episodeKeyframes.filter((time) => time < 90).join(','),
                '-c:a:0',
                'ac3',
                '-c:a:1',
                'eac3',
                '-shortest',
                source,
            ],
            { timeout: 60_000, stdio: 'pipe' },
        );
        const probe = JSON.parse(
            execFileSync(
                ffprobe,
                [
                    '-v',
                    'error',
                    '-select_streams',
                    'v',
                    '-skip_frame',
                    'nokey',
                    '-show_entries',
                    'frame=pts_time:format=duration',
                    '-of',
                    'json',
                    source,
                ],
                { encoding: 'utf8', timeout: 30_000 },
            ),
        ) as { frames: { pts_time: string }[]; format: { duration: string } };
        keyframes = probe.frames.map((frame) => Number(frame.pts_time));
        duration = Number(probe.format.duration);
    }, 90_000);
    afterAll(() => {
        if (directory) rmSync(directory, { recursive: true, force: true });
    });

    it.each([
        { target: 0, audioIndex: 1, codec: 'ac3' },
        { target: 32, audioIndex: 2, codec: 'eac3' },
        { target: 65, audioIndex: 1, codec: 'ac3' },
    ])(
        'a fresh source at $target seconds maps the selected track and real fragment durations',
        ({ target, audioIndex, codec }) => {
            const outputDir = join(directory, `seek-${target}`);
            mkdirSync(outputDir);
            const start =
                target > 0 ? alignToKeyframeSegmentStart(target, keyframes, duration, 10) : 0;
            const config = {
                localFilePath: source,
                outputDir,
                segmentDuration: 10,
                startTimeSeconds: start,
                videoInfo: { codec: 'h264', width: 128, height: 72, frameRate: 25 },
                audioCodec: 'aac',
                audioBitrateStereo: '192k',
                audioBitrateSurround: '384k',
                audioBoost: 1,
                audioTracks: [
                    {
                        index: 1,
                        codec: 'ac3',
                        channels: 1,
                        language: 'eng',
                        isDefault: true,
                        bitrate: 96000,
                    },
                    {
                        index: 2,
                        codec: 'eac3',
                        channels: 1,
                        language: 'ger',
                        isDefault: false,
                        bitrate: 96000,
                    },
                ],
                hlsOutput: {
                    hlsAudioMode: 'muxed',
                    hlsContainer: 'fmp4',
                    hlsPlaylistType: 'event',
                    hlsAudioTrackIndex: audioIndex,
                },
                decision: { videoAction: 'copy', audioAction: 'copy' },
            } as unknown as FullStrategyConfig;
            const { args } = new FullTranscodeStrategy().buildArgs(config);
            execFileSync(ffmpeg, ['-v', 'error', ...args], { timeout: 30_000, stdio: 'pipe' });
            const producer = durations(readFileSync(join(outputDir, 'index.m3u8'), 'utf8'));
            const manifest = durations(
                buildMuxedVodPlaylist({
                    runtimeSeconds: duration,
                    segmentDuration: 10,
                    keyframeData: keyframes,
                    seekStartTime: start,
                    segmentBase: '/hls',
                    segmentParams: new URLSearchParams(),
                    segmentExtension: 'm4s',
                }),
            );
            expect(manifest.reduce((sum, value) => sum + value, 0)).toBeCloseTo(duration, 5);
            const offset = getKeyframeSegmentIndexForTime(start, keyframes, duration, 10);
            expect(producer.length).toBe(manifest.length - offset);
            // Audio packet rounding can extend the last fragment slightly; the
            // actual video cut points, which define seeking, must agree exactly.
            for (let i = 0; i < producer.length - 1; i++) {
                expect(Math.abs(producer[i] - manifest[offset + i])).toBeLessThan(0.06);
            }
            const audio = execFileSync(
                ffprobe,
                [
                    '-v',
                    'error',
                    '-select_streams',
                    'a',
                    '-show_entries',
                    'stream=codec_name',
                    '-of',
                    'default=noprint_wrappers=1:nokey=1',
                    join(outputDir, 'init_0.mp4'),
                ],
                { encoding: 'utf8' },
            ).trim();
            expect(audio).toBe(codec);
        },
        40_000,
    );
});
