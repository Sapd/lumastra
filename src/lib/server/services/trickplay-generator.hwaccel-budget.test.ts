// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Trickplay: hardware decode, per-frame budgets, and one-source-per-run.
 *
 * All four behaviours here exist because of the same prod incident (2026-08-21):
 * six long movies that each carry a 1080p AND a 4K edition failed
 * `trickplay-generation` every ~35 minutes for a full day and never persisted a
 * single sprite sheet. The causes compounded —
 *
 *   1. one run tried to do EVERY source of an item inside one 30-minute cap,
 *      while a single 4K source is a 15-60 minute job;
 *   2. the per-frame ffmpeg ceiling was 15s, calibrated on a ~0.3s 1080p frame,
 *      while a 4K AV1 frame measured 9.4-12.5s — so good frames were being
 *      discarded as failures;
 *   3. frames were decoded in software when the box had an idle GPU that does
 *      the same frame 7-18x faster;
 *   4. 4 runs x 4 frames x 4 ffmpeg threads asked 20 cores for 64 threads,
 *      which is what pushed (2) over its ceiling in the first place.
 *
 * — and the loop was closed by the watchdog kill discarding all in-flight work,
 * so every retry started from frame zero. These tests pin each piece.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import sharpReal from 'sharp';

vi.mock('$lib/server/database/queries/trickplay-params.queries.js', () => ({
    deleteNonLocalTrickplayParams: vi.fn().mockResolvedValue(undefined),
    upsertTrickplayParams: vi.fn().mockResolvedValue(undefined),
}));

const execFileMock = vi.fn();
const spawnFFmpegSafelyMock = vi.fn();
const saveSpriteSheetMock = vi.fn();
const saveTrickplayManifestMock = vi.fn();
const hasTrickplayMock = vi.fn();
const safeExistsMock = vi.fn();
const getFilesForMediaItemMock = vi.fn();
const getMediaItemForTrickplayMock = vi.fn();

const ITEM_ID = '22222222-2222-4222-8222-222222222222';
const SOURCE_HD = '11111111-1111-4111-8111-111111111111';
const SOURCE_4K = '33333333-3333-4333-8333-333333333333';
const PATH_HD = '/data/movies/Example (2020)/Example - Bluray-1080p.mkv';
const PATH_4K = '/data/4kmovies/Example (2020)/Example - Bluray-2160p.mkv';
const RENDER_NODE = '/dev/dri/renderD128';

const INTERVAL_MS = 10_000;
const SPRITE_W = 32;
const SPRITE_H = 18;
const TILE_W = 3;
const TILE_H = 2;

const configMock = {
    FFPROBE_PATH: '/usr/bin/ffprobe',
    FFMPEG_PATH: '/usr/bin/ffmpeg',
    TRICKPLAY_ENABLED: true,
    TRICKPLAY_INTERVAL_MS: INTERVAL_MS,
    TRICKPLAY_TILE_WIDTH: TILE_W,
    TRICKPLAY_TILE_HEIGHT: TILE_H,
    TRICKPLAY_WIDTH: SPRITE_W,
    TRICKPLAY_QUALITY: 80,
    TRICKPLAY_PROVIDER: 'local_only',
    TRICKPLAY_HWACCEL: 'auto' as string,
    TRICKPLAY_HWACCEL_DEVICE: RENDER_NODE,
    TRICKPLAY_PER_FRAME_CONCURRENCY: 4,
    BASE_PATH: '/tmp',
};

vi.mock('$lib/server/config.js', () => ({
    config: configMock,
    FEATURE_PER_TASK_QUEUES: false,
    LUMASTRA_FFMPEG_THREADS: 4,
    LUMASTRA_CONCURRENCY_CPU: 4,
}));

vi.mock('$lib/server/utils/cpu-budget.js', () => ({
    // 20 cores is the real prod box; with 4 runs x 4 frames in flight that is
    // exactly one thread per frame, which is the point of the budget.
    getCpuBudgetCores: () => 20,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

vi.mock('child_process', () => ({
    execFile: (...args: unknown[]) => execFileMock(...args),
}));

vi.mock('$lib/server/utils/ffmpeg-spawn.js', () => ({
    spawnFFmpegSafely: (opts: unknown) => spawnFFmpegSafelyMock(opts),
}));

// Spread the real module: the playlist-body source guard sniffs the input
// under the real `withFsGuard`, and a nonexistent test path is left to ffmpeg.
vi.mock('$lib/server/utils/safe-fs.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/utils/safe-fs.js')>()),
    safeExists: (...a: unknown[]) => safeExistsMock(...a),
    safeStat: vi.fn(async (path: string) =>
        path.startsWith('/data/')
            ? { size: 1000, mtimeMs: 100, isFile: (): boolean => true }
            : path === '/mock-sprite.webp'
              ? { size: 6, isFile: (): boolean => true }
              : (await import('node:fs/promises')).stat(path),
    ),
    safeReaddir: vi.fn().mockResolvedValue([]),
}));

vi.mock('./trickplay-storage.service.js', () => ({
    getBestTrickplayInfo: vi.fn(),
    getSpriteSheet: vi.fn().mockResolvedValue(Buffer.from('sprite')),
    getSpriteSheetPath: vi.fn().mockResolvedValue('/mock-sprite.webp'),
    saveSpriteSheet: (...a: unknown[]) => saveSpriteSheetMock(...a),
    deleteTrickplayGeneration: vi.fn().mockResolvedValue(undefined),
    saveTrickplayManifest: (...a: unknown[]) => saveTrickplayManifestMock(...a),
    getTrickplayManifest: vi.fn(async () => ({
        version: '1.0',
        format: 'webp',
        width: SPRITE_W,
        height: SPRITE_H,
        tileWidth: TILE_W,
        tileHeight: TILE_H,
        interval: INTERVAL_MS,
        thumbnailCount: 1,
        sheets: [{ index: 0, filename: '0.webp', thumbnailCount: 1 }],
        reuse: {
            sampledHash: '1'.repeat(64),
            size: 1,
            mtimeMs: 1,
            quality: 80,
            spriteQuality: 80,
            providerId: 'local-trickplay',
        },
    })),
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
    recordDecodeHealthIssue: vi.fn().mockResolvedValue(undefined),
    clearDecodeHealthIssues: vi.fn().mockResolvedValue(undefined),
}));

// ── helpers ────────────────────────────────────────────────────────────────

interface SpawnCall {
    args: string[];
    timeout: number;
}

/** Every spawn the run made, in order. */
function spawnCalls(): SpawnCall[] {
    return spawnFFmpegSafelyMock.mock.calls.map((c) => c[0] as SpawnCall);
}

function isHardware(call: SpawnCall): boolean {
    return call.args.includes('-hwaccel');
}

/** The input path a spawn was pointed at (`-i <path>`). */
function inputPath(call: SpawnCall): string {
    return call.args[call.args.indexOf('-i') + 1];
}

/** Value of a flag in an argv, or undefined. */
function flag(call: SpawnCall, name: string): string | undefined {
    const i = call.args.indexOf(name);
    return i === -1 ? undefined : call.args[i + 1];
}

async function realWebp(): Promise<Buffer> {
    return sharpReal({
        create: { width: SPRITE_W, height: SPRITE_H, channels: 3, background: '#336699' },
    })
        .webp({ lossless: true })
        .toBuffer();
}

/**
 * Drive the mocked spawn. `decide` says what ffmpeg "did" for a given call —
 * `'frame'` writes a real webp, `'empty'` reproduces the prod behaviour
 * (exit 0, 0-byte file, which is how a GPU that cannot decode this source
 * shows up).
 */
function installSpawn(decide: (call: SpawnCall) => 'frame' | 'empty'): void {
    spawnFFmpegSafelyMock.mockImplementation(async (opts: SpawnCall) => {
        const outPath = opts.args[opts.args.length - 1];
        if (decide(opts) === 'frame') {
            await writeFile(outPath, await realWebp());
        } else {
            await writeFile(outPath, Buffer.alloc(0));
        }
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, sizeExceeded: false };
    });
}

function installProbe(
    durationSeconds: number,
    videoWidth = 1920,
    codecFor: (path: string) => string = () => 'hevc',
    pixFmtFor: (path: string) => string = () => 'yuv420p',
): void {
    execFileMock.mockImplementation((...args: unknown[]) => {
        const argv = (args[1] as string[]) ?? [];
        const path = argv[argv.length - 1] ?? '';
        const cb = args[args.length - 1] as (e: unknown, v: unknown) => void;
        cb(null, {
            stdout: JSON.stringify({
                format: { duration: String(durationSeconds) },
                streams: [
                    {
                        width: videoWidth,
                        height: Math.round((videoWidth * 9) / 16),
                        codec_name: codecFor(path),
                        pix_fmt: pixFmtFor(path),
                    },
                ],
            }),
            stderr: '',
        });
    });
}

let tempRoot: string;

beforeEach(async () => {
    vi.clearAllMocks();
    tempRoot = await mkdtemp(join(tmpdir(), 'trickplay-hw-'));
    configMock.TRICKPLAY_HWACCEL = 'auto';
    configMock.TRICKPLAY_PER_FRAME_CONCURRENCY = 4;
    hasTrickplayMock.mockResolvedValue(false);
    saveSpriteSheetMock.mockResolvedValue(undefined);
    saveTrickplayManifestMock.mockResolvedValue(undefined);
    // Default: a render node is present, and nothing else asks safeExists.
    safeExistsMock.mockImplementation(async (p: string) => p === RENDER_NODE);
    getMediaItemForTrickplayMock.mockResolvedValue({ id: ITEM_ID, media_type: 'movie' });
    getFilesForMediaItemMock.mockResolvedValue([{ id: SOURCE_HD, file_path: PATH_HD }]);
    installProbe(50); // 5 sample points
    installSpawn(() => 'frame');

    const { resetHwaccelProbe } = await import('./trickplay-generator.service.js');
    resetHwaccelProbe();
});

afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
});

interface RunResult {
    success: boolean;
    generated: number;
    skipped: number;
    errors: number;
    sourcesRemaining: number;
}

interface DenyList {
    isDenied(codec: string): Promise<boolean>;
    deny(codec: string): Promise<void>;
}

async function run(
    opts: { deadlineAt?: number; force?: boolean; hwaccelDenyList?: DenyList } = {},
): Promise<RunResult> {
    const { generateTrickplayForMediaItem } = await import('./trickplay-generator.service.js');
    return generateTrickplayForMediaItem({} as never, ITEM_ID, {
        width: SPRITE_W,
        intervalMs: INTERVAL_MS,
        tileWidth: TILE_W,
        tileHeight: TILE_H,
        ...opts,
    });
}

// ── hardware decode ────────────────────────────────────────────────────────

describe('hardware-accelerated frame extraction', () => {
    it('decodes on the GPU when a render node is present, downloading each frame back', async () => {
        await run();

        const calls = spawnCalls();
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every(isHardware)).toBe(true);
        expect(flag(calls[0], '-hwaccel')).toBe('vaapi');
        expect(flag(calls[0], '-hwaccel_device')).toBe(RENDER_NODE);
        expect(flag(calls[0], '-hwaccel_output_format')).toBe('vaapi');
        // 🔴 Without the explicit hwdownload the encoder is handed a GPU
        // surface and the frame never materialises.
        expect(flag(calls[0], '-vf')).toBe(`scale_vaapi=w=${SPRITE_W}:h=-2,hwdownload,format=nv12`);
    });

    it('builds a QSV chain that a real Intel GPU accepts', async () => {
        // 🔴 Pinned because the first version of this argv failed on EVERY
        // codec against an Arc A380, and nothing caught it: `qsv` is never
        // auto-selected, so the whole path was code-review-only until someone
        // set TRICKPLAY_HWACCEL=qsv and silently got software for everything.
        // Both details below are load-bearing — see buildFrameArgs.
        configMock.TRICKPLAY_HWACCEL = 'qsv';

        await run();

        const call = spawnCalls()[0];
        expect(flag(call, '-hwaccel')).toBe('qsv');
        expect(flag(call, '-qsv_device')).toBe(RENDER_NODE);
        // `-2` is rejected by scale_qsv; `format=nv12` on the scaler is what
        // lets a 10-bit p010 surface survive hwdownload.
        expect(flag(call, '-vf')).toBe(
            `scale_qsv=w=${SPRITE_W}:h=-1:format=nv12,hwdownload,format=nv12`,
        );
    });

    it('seeks on the INPUT side in every mode', async () => {
        // -ss after -i decodes from the start of the file, which is both far
        // slower and the long continuous decode that silently produced stale
        // frames before 2026-08-13.
        await run();
        for (const call of spawnCalls()) {
            expect(call.args.indexOf('-ss')).toBeLessThan(call.args.indexOf('-i'));
        }
    });

    it('stays on the CPU when no render node exists', async () => {
        safeExistsMock.mockResolvedValue(false);

        await run();

        const calls = spawnCalls();
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.some(isHardware)).toBe(false);
        expect(flag(calls[0], '-vf')).toBe(
            `scale=${SPRITE_W}:-2:force_original_aspect_ratio=decrease`,
        );
    });

    it('stays on the CPU when an operator turns hardware decode off', async () => {
        configMock.TRICKPLAY_HWACCEL = 'off';

        await run();

        expect(spawnCalls().some(isHardware)).toBe(false);
    });

    it('marks the probe attempt as an expected failure so it does not log as an incident', async () => {
        // 🔴 A probe failing IS the probe working. On prod the GPU cannot decode
        // MPEG-4 Part 2, so every Xvid file produced a `libwebp: Could not open
        // encoder` ERROR before falling back and succeeding — 76 of them in half
        // an hour, which is exactly how a real error gets buried. Another
        // session read those logs and concluded the ffmpeg build had no webp
        // encoder at all.
        await run();

        const calls = spawnFFmpegSafelyMock.mock.calls.map(
            (c) => c[0] as SpawnCall & { expectFailure?: boolean },
        );
        expect(calls[0].expectFailure).toBe(true);
        // Only the probe is exempt — a failure in the main pass is real news.
        expect(calls.slice(1).every((c) => c.expectFailure !== true)).toBe(true);
    });

    it('probes with ONE frame, not a whole batch, before trusting the GPU', async () => {
        await run();

        // The first spawn must have completed before any other was issued —
        // otherwise a broken GPU costs `concurrency` wasted frames per source
        // instead of one.
        const calls = spawnCalls();
        expect(calls[0].args[calls[0].args.length - 1]).toMatch(/frame_0001\.webp$/);
    });
});

describe('falling back when the GPU cannot decode a source', () => {
    it('re-runs the probe frame in software and switches the whole source over', async () => {
        // Hardware yields nothing; software yields a frame. That combination is
        // the only proof that the GPU — not the file — is at fault.
        installSpawn((call) => (isHardware(call) ? 'empty' : 'frame'));

        const result = await run();

        const calls = spawnCalls();
        // One hardware attempt, one software control, then software for the rest.
        expect(isHardware(calls[0])).toBe(true);
        expect(isHardware(calls[1])).toBe(false);
        expect(calls.slice(1).some(isHardware)).toBe(false);
        // 🔴 And the source still completes — a broken GPU must cost one frame,
        // not the item.
        expect(result.success).toBe(true);
        expect(result.errors).toBe(0);
        expect(result.generated).toBe(5);
    });

    it('does not re-probe on later sources once hardware is known bad', async () => {
        installSpawn((call) => (isHardware(call) ? 'empty' : 'frame'));
        getFilesForMediaItemMock.mockResolvedValue([
            { id: SOURCE_HD, file_path: PATH_HD },
            { id: SOURCE_4K, file_path: PATH_4K },
        ]);

        await run(); // source 1 discovers the GPU is broken
        spawnFFmpegSafelyMock.mockClear();
        hasTrickplayMock.mockImplementation(async (id: string) => id === SOURCE_HD);
        await run(); // source 2, same process

        const calls = spawnCalls();
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.some(isHardware)).toBe(false);
    });

    it('re-probes rather than committing when BOTH paths come back empty', async () => {
        // A timestamp with no picture says nothing about the decoder, so a
        // single inconclusive probe must not settle the question either way.
        installSpawn((call) => {
            const out = call.args[call.args.length - 1];
            return /frame_0001\.webp$/.test(out) ? 'empty' : 'frame';
        });

        await run();

        const calls = spawnCalls();
        // Frame 1 probed twice (hardware, then the software control), both
        // empty → inconclusive → frame 2 is probed again rather than the mode
        // being decided on no evidence.
        expect(isHardware(calls[0])).toBe(true);
        expect(isHardware(calls[1])).toBe(false);
        expect(isHardware(calls[2])).toBe(true);
        // Frame 2 decodes on hardware, which settles it; the rest stay there.
        const late = calls.filter((c) => !/frame_000[12]\.webp$/.test(c.args[c.args.length - 1]));
        expect(late.length).toBeGreaterThan(0);
        expect(late.every(isHardware)).toBe(true);
    });

    it('falls back to SOFTWARE when the probe budget runs out undecided', async () => {
        // 🔴 The dangerous shape: a file whose first frames genuinely have no
        // picture (black leader) on a box where hardware is ALSO broken. Every
        // probe is inconclusive, so nothing ever proves the GPU bad — and
        // staying on it would fail every remaining frame and get a
        // software-decodable file written off as an unreadable container.
        // Software is the always-available path, so it is the only safe
        // landing place when the evidence runs out.
        installSpawn((call) => {
            const out = call.args[call.args.length - 1];
            const early = /frame_000[123]\.webp$/.test(out);
            if (early) return 'empty'; // both paths empty → inconclusive
            return isHardware(call) ? 'empty' : 'frame';
        });

        const result = await run();

        const late = spawnCalls().filter(
            (c) => !/frame_000[123]\.webp$/.test(c.args[c.args.length - 1]),
        );
        expect(late.length).toBeGreaterThan(0);
        expect(late.some(isHardware)).toBe(false);
        // And the file is NOT condemned — it decodes fine in software.
        expect(result.generated).toBeGreaterThan(0);
    });
});

// ── per-frame timeout ──────────────────────────────────────────────────────

/** The software 4K ceiling, asserted directly in the test above it. */
const perFrameSoftware4kCeiling = 90_000;

describe('per-frame ffmpeg ceiling', () => {
    it('gives a 4K software frame far more than the old flat 15s', async () => {
        // 🔴 The regression this pins: a 4K AV1 frame measured 9.4-12.5s on an
        // idle prod box and well past 15s under normal concurrency, so real
        // frames were being killed and scored as failures on every retry.
        configMock.TRICKPLAY_HWACCEL = 'off';
        installProbe(50, 3840);

        await run();

        for (const call of spawnCalls()) {
            expect(call.timeout).toBeGreaterThan(15_000);
            expect(call.timeout).toBe(90_000);
        }
    });

    it('keeps the ordinary ceiling for an HD software source', async () => {
        configMock.TRICKPLAY_HWACCEL = 'off';
        installProbe(50, 1920);

        await run();

        expect(spawnCalls()[0].timeout).toBe(30_000);
    });

    it('keeps the hardware ceiling well under the software one', async () => {
        // The GPU is shared with live transcodes, so it does have a
        // slow-but-fine case — but a hardware frame that needs a minute is
        // broken, and waiting that long only delays the software fallback.
        installProbe(50, 3840);

        await run();

        const t = spawnCalls()[0].timeout;
        expect(t).toBeGreaterThan(30_000);
        expect(t).toBeLessThan(perFrameSoftware4kCeiling);
    });
});

// ── thread budget ──────────────────────────────────────────────────────────

describe('ffmpeg thread budget', () => {
    it('divides the core budget across every frame that can be in flight', async () => {
        // 20 cores / (4 concurrent runs x 4 frames each) = 1. The old arrangement
        // asked for 4 threads per frame — 64 on a 20-core box — and the resulting
        // contention is what pushed frames past their ceiling.
        configMock.TRICKPLAY_HWACCEL = 'off';

        await run();

        expect(flag(spawnCalls()[0], '-threads')).toBe('1');
    });

    it('gives more threads per frame when fewer frames run at once', async () => {
        configMock.TRICKPLAY_HWACCEL = 'off';
        configMock.TRICKPLAY_PER_FRAME_CONCURRENCY = 1;

        await run();

        // 20 / (4 x 1) = 5, clamped to the global ffmpeg cap of 4.
        expect(flag(spawnCalls()[0], '-threads')).toBe('4');
    });

    it('asks for a single thread on the GPU path', async () => {
        // Decode happens on the GPU; extra CPU threads buy nothing.
        await run();

        expect(flag(spawnCalls()[0], '-threads')).toBe('1');
    });

    it('always passes -threads explicitly so the global injector stands aside', async () => {
        await run();

        for (const call of spawnCalls()) {
            expect(call.args).toContain('-threads');
        }
    });
});

// ── one source per run ─────────────────────────────────────────────────────

describe('one working source per run', () => {
    beforeEach(() => {
        getFilesForMediaItemMock.mockResolvedValue([
            { id: SOURCE_4K, file_path: PATH_4K },
            { id: SOURCE_HD, file_path: PATH_HD },
        ]);
    });

    async function completeFirstSource(): Promise<void> {
        const path = join(tempRoot, 'completed-4k.mkv');
        await writeFile(path, Buffer.alloc(128, 1));
        const storage = await import('./trickplay-storage.service.js');
        const { fingerprintTrickplaySource } = await import('./trickplay-reclaim.service.js');
        const manifest = await storage.getTrickplayManifest(SOURCE_4K, SPRITE_W);
        manifest!.reuse = {
            ...(await fingerprintTrickplaySource(path)),
            quality: 80,
            spriteQuality: 80,
            providerId: 'local-trickplay',
        };
        vi.mocked(storage.getTrickplayManifest).mockResolvedValueOnce(manifest);
        hasTrickplayMock.mockImplementation(async (id: string) => id === SOURCE_4K);
        getFilesForMediaItemMock.mockResolvedValue([
            { id: SOURCE_4K, file_path: path },
            { id: SOURCE_HD, file_path: PATH_HD },
        ]);
    }

    it('generates the first source only and reports the rest as remaining', async () => {
        // 🔴 The core fix. Both editions in one run cannot fit one cap, and the
        // watchdog kill that followed discarded everything — including the cheap
        // 1080p edition, which the run never even reached.
        const result = await run();

        expect(result.success).toBe(true);
        expect(result.sourcesRemaining).toBe(1);
        expect(new Set(spawnCalls().map(inputPath))).toEqual(new Set([PATH_4K]));
    });

    it('picks up the next source on the following run', async () => {
        await completeFirstSource();

        const result = await run();

        expect(result.success).toBe(true);
        // 🔴 Zero is what lets the caller finally write the coverage row.
        expect(result.sourcesRemaining).toBe(0);
        expect(new Set(spawnCalls().map(inputPath))).toEqual(new Set([PATH_HD]));
    });

    it('does not spend the allowance on sources that were already done', async () => {
        // A skipped source costs a fingerprint check, not a budget slot — otherwise an item
        // whose first edition is finished would need an extra sweep cycle for
        // no reason.
        await completeFirstSource();

        const result = await run();

        expect(result.skipped).toBe(1);
        expect(result.generated).toBeGreaterThan(0);
        expect(result.sourcesRemaining).toBe(0);
    });

    it('reports nothing remaining for a single-source item', async () => {
        getFilesForMediaItemMock.mockResolvedValue([{ id: SOURCE_HD, file_path: PATH_HD }]);

        const result = await run();

        expect(result.sourcesRemaining).toBe(0);
    });
});

// ── deadline ───────────────────────────────────────────────────────────────

describe('stopping before the watchdog does', () => {
    it('refuses to start a source it cannot finish, and says so', async () => {
        // Being killed mid-source persists nothing, so a doomed attempt is
        // strictly worse than no attempt.
        getFilesForMediaItemMock.mockResolvedValue([
            { id: SOURCE_4K, file_path: PATH_4K },
            { id: SOURCE_HD, file_path: PATH_HD },
        ]);

        const result = await run({ deadlineAt: Date.now() + 1_000 });

        expect(spawnFFmpegSafelyMock).not.toHaveBeenCalled();
        expect(result.sourcesRemaining).toBe(2);
        // Nothing failed — there is simply work left, which the caller must not
        // mistake for coverage.
        expect(result.success).toBe(true);
        expect(result.errors).toBe(0);
    });

    it('proceeds normally with a deadline comfortably far out', async () => {
        const result = await run({ deadlineAt: Date.now() + 60 * 60 * 1000 });

        expect(result.generated).toBe(5);
        expect(result.sourcesRemaining).toBe(0);
    });

    it('runs unbounded when no deadline is supplied', async () => {
        const result = await run();

        expect(result.generated).toBe(5);
    });
});

// ── environment failures must never be persisted as a finished trickplay ───

describe('frames whose ffmpeg never completed', () => {
    it('retries them in software rather than leaving holes in the sheet', async () => {
        // 🔴 The shape that motivates this: a GPU that survives the
        // single-frame probe and then dies under `concurrency` parallel
        // decodes. Frame 1 is usable, everything after it is a spawn failure,
        // and the tail-stop guard would bank a ONE-TILE sprite sheet as a
        // finished trickplay that `hasTrickplay()` honours forever.
        let hwCalls = 0;
        spawnFFmpegSafelyMock.mockImplementation(async (opts: SpawnCall) => {
            const outPath = opts.args[opts.args.length - 1];
            if (isHardware(opts)) {
                hwCalls++;
                if (hwCalls > 1) throw new Error('vaapi: failed to allocate surface');
            }
            await writeFile(outPath, await realWebp());
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false, sizeExceeded: false };
        });

        const result = await run();

        // Every sample point ends up rendered, via the software rescue.
        expect(result.generated).toBe(5);
        expect(result.errors).toBe(0);
        expect(result.success).toBe(true);
        expect(saveTrickplayManifestMock).toHaveBeenCalled();
    });

    it('latches the codec off once software rescues what hardware dropped', async () => {
        let hwCalls = 0;
        spawnFFmpegSafelyMock.mockImplementation(async (opts: SpawnCall) => {
            const outPath = opts.args[opts.args.length - 1];
            if (isHardware(opts)) {
                hwCalls++;
                if (hwCalls > 1) throw new Error('vaapi: failed to allocate surface');
            }
            await writeFile(outPath, await realWebp());
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false, sizeExceeded: false };
        });

        await run();
        spawnFFmpegSafelyMock.mockClear();
        installSpawn(() => 'frame');
        await run();

        expect(spawnCalls().some(isHardware)).toBe(false);
    });

    it('demotes mid-extraction when the GPU dies part-way, and still finishes the source', async () => {
        // 🔴 The truncation trap. A long run of spawn failures used to trip the
        // same tail-stop as a run of EMPTY outputs — which means "the file's
        // video ends here", a fact about the media. Treating a dead GPU that
        // way stops the extraction and persists a sheet covering a fraction of
        // the movie, which `hasTrickplay()` then honours forever. Spawn
        // failures must demote and continue, not stop and bank.
        installProbe(500); // 50 sample points; tail-stop threshold is 30
        let hwCalls = 0;
        spawnFFmpegSafelyMock.mockImplementation(async (opts: SpawnCall) => {
            const outPath = opts.args[opts.args.length - 1];
            if (isHardware(opts) && hwCalls++ >= 1) {
                throw new Error('vaapi: failed to allocate surface');
            }
            await writeFile(outPath, await realWebp());
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false, sizeExceeded: false };
        });

        const result = await run();

        // Every sample point covered, not just the ones before the GPU died.
        expect(result.generated).toBe(50);
        expect(result.success).toBe(true);
        expect(saveTrickplayManifestMock).toHaveBeenCalled();
    });

    it('refuses to persist a sheet when the rescue cannot recover them either', async () => {
        // Both paths fail: the ENVIRONMENT is broken, not the file. Persisting
        // here would write a near-empty manifest that is treated as done
        // forever; failing transiently sends the item back to `pending`.
        configMock.TRICKPLAY_HWACCEL = 'off';
        installProbe(500); // 50 sample points, well past the tolerance
        let n = 0;
        spawnFFmpegSafelyMock.mockImplementation(async (opts: SpawnCall) => {
            const outPath = opts.args[opts.args.length - 1];
            if (n++ === 0) {
                await writeFile(outPath, await realWebp());
                return {
                    exitCode: 0,
                    stdout: '',
                    stderr: '',
                    timedOut: false,
                    sizeExceeded: false,
                };
            }
            throw new Error('FFmpeg operation timed out after 90000ms');
        });

        const result = await run();

        expect(saveTrickplayManifestMock).not.toHaveBeenCalled();
        expect(saveSpriteSheetMock).not.toHaveBeenCalled();
        expect(result.success).toBe(false);
        expect(result.generated).toBe(0);
    });

    it('does not bank a truncated sheet when the rescue succeeds but the run had already stopped', async () => {
        // 🔴 The subtle one. A burst of load makes every frame fail on its
        // first attempt; the run abandons at the tail-stop threshold, having
        // requested only ~32 of 50 sample points. The rescue pass then succeeds
        // on all of them, driving `spawnFailures` back to zero — so a guard
        // that looked only at the failure COUNT would happily persist a sheet
        // covering two-thirds of the movie and mark the source done forever.
        // The run must be judged on having been abandoned, not on the tally it
        // ended up with.
        configMock.TRICKPLAY_HWACCEL = 'off';
        installProbe(500); // 50 sample points; tail-stop threshold is 30
        const attempted = new Set<string>();
        spawnFFmpegSafelyMock.mockImplementation(async (opts: SpawnCall) => {
            const outPath = opts.args[opts.args.length - 1];
            if (!attempted.has(outPath)) {
                attempted.add(outPath);
                throw new Error('FFmpeg operation timed out after 90000ms');
            }
            await writeFile(outPath, await realWebp());
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false, sizeExceeded: false };
        });

        const result = await run();

        expect(saveTrickplayManifestMock).not.toHaveBeenCalled();
        expect(result.success).toBe(false);
        // Transient, so the next run gets another go — NOT written off.
        expect(result).not.toHaveProperty('permanent');
    });

    it('tolerates a handful of flaky spawns on an otherwise good source', async () => {
        // A single unlucky timeout must not cost the whole source.
        configMock.TRICKPLAY_HWACCEL = 'off';
        installProbe(500);
        let failures = 0;
        spawnFFmpegSafelyMock.mockImplementation(async (opts: SpawnCall) => {
            const outPath = opts.args[opts.args.length - 1];
            if (/frame_0007\.webp$/.test(outPath) && failures++ < 2) {
                throw new Error('FFmpeg operation timed out after 90000ms');
            }
            await writeFile(outPath, await realWebp());
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false, sizeExceeded: false };
        });

        const result = await run();

        expect(result.success).toBe(true);
        expect(saveTrickplayManifestMock).toHaveBeenCalled();
    });
});

// ── admin force ────────────────────────────────────────────────────────────

describe('an explicit admin regenerate', () => {
    beforeEach(() => {
        getFilesForMediaItemMock.mockResolvedValue([
            { id: SOURCE_4K, file_path: PATH_4K },
            { id: SOURCE_HD, file_path: PATH_HD },
        ]);
    });

    it('regenerates EVERY source, not just the first', async () => {
        // 🔴 The one-source-per-run rule is there to make sweep-driven runs
        // finishable. A forced run has no second pass to rely on: a sweep
        // re-enqueue arrives WITHOUT force and skips every source on
        // `hasTrickplay`, so a half-done force silently leaves stale sprites
        // on the other edition while the admin UI reports success.
        const result = await run({ force: true });

        expect(new Set(spawnCalls().map(inputPath))).toEqual(new Set([PATH_4K, PATH_HD]));
        expect(result.sourcesRemaining).toBe(0);
    });

    it('still stops at the deadline rather than being killed', async () => {
        const result = await run({ force: true, deadlineAt: Date.now() + 1_000 });

        expect(spawnFFmpegSafelyMock).not.toHaveBeenCalled();
        expect(result.sourcesRemaining).toBe(2);
    });
});

describe('the hardware latch is scoped to the codec, not the box', () => {
    it('keeps using the GPU for a codec it can decode after another codec failed', async () => {
        // 🔴 GPU decode support is a property of the (card, codec, profile)
        // triple. A card with no AV1 path still does HEVC at 534ms/frame; a
        // process-wide latch would push every later HEVC source onto the
        // software path at one thread per frame — the 8.2s/frame regime this
        // whole change exists to escape — until the worker restarts.
        installProbe(50, 3840, (path) => (path.includes('2160p') ? 'av1' : 'hevc'));
        // Hardware is broken for AV1 only.
        spawnFFmpegSafelyMock.mockImplementation(async (opts: SpawnCall) => {
            const outPath = opts.args[opts.args.length - 1];
            const isAv1 = inputPath(opts).includes('2160p');
            if (isHardware(opts) && isAv1) {
                await writeFile(outPath, Buffer.alloc(0));
            } else {
                await writeFile(outPath, await realWebp());
            }
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false, sizeExceeded: false };
        });
        getFilesForMediaItemMock.mockResolvedValue([{ id: SOURCE_4K, file_path: PATH_4K }]);

        await run(); // AV1 source proves the GPU cannot do AV1
        expect(spawnCalls().some((c) => !isHardware(c))).toBe(true);

        spawnFFmpegSafelyMock.mockClear();
        getFilesForMediaItemMock.mockResolvedValue([{ id: SOURCE_HD, file_path: PATH_HD }]);
        await run(); // HEVC source, same process

        const calls = spawnCalls();
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every(isHardware)).toBe(true);
    });

    it('keeps using the GPU for an 8-bit source of a codec whose 10-bit profile failed', async () => {
        // 🔴 Finding #6: GPU decode support is a property of the (card, codec,
        // PROFILE) triple, not (card, codec) alone. A VAAPI driver commonly
        // implements HEVC Main (8-bit) but not Main10 (10-bit) — the SAME
        // codec name, different pix_fmt. Keying the deny list on codec alone
        // would let one 10-bit failure push every 8-bit source of the same
        // codec onto the software path for the full 6h TTL, library-wide.
        installProbe(
            50,
            3840,
            () => 'hevc',
            (path) => (path.includes('2160p') ? 'yuv420p10le' : 'yuv420p'),
        );
        // Hardware is broken for the 10-bit source only.
        spawnFFmpegSafelyMock.mockImplementation(async (opts: SpawnCall) => {
            const outPath = opts.args[opts.args.length - 1];
            const is10Bit = inputPath(opts).includes('2160p');
            if (isHardware(opts) && is10Bit) {
                await writeFile(outPath, Buffer.alloc(0));
            } else {
                await writeFile(outPath, await realWebp());
            }
            return { exitCode: 0, stdout: '', stderr: '', timedOut: false, sizeExceeded: false };
        });
        getFilesForMediaItemMock.mockResolvedValue([{ id: SOURCE_4K, file_path: PATH_4K }]);

        await run(); // 10-bit HEVC source proves the GPU cannot do Main10
        expect(spawnCalls().some((c) => !isHardware(c))).toBe(true);

        spawnFFmpegSafelyMock.mockClear();
        getFilesForMediaItemMock.mockResolvedValue([{ id: SOURCE_HD, file_path: PATH_HD }]);
        await run(); // 8-bit HEVC source, same process

        const calls = spawnCalls();
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.every(isHardware)).toBe(true);
    });
});

// ── the deny list survives the run ─────────────────────────────────────────

describe('remembering what the GPU cannot decode, across runs', () => {
    /** Minimal stand-in for the task system's NamespacedCache. */
    function fakeCache() {
        const store = new Map<string, { value: unknown; ttlMs?: number }>();
        return {
            store,
            get: async <T>(k: string): Promise<T | null> =>
                (store.get(k)?.value as T | undefined) ?? null,
            set: async <T>(k: string, v: T, ttlMs?: number): Promise<void> => {
                store.set(k, { value: v, ...(ttlMs === undefined ? {} : { ttlMs }) });
            },
        };
    }

    it('records a proven-bad codec so the NEXT run does not probe it again', async () => {
        // 🔴 trickplay-generation runs under `isolation: 'worker'`, so this
        // module is re-imported for every run and an in-memory latch is
        // per-run. Without a store, prod re-probed the GPU on every single Xvid
        // file, forever, because VAAPI has no MPEG-4 Part 2 decoder.
        const cache = fakeCache();
        const { cacheBackedHwaccelDenyList } = await import('./trickplay-generator.service.js');
        const denyList = cacheBackedHwaccelDenyList(cache);
        installProbe(50, 1920, () => 'mpeg4');
        installSpawn((call) => (isHardware(call) ? 'empty' : 'frame'));

        await run({ hwaccelDenyList: denyList });

        expect([...cache.store.keys()]).toEqual([`hwaccel-deny:${RENDER_NODE}:mpeg4:yuv420p`]);

        // Simulate the next run: fresh in-memory latch, same cache.
        const { resetHwaccelProbe } = await import('./trickplay-generator.service.js');
        resetHwaccelProbe();
        spawnFFmpegSafelyMock.mockClear();
        installSpawn(() => 'frame');

        await run({ hwaccelDenyList: denyList });

        const calls = spawnCalls();
        expect(calls.length).toBeGreaterThan(0);
        expect(calls.some(isHardware)).toBe(false);
    });

    it('keys the record by render node, so a different GPU is judged on its own', async () => {
        const cache = fakeCache();
        const { cacheBackedHwaccelDenyList } = await import('./trickplay-generator.service.js');
        installProbe(50, 1920, () => 'mpeg4');
        installSpawn((call) => (isHardware(call) ? 'empty' : 'frame'));

        await run({ hwaccelDenyList: cacheBackedHwaccelDenyList(cache) });
        expect(cache.store.has(`hwaccel-deny:${RENDER_NODE}:mpeg4:yuv420p`)).toBe(true);

        // Point at a second card; its verdicts must not be inherited.
        safeExistsMock.mockResolvedValue(true);
        configMock.TRICKPLAY_HWACCEL_DEVICE = '/dev/dri/renderD129';
        const { resetHwaccelProbe } = await import('./trickplay-generator.service.js');
        resetHwaccelProbe();
        spawnFFmpegSafelyMock.mockClear();
        installSpawn(() => 'frame');

        await run({ hwaccelDenyList: cacheBackedHwaccelDenyList(cache) });

        expect(spawnCalls().some(isHardware)).toBe(true);
        configMock.TRICKPLAY_HWACCEL_DEVICE = RENDER_NODE;
    });

    it('expires the record rather than condemning a codec forever', async () => {
        // The evidence is strong but not airtight — a GPU briefly out of
        // surfaces looks identical. A deny that never expired would cost every
        // source in that codec the software path until someone noticed.
        const cache = fakeCache();
        const { cacheBackedHwaccelDenyList } = await import('./trickplay-generator.service.js');
        installProbe(50, 1920, () => 'mpeg4');
        installSpawn((call) => (isHardware(call) ? 'empty' : 'frame'));

        await run({ hwaccelDenyList: cacheBackedHwaccelDenyList(cache) });

        const entry = cache.store.get(`hwaccel-deny:${RENDER_NODE}:mpeg4:yuv420p`);
        expect(entry?.ttlMs).toBeGreaterThan(0);
        expect(entry?.ttlMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    });

    it('probes rather than refusing hardware when the store is unreachable', async () => {
        // A cache blip must never decide decode policy: probing again costs one
        // spawn, wrongly refusing hardware costs the whole source.
        const { cacheBackedHwaccelDenyList } = await import('./trickplay-generator.service.js');
        const broken = cacheBackedHwaccelDenyList({
            get: async () => {
                throw new Error('valkey unreachable');
            },
            set: async () => {
                throw new Error('valkey unreachable');
            },
        });
        installSpawn(() => 'frame');

        const result = await run({ hwaccelDenyList: broken });

        expect(spawnCalls().some(isHardware)).toBe(true);
        expect(result.generated).toBe(5);
    });

    // 2026-08-07's actual incident: a `-color_range` bug made a codec fail
    // hardware decode, the deny-map learned it, and deleting the Valkey entry by
    // hand did NOT undo the lesson on a replica that had already latched it —
    // resolveDecodeMode() checks `hwaccelDisabledCodecs` BEFORE ever consulting
    // the cache again. The admin reset has to reach that in-process Set, on
    // every replica, without a restart.
    it('a cache-only delete does not un-latch the codec, but a remote reset does', async () => {
        const cache = fakeCache();
        const { cacheBackedHwaccelDenyList } = await import('./trickplay-generator.service.js');
        const denyList = cacheBackedHwaccelDenyList(cache);
        installProbe(50, 1920, () => 'mpeg4');
        installSpawn((call) => (isHardware(call) ? 'empty' : 'frame'));

        await run({ hwaccelDenyList: denyList }); // latches mpeg4:yuv420p off, in-process AND cache

        // Operator deletes the Valkey key by hand — the pre-fix admin recipe.
        // Not sufficient on its own: the in-process latch never re-checks the
        // cache once it already holds the codec.
        cache.store.delete(`hwaccel-deny:${RENDER_NODE}:mpeg4:yuv420p`);
        spawnFFmpegSafelyMock.mockClear();
        installSpawn(() => 'frame');
        await run({ hwaccelDenyList: denyList });
        expect(spawnCalls().some(isHardware)).toBe(false);

        // Now the reset arrives over the cross-replica bus — what
        // resetOneHwaccelDeny() publishes when an admin clears this entry
        // (from this replica or another one).
        const { _handleTrickplayHwaccelDenyResetForTests } =
            await import('../cache/trickplay-hwaccel-deny-bus.js');
        _handleTrickplayHwaccelDenyResetForTests(
            JSON.stringify({ kind: 'reset-key', codecKey: 'mpeg4:yuv420p' }),
        );

        spawnFFmpegSafelyMock.mockClear();
        await run({ hwaccelDenyList: denyList });
        expect(spawnCalls().some(isHardware)).toBe(true);
    });
});

describe('generation reuse proof', () => {
    it('regenerates a complete legacy manifest without source provenance when force is off', async () => {
        hasTrickplayMock.mockResolvedValue(true);
        const storage = await import('./trickplay-storage.service.js');
        const manifest = await storage.getTrickplayManifest(SOURCE_HD, SPRITE_W);
        delete manifest!.reuse;
        vi.mocked(storage.getTrickplayManifest).mockResolvedValueOnce(manifest);
        const result = await run();
        expect(result.generated).toBeGreaterThan(0);
        expect(result.skipped).toBe(0);
        expect(spawnCalls().length).toBeGreaterThan(0);
    });
    it('records a bounded sampled fingerprint and quality only after successful extraction', async () => {
        const { fingerprintTrickplaySource } = await import('./trickplay-reclaim.service.js');
        const folder = await mkdtemp(join(tmpdir(), 'trick-proof-'));
        const path = join(folder, 'source.mkv');
        const bytes = Buffer.alloc(70000, 1);
        try {
            await writeFile(path, bytes);
            getFilesForMediaItemMock.mockResolvedValue([{ id: SOURCE_HD, file_path: path }]);
            expect((await run()).generated).toBeGreaterThan(0);
            expect(saveTrickplayManifestMock).toHaveBeenCalledWith(
                SOURCE_HD,
                SPRITE_W,
                expect.objectContaining({
                    reuse: {
                        ...(await fingerprintTrickplaySource(path)),
                        providerId: 'local-trickplay',
                        quality: 80,
                        spriteQuality: 80,
                    },
                }),
                path,
            );
        } finally {
            await rm(folder, { recursive: true, force: true });
        }
    });
    it('regenerates a published manifest whose sheet is missing', async () => {
        hasTrickplayMock.mockResolvedValue(true);
        const { getSpriteSheetPath } = await import('./trickplay-storage.service.js');
        vi.mocked(getSpriteSheetPath).mockResolvedValueOnce('/missing-sprite.webp');
        expect((await run()).generated).toBeGreaterThan(0);
    });
    it('regenerates existing output after a quality change', async () => {
        hasTrickplayMock.mockResolvedValue(true);
        configMock.TRICKPLAY_QUALITY = 50;
        try {
            expect((await run()).generated).toBeGreaterThan(0);
        } finally {
            configMock.TRICKPLAY_QUALITY = 80;
        }
    });
});

// ── thread opt-out ─────────────────────────────────────────────────────────

describe('the global ffmpeg thread opt-out', () => {
    it('emits no -threads at all when the cap is set to 0', async () => {
        // 0 is documented as "restore ffmpeg's own thread defaults". Emitting a
        // number would override an admin's explicit choice, and passing ANY
        // -threads also suppresses the global injector's matching opt-out.
        vi.resetModules();
        vi.doMock('$lib/server/config.js', () => ({
            config: configMock,
            FEATURE_PER_TASK_QUEUES: false,
            LUMASTRA_FFMPEG_THREADS: 0,
            LUMASTRA_CONCURRENCY_CPU: 4,
        }));
        configMock.TRICKPLAY_HWACCEL = 'off';

        const { generateTrickplayForMediaItem } = await import('./trickplay-generator.service.js');
        await generateTrickplayForMediaItem({} as never, ITEM_ID, {
            width: SPRITE_W,
            intervalMs: INTERVAL_MS,
            tileWidth: TILE_W,
            tileHeight: TILE_H,
        });

        const calls = spawnCalls();
        expect(calls.length).toBeGreaterThan(0);
        for (const call of calls) {
            expect(call.args).not.toContain('-threads');
        }
        vi.doUnmock('$lib/server/config.js');
        vi.resetModules();
    });
});
