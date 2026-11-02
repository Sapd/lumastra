// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression tests for the 2026-08-20 prod incident: ffmpeg exits 0 while
 * writing a 0-byte .webp whenever it cannot produce a picture at the requested
 * timestamp. Those empty files were counted as extracted, read back as empty
 * Buffers, and handed to sharp, which throws `Input Buffer is empty` — failing
 * the whole item, which the run-wrapper reset to `pending`, so it retried
 * forever. 48 items/hour failed vs 6 completing; the stage sat at 98%.
 *
 * These tests use REAL sharp and REAL files on disk, mocking only the ffmpeg
 * spawn, so they exercise the actual sprite assembly rather than a stand-in.
 * Each frame gets a unique solid colour, which lets the slot-alignment test
 * assert that a missing frame leaves a hole instead of shifting its
 * neighbours — the silent-corruption failure mode the packed layout had.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharpReal from 'sharp';

const upsertParamsMock = vi.fn().mockResolvedValue(undefined);
vi.mock('$lib/server/database/queries/trickplay-params.queries.js', () => ({
    deleteNonLocalTrickplayParams: vi.fn().mockResolvedValue(undefined),
    upsertTrickplayParams: (...args: unknown[]) => upsertParamsMock(...args),
}));

const execFileMock = vi.fn();
const probeStreamTailsMock = vi.fn();
const spawnFFmpegSafelyMock = vi.fn();
const saveSpriteSheetMock = vi.fn();
const saveTrickplayManifestMock = vi.fn();
const deleteGenerationMock = vi.fn().mockResolvedValue(undefined);
const hasTrickplayMock = vi.fn();
const recordDecodeHealthIssueMock = vi.fn();
const clearDecodeHealthIssuesMock = vi.fn();
const getFilesForMediaItemMock = vi.fn();
const getMediaItemForTrickplayMock = vi.fn();

const SOURCE_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';
const VIDEO_PATH = '/data/movies/Example (2020)/Example.mkv';

/** Sample interval and grid, chosen small so a run is two sheets of six. */
const INTERVAL_MS = 10_000;
const TILE_W = 3;
const TILE_H = 2;
const SPRITE_W = 32;
const SPRITE_H = 18;

vi.mock('$lib/server/config.js', () => ({
    config: {
        FFPROBE_PATH: '/usr/bin/ffprobe',
        FFMPEG_PATH: '/usr/bin/ffmpeg',
        TRICKPLAY_ENABLED: true,
        TRICKPLAY_INTERVAL_MS: INTERVAL_MS,
        TRICKPLAY_TILE_WIDTH: TILE_W,
        TRICKPLAY_TILE_HEIGHT: TILE_H,
        TRICKPLAY_WIDTH: SPRITE_W,
        TRICKPLAY_QUALITY: 80,
        // Software decode keeps these tests independent of whether the machine
        // running them happens to have a GPU render node.
        TRICKPLAY_HWACCEL: 'off',
        TRICKPLAY_HWACCEL_DEVICE: '/dev/dri/renderD128',
        TRICKPLAY_PER_FRAME_CONCURRENCY: 4,
        TRICKPLAY_PROVIDER: 'local_only',
        BASE_PATH: '/tmp',
    },
    FEATURE_PER_TASK_QUEUES: false,
    LUMASTRA_FFMPEG_THREADS: 0,
    LUMASTRA_CONCURRENCY_CPU: 4,
}));

vi.mock('$lib/server/utils/cpu-budget.js', () => ({
    getCpuBudgetCores: () => 8,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('child_process', () => ({
    execFile: (...args: unknown[]) => execFileMock(...args),
}));

vi.mock('$lib/server/utils/ffprobe.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/ffprobe.js')>()),
    probeStreamTails: (...a: unknown[]) => probeStreamTailsMock(...a),
}));

vi.mock('$lib/server/utils/ffmpeg-spawn.js', () => ({
    spawnFFmpegSafely: (opts: { args: string[] }) => spawnFFmpegSafelyMock(opts),
}));

// Sources are virtual ffmpeg fixtures; frame files still use the real filesystem.
vi.mock('$lib/server/utils/safe-fs.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/safe-fs.js')>()),
    safeStat: vi.fn(async (path: string) =>
        path.startsWith('/data/')
            ? { size: 1000, mtimeMs: 100, isFile: (): boolean => true }
            : (await import('node:fs/promises')).stat(path),
    ),
}));

vi.mock('./trickplay-storage.service.js', () => ({
    getBestTrickplayInfo: vi.fn(),
    saveSpriteSheet: (...a: unknown[]) => saveSpriteSheetMock(...a),
    deleteTrickplayGeneration: (...args: unknown[]) => deleteGenerationMock(...args),
    saveTrickplayManifest: (...a: unknown[]) => saveTrickplayManifestMock(...a),
    getTrickplayManifest: vi.fn(),
    hasTrickplay: (...a: unknown[]) => hasTrickplayMock(...a),
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
    getMediaItemForTrickplay: (...a: unknown[]) => getMediaItemForTrickplayMock(...a),
    findEpisodesForSeries: vi.fn().mockResolvedValue([]),
    findEpisodesForSeason: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/database/queries/media-files.queries.js', () => ({
    getFilesForMediaItem: (...a: unknown[]) => getFilesForMediaItemMock(...a),
    recordDecodeHealthIssue: (...a: unknown[]) => recordDecodeHealthIssueMock(...a),
    clearDecodeHealthIssues: (...a: unknown[]) => clearDecodeHealthIssuesMock(...a),
}));

/** Distinct, easily-recognised colour per frame index. */
function colorForIndex(i: number): { r: number; g: number; b: number } {
    return { r: 20 + i * 20, g: 60, b: 200 - i * 15 };
}

async function webpForIndex(i: number): Promise<Buffer> {
    return sharpReal({
        create: {
            width: SPRITE_W,
            height: SPRITE_H,
            channels: 3,
            background: colorForIndex(i),
        },
    })
        .webp({ lossless: true })
        .toBuffer();
}

/** Parse the frame index back out of `frame_0007.webp`. */
function frameIndexFromArgs(args: string[]): { index: number; outPath: string } {
    const outPath = args[args.length - 1];
    const match = /frame_(\d+)\.webp$/.exec(outPath);
    return { index: match ? Number(match[1]) - 1 : -1, outPath };
}

/**
 * Drive the mocked spawn: `decides(index)` returns what ffmpeg "did" for that
 * sample point. `'frame'` writes a real webp, `'empty'` reproduces the exact
 * prod behaviour (exit 0, 0-byte file), `'absent'` writes nothing at all,
 * `'truncated'` writes a PARTIAL webp and then throws — what a timeout or a
 * kill leaves behind mid-write — and `'throws'` fails before writing anything.
 */
function installSpawn(
    decides: (index: number) => 'frame' | 'empty' | 'absent' | 'truncated' | 'throws',
    stderrForEmpty = '[matroska,webm @ 0x7b7b] 0x00 at pos 8193 (0x2001) invalid as first byte of an EBML number',
): void {
    spawnFFmpegSafelyMock.mockImplementation(async (opts: { args: string[] }) => {
        const { index, outPath } = frameIndexFromArgs(opts.args);
        const decision = decides(index);
        if (decision === 'frame') {
            await writeFile(outPath, await webpForIndex(index));
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false, sizeExceeded: false };
        }
        if (decision === 'truncated') {
            // Non-zero length, but only the first bytes of the container.
            await writeFile(outPath, (await webpForIndex(index)).subarray(0, 12));
            throw new Error('ffmpeg timed out after 30000ms');
        }
        if (decision === 'throws') {
            throw new Error('spawn /usr/bin/ffmpeg ENOENT');
        }
        if (decision === 'empty') {
            // 🔴 The whole point: ffmpeg SUCCEEDS and leaves nothing behind.
            await writeFile(outPath, Buffer.alloc(0));
            return {
                exitCode: 0,
                stdout: '',
                stderr: stderrForEmpty,
                timedOut: false,
                sizeExceeded: false,
            };
        }
        return {
            exitCode: 0,
            stdout: '',
            stderr: stderrForEmpty,
            timedOut: false,
            sizeExceeded: false,
        };
    });
}

function installProbe(durationSeconds: number): void {
    execFileMock.mockImplementation((...args: unknown[]) => {
        const cb = args[args.length - 1] as (e: unknown, v: unknown) => void;
        cb(null, {
            stdout: JSON.stringify({
                format: { duration: String(durationSeconds) },
                streams: [{ width: 1920, height: 1080 }],
            }),
            stderr: '',
        });
    });
}

/** Read back the colour at the centre of one tile of a saved sheet. */
async function tileColor(
    sheet: Buffer,
    slot: number,
): Promise<{ r: number; g: number; b: number }> {
    const left = (slot % TILE_W) * SPRITE_W + Math.floor(SPRITE_W / 2);
    const top = Math.floor(slot / TILE_W) * SPRITE_H + Math.floor(SPRITE_H / 2);
    const { data } = await sharpReal(sheet)
        .extract({ left, top, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
    return { r: data[0], g: data[1], b: data[2] };
}

/** Colours survive a lossy webp round-trip only approximately. */
function expectCloseTo(
    actual: { r: number; g: number; b: number },
    expected: { r: number; g: number; b: number },
): void {
    expect(Math.abs(actual.r - expected.r)).toBeLessThanOrEqual(8);
    expect(Math.abs(actual.g - expected.g)).toBeLessThanOrEqual(8);
    expect(Math.abs(actual.b - expected.b)).toBeLessThanOrEqual(8);
}

let tempRoot: string;

beforeEach(async () => {
    vi.clearAllMocks();
    // Default: ffprobe gives no usable tail (as when it cannot run), so the
    // decision falls back to what the extraction itself decoded.
    probeStreamTailsMock.mockResolvedValue({
        videoEnd: null,
        audioEnd: null,
        hasAudio: false,
        endedPrematurely: false,
    });
    tempRoot = await mkdtemp(join(tmpdir(), 'trickplay-test-'));
    hasTrickplayMock.mockResolvedValue(false);
    saveSpriteSheetMock.mockResolvedValue(undefined);
    saveTrickplayManifestMock.mockResolvedValue(undefined);
    recordDecodeHealthIssueMock.mockResolvedValue(undefined);
    clearDecodeHealthIssuesMock.mockResolvedValue(undefined);
    getMediaItemForTrickplayMock.mockResolvedValue({ id: ITEM_ID, media_type: 'movie' });
    getFilesForMediaItemMock.mockResolvedValue([{ id: SOURCE_ID, file_path: VIDEO_PATH }]);
});

afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
});

async function run(signal?: AbortSignal): Promise<{
    success: boolean;
    generated: number;
    errors: number;
    permanent?: boolean;
    error?: string;
}> {
    const { generateTrickplayForMediaItem } = await import('./trickplay-generator.service.js');
    return generateTrickplayForMediaItem({} as never, ITEM_ID, {
        width: SPRITE_W,
        intervalMs: INTERVAL_MS,
        tileWidth: TILE_W,
        tileHeight: TILE_H,
        ...(signal ? { signal } : {}),
    });
}

describe('trickplay generation with empty ffmpeg output', () => {
    it('publishes params for the physical file as soon as generation completes', async () => {
        upsertParamsMock.mockClear();
        installProbe(60);
        installSpawn(() => 'frame');
        expect((await run()).success).toBe(true);
        expect(upsertParamsMock).toHaveBeenCalledWith(expect.anything(), ITEM_ID, SOURCE_ID, [
            expect.objectContaining({ width: SPRITE_W, thumbnailCount: 6, source: 'local' }),
        ]);
        expect(saveTrickplayManifestMock.mock.invocationCallOrder[0]).toBeLessThan(
            upsertParamsMock.mock.invocationCallOrder[0]!,
        );
    });

    it('succeeds when the final sample point yields a 0-byte file', async () => {
        // The prod-dominant case: `ceil(duration / interval)` puts the last
        // sample inside the final fraction of a second, where ffmpeg has no
        // frame left to give. 11 of 11 failing prod files looked exactly like
        // this. It must not fail the item.
        installProbe(100.05); // → 11 samples, index 10 lands at 100.0s
        installSpawn((i) => (i === 10 ? 'empty' : 'frame'));

        const result = await run();

        expect(result.success).toBe(true);
        expect(result.permanent).toBeUndefined();
        expect(result.generated).toBe(10);
        expect(result.errors).toBe(0);
    });

    it('refuses publication after source bytes change during extraction', async () => {
        installProbe(60);
        installSpawn(() => 'frame');
        const source = join(tempRoot, 'changing-source.mkv');
        await writeFile(source, Buffer.alloc(100, 1));
        getFilesForMediaItemMock.mockResolvedValue([{ id: SOURCE_ID, file_path: source }]);
        saveSpriteSheetMock.mockImplementationOnce(async () => {
            await writeFile(source, Buffer.alloc(101, 2));
        });
        expect((await run()).success).toBe(false);
        expect(saveTrickplayManifestMock).not.toHaveBeenCalled();
        const storage = await import('./trickplay-storage.service.js');
        expect(storage.deleteTrickplay).not.toHaveBeenCalled();
    });
    it('never hands sharp an empty buffer', async () => {
        installProbe(100.05);
        installSpawn((i) => (i === 10 ? 'empty' : 'frame'));

        // Before the fix this rejected with `Input Buffer is empty`.
        await expect(run()).resolves.toMatchObject({ success: true });
        expect(saveSpriteSheetMock).toHaveBeenCalled();
    });

    it('keeps every surviving frame in its own slot when one is missing', async () => {
        // 🔴 The player addresses tiles positionally
        // (`floor(time / interval)` → slot), so packing survivors together
        // would show the wrong scene for every tile after the gap.
        installProbe(60); // 6 samples → exactly one 3x2 sheet
        installSpawn((i) => (i === 2 ? 'empty' : 'frame'));

        const result = await run();
        expect(result.success).toBe(true);

        expect(saveSpriteSheetMock).toHaveBeenCalledTimes(1);
        const sheet = saveSpriteSheetMock.mock.calls[0][3] as Buffer;

        expectCloseTo(await tileColor(sheet, 0), colorForIndex(0));
        expectCloseTo(await tileColor(sheet, 1), colorForIndex(1));
        // Slot 2 is the hole — black background, NOT frame 3 slid forward.
        expectCloseTo(await tileColor(sheet, 2), { r: 0, g: 0, b: 0 });
        expectCloseTo(await tileColor(sheet, 3), colorForIndex(3));
        expectCloseTo(await tileColor(sheet, 4), colorForIndex(4));
        expectCloseTo(await tileColor(sheet, 5), colorForIndex(5));
    });

    it('does NOT write off when ffprobe itself could not run', async () => {
        // A spun-down disk, an unmounted share or a bad FFPROBE_PATH makes the probe
        // THROW. That says nothing about the file, so it must stay retryable —
        // otherwise one storage blip permanently writes off the whole swept slice
        // with a false container_unreadable diagnosis and no event to revive it.
        execFileMock.mockImplementation((...args: unknown[]) => {
            const cb = args[args.length - 1] as (e: unknown, v: unknown) => void;
            cb(Object.assign(new Error('spawn ETIMEDOUT'), { code: 'ETIMEDOUT' }), null);
        });
        installSpawn(() => 'frame');

        const result = await run();

        expect(result.success).toBe(false);
        expect(result.permanent).toBeUndefined();
        // No health issue: we learned nothing about the file.
        expect(recordDecodeHealthIssueMock).not.toHaveBeenCalled();
    });

    it('writes off a file ffprobe cannot get a duration for, permanently', async () => {
        // Prod 2026-08-27: an episode carried two file rows and one no longer
        // existed on disk. ffprobe returned no duration, and this path returned
        // `success:false` WITHOUT `permanent` — which routes through
        // resetRunningToPending, leaves `attempt` untouched, and puts the row
        // straight back to pending. The sweep re-enqueued it every 60s: 41 runs in
        // 42 minutes for one item, 7 items at once, and silent, because the branch
        // logged nothing. Retrying cannot make an unreadable file readable; the
        // stage's file.* invalidation brings it back if the file returns.
        installProbe(0);
        installSpawn(() => 'frame');

        const result = await run();

        expect(result.success).toBe(false);
        expect(result.permanent).toBe(true);
        expect(recordDecodeHealthIssueMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ fileId: SOURCE_ID, type: 'container_unreadable' }),
        );
    });

    it('reports a permanent failure and the verbatim reason when nothing decodes', async () => {
        // The Valerian case: broken EBML header, every frame 0 bytes, exit 0.
        // Retrying can never help, so the stage row must not go back to
        // pending — that is the loop this whole change exists to stop.
        installProbe(100);
        installSpawn(() => 'empty');

        const result = await run();

        expect(result.success).toBe(false);
        expect(result.permanent).toBe(true);
        expect(result.error).toContain('EBML');

        expect(recordDecodeHealthIssueMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                fileId: SOURCE_ID,
                type: 'container_unreadable',
                detail: expect.stringContaining('EBML'),
            }),
        );
        // The rotating `@ 0x…` allocation address must be stripped, or the
        // stored detail looks different on every attempt for one defect.
        const detail = recordDecodeHealthIssueMock.mock.calls[0][1].detail as string;
        expect(detail).not.toMatch(/0x7b7b/);
    });

    it('stops early and flags the file when the container over-reports duration', async () => {
        // Sugar Apple Fairy Tale S01E21 on prod: container claims 13600s for
        // 1360s of video, so 1225 of 1361 samples were pointless spawns.
        installProbe(13_600);
        installSpawn((i) => (i * 10 < 1360 ? 'frame' : 'empty'));

        const result = await run();

        expect(result.success).toBe(true);
        expect(result.generated).toBe(136);

        // 136 real frames + the 300s (30-sample) tail-stop run, nowhere near
        // the 1361 the naive duration implies.
        expect(spawnFFmpegSafelyMock.mock.calls.length).toBeLessThan(200);

        expect(recordDecodeHealthIssueMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                type: 'video_ends_early',
                expectedDuration: 13_600,
            }),
        );
    });

    it('does not record video_ends_early when ffprobe shows the video runs to the end (transient)', async () => {
        // The container claims 600 s and extraction stops at 300 s, but the
        // video really decodes to the end: the failure was transient.
        installProbe(600);
        installSpawn((i) => (i < 30 ? 'frame' : 'empty'));
        probeStreamTailsMock.mockResolvedValueOnce({
            videoEnd: 599.5,
            audioEnd: 599.8,
            hasAudio: true,
            endedPrematurely: false,
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(probeStreamTailsMock).toHaveBeenCalledWith(VIDEO_PATH);
        expect(recordDecodeHealthIssueMock).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ type: 'video_ends_early' }),
        );
        // Existing video_ends_early is left alone, not cleared.
        expect(clearDecodeHealthIssuesMock).toHaveBeenCalledWith(
            expect.anything(),
            SOURCE_ID,
            expect.not.arrayContaining(['video_ends_early']),
        );
    });

    it('persists nothing and records no health issue when the run is cancelled mid-extraction', async () => {
        // Admin Cancel (or a pod shutdown) fires after a few frames exist. The
        // unextracted tail is not a fact about the file, so the partial result
        // must not become a sprite sheet + manifest, nor a video_ends_early.
        installProbe(600); // 60 samples; the container and the file agree
        const controller = new AbortController();
        spawnFFmpegSafelyMock.mockImplementation(async (opts: { args: string[] }) => {
            const { index, outPath } = frameIndexFromArgs(opts.args);
            await writeFile(outPath, await webpForIndex(index));
            if (index === 4) controller.abort();
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false, sizeExceeded: false };
        });

        const result = await run(controller.signal);

        expect(result.success).toBe(false);
        expect(result.permanent).not.toBe(true);
        expect(saveSpriteSheetMock).not.toHaveBeenCalled();
        expect(saveTrickplayManifestMock).not.toHaveBeenCalled();
        expect(recordDecodeHealthIssueMock).not.toHaveBeenCalled();
    });

    it('crosses a short interior gap instead of stopping at it', async () => {
        // A damaged stretch well short of the tail-stop window must not be
        // mistaken for the end of the file — the frames after it are real.
        installProbe(600); // 60 samples
        installSpawn((i) => (i >= 20 && i < 25 ? 'empty' : 'frame'));

        const result = await run();

        expect(result.success).toBe(true);
        expect(result.generated).toBe(55);
        expect(recordDecodeHealthIssueMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ type: 'video_decode_gaps' }),
        );
    });

    it('treats a frame ffmpeg never wrote the same as an empty one', async () => {
        installProbe(60);
        installSpawn((i) => (i === 4 ? 'absent' : 'frame'));

        const result = await run();

        expect(result.success).toBe(true);
        expect(result.generated).toBe(5);
    });

    it('clears stale decode issues once the file extracts cleanly', async () => {
        installProbe(60);
        installSpawn(() => 'frame');

        await run();

        expect(clearDecodeHealthIssuesMock).toHaveBeenCalledWith(
            expect.anything(),
            SOURCE_ID,
            expect.arrayContaining([
                'container_unreadable',
                'video_ends_early',
                'video_decode_gaps',
            ]),
        );
        expect(recordDecodeHealthIssueMock).not.toHaveBeenCalled();
    });
});

describe('a run that never completed is not the file being unreadable', () => {
    it('discards a truncated frame left behind by a killed ffmpeg', async () => {
        // `size > 0` was the only gate, and the catch above it assumed a
        // timeout leaves an EMPTY target. A kill mid-write leaves a partial
        // one: it passed the gate, sharp threw on the partial container, and
        // the item failed without the permanent flag — back into the loop.
        installProbe(60);
        installSpawn((i) => (i === 2 ? 'truncated' : 'frame'));

        const result = await run();

        expect(result.success).toBe(true);
        expect(result.generated).toBe(5);
        // The slot is a hole, exactly like a 0-byte frame's.
        const sheet = saveSpriteSheetMock.mock.calls[0][3] as Buffer;
        expectCloseTo(await tileColor(sheet, 3), colorForIndex(3));
    });

    it('does not write off a file whose ffmpeg never ran', async () => {
        // Zero frames because the binary is missing says nothing about the
        // FILE. Marking it container_unreadable would make it permanent, and
        // `file.contentChanged` can never rescue it — the file never changes.
        installProbe(60);
        installSpawn(() => 'throws');

        const result = await run();

        expect(result.success).toBe(false);
        expect(result.permanent).toBeUndefined();
        expect(recordDecodeHealthIssueMock).not.toHaveBeenCalled();
        expect(deleteGenerationMock).toHaveBeenCalledWith(
            SOURCE_ID,
            SPRITE_W,
            expect.stringMatching(/^[a-f0-9-]{36}$/),
            VIDEO_PATH,
        );
    });

    it('still writes off a file ffmpeg read cleanly and found nothing in', async () => {
        installProbe(60);
        installSpawn(() => 'empty');

        const result = await run();

        expect(result.permanent).toBe(true);
        expect(recordDecodeHealthIssueMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ fileId: SOURCE_ID, type: 'container_unreadable' }),
        );
    });
});

/** Make every ffmpeg spawn reject the way `spawnFFmpegSafely` does. */
function installRejectingSpawn(err: Error): void {
    spawnFFmpegSafelyMock.mockImplementation(async () => {
        throw err;
    });
}

function ffmpegError(
    stderr: string,
    exitCode: number | null,
    extra: Record<string, unknown> = {},
): Error {
    return Object.assign(new Error(stderr.trim() || `FFmpeg exited with code ${exitCode}`), {
        name: 'FFmpegError',
        exitCode,
        stderr,
        timedOut: false,
        sizeExceeded: false,
        ...extra,
    });
}

describe('an ffmpeg that ran and cannot decode the input is the file, not the environment', () => {
    // Prod: an MKV with ~27 font attachment streams whose selected "video"
    // stream has codec none. ffmpeg exits 1 on every frame, which was counted
    // as a spawn failure, so the stage row went back to pending every hour.
    const NO_DECODER_STDERR =
        '[vist#0:0/none @ 0x55d0c8e0] Decoding requested, but no decoder found for: none\n' +
        'Error opening output file /tmp/trickplay-temp/a/a/frame_0001.webp.\n' +
        'Error opening output files: Invalid argument\n';

    it('writes off a file whose stream has no decoder, permanently', async () => {
        installProbe(60);
        installRejectingSpawn(ffmpegError(NO_DECODER_STDERR, 234));

        const result = await run();

        expect(result.success).toBe(false);
        expect(result.permanent).toBe(true);
        expect(recordDecodeHealthIssueMock).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ fileId: SOURCE_ID, type: 'container_unreadable' }),
        );
    });

    it.each(['Invalid data found when processing input', 'moov atom not found'])(
        'writes off a file whose ffmpeg reports "%s"',
        async (marker) => {
            installProbe(60);
            installRejectingSpawn(ffmpegError(`/data/x.mkv: ${marker}\n`, 183));

            const result = await run();

            expect(result.permanent).toBe(true);
        },
    );

    it('does NOT write off on "Invalid argument" alone (a bad temp dir looks the same)', async () => {
        installProbe(60);
        installRejectingSpawn(
            ffmpegError(
                'Error opening output file /tmp/x/frame_0001.webp.\n' +
                    'Error opening output files: Invalid argument\n',
                234,
            ),
        );

        const result = await run();

        expect(result.success).toBe(false);
        expect(result.permanent).toBeUndefined();
        expect(recordDecodeHealthIssueMock).not.toHaveBeenCalled();
    });

    it('keeps a timeout transient even if its stderr carries a decoder marker', async () => {
        installProbe(60);
        installRejectingSpawn(ffmpegError(NO_DECODER_STDERR, null, { timedOut: true }));

        const result = await run();

        expect(result.permanent).toBeUndefined();
        expect(recordDecodeHealthIssueMock).not.toHaveBeenCalled();
    });

    it('keeps a killed process (no exit code) transient', async () => {
        installProbe(60);
        installRejectingSpawn(ffmpegError(NO_DECODER_STDERR, null));

        const result = await run();

        expect(result.permanent).toBeUndefined();
        expect(recordDecodeHealthIssueMock).not.toHaveBeenCalled();
    });

    it('keeps a missing binary (ENOENT) transient', async () => {
        installProbe(60);
        installRejectingSpawn(
            Object.assign(new Error('spawn /usr/bin/ffmpeg ENOENT'), { code: 'ENOENT' }),
        );

        const result = await run();

        expect(result.permanent).toBeUndefined();
        expect(recordDecodeHealthIssueMock).not.toHaveBeenCalled();
    });
});

describe('a corrupt source among several must not strand the healthy ones', () => {
    it('reaches and completes the healthy source in the SAME run as a fast, zero-frame permanent failure', async () => {
        // Regression test: the one-source-per-run loop used to count ANY
        // zero-frame `permanent` result that crossed SOURCE_WORK_THRESHOLD_MS
        // as "work done", exactly like a genuinely slow multi-minute source.
        // A large corrupt remux's truncated extraction pass (bounded by the
        // tail-stop guard, but still real seek+decode work) routinely clears
        // that bar while producing nothing, which burned the allowance and
        // broke the loop BEFORE the healthy second edition was ever tried —
        // every future run repeated exactly the same thing, so the good
        // edition never got sprites. The fix exempts a zero-frame permanent
        // result from the time-based branch, since the tail-stop guard
        // already bounds its cost far below the multi-minute grind the
        // allowance exists to protect against.
        const BAD_PATH = '/data/movies/Example (2020)/Corrupt-4K.mkv';
        const GOOD_PATH = '/data/movies/Example (2020)/Good-1080p.mkv';
        const BAD_ID = '33333333-3333-4333-8333-333333333333';
        const GOOD_ID = '44444444-4444-4444-8444-444444444444';

        installProbe(60); // 6 samples per source — one 3x2 sheet each

        // Simulate real wall-clock cost without an actual multi-second test
        // sleep: each Date.now() call advances the clock, so the bad source's
        // several internal timing checks add up to well over
        // SOURCE_WORK_THRESHOLD_MS (10s) by the time the run loop measures
        // its elapsed time — the "large remux" case the finding describes.
        let clock = 0;
        const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => (clock += 6_000));

        try {
            spawnFFmpegSafelyMock.mockImplementation(async (opts: { args: string[] }) => {
                const { index, outPath } = frameIndexFromArgs(opts.args);
                if (opts.args.includes(BAD_PATH)) {
                    // Every attempt on the corrupt source fails exactly like a
                    // broken EBML header: exit 0, 0-byte file.
                    await writeFile(outPath, Buffer.alloc(0));
                    return {
                        exitCode: 0,
                        stdout: '',
                        stderr: '[matroska] broken EBML header',
                        timedOut: false,
                        sizeExceeded: false,
                    };
                }
                await writeFile(outPath, await webpForIndex(index));
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                    timedOut: false,
                    sizeExceeded: false,
                };
            });

            getFilesForMediaItemMock.mockResolvedValue([
                { id: BAD_ID, file_path: BAD_PATH },
                { id: GOOD_ID, file_path: GOOD_PATH },
            ]);

            const { generateTrickplayForMediaItem } =
                await import('./trickplay-generator.service.js');
            const result = (await generateTrickplayForMediaItem({} as never, ITEM_ID, {
                width: SPRITE_W,
                intervalMs: INTERVAL_MS,
                tileWidth: TILE_W,
                tileHeight: TILE_H,
            })) as { generated: number; errors: number; sourcesRemaining: number };

            // Both sources were processed in this ONE run — the corrupt
            // source did not strand the healthy one behind it.
            expect(result.sourcesRemaining).toBe(0);
            expect(result.generated).toBe(6);
            expect(result.errors).toBe(1);

            // The healthy source's sheet was actually persisted, not just
            // counted — the whole point is that it gets sprites.
            expect(saveSpriteSheetMock).toHaveBeenCalledTimes(1);
            expect(recordDecodeHealthIssueMock).toHaveBeenCalledWith(
                expect.anything(),
                expect.objectContaining({ fileId: BAD_ID, type: 'container_unreadable' }),
            );
        } finally {
            dateNowSpy.mockRestore();
        }
    });
});
