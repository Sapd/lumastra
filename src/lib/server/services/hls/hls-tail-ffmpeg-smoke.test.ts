// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real ffmpeg: the playlists we serve end where FFmpeg's output ends.
 *
 * Found by the reverse-proxy e2e 2026-10-06: a transcoded playlist ended with a
 * phantom 0.021 s segment, and requesting it returned the previous segment's
 * bytes. The container ran 12.021 s over 12.000 s of 24 fps video; the playlist
 * was `ceil(12.021 / 6)` = 3 entries while FFmpeg cut the video into 2 files
 * (its last frame starts before 12 s, so nothing can open a third). This runs
 * the args the strategy really builds on such a file and holds every served
 * playlist against the files on disk.
 *
 * Skips when ffmpeg/ffprobe are absent; generates its own fixtures otherwise.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FullTranscodeStrategy } from '../transcoding/full-transcode-strategy';
import type { FullStrategyConfig } from '../transcoding/transcode-strategy';
import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';
import {
    isPastProducedEnd,
    uniformSegmentCount,
    uniformSegmentDuration,
} from '$lib/server/utils/hls-segment-grid';
import { generateCompleteVodManifest } from './vod-playlist';
import { buildMuxedVodPlaylist } from './muxed-vod-playlist';
import { haveFfmpeg } from '../../../../../tests/helpers/have-ffmpeg';

const SEGMENT = 6;

/** 12 s of 24 fps video (keyframe every 2 s) and AAC audio of `audioSeconds`. */
function makeSource(dir: string, name: string, audioSeconds: number): string {
    const path = join(dir, name);
    execFileSync(
        'ffmpeg',
        [
            ...['-hide_banner', '-loglevel', 'error', '-y'],
            ...['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=12'],
            ...[
                '-f',
                'lavfi',
                '-i',
                `sine=frequency=440:sample_rate=48000:duration=${audioSeconds}`,
            ],
            ...['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-c:a', 'aac', path],
        ],
        { stdio: 'pipe', timeout: 60_000 },
    );
    return path;
}

/** The container duration — what `media_files` stores and the playlist is built from. */
function containerSeconds(path: string): number {
    return Number(
        execFileSync('ffprobe', [
            ...['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path],
        ])
            .toString()
            .trim(),
    );
}

function keyframes(path: string): number[] {
    return execFileSync('ffprobe', [
        ...['-v', 'error', '-select_streams', 'v:0', '-skip_frame', 'nokey'],
        ...['-show_entries', 'frame=pts_time', '-of', 'csv=p=0', path],
    ])
        .toString()
        .trim()
        .split('\n')
        .map(Number);
}

function runStrategy(
    source: string,
    out: string,
    opts: {
        mode: 'demux' | 'muxed';
        action: 'transcode' | 'copy';
        startTimeSeconds?: number;
        startNumber?: number;
    },
): void {
    mkdirSync(out, { recursive: true });
    const config = {
        localFilePath: source,
        outputDir: out,
        segmentDuration: SEGMENT,
        gpuAcceleration: 'none',
        encodingPreset: 'ultrafast',
        nvencPreset: 'p4',
        h264Crf: 23,
        h265Crf: 28,
        videoBitrateMbps: 0,
        maxWidth: 0,
        maxHeight: 0,
        tonemappingAlgorithm: 'bt2390',
        deinterlaceMethod: 'yadif',
        audioCodec: 'aac',
        audioBitrateStereo: '128k',
        audioBitrateSurround: '256k',
        audioVbr: false,
        audioBoost: 1,
        startTimeSeconds: opts.startTimeSeconds,
        startNumber: opts.startNumber,
        hlsOutput: { hlsAudioMode: opts.mode },
        audioTracks: [
            {
                index: asAbsoluteStreamIndex(1),
                displayTitle: 'English',
                language: 'eng',
                channels: 1,
                codec: 'aac',
                isDefault: true,
            },
        ],
        videoInfo: {
            codec: 'h264',
            width: 320,
            height: 240,
            outputCodec: 'h264',
            frameRate: 24,
        },
        decision: {
            mode: 'full',
            reasons: 0,
            videoAction: opts.action,
            audioAction: opts.action,
            useGpu: false,
            needsTonemapping: false,
            preserveHdr10: false,
        },
    } as unknown as FullStrategyConfig;
    const { args } = new FullTranscodeStrategy().buildArgs(config);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
        cwd: out,
        stdio: 'pipe',
        timeout: 120_000,
    });
}

interface ProducedStream {
    dir: string;
    manifest: string;
    /** segment index → md5 of its bytes */
    files: Map<number, string>;
}

/** Each directory under `out` (or `out` itself) holding FFmpeg segments. */
function produced(out: string): Map<string, ProducedStream> {
    const result = new Map<string, ProducedStream>();
    const dirs = [out, ...readdirSync(out).map((d) => join(out, d))].filter((d) => {
        try {
            return readdirSync(d).some((f) => /^segment_\d+\./.test(f));
        } catch {
            return false;
        }
    });
    for (const dir of dirs) {
        const names = readdirSync(dir);
        const files = new Map<number, string>();
        for (const f of names) {
            const m = /^segment_(\d+)\.(m4s|ts)$/.exec(f);
            if (!m) continue;
            const hash = createHash('md5')
                .update(readFileSync(join(dir, f)))
                .digest('hex');
            files.set(Number(m[1]), hash);
        }
        const manifestName = names.find((f) => f.endsWith('.m3u8') && f !== 'master.m3u8');
        const manifest = manifestName ? readFileSync(join(dir, manifestName), 'utf8') : '';
        result.set(dir === out ? '.' : dir.slice(out.length + 1), { dir, manifest, files });
    }
    return result;
}

/** Segment indices a served playlist lists, in order. */
function listedIndices(playlist: string): number[] {
    return [...playlist.matchAll(/^(?:.*\/)?segment_(\d+)\.(?:m4s|ts)/gm)].map((m) => Number(m[1]));
}

function extinfs(playlist: string): number[] {
    return [...playlist.matchAll(/#EXTINF:([\d.]+),/g)].map((m) => Number(m[1]));
}

/** Every listed entry is a file FFmpeg wrote, and no two entries share bytes. */
function expectListedExactlyProduced(listed: number[], stream: ProducedStream, label: string) {
    for (const index of listed) {
        expect(stream.files.has(index), `${label}: listed segment ${index} was never written`).toBe(
            true,
        );
    }
    const hashes = listed.map((i) => stream.files.get(i));
    expect(new Set(hashes).size, `${label}: two entries serve the same bytes`).toBe(hashes.length);
}

const ffmpegSmoke = describe.skipIf(!process.env.LUMASTRA_FFMPEG_SMOKE || !haveFfmpeg());

ffmpegSmoke(
    'HLS tail: served playlists end with FFmpeg (real execution)',
    () => {
        let dir: string;
        let sliver: string; // 12 s video, container a few ms longer
        let overhang: string; // 12 s video, 12.7 s audio
        let sliverSeconds: number;

        beforeAll(() => {
            dir = mkdtempSync(join(tmpdir(), 'hls-tail-smoke-'));
            sliver = makeSource(dir, 'sliver.mkv', 12.021);
            overhang = makeSource(dir, 'overhang.mkv', 12.7);
            sliverSeconds = containerSeconds(sliver);
            return () => rmSync(dir, { recursive: true, force: true });
        }, 70_000);

        it('the fixture has the shape that broke: a sub-frame-ish tail past 12 s', () => {
            expect(sliverSeconds).toBeGreaterThan(12);
            expect(sliverSeconds).toBeLessThan(12.1);
            expect(uniformSegmentCount(sliverSeconds, SEGMENT)).toBe(2);
        });

        it('transcode, demuxed: video and audio playlists list only real, distinct files', () => {
            const out = join(dir, 'xcode-demux');
            runStrategy(sliver, out, { mode: 'demux', action: 'transcode' });
            const streams = produced(out);
            // FFmpeg's shape: video 2 files; audio wrote the sliver as a 3rd.
            expect(streams.get('stream_1')?.files.size).toBe(2);
            expect(streams.get('stream_0')?.files.size).toBe(3);

            for (const [name, stream] of streams) {
                const playlist = generateCompleteVodManifest(
                    stream.manifest,
                    {
                        totalDurationSeconds: sliverSeconds,
                        segmentDurationSeconds: SEGMENT,
                        totalSegments: uniformSegmentCount(sliverSeconds, SEGMENT),
                        isComplete: true,
                    },
                    new URLSearchParams(),
                );
                const listed = listedIndices(playlist);
                expect(listed, name).toEqual([0, 1]);
                expectListedExactlyProduced(listed, stream, name);
            }
        });

        it('transcode, muxed: the playlist lists only real, distinct files', () => {
            const out = join(dir, 'xcode-muxed');
            runStrategy(sliver, out, { mode: 'muxed', action: 'transcode' });
            const streams = produced(out);
            expect(streams.size).toBe(1);
            const [stream] = streams.values();
            const playlist = buildMuxedVodPlaylist({
                runtimeSeconds: sliverSeconds,
                segmentDuration: SEGMENT,
                segmentBase: '/hls',
                segmentParams: new URLSearchParams(),
                segmentExtension: 'm4s',
            });
            const listed = listedIndices(playlist);
            expect(listed).toEqual([...stream.files.keys()].sort((a, b) => a - b));
            expectListedExactlyProduced(listed, stream, 'muxed');
            expect(extinfs(playlist).reduce((a, b) => a + b, 0)).toBeCloseTo(sliverSeconds, 3);
        });

        it('remux (direct stream), demuxed: the uniform audio grid lists only real files', () => {
            const out = join(dir, 'remux-demux');
            runStrategy(sliver, out, { mode: 'demux', action: 'copy' });
            const streams = produced(out);
            const audio = streams.get('stream_0')!;
            const playlist = generateCompleteVodManifest(
                audio.manifest,
                {
                    totalDurationSeconds: sliverSeconds,
                    segmentDurationSeconds: SEGMENT,
                    totalSegments: uniformSegmentCount(sliverSeconds, SEGMENT),
                    isComplete: true,
                },
                new URLSearchParams(),
            );
            expectListedExactlyProduced(listedIndices(playlist), audio, 'remux audio');
            // Video lists keyframe-derived entries (not this grid); with 2 s GOPs
            // its cut at 6 s gives the same two files FFmpeg wrote.
            expect(keyframes(sliver).length).toBeGreaterThan(0);
            expect(streams.get('stream_1')?.files.size).toBe(2);
        });

        it('a seek into the last segment (-ss 6, -start_number 1) produces exactly the last listed entry', () => {
            const out = join(dir, 'xcode-seek');
            runStrategy(sliver, out, {
                mode: 'demux',
                action: 'transcode',
                startTimeSeconds: 6,
                startNumber: 1,
            });
            const last = uniformSegmentCount(sliverSeconds, SEGMENT) - 1;
            expect(last).toBe(1);
            for (const [name, stream] of produced(out)) {
                expect(stream.files.has(last), name).toBe(true);
                // Index 2 is never listed; whatever audio wrote there is unreachable.
                expect(isPastProducedEnd(stream.manifest, last, last + 1), name).toBe(false);
            }
            expect(uniformSegmentDuration(last, sliverSeconds, SEGMENT)).toBeCloseTo(
                sliverSeconds - 6,
                6,
            );
        });

        it('a long audio overhang keeps its entry; the video manifest proves it is past the end', () => {
            const total = containerSeconds(overhang);
            const grid = uniformSegmentCount(total, SEGMENT);
            expect(grid).toBe(3);

            const out = join(dir, 'xcode-overhang');
            runStrategy(overhang, out, { mode: 'demux', action: 'transcode' });
            const streams = produced(out);
            const video = streams.get('stream_1')!;
            const audio = streams.get('stream_0')!;
            expect(video.files.size).toBe(2);
            expect(audio.files.size).toBe(3);
            // The handler 404s video #2 on this evidence instead of serving a copy…
            expect(isPastProducedEnd(video.manifest, 2, grid)).toBe(true);
            // …and serves audio #2, which exists.
            expect(isPastProducedEnd(audio.manifest, 2, grid)).toBe(false);
            expect(existsSync(join(audio.dir, 'segment_00002.m4s'))).toBe(true);
        });
    },
);
