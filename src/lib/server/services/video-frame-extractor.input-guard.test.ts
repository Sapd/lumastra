// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `extractFrame` runs ffprobe and then ffmpeg on a library file. A file whose
 * CONTENT became an HLS/ffconcat/DASH/IMF playlist body after the last scan
 * would have both follow its references into other libraries, so the frame
 * would be cut from a file the item does not own. Refused before either spawn
 * (fix plan 6 follow-up to the final-wave M1 guard,
 * `transcoding/input-guard.ts`).
 *
 * The sniff is the REAL one over real temp files; only ffprobe (execFile) and
 * the ffmpeg spawn are mocked.
 */

import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    execFile: vi.fn(),
    spawnFFmpegSafely: vi.fn(),
}));

vi.mock('$lib/server/config.js', () => ({
    config: {
        FFPROBE_PATH: '/usr/bin/ffprobe',
        IMAGE_SYNC_VIDEO_TIMESTAMP: 10,
        IMAGE_SYNC_VIDEO_QUALITY: 80,
        IMAGE_SYNC_VIDEO_MAX_WIDTH: 640,
        IMAGE_SYNC_VIDEO_MAX_HEIGHT: 360,
    },
}));

vi.mock('child_process', () => ({
    execFile: (...a: unknown[]) => h.execFile(...a),
}));

vi.mock('$lib/server/utils/ffmpeg-spawn.js', () => ({
    spawnFFmpegSafely: (...a: unknown[]) => h.spawnFFmpegSafely(...a),
}));

const REAL_MEDIA = `${process.cwd()}/tests/fixtures/test-video.mp4`;
const CONCAT_BODY = "ffconcat version 1.0\nfile '/other/library/secret.mkv'\n";

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lumastra-frame-guard-'));
    h.execFile.mockReset().mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (e: unknown, v: unknown) => void;
        cb(null, { stdout: JSON.stringify({ format: { duration: '5' } }), stderr: '' });
    });
    // A failing ffmpeg is enough: the control only needs to show it was reached.
    h.spawnFFmpegSafely.mockReset().mockResolvedValue({
        exitCode: 1,
        stdout: '',
        stderr: '',
        timedOut: false,
        sizeExceeded: false,
    });
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('extractFrame — playlist-body source guard', () => {
    it('refuses a source whose content is a playlist body: no ffprobe, no ffmpeg', async () => {
        const videoPath = join(dir, 'episode.mkv');
        await writeFile(videoPath, CONCAT_BODY);
        const { extractFrame } = await import('./video-frame-extractor.service.js');

        const result = await extractFrame({ videoPath, outputPath: join(dir, 'out', 'thumb.jpg') });

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/playlist/);
        expect(h.execFile).not.toHaveBeenCalled();
        expect(h.spawnFFmpegSafely).not.toHaveBeenCalled();
    });

    it('re-checks before EACH candidate spawn: a file swapped mid-loop never reaches ffmpeg', async () => {
        // Up to five candidate timestamps, each its own ffmpeg with a 60 s
        // ceiling, each re-opening the path — one check up front is not enough.
        const videoPath = join(dir, 'episode.mkv');
        await copyFile(REAL_MEDIA, videoPath);
        let spawnsOnPlaylist = 0;
        h.spawnFFmpegSafely.mockImplementation(async () => {
            if ((await readFile(videoPath, 'latin1')).startsWith('ffconcat')) spawnsOnPlaylist++;
            // The first candidate "fails", so the loop moves on — and the
            // file is swapped for a playlist body meanwhile.
            await writeFile(videoPath, CONCAT_BODY);
            return { exitCode: 1, stdout: '', stderr: '', timedOut: false, sizeExceeded: false };
        });
        const { extractFrame } = await import('./video-frame-extractor.service.js');

        const result = await extractFrame({ videoPath, outputPath: join(dir, 'out', 'thumb.jpg') });

        expect(h.spawnFFmpegSafely).toHaveBeenCalledTimes(1);
        expect(spawnsOnPlaylist).toBe(0);
        expect(result.success).toBe(false);
        expect(result.error).toMatch(/playlist/);
    });

    it('control: real media reaches ffprobe and ffmpeg on that path', async () => {
        const { extractFrame } = await import('./video-frame-extractor.service.js');

        await extractFrame({ videoPath: REAL_MEDIA, outputPath: join(dir, 'out', 'thumb.jpg') });

        expect(h.execFile.mock.calls[0][1]).toContain(REAL_MEDIA);
        expect(h.spawnFFmpegSafely).toHaveBeenCalled();
        expect(h.spawnFFmpegSafely.mock.calls[0][0].args).toContain(REAL_MEDIA);
    });
});
