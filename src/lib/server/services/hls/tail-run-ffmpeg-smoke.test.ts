// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real ffmpeg: the remux tail worker's run, read the way the service reads it,
 * answers the last playlist entry only for a stream whose media reaches it.
 *
 * The tail cache used to hand a copy audio stream's last segment to ANY tail
 * index. When the audio ends before the last grid entry starts (>= 0.5 s short
 * of the container, so the grid keeps the entry), that entry got the previous
 * audio segment's bytes and the player repeated them.
 *
 * Skips when ffmpeg/ffprobe are absent; generates its own fixtures otherwise.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildRemuxTailRunArgs, cacheTailRun, readTailRunStreams } from './tail-run';
import { lookupEndSegment, type EndSegmentCache } from './end-segment-cache';
import { FullTranscodeStrategy } from '../transcoding/full-transcode-strategy';
import type { FullStrategyConfig } from '../transcoding/transcode-strategy';
import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';
import { haveFfmpeg } from '../../../../../tests/helpers/have-ffmpeg';

const SEGMENT = 6;
const TOTAL = 40;
// 40 s at 6 s: entries 0..6, the last one [36, 40].
const GRID = { totalSeconds: TOTAL, segmentSeconds: SEGMENT };

function makeSource(dir: string, name: string, videoSeconds: number, audioSeconds: number): string {
    const path = join(dir, name);
    execFileSync(
        'ffmpeg',
        [
            ...['-hide_banner', '-loglevel', 'error', '-y'],
            ...['-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=24:duration=${videoSeconds}`],
            ...[
                '-f',
                'lavfi',
                '-i',
                `sine=frequency=440:sample_rate=48000:duration=${audioSeconds}`,
            ],
            ...['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-bf', '2'],
            ...['-c:a', 'aac', path],
        ],
        { stdio: 'pipe', timeout: 60_000 },
    );
    return path;
}

/** The transcode tail worker's strategy config, trimmed to a CPU libx264 + AAC run. */
function transcodeTailArgs(source: string, tailDir: string): string[] {
    const config = {
        localFilePath: source,
        outputDir: tailDir,
        segmentDuration: SEGMENT,
        startTimeSeconds: TOTAL - 30,
        startNumber: 0,
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
        hlsOutput: { hlsAudioMode: 'demux', hlsPlaylistType: 'vod' },
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
        videoInfo: { codec: 'h264', width: 320, height: 240, outputCodec: 'h264', frameRate: 24 },
        decision: {
            mode: 'full',
            reasons: 0,
            videoAction: 'transcode',
            audioAction: 'transcode',
            useGpu: false,
            needsTonemapping: false,
            preserveHdr10: false,
        },
    } as unknown as FullStrategyConfig;
    return [
        '-hide_banner',
        '-loglevel',
        'error',
        ...new FullTranscodeStrategy().buildArgs(config).args,
    ];
}

/** Run a tail worker on `source` and cache its output the way the service does. */
async function runTail(
    dir: string,
    source: string,
    label: string,
    worker: 'remux' | 'transcode' = 'remux',
): Promise<EndSegmentCache> {
    const tailDir = join(dir, label);
    for (const stream of ['stream_0', 'stream_1']) {
        mkdirSync(join(tailDir, stream), { recursive: true });
    }
    const args =
        worker === 'remux'
            ? buildRemuxTailRunArgs({
                  seekToSeconds: TOTAL - 30,
                  inputFile: source,
                  audioTrackCount: 1,
                  segmentSeconds: SEGMENT,
                  tailDir,
              })
            : transcodeTailArgs(source, tailDir);
    execFileSync('ffmpeg', args, { cwd: tailDir, stdio: 'pipe', timeout: 120_000 });
    const cache: EndSegmentCache = new Map();
    const results = await cacheTailRun({
        cache,
        tailDir,
        streamDirs: ['stream_0', 'stream_1'],
        totalSeconds: TOTAL,
        segmentSecondsFor: () => SEGMENT,
    });
    expect(results).not.toBeNull();
    return cache;
}

const ffmpegSmoke = describe.skipIf(!process.env.LUMASTRA_FFMPEG_SMOKE || !haveFfmpeg());

ffmpegSmoke('tail run on real ffmpeg output', () => {
    let dir: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'lumastra-tail-run-'));
    });

    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('audio 1.6 s short still reaches the last entry: both streams answer it', async () => {
        const cache = await runTail(dir, makeSource(dir, 'reach.mp4', TOTAL, 38.4), 'reach');

        expect(lookupEndSegment(cache, 'stream_0', 6, GRID)).toBeDefined();
        expect(lookupEndSegment(cache, 'stream_1', 6, GRID)).toBeDefined();
        // Never another tail index.
        expect(lookupEndSegment(cache, 'stream_0', 5, GRID)).toBeUndefined();
        expect(lookupEndSegment(cache, 'stream_1', 4, GRID)).toBeUndefined();
        const audio = cache.get('stream_0');
        expect(audio?.kind === 'tail_run' && audio.mediaEndSeconds).toBeCloseTo(38.4, 0);
    });

    it('audio ending before the last entry starts answers nothing; video still does', async () => {
        const cache = await runTail(dir, makeSource(dir, 'short.mp4', TOTAL, 35), 'short');

        expect(lookupEndSegment(cache, 'stream_0', 6, GRID)).toBeUndefined();
        expect(lookupEndSegment(cache, 'stream_0', 5, GRID)).toBeUndefined();
        expect(lookupEndSegment(cache, 'stream_1', 6, GRID)).toBeDefined();
    });

    it('video ending before the last entry (audio overhang) answers nothing', async () => {
        const cache = await runTail(dir, makeSource(dir, 'overhang.mp4', 35.5, TOTAL), 'overhang');

        expect(lookupEndSegment(cache, 'stream_1', 6, GRID)).toBeUndefined();
        expect(lookupEndSegment(cache, 'stream_0', 6, GRID)).toBeDefined();
    });

    it('the transcode worker run is read and timed too', async () => {
        const reach = await runTail(
            dir,
            makeSource(dir, 'tx-reach.mp4', TOTAL, 38.4),
            'tx-reach',
            'transcode',
        );
        expect(lookupEndSegment(reach, 'stream_0', 6, GRID)).toBeDefined();
        expect(lookupEndSegment(reach, 'stream_1', 6, GRID)).toBeDefined();
        expect(lookupEndSegment(reach, 'stream_0', 5, GRID)).toBeUndefined();

        const short = await runTail(
            dir,
            makeSource(dir, 'tx-short.mp4', TOTAL, 35),
            'tx-short',
            'transcode',
        );
        expect(lookupEndSegment(short, 'stream_0', 6, GRID)).toBeUndefined();
        expect(lookupEndSegment(short, 'stream_1', 6, GRID)).toBeDefined();
    });

    it('a run missing a stream yields nothing at all', async () => {
        const tailDir = join(dir, 'partial');
        mkdirSync(join(tailDir, 'stream_0'), { recursive: true });
        expect(await readTailRunStreams(tailDir, ['stream_0', 'stream_1'])).toBeNull();
    });
});
