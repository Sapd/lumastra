// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { spawnFFmpegSafely } from '$lib/server/utils/ffmpeg-spawn.js';
import { buildCandidateArgs, generateEpisodeThumbnail } from './frame-candidate.service.js';

describe('episode frames stay inside their span with sparse keyframes', () => {
    let dir: string;
    let video: string;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'frame-span-'));
        video = join(dir, 'combined.mp4');
        const result = await spawnFFmpegSafely({
            args: [
                '-hide_banner',
                '-loglevel',
                'error',
                '-f',
                'lavfi',
                '-i',
                'color=red:s=32x32:r=1:d=10',
                '-f',
                'lavfi',
                '-i',
                'color=blue:s=32x32:r=1:d=10',
                '-f',
                'lavfi',
                '-i',
                'color=green:s=32x32:r=1:d=10',
                '-filter_complex',
                '[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]',
                '-map',
                '[v]',
                '-c:v',
                'libx264',
                '-g',
                '1000',
                '-keyint_min',
                '1000',
                '-sc_threshold',
                '0',
                '-force_key_frames',
                '0,25',
                '-y',
                video,
            ],
            timeout: 15000,
        });
        expect(result.exitCode).toBe(0);
    });

    afterAll(async () => {
        if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('decodes the middle episode instead of jumping to the next episode keyframe', async () => {
        const outputPath = join(dir, 'middle.jpg');
        const result = await generateEpisodeThumbnail({
            episodeId: '11111111-1111-4111-8111-111111111111',
            videoPath: video,
            outputPath,
            baseOffsetSeconds: 10,
            durationSeconds: 10,
        });
        expect(result.success).toBe(true);
        const stats = await sharp(await readFile(outputPath))
            .removeAlpha()
            .stats();
        expect(stats.channels[2].mean).toBeGreaterThan(220);
        expect(stats.channels[0].mean).toBeLessThan(20);
        expect(stats.channels[1].mean).toBeLessThan(20);
    });

    it.each([
        [19.75, 19.9],
        [19.75051, 20],
    ])(
        'emits no frame for seek %s when the next source frame reaches or exceeds end %s',
        async (seek, end) => {
            const result = await spawnFFmpegSafely({
                args: buildCandidateArgs(video, [seek], dir, 80, 32, 32, end),
                libraryInput: video,
                timeout: 15000,
            });
            expect(result.exitCode).toBe(0);
            await expect(stat(join(dir, 'cand0.jpg'))).rejects.toMatchObject({ code: 'ENOENT' });
        },
    );
});
