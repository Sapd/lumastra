// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real ffmpeg, real interlaced source: an MPEG-2 720x576 25i TFF file (what a
 * DVD rip or a DVB recording is) must be (1) detected as interlaced by the
 * probes the transcode path uses, and (2) come out of the args the strategy
 * builds with no interlaced frames left, measured with `idet`.
 *
 * Found 2026-10-02 on NVENC and VA-API: no deinterlacer in the argv, output
 * flagged progressive, idet on it still 56/100 frames TFF — combing on every
 * motion. The cause was upstream of the filter (nothing ever said the native
 * file was interlaced), so the string-level tests alone would not have caught
 * it. The GPU deinterlacers can't run here; this proves the detection and the
 * CPU path, and the comparison run (same args, flag off) proves idet sees the
 * combing this fixes.
 *
 * Skips when ffmpeg/ffprobe are absent; generates its own fixture otherwise.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FullTranscodeStrategy } from './full-transcode-strategy';
import type { FullStrategyConfig } from './transcode-strategy';
import {
    isInterlacedFieldOrder,
    probeMediaFile,
    probeStreamCounts,
} from '$lib/server/utils/ffprobe';
import { haveFfmpeg } from '../../../../../tests/helpers/have-ffmpeg';

/**
 * 4 s of moving test pattern, 50p woven into 25i top-field-first and encoded as
 * interlaced MPEG-2 (anamorphic 16:9 PAL, like a DVD).
 */
function makeInterlacedSample(dir: string): string {
    const path = join(dir, 'pal-25i-tff.mkv');
    execFileSync(
        'ffmpeg',
        [
            ...['-hide_banner', '-loglevel', 'error', '-y'],
            ...['-f', 'lavfi', '-i', 'testsrc2=size=720x576:rate=50:duration=4'],
            '-vf',
            'setsar=64/45,tinterlace=mode=interleave_top,setfield=tff',
            ...['-c:v', 'mpeg2video', '-b:v', '6M', '-flags', '+ilme+ildct', '-top', '1'],
            path,
        ],
        { stdio: 'pipe', timeout: 60_000 },
    );
    return path;
}

/** idet's multi-frame verdict over every frame of `input`. */
function idet(input: string): { interlaced: number; progressive: number } {
    const run = spawnSync(
        'ffmpeg',
        ['-hide_banner', '-nostats', '-i', input, '-vf', 'idet', '-an', '-f', 'null', '-'],
        { encoding: 'utf8', timeout: 60_000 },
    );
    // The LAST verdict: ffmpeg may build the graph twice (a reinit on the first
    // decoded frame) and the discarded instance reports all zeros first.
    const line = run.stderr
        .split('\n')
        .filter((l) => l.includes('Multi frame detection'))
        .at(-1);
    const m = line?.match(/TFF:\s*(\d+)\s+BFF:\s*(\d+)\s+Progressive:\s*(\d+)/);
    if (!m) throw new Error(`no idet verdict for ${input}:\n${run.stderr.slice(-2000)}`);
    return { interlaced: Number(m[1]) + Number(m[2]), progressive: Number(m[3]) };
}

function transcode(source: string, outputDir: string, isInterlaced: boolean): string {
    mkdirSync(outputDir, { recursive: true });
    const config = {
        localFilePath: source,
        outputDir,
        segmentDuration: 2,
        gpuAcceleration: 'none',
        encodingPreset: 'ultrafast',
        h264Crf: 20,
        h265Crf: 28,
        videoBitrateMbps: 0,
        maxWidth: 0,
        maxHeight: 0,
        tonemappingAlgorithm: 'hable',
        deinterlaceMethod: 'yadif',
        audioCodec: 'aac',
        audioBitrateStereo: '128k',
        audioBitrateSurround: '256k',
        audioBoost: 1.0,
        audioTracks: [],
        videoInfo: {
            codec: 'mpeg2video',
            width: 720,
            height: 576,
            outputCodec: 'h264',
            frameRate: 25,
        },
        mediaSourceInfo: { streams: [{ type: 'Video', isInterlaced }] },
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

    const { args } = new FullTranscodeStrategy().buildArgs(config);
    expect(/(^|,)yadif=mode=0(,|$)/.test(args[args.indexOf('-vf') + 1] ?? '')).toBe(isInterlaced);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
        stdio: 'pipe',
        timeout: 120_000,
    });
    return join(outputDir, 'stream_0', 'index.m3u8');
}

const ffmpegSmoke = describe.skipIf(!process.env.LUMASTRA_FFMPEG_SMOKE || !haveFfmpeg());

ffmpegSmoke('deinterlacing (real execution)', () => {
    let dir: string;
    let sample: string;

    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'deinterlace-smoke-'));
        sample = makeInterlacedSample(dir);
        return () => rmSync(dir, { recursive: true, force: true });
    }, 70_000);

    it('the probes the transcode path uses report the file as interlaced', async () => {
        const counts = await probeStreamCounts(sample);
        expect(counts?.video).toBe(1);
        expect(
            isInterlacedFieldOrder(counts?.videoFieldOrder),
            String(counts?.videoFieldOrder),
        ).toBe(true);

        const full = await probeMediaFile(sample);
        expect(full.success).toBe(true);
        expect(isInterlacedFieldOrder(full.video?.fieldOrder)).toBe(true);
    });

    it('the transcoded output has no interlaced frames left (vs. combing without)', () => {
        const source = idet(sample);
        const without = idet(transcode(sample, join(dir, 'off'), false));
        const withFix = idet(transcode(sample, join(dir, 'on'), true));

        // The fixture really is interlaced, and transcoding it untouched keeps
        // the combing — otherwise the assertion below would prove nothing.
        expect(source.interlaced).toBeGreaterThan(source.progressive);
        expect(without.interlaced, JSON.stringify(without)).toBeGreaterThan(without.progressive);

        expect(withFix.progressive, JSON.stringify(withFix)).toBeGreaterThan(0);
        expect(withFix.interlaced, JSON.stringify(withFix)).toBeLessThanOrEqual(
            Math.ceil((withFix.interlaced + withFix.progressive) * 0.05),
        );
    }, 200_000);
});
