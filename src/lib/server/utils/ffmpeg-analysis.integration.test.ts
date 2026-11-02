// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnFFmpegSafely } from './ffmpeg-spawn.js';
import { detectBlackFrames } from './ffmpeg-analysis.js';

let dir: string | undefined;
afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
});

it('retains non-keyframe black transitions with fast decoding and early downscaling', async () => {
    dir = await mkdtemp(join(tmpdir(), 'analysis-accuracy-'));
    const file = join(dir, 'long-gop.mp4');
    // The only keyframe is white at t=0. Black starts on a predicted frame at
    // t=2, so keyframe-only decoding cannot find this two-second black interval.
    await spawnFFmpegSafely({
        args: [
            '-f',
            'lavfi',
            '-i',
            "color=white:s=640x360:r=25:d=6,drawbox=color=black:t=fill:enable='between(t,2,4)'",
            '-c:v',
            'libx264',
            '-threads',
            '2',
            '-preset',
            'ultrafast',
            '-g',
            '250',
            '-keyint_min',
            '250',
            '-sc_threshold',
            '0',
            file,
        ],
        timeout: 30_000,
    });
    const frames = await detectBlackFrames(file, 0, 6, { minimumBlackPct: 98 });
    expect(frames.length).toBeGreaterThanOrEqual(9);
    expect(frames[0]!.time).toBeCloseTo(2, 1);
    // Compare to all-frame native-resolution detection: fast decode + scaling
    // must preserve the same 5fps boundary timestamps, including the last bucket.
    const reference = await spawnFFmpegSafely({
        libraryInput: file,
        args: [
            '-threads',
            '2',
            '-filter_threads',
            '2',
            '-i',
            file,
            '-an',
            '-sn',
            '-vf',
            'fps=5,blackframe=amount=98:threshold=32',
            '-f',
            'null',
            '-',
        ],
        timeout: 30_000,
    });
    const referenceTimes = [...reference.stderr.matchAll(/pblack:\d+.*?t:([\d.]+)/g)].map((m) =>
        Number(m[1]),
    );
    expect(frames.map((f) => f.time)).toEqual(referenceTimes);
    expect(frames.every((f) => f.blackPercentage >= 98)).toBe(true);
    for (let i = 1; i < frames.length; i++) {
        expect(frames[i]!.time - frames[i - 1]!.time).toBeCloseTo(0.2, 3);
    }
}, 60_000);
