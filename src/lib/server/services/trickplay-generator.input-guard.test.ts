// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Trickplay generation runs ffprobe and then per-frame ffmpeg on each source
 * file of an item. A file whose CONTENT became an HLS/ffconcat/DASH/IMF
 * playlist body after the last scan would have both follow its references
 * into other libraries. Refused before either spawn, as a permanent write-off
 * (fix plan 6 follow-up to the final-wave M1 guard,
 * `transcoding/input-guard.ts`): re-running cannot change the content, and a
 * replaced file re-enters through the stage's `file.contentChanged`
 * invalidation.
 *
 * The sniff is the REAL one over real temp files; only ffprobe (execFile), the
 * ffmpeg spawn, storage and queries are mocked.
 */

import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    execFile: vi.fn(),
    spawnFFmpegSafely: vi.fn(),
    getFilesForMediaItem: vi.fn(),
    perFrameConcurrency: 4,
}));

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';
const REAL_MEDIA = `${process.cwd()}/tests/fixtures/test-video.mp4`;
const HLS_BODY = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/other/library/secret.ts\n';

vi.mock('$lib/server/config.js', () => ({
    config: {
        FFPROBE_PATH: '/usr/bin/ffprobe',
        FFMPEG_PATH: '/usr/bin/ffmpeg',
        TRICKPLAY_ENABLED: true,
        TRICKPLAY_INTERVAL_MS: 10_000,
        TRICKPLAY_TILE_WIDTH: 3,
        TRICKPLAY_TILE_HEIGHT: 2,
        TRICKPLAY_WIDTH: 32,
        TRICKPLAY_QUALITY: 80,
        TRICKPLAY_HWACCEL: 'off',
        TRICKPLAY_HWACCEL_DEVICE: '/dev/dri/renderD128',
        get TRICKPLAY_PER_FRAME_CONCURRENCY() {
            return h.perFrameConcurrency;
        },
        TRICKPLAY_PROVIDER: 'local_only',
        BASE_PATH: '/tmp',
    },
    FEATURE_PER_TASK_QUEUES: false,
    LUMASTRA_FFMPEG_THREADS: 0,
    LUMASTRA_CONCURRENCY_CPU: 4,
}));

vi.mock('$lib/server/utils/cpu-budget.js', () => ({ getCpuBudgetCores: () => 8 }));

vi.mock('child_process', () => ({
    execFile: (...a: unknown[]) => h.execFile(...a),
}));

vi.mock('$lib/server/utils/ffmpeg-spawn.js', () => ({
    spawnFFmpegSafely: (...a: unknown[]) => h.spawnFFmpegSafely(...a),
}));

vi.mock('./trickplay-storage.service.js', () => ({
    getBestTrickplayInfo: vi.fn(),
    saveSpriteSheet: vi.fn(),
    deleteTrickplayGeneration: vi.fn().mockResolvedValue(undefined),
    saveTrickplayManifest: vi.fn(),
    getTrickplayManifest: vi.fn(),
    hasTrickplay: vi.fn().mockResolvedValue(false),
    deleteTrickplay: vi.fn(),
    getTrickplayStats: vi.fn(),
}));

vi.mock('./database.service.js', () => ({
    aiDbService: { getSql: vi.fn().mockResolvedValue({}) },
}));

vi.mock('./trickplay-params.service.js', () => ({
    trickplayParamsService: { invalidate: vi.fn(), write: vi.fn() },
}));

vi.mock('$lib/server/database/queries/trickplay.queries.js', () => ({
    getMediaItemForTrickplay: vi.fn().mockResolvedValue({ id: ITEM_ID, media_type: 'movie' }),
    findEpisodesForSeries: vi.fn().mockResolvedValue([]),
    findEpisodesForSeason: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getFilesForMediaItem: (...a: unknown[]) => h.getFilesForMediaItem(...a),
    recordDecodeHealthIssue: vi.fn().mockResolvedValue(undefined),
    clearDecodeHealthIssues: vi.fn().mockResolvedValue(undefined),
}));

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'lumastra-trickplay-guard-'));
    // ffprobe "reports" no duration, so a source that reaches it is written
    // off right there — the control only needs to show it was reached.
    h.execFile.mockReset().mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (e: unknown, v: unknown) => void;
        cb(null, { stdout: JSON.stringify({ format: {}, streams: [] }), stderr: '' });
    });
    h.spawnFFmpegSafely.mockReset();
    h.perFrameConcurrency = 4;
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

async function runFor(filePath: string) {
    h.getFilesForMediaItem.mockResolvedValue([{ id: SOURCE_ID, file_path: filePath }]);
    const { generateTrickplayForMediaItem } = await import('./trickplay-generator.service.js');
    return generateTrickplayForMediaItem({} as never, ITEM_ID);
}

describe('trickplay — playlist-body source guard', () => {
    it('refuses a source whose content is a playlist body: permanent, no ffprobe, no ffmpeg', async () => {
        const input = join(dir, 'movie.mkv');
        await writeFile(input, HLS_BODY);

        const result = await runFor(input);

        expect(result.success).toBe(false);
        expect(result.permanent).toBe(true);
        expect(result.error).toMatch(/playlist/);
        expect(h.execFile).not.toHaveBeenCalled();
        expect(h.spawnFFmpegSafely).not.toHaveBeenCalled();
    });

    it('re-checks before EACH frame spawn: a file swapped mid-run never reaches ffmpeg', async () => {
        // A source is hundreds of per-frame ffmpegs over up to tens of minutes,
        // each re-opening the path — one check before ffprobe is not enough.
        // One frame at a time, so "after the swap" is well defined.
        h.perFrameConcurrency = 1;
        const input = join(dir, 'movie.mkv');
        await copyFile(REAL_MEDIA, input);
        h.execFile.mockImplementation((...args: unknown[]) => {
            const cb = args[args.length - 1] as (e: unknown, v: unknown) => void;
            cb(null, {
                stdout: JSON.stringify({
                    format: { duration: '100' },
                    streams: [{ width: 1920, height: 1080, codec_name: 'h264' }],
                }),
                stderr: '',
            });
        });
        const frame = await sharp({
            create: { width: 32, height: 18, channels: 3, background: { r: 90, g: 60, b: 200 } },
        })
            .webp()
            .toBuffer();
        let spawns = 0;
        let spawnsOnPlaylist = 0;
        h.spawnFFmpegSafely.mockImplementation(async (opts: { args: string[] }) => {
            spawns++;
            if ((await readFile(input, 'latin1')).startsWith('#EXTM3U')) spawnsOnPlaylist++;
            await writeFile(opts.args[opts.args.length - 1], frame);
            // Swapped for a playlist body after the third frame.
            if (spawns === 3) await writeFile(input, HLS_BODY);
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false, sizeExceeded: false };
        });

        const result = await runFor(input);

        expect(spawns).toBe(3);
        expect(spawnsOnPlaylist).toBe(0);
        expect(result.success).toBe(false);
    });

    it('control: real media reaches ffprobe on that path', async () => {
        await runFor(REAL_MEDIA);

        expect(h.execFile).toHaveBeenCalled();
        expect(h.execFile.mock.calls[0][1]).toContain(REAL_MEDIA);
    });
});
