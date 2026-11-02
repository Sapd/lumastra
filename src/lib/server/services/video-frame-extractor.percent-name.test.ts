// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A library file named `Movie %d` (or in a folder named that) puts `%d` into
 * the frame extractor's ffmpeg OUTPUT path. The image2 muxer expands it, so the
 * frame went to a digit-substituted sibling path (here `d1/`) instead of the
 * path the extractor then renames from, and the thumbnail failed. Runs real
 * ffmpeg.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { haveFfmpeg } from '../../../../tests/helpers/have-ffmpeg';

vi.mock('$lib/server/config.js', () => ({
    LUMASTRA_FFMPEG_THREADS: 0,
    config: {
        FFMPEG_PATH: 'ffmpeg',
        FFPROBE_PATH: 'ffprobe',
        IMAGE_SYNC_AUTO_VIDEO_EXTRACTION: true,
        IMAGE_SYNC_VIDEO_TIMESTAMP: 50,
        IMAGE_SYNC_VIDEO_QUALITY: 80,
        IMAGE_SYNC_VIDEO_MAX_WIDTH: 320,
        IMAGE_SYNC_VIDEO_MAX_HEIGHT: 180,
    },
}));

describe.skipIf(!haveFfmpeg())('extractFrame with a % in the path (real ffmpeg)', () => {
    let root: string;

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), 'frame-pct-'));
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('writes the thumbnail to the literal path and leaves the digit-named sibling alone', async () => {
        const { extractFrame } = await import('./video-frame-extractor.service.js');

        const dir = join(root, 'd%d');
        const sibling = join(root, 'd1');
        mkdirSync(dir);
        mkdirSync(sibling);
        const video = join(dir, 'clip.mp4');
        execFileSync('ffmpeg', [
            '-v',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc2=size=320x180:rate=10:duration=4',
            '-pix_fmt',
            'yuv420p',
            video,
        ]);

        const outputPath = join(dir, 'thumb.jpg');
        const result = await extractFrame({ videoPath: video, outputPath });

        expect(result).toEqual({ success: true, outputPath });
        expect(existsSync(outputPath)).toBe(true);
        expect(readdirSync(sibling)).toEqual([]);
    }, 60_000);
});
