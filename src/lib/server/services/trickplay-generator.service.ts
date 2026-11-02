// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Trickplay Generator Service
 *
 * Generates WebP sprite sheets from local video files for thumbnail scrubbing.
 * Creates standardized sprite sheets that can be served to the player.
 */

import { spawnFFmpegSafely } from '$lib/server/utils/ffmpeg-spawn.js';
import { ffprobeLibraryInputArgs } from '$lib/server/utils/library-input-guard.js';
import { probeStreamTails } from '$lib/server/utils/ffprobe.js';
import {
    isMaterialStreamLoss,
    streamLossToleranceSeconds,
} from '$lib/server/utils/stream-tail-loss.js';
import { namespacedCacheKeyPrefix } from '$lib/server/tasks/cache-namespace.js';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { config, LUMASTRA_CONCURRENCY_CPU, LUMASTRA_FFMPEG_THREADS } from '$lib/server/config.js';
import { getCpuBudgetCores } from '$lib/server/utils/cpu-budget.js';
import { Logger } from '$lib/server/utils/logger.js';
import { mkdir, readFile, rm, stat, unlink } from 'fs/promises';
import { safeExists, safeReaddir, safeStat } from '$lib/server/utils/safe-fs.js';
import { assertTranscodeInputIsMedia } from './transcoding/input-guard.js';
import { PlaylistSourceRefusedError } from './music-transcode/source-guard.js';
import { join, dirname, basename, extname } from 'path';
import sharp from 'sharp';
import type postgres from 'postgres';
import {
    getBestTrickplayInfo,
    saveSpriteSheet,
    saveTrickplayManifest,
    deleteTrickplayGeneration,
    getTrickplayManifest,
    hasTrickplay,
    deleteTrickplay as deleteTrickplayForFile,
    getTrickplayStats,
} from './trickplay-storage.service.js';
import { aiDbService } from './database.service.js';
import { loadStoredVideoProbe } from '../database/queries/media-files.queries.js';
import { videoInfoFromStoredProbe } from './trickplay-stored-video-info.js';
import { persistLocalTrickplayParams } from './playback-trickplay.service.js';
import type { TrickplayManifest, TrickplaySheet } from './trickplay-storage.service.js';
import {
    getMediaItemForTrickplay,
    findEpisodesForSeries,
    findEpisodesForSeason,
} from '$lib/server/database/queries/trickplay.queries.js';
import {
    getFilesForMediaItem,
    recordDecodeHealthIssue,
    clearDecodeHealthIssues,
} from '$lib/server/database/queries/media-files.queries.js';
import { isMovie, isEpisode, isSeries, isSeason } from '$lib/server/utils/media-types.js';
import {
    cacheDel,
    deleteKeysByPattern,
    getKeysByPattern,
    getKeyTtlSeconds,
} from '$lib/server/cache/valkey.js';
import {
    onRemoteTrickplayHwaccelDenyReset,
    publishTrickplayHwaccelDenyReset,
} from '$lib/server/cache/trickplay-hwaccel-deny-bus.js';

import {
    fingerprintTrickplaySource,
    matchesTrickplaySettings,
    hasCompleteTrickplayFiles,
    type TrickplayFingerprint,
} from './trickplay-reclaim.service.js';

const execFileAsync = promisify(execFile);
const logger = Logger.for('TrickplayGenerator');

/**
 * Check if Jellyfin-format trickplay exists alongside a media file.
 * Looks for {filename}.trickplay/ directory with at least one resolution subdirectory
 * containing .jpg sprite sheets.
 */
async function hasJellyfinTrickplay(videoPath: string): Promise<boolean> {
    const dir = dirname(videoPath);
    const base = basename(videoPath, extname(videoPath));
    const trickplayDir = join(dir, `${base}.trickplay`);

    // safeExists/safeReaddir: this lives next to the media file on the (possibly
    // NFS) library mount — sync fs here would block the event loop on a stall.
    if (!(await safeExists(trickplayDir))) return false;

    let entries;
    try {
        entries = await safeReaddir(trickplayDir);
    } catch {
        return false;
    }
    for (const e of entries) {
        if (!e.isDirectory() || !/^\d+/.test(e.name)) continue;
        // Verify the resolution dir actually contains .jpg sprite sheets
        try {
            const files = await safeReaddir(join(trickplayDir, e.name));
            if (files.some((f) => f.name.endsWith('.jpg'))) return true;
        } catch {
            // unreadable resolution dir — skip
        }
    }
    return false;
}

export interface TrickplayOptions {
    width?: number;
    quality?: number;
    intervalMs?: number;
    tileWidth?: number;
    tileHeight?: number;
    force?: boolean;
    onProgress?: (processed: number, total: number) => void;
    /**
     * When set, checked between sources/episodes AND passed to the
     * underlying ffmpeg spawn so the long-running frame extraction can be
     * killed mid-pass on admin Cancel. Without it, orphan ffmpeg processes
     * keep running until the per-source timeout fires.
     */
    signal?: AbortSignal;
    /**
     * Wall-clock instant (epoch ms) this call must not run past — normally the
     * calling task's own hard cap, minus a margin.
     *
     * 🔴 Purpose is to STOP CLEANLY rather than be killed. When the watchdog
     * fires instead, everything the run had in flight is thrown away and the
     * item is re-enqueued to start from scratch, which is how six 4K movies
     * spent a day failing every 35 minutes without ever persisting a sheet.
     * Checked between sources/episodes, never mid-source: a half-extracted
     * source has nothing worth keeping.
     */
    deadlineAt?: number;
    /**
     * Cross-run record of codecs this GPU cannot decode. Optional: without it
     * the latch is per-run only, which is correct but re-probes every source.
     */
    hwaccelDenyList?: HwaccelDenyList;
}

export interface GenerationResult {
    success: boolean;
    /** The media item ID that was passed to generateTrickplay (not a media_files UUID). */
    fileId: string;
    generated: number;
    skipped: number;
    errors: number;
    duration: number;
    error?: string;
    /**
     * Set when the failure cannot be fixed by running again — the file itself
     * is unreadable. The task surfaces this to the run-wrapper, which marks the
     * stage row `failed_permanent` instead of resetting it to `pending`.
     * Without it an undecodable file re-drains forever, holding a worker slot
     * and drowning the stage's throughput signal.
     */
    permanent?: boolean;
    /**
     * Sources this item still needs generated after this call returned.
     *
     * 🔴 `success: true` with a NON-ZERO value means "this run did its share and
     * nothing failed", NOT "the item is covered". The caller must therefore
     * withhold the stage's completion row so the sweep enqueues the item again
     * and the next run picks up where this one stopped (already-generated
     * sources short-circuit on `hasTrickplay`). Marking coverage complete here
     * would strand every source after the first.
     */
    sourcesRemaining: number;
}

/**
 * What ONE source's generation reports. Identical to {@link GenerationResult}
 * minus the item-level bookkeeping — a single source has no notion of "other
 * sources still to do", and letting it invent one is how that field would
 * silently start lying.
 */
type SourceGenerationResult = Omit<GenerationResult, 'sourcesRemaining'>;

export type { TrickplayManifest, TrickplaySheet };

interface TrickplaySourceSpec {
    sourceId: string;
    filePath: string;
}

interface VideoInfo {
    duration: number;
    width: number;
    height: number;
    /**
     * True when ffprobe itself could not run or produce output — a timeout, a bad
     * FFPROBE_PATH, an unmounted share. Distinct from "ffprobe ran and reported a
     * zero duration", which IS a statement about the file. The caller writes a
     * permanent write-off only for the latter.
     */
    probeFailed?: boolean;
    /**
     * Video codec name as ffprobe reports it (`hevc`, `av1`, `h264`, …), or
     * `'unknown'`. Used to scope the hardware-decode latch: GPU support is
     * per-codec (a card can do HEVC and not AV1, or 8-bit and not 10-bit), so
     * "hardware failed" is never a statement about the whole box.
     */
    codec: string;
    /**
     * Pixel format as ffprobe reports it (`yuv420p`, `yuv420p10le`, …), or
     * `'unknown'`. GPU decode support is a property of the (card, codec,
     * profile) triple, not just the codec — a VAAPI driver commonly does
     * HEVC Main (8-bit) but not Main10 (10-bit). Combined with `codec` to
     * scope the hardware-decode latch so one 10-bit failure does not condemn
     * 8-bit sources of the same codec.
     */
    pixFmt: string;
}

/**
 * The file's video facts from the media-probe stage's stored probe, when they
 * are complete. Null means "probe the file", as before.
 */
async function storedVideoInfoFor(sourceId: string): Promise<VideoInfo | null> {
    try {
        const sql = await aiDbService.getSql();
        if (!sql) return null;
        const row = await loadStoredVideoProbe(sql, sourceId);
        return row ? videoInfoFromStoredProbe(row) : null;
    } catch (err) {
        // Best effort: a failed read only costs the probe it would have saved.
        logger.debug('Trickplay: stored video probe unavailable, probing the file', {
            sourceId,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

async function getVideoInfo(videoPath: string): Promise<VideoInfo> {
    const ffprobePath = config.FFPROBE_PATH;
    try {
        const { stdout } = await execFileAsync(
            ffprobePath,
            [
                '-v',
                'quiet',
                '-print_format',
                'json',
                '-show_format',
                '-show_streams',
                '-select_streams',
                'v:0',
                ...(await ffprobeLibraryInputArgs()),
                videoPath,
            ],
            { timeout: 30_000, killSignal: 'SIGKILL' },
        );

        const data = JSON.parse(stdout) as {
            format?: { duration?: unknown };
            streams?: Array<{
                width?: unknown;
                height?: unknown;
                codec_name?: unknown;
                pix_fmt?: unknown;
            }>;
        };

        const duration = data.format?.duration ? parseFloat(String(data.format.duration)) : 0;

        const stream = data.streams?.[0];
        const width = stream?.width ? Number(stream.width) : 0;
        const height = stream?.height ? Number(stream.height) : 0;
        const codec = typeof stream?.codec_name === 'string' ? stream.codec_name : 'unknown';
        const pixFmt = typeof stream?.pix_fmt === 'string' ? stream.pix_fmt : 'unknown';

        return { duration, width, height, codec, pixFmt, probeFailed: false };
    } catch (err) {
        // The caller writes a PERMANENT write-off on a zero duration, so it must be
        // able to tell "ffprobe read the file and it has no duration" from "ffprobe
        // could not run at all". This catch covers an unreadable container, but also
        // an ffprobe timeout (spun-down disk), ENOENT on the ffprobe BINARY (bad
        // FFPROBE_PATH), and EIO from an unmounted share — none of which say anything
        // about the file. Collapsing them all to duration:0 turned a storage blip
        // into failed_permanent across the swept slice, with a false
        // "container_unreadable" diagnosis and no event that ever revives it.
        logger.error('ffprobe failed for video info', undefined, {
            videoPath,
            error: err instanceof Error ? err.message : String(err),
        });
        return {
            duration: 0,
            width: 0,
            height: 0,
            codec: 'unknown',
            pixFmt: 'unknown',
            probeFailed: true,
        };
    }
}

// Bounded parallel ffmpeg spawns for per-frame extraction. Each spawn is a
// fast (input-side) seek + single-frame grab, so this isn't about hiding
// per-process latency — it's about not launching hundreds of ffmpeg processes
// at once against a shared 'cpu' task-class budget the rest of the pipeline
// (intro-analyzer, other trickplay jobs) also draws from.
function perFrameConcurrency(): number {
    const configured = config.TRICKPLAY_PER_FRAME_CONCURRENCY;
    if (!Number.isFinite(configured) || configured < 1) return 4;
    return Math.min(16, Math.floor(configured));
}

/**
 * Least time worth starting another source with. Below this, a run stops and
 * reports the source as remaining instead of beginning work it cannot finish —
 * an interrupted source persists nothing, so a partial attempt is strictly
 * worse than not attempting at all.
 *
 * Sized against a hardware-decoded 4K feature (~4 min measured) with a wide
 * margin, NOT against the software fallback: a software 4K source is a 15-60
 * minute job that no per-run budget can usefully bound, and for that case the
 * one-source-per-run rule — not this number — is what keeps a run finishable.
 */
const MIN_SOURCE_BUDGET_MS = 15 * 60 * 1000;

/**
 * Above this, a source counts as having done real work and consumes the run's
 * one-source allowance — whether or not it produced frames. Comfortably above a
 * `hasTrickplay` stat and a fast permanent failure, far below any real
 * extraction.
 */
const SOURCE_WORK_THRESHOLD_MS = 10_000;

/** True when {@link TrickplayOptions.deadlineAt} leaves too little time to start another source. */
function pastDeadline(options: TrickplayOptions): boolean {
    if (options.deadlineAt === undefined) return false;
    return options.deadlineAt - Date.now() < MIN_SOURCE_BUDGET_MS;
}

/** How a single frame is decoded. `software` is the always-available fallback. */
type DecodeMode = 'software' | 'vaapi' | 'qsv';

/**
 * Threads to give ONE per-frame ffmpeg.
 *
 * 🔴 The number that matters is the PRODUCT, not this value: parallel trickplay
 * runs × frames-in-parallel × threads-per-frame. On a 20-core prod box the old
 * arrangement (4 runs × 4 frames × the global `LUMASTRA_FFMPEG_THREADS` of 4)
 * asked for 64 threads and measured a load average of 28. That oversubscription
 * is self-defeating: a 4K HEVC frame that takes 5.8s with 4 threads on a quiet
 * box was taking >15s under it — past the per-frame ceiling, so the work was
 * thrown away as a failure rather than merely being slow.
 *
 * So: divide the effective core budget by how many frames can be in flight, and
 * never exceed the global ffmpeg cap. Hardware decode gets 1 — the decode runs
 * on the GPU, and extra CPU threads buy nothing (measured: 349ms at 1 thread vs
 * 5793ms for the same frame in software at 4).
 */
function perFrameThreads(mode: DecodeMode): number | null {
    // 0 is the documented global opt-out ("restore ffmpeg's own thread
    // defaults"). Emitting a number here would quietly override an admin's
    // explicit choice, and passing ANY `-threads` also suppresses
    // injectThreadsFlag's matching skip — so honour it by emitting nothing.
    if (LUMASTRA_FFMPEG_THREADS <= 0) return null;
    if (mode !== 'software') return 1;
    const framesInFlight =
        perFrameConcurrency() * Math.max(1, Math.min(4, LUMASTRA_CONCURRENCY_CPU));
    const budget = Math.floor(getCpuBudgetCores() / framesInFlight);
    return Math.max(1, Math.min(LUMASTRA_FFMPEG_THREADS, budget));
}

/**
 * Stop requesting frames after this many SECONDS of consecutive timestamps
 * produce nothing. Guards the case where `format.duration` massively
 * over-reports the real video (see `video_ends_early`): one prod file claimed
 * 13600s for 1360s of video and burned 1225 pointless ffmpeg spawns per
 * attempt before failing.
 *
 * Deliberately generous — five contiguous minutes of undecodable video is
 * broken media, not a hiccup — so an interior damaged stretch shorter than
 * this is still crossed and the tail beyond it still rendered. Whatever we
 * stop before is reported as a health issue, never silently dropped.
 */
const TAIL_STOP_SECONDS = 300;

/**
 * How many frames may be spent deciding whether hardware decode works before we
 * stop asking. Each inconclusive probe costs two spawns (hardware, then the
 * software control), so this is deliberately small.
 */
const MAX_HWACCEL_PROBES = 3;

/**
 * Ceiling for ONE frame's ffmpeg. Meant to catch a hung spawn, never to cut off
 * a frame that is merely expensive.
 *
 * 🔴 This used to be a flat 15s, chosen against a ~0.3s measurement on 1080p
 * HEVC. That is not the cost of a 4K frame. Measured on prod:
 *
 *   1080p h264, software          ~0.3s
 *   2160p HEVC, software          ~3.6s   (8.2s single-threaded)
 *   2160p AV1 10-bit, software    ~9.4-12.5s
 *   2160p either, hardware        ~0.35-0.7s
 *
 * So a 4K AV1 frame sat *at* the old ceiling on an idle box and blew straight
 * through it under normal concurrency — and a timeout is scored as a spawn
 * failure, so perfectly good frames were being discarded, forever, on every
 * retry. Scale with the pixel count instead, and keep enough headroom that only
 * a genuinely wedged process is killed.
 */
function perFrameTimeoutMs(videoWidth: number, mode: DecodeMode): number {
    // Hardware frames land in well under a second, but the GPU is shared — a
    // box mid-live-transcode has a genuine slow-but-fine case, and scoring
    // those as failures is what turns contention into missing tiles. Generous
    // relative to the measurement, still far below the software ceiling.
    if (mode !== 'software') return videoWidth >= 3000 ? 45_000 : 30_000;
    return videoWidth >= 3000 ? 90_000 : 30_000;
}

/**
 * A record of which codecs the GPU has been PROVEN unable to decode, shared
 * across runs.
 *
 * 🔴 Needs to outlive the run. `trickplay-generation` declares
 * `isolation: 'worker'`, so `execute()` runs in a fresh `node:worker_threads`
 * Worker that re-imports this module every time — module state is therefore
 * per-RUN, not per-process, and a purely in-memory latch re-probes on every
 * source forever. On prod that was one wasted ffmpeg spawn per Xvid file,
 * indefinitely, because VAAPI has no MPEG-4 Part 2 decoder and never will.
 */
export interface HwaccelDenyList {
    /**
     * True when hardware decode is already known to fail for this
     * `${codec}:${pixFmt}` key — see {@link hwaccelCodecKey}. Despite the
     * parameter name, this is NOT the bare ffprobe codec: profile/bit-depth
     * is folded in so an 8-bit and a 10-bit source of the same codec are
     * judged independently.
     */
    isDenied(codec: string): Promise<boolean>;
    /** Record that hardware decode failed for this `${codec}:${pixFmt}` key. */
    deny(codec: string): Promise<void>;
}

/**
 * The hardware-decode latch key for a source: codec AND pixel format.
 *
 * 🔴 GPU decode support is a property of the (card, codec, profile) triple,
 * not of (card, codec) alone — a VAAPI driver commonly implements HEVC Main
 * (8-bit) but not Main10 (10-bit), so a single 10-bit failure must not latch
 * off every 8-bit source of the same codec. `pixFmt` is ffprobe's `pix_fmt`
 * verbatim (`yuv420p`, `yuv420p10le`, …) rather than a collapsed "8-bit vs
 * 10-bit" boolean, so distinct chroma/bit-depth combinations (4:2:2, 4:4:4,
 * 12-bit, …) are never conflated either.
 */
function hwaccelCodecKey(videoInfo: Pick<VideoInfo, 'codec' | 'pixFmt'>): string {
    return `${videoInfo.codec}:${videoInfo.pixFmt}`;
}

/**
 * TTL on a deny entry.
 *
 * 🔴 Deliberately short. The evidence behind a deny is strong (a hardware frame
 * failed while the SAME index decoded in software) but not airtight — a GPU
 * momentarily out of surfaces produces exactly that shape. The asymmetry
 * decides the number: what a deny saves is ~0.2s of probe per source; what a
 * FALSE deny costs is every source in that codec running on the CPU at one
 * thread per frame. Six hours is long enough to cover a library sweep of
 * thousands of files, short enough that a mistaken deny heals itself the same
 * day rather than the same week.
 */
const HWACCEL_DENY_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Cache-key prefix for a device's hwaccel deny entries, as seen THROUGH the
 * task system's `NamespacedCache` (i.e. the key `cacheBackedHwaccelDenyList`
 * passes to `cache.get`/`cache.set`).
 *
 * Shared between the write path ({@link cacheBackedHwaccelDenyList}) and the
 * admin read/reset path below, so the two can never drift apart on the key
 * shape — a mismatch there would make the admin page unable to see (or clear)
 * what the generator itself is enforcing.
 */
function hwaccelDenyKeyPrefix(device: string): string {
    return `hwaccel-deny:${device}:`;
}

/** Logical cache key for one denied `${codec}:${pixFmt}` entry on the given device. */
function hwaccelDenyKeyFor(device: string, codecKey: string): string {
    return `${hwaccelDenyKeyPrefix(device)}${codecKey}`;
}

/**
 * The `plugin:${task.id}:` namespace `buildNamespacedCache()`
 * (context-primitives.ts) silently prepends to every key the trickplay task's
 * `ctx.cache` capability touches — see `capabilities: { cache: true }` on
 * `trickplayGenerationTask` in media-item-tasks.ts, whose id this must match.
 *
 * `cacheBackedHwaccelDenyList()` never sees this prefix — it only ever talks
 * through the `{get,set}` cache interface, which adds it transparently. The
 * admin read/reset functions below go straight to Valkey instead (they need
 * SCAN + TTL, which that narrow interface does not expose), so they have to
 * reconstruct the SAME prefix by hand or they silently look at — and "clear"
 * — a keyspace nothing ever wrote to.
 */
const TRICKPLAY_TASK_CACHE_NAMESPACE = namespacedCacheKeyPrefix('trickplay-generation');

/** Raw Valkey key prefix for a device's deny entries (admin read/reset path only). */
function hwaccelDenyRawKeyPrefix(device: string): string {
    return `${TRICKPLAY_TASK_CACHE_NAMESPACE}${hwaccelDenyKeyPrefix(device)}`;
}

/** Raw Valkey key for one denied entry (admin read/reset path only). */
function hwaccelDenyRawKeyFor(device: string, codecKey: string): string {
    return `${TRICKPLAY_TASK_CACHE_NAMESPACE}${hwaccelDenyKeyFor(device, codecKey)}`;
}

/**
 * Back a {@link HwaccelDenyList} with the task system's cache.
 *
 * Keyed by DEVICE as well as codec: pointing `TRICKPLAY_HWACCEL_DEVICE` at a
 * different render node is a different GPU with different capabilities, and it
 * must not inherit the previous card's verdicts.
 */
export function cacheBackedHwaccelDenyList(cache: {
    get<T>(key: string): Promise<T | null>;
    set<T>(k: string, v: T, ttlMs?: number): Promise<void>;
}): HwaccelDenyList {
    // Read the device HERE rather than taking it as an argument: this module
    // already owns the trickplay config, and the calling task deliberately
    // imports only `getAuthoritativeStageIds` from the config module — pulling
    // the whole `config` object in at its module scope is what broke partial
    // config mocks through TaskRegistry once before.
    const keyFor = (codec: string) => hwaccelDenyKeyFor(config.TRICKPLAY_HWACCEL_DEVICE, codec);
    return {
        async isDenied(codec) {
            try {
                return (await cache.get<boolean>(keyFor(codec))) === true;
            } catch {
                // A cache blip must never decide decode policy — probing again
                // costs one spawn, refusing hardware costs the whole source.
                return false;
            }
        },
        async deny(codec) {
            try {
                await cache.set(keyFor(codec), true, HWACCEL_DENY_TTL_MS);
            } catch {
                // Best effort. The in-process latch still covers this run.
            }
        },
    };
}

/**
 * L1 in front of {@link HwaccelDenyList} — codecs denied during THIS run.
 *
 * 🔴 Scoped per codec, deliberately. GPU decode support is a property of the
 * (card, codec, profile) triple, not of the box: an Arc that handles HEVC fine
 * may have no AV1 path at all. Latching indiscriminately would let one AV1 file
 * push every subsequent H.264 and HEVC source onto the software path — at one
 * thread per frame, which is the 8.2s/frame regime this change exists to
 * escape.
 */
const hwaccelDisabledCodecs = new Set<string>();

/** Test seam — clears the in-run hardware latch. */
export function resetHwaccelProbe(): void {
    hwaccelDisabledCodecs.clear();
}

/** Latch a codec off for this run AND, when a store is wired, for later runs. */
async function denyHwaccelForCodec(codec: string, store?: HwaccelDenyList): Promise<void> {
    hwaccelDisabledCodecs.add(codec);
    await store?.deny(codec);
}

// Apply a reset performed on ANOTHER replica (or by this replica's own admin
// action, see resetAllHwaccelDeny/resetOneHwaccelDeny below) to the local
// latch. Registered once at module load — `FEATURE_PLUGIN_WORKER_ISOLATION`
// defaults off, so this module lives for the life of the pod process, and
// `hwaccelDisabledCodecs` short-circuits resolveDecodeMode() BEFORE it ever
// re-checks the cache. Without this listener, the only way to undo a false
// deny was a process restart — precisely the 2026-08-07 incident that forced
// a bad codec fallback for two days after the actual bug was already fixed.
onRemoteTrickplayHwaccelDenyReset((event) => {
    if (event.kind === 'reset-all') hwaccelDisabledCodecs.clear();
    else hwaccelDisabledCodecs.delete(event.codecKey);
});

/** One currently-denied entry, for the admin diagnostics page. */
export interface HwaccelDenyEntryView {
    device: string;
    codec: string;
    pixFmt: string;
    /** ISO timestamp the entry ages out, or null when it has no discoverable TTL. */
    expiresAt: string | null;
}

/**
 * Current hwaccel deny entries for `TRICKPLAY_HWACCEL_DEVICE`, read straight
 * from the cache (never from `hwaccelDisabledCodecs` — that Set carries no
 * TTL and, on a replica that only ever learned from the cache, may not even
 * hold every entry this device has recorded).
 *
 * A clear button with nothing to look at is not much better than no button —
 * this is what lets an operator see WHAT is denied before deciding to clear it.
 */
export async function listHwaccelDenyEntries(): Promise<HwaccelDenyEntryView[]> {
    const device = config.TRICKPLAY_HWACCEL_DEVICE;
    const prefix = hwaccelDenyRawKeyPrefix(device);
    const keys = await getKeysByPattern(`${prefix}*`);
    const entries: HwaccelDenyEntryView[] = [];
    for (const key of keys) {
        const codecKey = key.slice(prefix.length);
        const sep = codecKey.indexOf(':');
        if (sep === -1) continue; // malformed key — codec and pixFmt are both required
        const codec = codecKey.slice(0, sep);
        const pixFmt = codecKey.slice(sep + 1);
        const ttlSeconds = await getKeyTtlSeconds(key);
        entries.push({
            device,
            codec,
            pixFmt,
            expiresAt:
                ttlSeconds > 0 ? new Date(Date.now() + ttlSeconds * 1000).toISOString() : null,
        });
    }
    return entries;
}

/**
 * Admin action: clear every hwaccel deny entry for the current device, on
 * EVERY replica — not just the one that served the request.
 *
 * Deleting the Valkey keys alone (what an operator could do by hand before
 * this existed) is NOT sufficient: `hwaccelDisabledCodecs` short-circuits
 * ahead of the cache, so every replica that had already latched a codec off
 * would keep enforcing it until its process restarted. Clearing locally AND
 * publishing closes that gap without a restart.
 */
export async function resetAllHwaccelDeny(): Promise<number> {
    const prefix = hwaccelDenyRawKeyPrefix(config.TRICKPLAY_HWACCEL_DEVICE);
    const cleared = await deleteKeysByPattern(`${prefix}*`);
    hwaccelDisabledCodecs.clear();
    publishTrickplayHwaccelDenyReset({ kind: 'reset-all' });
    return cleared;
}

/** Admin action: clear one denied `${codec}:${pixFmt}` entry, on every replica. */
export async function resetOneHwaccelDeny(codecKey: string): Promise<number> {
    const key = hwaccelDenyRawKeyFor(config.TRICKPLAY_HWACCEL_DEVICE, codecKey);
    const cleared = await cacheDel(key);
    hwaccelDisabledCodecs.delete(codecKey);
    publishTrickplayHwaccelDenyReset({ kind: 'reset-key', codecKey });
    return cleared;
}

/**
 * Which decode mode to ATTEMPT for a source.
 *
 * `auto` resolves to VAAPI (the mode actually verified on the reference box)
 * and only when the configured render node exists — a container without
 * `/dev/dri` passed through gets software with no failed spawns at all. An
 * explicit `vaapi`/`qsv` is honoured even without the node so a misconfiguration
 * surfaces as a probe failure in the log rather than being silently ignored.
 */
async function resolveDecodeMode(codec: string, store?: HwaccelDenyList): Promise<DecodeMode> {
    if (hwaccelDisabledCodecs.has(codec)) return 'software';
    const setting = config.TRICKPLAY_HWACCEL;
    if (setting === 'off') return 'software';
    // Consulted BEFORE the explicit-mode branch: an operator pinning 'vaapi'
    // still should not re-probe a codec this GPU has already been shown unable
    // to decode — that is a fact about the hardware, not a preference.
    if (await (store?.isDenied(codec) ?? Promise.resolve(false))) {
        hwaccelDisabledCodecs.add(codec);
        return 'software';
    }
    if (setting === 'vaapi' || setting === 'qsv') return setting;
    return (await safeExists(config.TRICKPLAY_HWACCEL_DEVICE)) ? 'vaapi' : 'software';
}

/**
 * ffmpeg argv for a single frame.
 *
 * 🔴 `-ss` goes BEFORE `-i` in every mode — input-side (fast) seek. Moving it
 * after `-i` forces a decode from the start of the file, which is both ~5x
 * slower and (per the note on extractAllFrames) the long continuous decode that
 * silently produces stale frames.
 *
 * The hardware chains keep the frame on the GPU for the scale and then
 * `hwdownload,format=nv12` it back to system memory. Dropping the explicit
 * download does NOT get software frames — ffmpeg hands libwebp a GPU surface
 * and the encode fails — so it is load-bearing, not decoration.
 */
function buildFrameArgs(opts: {
    mode: DecodeMode;
    targetSeconds: number;
    videoPath: string;
    framePath: string;
    width: number;
    quality: number;
}): string[] {
    const { mode, targetSeconds, videoPath, framePath, width, quality } = opts;
    const seek = ['-ss', targetSeconds.toFixed(3), '-i', videoPath, '-frames:v', '1'];
    const encode = ['-c:v', 'libwebp', '-quality', quality.toString(), '-y', framePath];
    // Explicit -threads suppresses the global injectThreadsFlag, by its own
    // documented contract ("the caller's intent wins"). `null` means the admin
    // opted out of thread capping entirely, so we emit nothing and let the
    // injector's own opt-out path apply.
    const budget = perFrameThreads(mode);
    const threads = budget === null ? [] : ['-threads', String(budget)];
    const device = config.TRICKPLAY_HWACCEL_DEVICE;

    if (mode === 'vaapi') {
        return [
            ...threads,
            '-hwaccel',
            'vaapi',
            '-hwaccel_device',
            device,
            '-hwaccel_output_format',
            'vaapi',
            ...seek,
            '-vf',
            `scale_vaapi=w=${width}:h=-2,hwdownload,format=nv12`,
            ...encode,
        ];
    }
    if (mode === 'qsv') {
        return [
            ...threads,
            '-hwaccel',
            'qsv',
            '-qsv_device',
            device,
            '-hwaccel_output_format',
            'qsv',
            ...seek,
            '-vf',
            // 🔴 Two ways this differs from the VAAPI chain, both verified
            // against an Arc A380 on 2026-08-21 — neither is cosmetic:
            //
            //  - `h=-1`, not `-2`. `scale_qsv` rejects anything below -1
            //    ("Size values less than -1 are not acceptable") where
            //    `scale_vaapi` accepts it. With `-2` EVERY frame failed, on
            //    every codec.
            //  - `format=nv12` on the SCALER. A 10-bit source gives a p010
            //    surface, and `hwdownload` then refuses ("Invalid output
            //    format nv12 for hwframe download"); converting on the GPU
            //    first is what makes 10-bit HEVC and AV1 work. `scale_vaapi`
            //    happens to do this implicitly, which is why the VAAPI chain
            //    needs no equivalent.
            //
            // Measured after the fix: 2160p HEVC 401ms, 2160p AV1 10-bit
            // 654ms, 1080p h264 104ms — on par with VAAPI. Frame content
            // confirmed correct at the same timestamps.
            `scale_qsv=w=${width}:h=-1:format=nv12,hwdownload,format=nv12`,
            ...encode,
        ];
    }
    return [
        ...threads,
        ...seek,
        '-vf',
        `scale=${width}:-2:force_original_aspect_ratio=decrease`,
        ...encode,
    ];
}

/**
 * stderr signatures that mean "ffmpeg ran and this INPUT cannot be decoded".
 * Retrying such a file never changes the answer, so a non-zero exit carrying
 * one is a content failure, not a spawn failure.
 *
 * `Error opening output files: Invalid argument` is deliberately NOT here on
 * its own: a bad temp dir produces it too. It only ever accompanies one of
 * these markers.
 */
const UNDECODABLE_INPUT_STDERR =
    /no decoder found for|Invalid data found when processing input|moov atom not found/i;

/**
 * True when `err` is an ffmpeg process that ran to a non-zero exit and whose
 * stderr names an undecodable input. Timeouts, kills, aborts, ENOENT and
 * anything without an exit code stay false — those say nothing about the file.
 * Duck-typed on `FFmpegError`'s fields so it holds for any error that carries
 * them.
 */
function isUndecodableInputExit(err: unknown): err is { stderr: string } {
    if (typeof err !== 'object' || err === null) return false;
    const { exitCode, stderr, timedOut, sizeExceeded } = err as {
        exitCode?: unknown;
        stderr?: unknown;
        timedOut?: unknown;
        sizeExceeded?: unknown;
    };
    return (
        typeof exitCode === 'number' &&
        exitCode > 0 &&
        timedOut !== true &&
        sizeExceeded !== true &&
        typeof stderr === 'string' &&
        UNDECODABLE_INPUT_STDERR.test(stderr)
    );
}

/**
 * Run one frame's ffmpeg and report whether it produced a real picture.
 *
 * Encapsulates the empty-output contract documented on {@link extractAllFrames}:
 * ffmpeg exits 0 and leaves a 0-byte file when it has no picture to give, so the
 * FILE — not the exit code — is the signal. A `spawnFailed` frame (timeout,
 * kill, ENOENT) is reported separately because only a COMPLETED-but-empty run
 * says anything about the source.
 */
async function extractOneFrame(opts: {
    mode: DecodeMode;
    index: number;
    intervalSeconds: number;
    videoPath: string;
    framePath: string;
    width: number;
    quality: number;
    timeoutMs: number;
    abortSignal?: AbortSignal;
    /** Set on a hardware attempt that has a software fallback waiting. */
    expectFailure?: boolean;
}): Promise<{ usable: boolean; spawnFailed: boolean; stderr: string; error?: string }> {
    const args = buildFrameArgs({
        mode: opts.mode,
        targetSeconds: opts.index * opts.intervalSeconds,
        videoPath: opts.videoPath,
        framePath: opts.framePath,
        width: opts.width,
        quality: opts.quality,
    });

    let stderr = '';
    let spawnFailed = false;
    let ranAndFailed = false;
    let error: string | undefined;
    try {
        // Every frame is a fresh ffmpeg that re-opens the path, over a run that
        // can last tens of minutes, so the source's up-front check does not
        // cover a file swapped for a playlist body mid-run. A refusal is this
        // frame's spawn failure: the rescue pass re-checks and refuses again,
        // the source fails as "frames never completed", and the next run's
        // up-front check writes it off permanently. It fails software and
        // hardware alike, so it can never read as "the GPU cannot decode this".
        await assertTranscodeInputIsMedia({ localFilePath: opts.videoPath });
        const spawned = await spawnFFmpegSafely({
            args,
            libraryInput: opts.videoPath,
            timeout: opts.timeoutMs,
            ...(opts.expectFailure === true ? { expectFailure: true } : {}),
            ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
        });
        stderr = spawned.stderr;
    } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        if (isUndecodableInputExit(err)) {
            // ffmpeg ran and said the input cannot be decoded: a fact about the
            // file, reported like an empty output so the permanent path applies.
            ranAndFailed = true;
            stderr = err.stderr;
        } else {
            spawnFailed = true;
        }
        const level = opts.expectFailure === true ? 'debug' : 'warn';
        logger[level]('Per-frame trickplay extraction failed', {
            videoPath: opts.videoPath,
            targetSeconds: opts.index * opts.intervalSeconds,
            mode: opts.mode,
            error,
        });
        // A timeout still leaves the -y target behind; fall through to the same
        // cleanup as a silent no-op.
    }

    let size = 0;
    try {
        size = (await stat(opts.framePath)).size;
    } catch {
        // never created — stays 0, same disposition as empty
    }

    // A non-empty file only counts when ffmpeg actually finished. A kill or
    // timeout mid-write leaves a TRUNCATED webp, not the empty one the catch
    // above assumed: it passes `size > 0`, sharp then throws on the partial
    // data, and the item fails without the permanent flag — straight back into
    // the retry loop this whole path exists to avoid.
    if (size > 0 && !spawnFailed && !ranAndFailed) {
        return { usable: true, spawnFailed: false, stderr };
    }

    // Delete it so nothing downstream can mistake a 0-byte (or truncated) file
    // for a frame, however this function is later changed.
    try {
        await unlink(opts.framePath);
    } catch {
        // never created, or already gone — either is fine
    }
    return { usable: false, spawnFailed, stderr, ...(error !== undefined ? { error } : {}) };
}

/**
 * Extract all trickplay frames via bounded-parallel per-frame ffmpeg spawns.
 * Produces numbered WebP files: frame_0001.webp, frame_0002.webp, etc.
 *
 * ## Why per-frame, not single-pass (read this before "optimizing" it back)
 *
 * 2026-05-24 → reverted 2026-08-13. The original version of this function was
 * a single ffmpeg process decoding the whole file once with `fps=1/N` doing
 * the sampling, `-skip_frame nokey` telling the decoder to skip everything
 * but keyframes (~6.5x faster than what's here now). It silently produced
 * WRONG thumbnails — not crashes, not errors, just the wrong scene, for
 * files that are extremely common in real libraries. Root-caused over a full
 * debugging session; every step below was actually tried against real files,
 * not theorized:
 *
 *   1. **`-skip_frame nokey`** corrupts output on sources whose HEVC/H.264
 *      encode uses open-GOP / B-frame-referencing structures — the default
 *      in most modern web-optimized x265/x264 encodes, not a rare edge case.
 *      Frames come out tagged with correct, monotonic PTS but STALE pixel
 *      content: a real scene cut is silently never sampled and the previous
 *      scene repeats for 60+ seconds of claimed timeline. Verified by
 *      diffing served thumbnails against frame-accurate ground truth at the
 *      same timestamp.
 *   2. **Gentler `-skip_frame` levels don't help.** `bidir` (keep I+P, skip
 *      only B) produces visibly corrupted macroblocks instead of staleness.
 *      `noref` (keep I + only the P frames actually used as references —
 *      theoretically the "smart" choice) reproduces the EXACT same
 *      staleness as `nokey`. All three skip levels are unsafe.
 *   3. **Dropping `-skip_frame` entirely (full, unskipped decode) does NOT
 *      fix it.** This is the counterintuitive part: a bare
 *      `ffmpeg -i file -vf fps=1/N` — or frame-count `select` instead of
 *      `fps`, or `-threads 1` to rule out a decoder race condition — still
 *      produces the identical stale frame at the identical spot. This was
 *      shipped as a fix once on the strength of a passing timing benchmark
 *      alone and turned out to still be broken; see
 *      `feedback_verify_correctness_not_just_timing_before_promote` in
 *      project memory for the write-up of that mistake.
 *   4. **Bisected the actual trigger**: it's proportional to how long ONE
 *      ffmpeg process continuously decodes-and-discards frames, independent
 *      of where in the file that process starts. A fresh process seeked to
 *      ~30s before a target frame produces it correctly; seeked to ~60s
 *      before, it's wrong. No single long-running ffmpeg invocation is safe
 *      for this content, full stop. Reproduced identically on two unrelated
 *      files/codecs (an HEVC WEB-DL and an H.264 anime rip), so this is a
 *      general property of long continuous decode-with-heavy-discard, not a
 *      one-off bitstream defect in a single file.
 *   5. **Chunking (bounded-length ffmpeg invocations) was considered and
 *      rejected.** At a 10s sample interval, staying under the ~30s safe
 *      window only yields 2-3 thumbnails per chunk before needing a fresh
 *      process — no better than one process per thumbnail, while adding
 *      real complexity and a safety margin nobody can prove is exactly
 *      right for every encode.
 *   6. **Hardware-accelerated decode (VAAPI) was evaluated here in 2026-08-13
 *      and rejected — that conclusion was WRONG and has since been reversed
 *      (2026-08-21).** The original note said VAAPI "didn't even initialize
 *      cleanly on the target host" and wouldn't pay off because hwdownload's
 *      per-frame copy-back would eat the gain. Re-measured on the same host,
 *      against the same files, with the filter graph wired as
 *      `scale_vaapi=…,hwdownload,format=nv12` (the piece that was missing):
 *
 *        2160p HEVC   3583ms software → 534ms hardware
 *        2160p AV1    12528ms         → 679ms
 *        1080p h264   284ms           → 92ms
 *        16 concurrent 4K frames: 1958ms total, 0 failures
 *
 *      The copy-back is real and is already priced into those numbers. The
 *      earlier reasoning also mis-framed the workload: cost here is dominated
 *      by decoding the reference chain from the preceding keyframe, which is
 *      exactly what a fixed-function decoder is for. Hardware is now the
 *      default when a render node is present, with a per-source probe that
 *      falls back to software the moment it doesn't produce a frame.
 *
 *      This does NOT relax rule 4: hardware or not, every frame is still its
 *      own short-lived process seeked to just before its target. Nothing here
 *      decodes continuously.
 *
 * Per-frame accurate seeking (`-ss` before `-i` — fast/input-side seek, NOT
 * `-ss` after `-i` which forces a slow decode-from-start) is the only
 * approach that was reliably correct in every test. Each spawn only decodes
 * a few frames from the nearest preceding keyframe, comfortably inside the
 * ~30s safe window above. Measured end to end on a 268-frame, 45-minute
 * 1080p HEVC episode:
 *
 *   - buggy single-pass (`-skip_frame nokey` + `fps` filter): ~14s — WRONG
 *   - broken "fix" (single-pass, no `-skip_frame`):           ~69-154s — WRONG
 *   - this approach (per-frame, `perFrameConcurrency()` spawns): ~23-47s — verified correct
 *   - historical pre-2026-05-24 per-frame baseline (accurate/output-side
 *     seek instead of fast/input-side): ~134s — the "per-frame is slow"
 *     number this used to cite; fast seeking is what actually makes this
 *     approach viable, not the concurrency
 *
 * tl;dr: this function is slower than the single-pass version it replaced,
 * on purpose, because the fast version does not work. Don't re-introduce
 * `-skip_frame` or a single continuous decode pass without re-running the
 * correctness verification described above — a clean timing benchmark alone
 * proved nothing the last time this exact mistake was made.
 */
interface FrameExtraction {
    /**
     * Indices that produced a NON-EMPTY frame file on disk. The caller must
     * consult this rather than assuming `0..extracted-1` — see the empty-output
     * note on {@link extractAllFrames}.
     */
    usableIndices: Set<number>;
    /** `usableIndices.size`, kept for readability at call sites. */
    extracted: number;
    /** How many indices were actually attempted (< expectedCount on tail-stop). */
    requested: number;
    /** Indices ffmpeg accepted but produced no picture for. */
    emptyOutputs: number;
    /**
     * Indices where ffmpeg never completed at all — timeout, kill, abort or a
     * spawn error. Distinct from `emptyOutputs`, where ffmpeg ran to completion
     * and simply had no picture to give: only the latter says anything about
     * the FILE, so only the latter may be classified `container_unreadable`.
     */
    spawnFailures: number;
    /** True when the tail-stop guard cut the run short. */
    stoppedEarly: boolean;
    /**
     * True when ffmpeg stopped COMPLETING and the run was abandoned. Unlike
     * `stoppedEarly` this says nothing about the file, so the caller must not
     * persist what was extracted — see the note at the break that sets it.
     */
    environmentFailed: boolean;
    /** Decode path the bulk of the frames actually ran on. Logged, not acted on. */
    decodeMode: DecodeMode;
    /** First hard spawn failure (timeout, ENOENT, non-zero exit). */
    error?: string;
    /**
     * Verbatim ffmpeg stderr from the first empty-output frame — this is the
     * demuxer complaint (`… invalid as first byte of an EBML number`) that
     * tells an admin what is actually wrong with the file, and where.
     */
    emptyOutputReason?: string;
}

/**
 * Extract one frame per sample point.
 *
 * 🔴 THE EMPTY-OUTPUT CONTRACT — do not "simplify" this away.
 *
 * When ffmpeg cannot produce a picture at the requested timestamp (seek past
 * the last decodable frame, an unreadable container, an interior hole) it
 * **exits 0 and leaves a 0-byte file behind**. It does not fail. Prior to
 * 2026-08-20 this function counted those as extracted, the sprite assembler
 * read them back as empty Buffers, and sharp threw `Input Buffer is empty`,
 * which failed the whole item — which the run-wrapper reset to `pending`, so
 * it retried forever. On prod that pinned both trickplay slots in a permanent
 * loop: 48 items/hour failing, 6 completing, 748 pending, stage stuck at 98%.
 *
 * So: every output is stat'd, zero-length files are deleted and reported as
 * `emptyOutputs`, and only genuinely-decoded indices come back in
 * `usableIndices`.
 */
async function extractAllFrames(
    videoPath: string,
    outputDir: string,
    intervalSeconds: number,
    width: number,
    quality: number,
    expectedCount: number,
    videoInfo: Pick<VideoInfo, 'width' | 'codec' | 'pixFmt'>,
    denyList?: HwaccelDenyList,
    abortSignal?: AbortSignal,
): Promise<FrameExtraction> {
    const usableIndices = new Set<number>();
    let firstError: string | undefined;
    let emptyOutputReason: string | undefined;
    let emptyOutputs = 0;
    let spawnFailures = 0;
    let requested = 0;
    let stoppedEarly = false;

    const concurrency = perFrameConcurrency();
    // Codec + pixel format, NOT codec alone — see hwaccelCodecKey. Computed
    // once so every latch check/write below judges the same (card, codec,
    // profile) triple this source actually is.
    const codecKey = hwaccelCodecKey(videoInfo);
    let mode = await resolveDecodeMode(codecKey, denyList);
    // Indices whose ffmpeg never completed — retried in software at the end.
    const spawnFailedIndices = new Set<number>();

    const framePathFor = (i: number) =>
        join(outputDir, `frame_${String(i + 1).padStart(4, '0')}.webp`);

    // Per-index outcome, in index order, so the trailing-failure run below is
    // measured against the timeline rather than completion order. The KIND
    // matters, not just success: an empty output is a fact about the file, a
    // spawn failure is a fact about this attempt, and the two must lead to
    // different early stops.
    const usable: boolean[] = [];
    const outcomeKind: ('ok' | 'empty' | 'failed')[] = [];
    let environmentFailed = false;
    const tailStopRun = Math.max(concurrency * 2, Math.ceil(TAIL_STOP_SECONDS / intervalSeconds));

    /** Record one frame's outcome into the shared tallies. */
    const record = (
        i: number,
        outcome: { usable: boolean; spawnFailed: boolean; stderr: string; error?: string },
    ): void => {
        if (outcome.usable) {
            usable[i] = true;
            outcomeKind[i] = 'ok';
            usableIndices.add(i);
            return;
        }
        usable[i] = false;
        if (outcome.spawnFailed) {
            outcomeKind[i] = 'failed';
            spawnFailures++;
            spawnFailedIndices.add(i);
            firstError ??= outcome.error;
        } else {
            outcomeKind[i] = 'empty';
            // Only a COMPLETED ffmpeg that produced no picture counts as an
            // empty output — that is the fact about the file. A kill or spawn
            // error is counted in `spawnFailures` instead, so the two can never
            // be confused downstream.
            emptyOutputs++;
            emptyOutputReason ??= firstMeaningfulFFmpegError(outcome.stderr);
        }
    };

    /**
     * Decide whether the hardware path works, using one real frame.
     *
     * 🔴 A GPU that cannot decode this source must cost us ONE frame, not the
     * whole source. So: if the hardware attempt yields nothing, re-run the SAME
     * index in software. Software succeeding is the proof that hardware — not
     * the file — is at fault, and only then is hardware switched off (for the
     * rest of the process, since it is a property of the box).
     *
     * Returns whether the probe settled the question. If BOTH attempts came
     * back empty, the timestamp tells us nothing about the GPU — a file can
     * legitimately have no picture at a given point — so the caller probes
     * again further in rather than committing to a mode on no evidence.
     */
    const probeFrame = async (i: number): Promise<boolean> => {
        const framePath = framePathFor(i);
        const hw = await extractOneFrame({
            mode,
            index: i,
            intervalSeconds,
            videoPath,
            framePath,
            width,
            quality,
            timeoutMs: perFrameTimeoutMs(videoInfo.width, mode),
            // A probe failing is the probe working — the software control runs
            // next and rescues the frame, so this must not log as an incident.
            // Prod: 76 `libwebp: Could not open encoder` ERRORs in 30 minutes,
            // one per Xvid file, every one of them handled.
            expectFailure: true,
            ...(abortSignal ? { abortSignal } : {}),
        });
        if (hw.usable) {
            record(i, hw);
            return true;
        }
        if (abortSignal?.aborted) {
            record(i, hw);
            return true;
        }

        const sw = await extractOneFrame({
            mode: 'software',
            index: i,
            intervalSeconds,
            videoPath,
            framePath,
            width,
            quality,
            timeoutMs: perFrameTimeoutMs(videoInfo.width, 'software'),
            ...(abortSignal ? { abortSignal } : {}),
        });
        if (sw.usable) {
            logger.warn('Trickplay hardware decode unavailable — falling back to software', {
                videoPath,
                mode,
                codec: videoInfo.codec,
                device: config.TRICKPLAY_HWACCEL_DEVICE,
                probeError: hw.error ?? firstMeaningfulFFmpegError(hw.stderr),
            });
            await denyHwaccelForCodec(codecKey, denyList);
            mode = 'software';
        }
        record(i, sw);
        return sw.usable;
    };

    // Probe alone, before opening the taps, so a GPU that cannot decode this
    // source costs one wasted frame instead of `concurrency` of them.
    //
    // 🔴 Bounded, and exhaustion falls back to SOFTWARE — never to the mode we
    // failed to confirm. A file whose first frames genuinely have no picture
    // (black leader, an unseekable head) burns every probe inconclusively; on a
    // box where hardware is also broken, staying on hardware then fails every
    // remaining frame and the source gets written off `container_unreadable`
    // even though 17 of its 20 sample points decode fine in software. Software
    // is the always-available path, so it is the only safe thing to fall back
    // to when the evidence ran out.
    let hwSettled = mode === 'software';
    let probesLeft = MAX_HWACCEL_PROBES;

    let batchStart = 0;
    while (batchStart < expectedCount) {
        if (abortSignal?.aborted) break;

        if (!hwSettled) {
            if (probesLeft > 0) {
                probesLeft--;
                hwSettled = await probeFrame(batchStart);
                requested = Math.max(requested, batchStart + 1);
                batchStart += 1;
                continue;
            }
            if (mode !== 'software') {
                logger.warn('Trickplay hardware probe inconclusive — using software for safety', {
                    videoPath,
                    mode,
                    codec: videoInfo.codec,
                    probes: MAX_HWACCEL_PROBES,
                });
                mode = 'software';
            }
            hwSettled = true;
        }

        const batchEnd = Math.min(batchStart + concurrency, expectedCount);

        await Promise.all(
            Array.from({ length: batchEnd - batchStart }, (_, offset) => batchStart + offset).map(
                async (i) => {
                    if (abortSignal?.aborted) return;
                    const outcome = await extractOneFrame({
                        mode,
                        index: i,
                        intervalSeconds,
                        videoPath,
                        framePath: framePathFor(i),
                        width,
                        quality,
                        timeoutMs: perFrameTimeoutMs(videoInfo.width, mode),
                        ...(abortSignal ? { abortSignal } : {}),
                    });
                    record(i, outcome);
                },
            ),
        );

        requested = batchEnd;
        batchStart = batchEnd;

        // Trailing run: how far back from here did nothing usable come out?
        let trailing = 0;
        let trailingHasSpawnFailure = false;
        for (let i = batchEnd - 1; i >= 0 && usable[i] === false; i--) {
            trailing++;
            if (outcomeKind[i] === 'failed') trailingHasSpawnFailure = true;
        }
        if (trailing >= tailStopRun && batchEnd < expectedCount) {
            // 🔴 Two very different reasons to stop, and conflating them was a
            // bug in waiting.
            //
            // A run of EMPTY outputs means the file's video ends before its
            // container claims — a fact about the media, so the frames we have
            // are the whole truth and get persisted (`stoppedEarly`).
            //
            // A run of SPAWN FAILURES means this attempt could not run ffmpeg,
            // which says nothing about the file. Persisting there would bank a
            // truncated sheet — 35 tiles of a 900-frame movie — that
            // `hasTrickplay()` then treats as finished forever. On hardware the
            // right move is to demote and keep going, since the GPU dying under
            // concurrency is exactly this shape; in software there is nothing
            // left to fall back to, so the run is abandoned without persisting.
            if (trailingHasSpawnFailure) {
                if (mode !== 'software') {
                    logger.warn(
                        'Hardware decode failing in a run — demoting to software mid-extraction',
                        { videoPath, mode, codec: videoInfo.codec, trailing },
                    );
                    await denyHwaccelForCodec(codecKey, denyList);
                    mode = 'software';
                    // Re-attempt the failed stretch on the way out; do NOT stop.
                    continue;
                }
                environmentFailed = true;
                logger.warn('Trickplay extraction abandoned — ffmpeg stopped completing', {
                    videoPath,
                    trailing,
                    spawnFailures,
                });
                break;
            }
            stoppedEarly = true;
            logger.info('Trickplay extraction stopped at undecodable tail', {
                videoPath,
                lastUsableSeconds: (batchEnd - trailing) * intervalSeconds,
                claimedDurationSeconds: expectedCount * intervalSeconds,
                skippedFrames: expectedCount - batchEnd,
            });
            break;
        }
    }

    // ── Software rescue pass ────────────────────────────────────────────────
    //
    // 🔴 A spawn failure (timeout, kill, ENOENT) says nothing about the FILE —
    // only that this attempt did not complete. Left alone it becomes a hole in
    // the sheet that no retry ever fills, because the manifest gets written and
    // `hasTrickplay()` reports the source as done forever.
    //
    // The shape that makes this urgent is the GPU that survives the single-frame
    // probe and then fails under `concurrency` parallel decodes (surface
    // exhaustion, contention with a live transcode). Frame 0 is usable, every
    // frame after it is a spawn failure, and the tail-stop guard cuts the run
    // short and persists a ONE-TILE sprite sheet as a finished trickplay.
    //
    // So: give every non-completing frame one more chance on the always-
    // available path. If software rescues a meaningful share of them, that is
    // also proof the GPU — not the file — was at fault, so latch the codec off.
    if (spawnFailedIndices.size > 0 && !abortSignal?.aborted) {
        const toRetry = [...spawnFailedIndices].sort((a, b) => a - b);
        let rescued = 0;
        logger.warn('Retrying frames whose ffmpeg never completed, in software', {
            videoPath,
            mode,
            codec: videoInfo.codec,
            frames: toRetry.length,
        });
        for (let i = 0; i < toRetry.length; i += concurrency) {
            if (abortSignal?.aborted) break;
            await Promise.all(
                toRetry.slice(i, i + concurrency).map(async (index) => {
                    if (abortSignal?.aborted) return;
                    const outcome = await extractOneFrame({
                        mode: 'software',
                        index,
                        intervalSeconds,
                        videoPath,
                        framePath: framePathFor(index),
                        width,
                        quality,
                        timeoutMs: perFrameTimeoutMs(videoInfo.width, 'software'),
                        ...(abortSignal ? { abortSignal } : {}),
                    });
                    if (outcome.usable) {
                        rescued++;
                        spawnFailures--;
                        spawnFailedIndices.delete(index);
                        usable[index] = true;
                        outcomeKind[index] = 'ok';
                        usableIndices.add(index);
                    } else if (!outcome.spawnFailed) {
                        // Software ran and had no picture — that IS a fact about
                        // the file, so reclassify rather than keeping it as a
                        // failed attempt.
                        spawnFailures--;
                        spawnFailedIndices.delete(index);
                        outcomeKind[index] = 'empty';
                        emptyOutputs++;
                        emptyOutputReason ??= firstMeaningfulFFmpegError(outcome.stderr);
                    }
                }),
            );
        }
        if (rescued > 0 && mode !== 'software') {
            logger.warn('Hardware decode failed under concurrency — disabling it for this codec', {
                videoPath,
                mode,
                codec: videoInfo.codec,
                rescued,
            });
            await denyHwaccelForCodec(codecKey, denyList);
            mode = 'software';
        }
    }

    return {
        usableIndices,
        extracted: usableIndices.size,
        requested,
        emptyOutputs,
        spawnFailures,
        stoppedEarly,
        environmentFailed,
        decodeMode: mode,
        ...(usableIndices.size === 0
            ? { error: firstError ?? emptyOutputReason ?? 'No frames extracted' }
            : {}),
        ...(emptyOutputReason !== undefined ? { emptyOutputReason } : {}),
    };
}

/**
 * Pull the first line out of ffmpeg stderr that names an actual problem, with
 * the `[demuxer @ 0x…]` address prefix stripped — that address changes every
 * run and would make the stored `detail` look different each time for the
 * same defect.
 *
 * Keeps the byte offset (`0x00 at pos 8193 (0x2001) invalid as first byte of
 * an EBML number`) because "where" is half of what makes the reason useful.
 */
function firstMeaningfulFFmpegError(stderr: string): string | undefined {
    const ERRORISH =
        /invalid|error|corrupt|failed|could not|cannot|unable|no such|truncat|malformed|missing|does not contain|non[- ]monotonic|empty/i;
    for (const raw of stderr.split('\n')) {
        const line = raw.replace(/\[[^\]]*@\s*0x[0-9a-f]+\]\s*/gi, '').trim();
        if (!line || !ERRORISH.test(line)) continue;
        return line.slice(0, 300);
    }
    return undefined;
}

/**
 * Highest member of a non-empty index set. A plain `Math.max(...set)` blows
 * the argument limit once a long file is sampled at a short interval.
 */
function highestIndex(indices: Set<number>): number {
    let max = -1;
    for (const i of indices) if (i > max) max = i;
    return max;
}

/** The decode-time subset of file health issues this service owns. */
type DecodeIssueType = 'container_unreadable' | 'video_ends_early' | 'video_decode_gaps';

/**
 * Annotate the file row so the admin's Media → "Has file issues" filter shows
 * WHY this file misbehaves, with the verbatim ffmpeg reason.
 *
 * Never allowed to fail the generation: an unwritable annotation is strictly
 * less important than the sprites we just produced.
 */
async function recordSourceHealthIssue(
    sourceId: string,
    type: DecodeIssueType,
    args: { detail: string; expectedDuration?: number; actualDuration?: number },
): Promise<void> {
    try {
        const sql = await aiDbService.getSql();
        // getSql() is nullable when the DB isn't up; an annotation is not
        // worth failing a finished generation over.
        if (!sql) return;
        await recordDecodeHealthIssue(sql, { fileId: sourceId, type, ...args });
    } catch (err) {
        logger.warn('Failed to record trickplay decode health issue', {
            sourceId,
            type,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/** Drop stale decode issues once a file decodes cleanly again. */
async function clearSourceHealthIssues(
    sourceId: string,
    types: Array<DecodeIssueType>,
): Promise<void> {
    if (types.length === 0) return;
    try {
        const sql = await aiDbService.getSql();
        if (!sql) return;
        await clearDecodeHealthIssues(sql, sourceId, types);
    } catch (err) {
        logger.warn('Failed to clear trickplay decode health issues', {
            sourceId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Turn the extraction outcome into file-health annotations.
 *
 * Only MATERIAL problems are recorded. Practically every file's final sample
 * lands inside the last fraction of a second and yields nothing, so a one- or
 * two-frame tail is normal and must not flag the entire library.
 */
async function reportDecodeHealth(
    sourceId: string,
    videoPath: string,
    extraction: FrameExtraction,
    claimedDuration: number,
    intervalSeconds: number,
    expectedCount: number,
): Promise<void> {
    const lastUsableIndex = highestIndex(extraction.usableIndices);
    const decodableSeconds = (lastUsableIndex + 1) * intervalSeconds;
    const shortfall = claimedDuration - decodableSeconds;
    const resolved: Array<DecodeIssueType> = ['container_unreadable'];

    // Tail: the container promises materially more than decodes. Needs BOTH a
    // meaningful absolute gap and a meaningful relative one so a long film
    // missing its last 90s isn't judged by the same bar as a 20-minute episode.
    let endsEarly: 'record' | 'clear' | 'untouched' = 'clear';
    if (
        extraction.stoppedEarly ||
        (shortfall > 60 && shortfall / Math.max(claimedDuration, 1) > 0.05)
    ) {
        // Ask the streams before blaming the file. A failed extraction can stop
        // early for reasons that say nothing about the container (a transient
        // decode error), while the video itself runs to the end.
        const tails = await probeStreamTails(videoPath);
        if (
            tails.videoEnd != null &&
            claimedDuration - tails.videoEnd <= streamLossToleranceSeconds(claimedDuration)
        ) {
            endsEarly = 'untouched';
            logger.warn(
                'Trickplay: extraction stopped early but the video continues — not recording',
                { sourceId, videoPath, claimedDuration, videoEnd: tails.videoEnd },
            );
        } else if (
            isMaterialStreamLoss({
                containerDuration: claimedDuration,
                videoEnd: tails.videoEnd ?? decodableSeconds,
                audioEnd: tails.audioEnd,
                hasAudio: tails.hasAudio,
                endedPrematurely: tails.endedPrematurely,
            })
        ) {
            endsEarly = 'record';
        }
    }
    if (endsEarly === 'record') {
        await recordSourceHealthIssue(sourceId, 'video_ends_early', {
            detail:
                `Video decodes to ~${Math.round(decodableSeconds)}s but the container reports ` +
                `${Math.round(claimedDuration)}s — ${Math.round(shortfall)}s past the last frame ` +
                `ffmpeg could produce` +
                (extraction.emptyOutputReason ? `. ffmpeg: ${extraction.emptyOutputReason}` : ''),
            expectedDuration: claimedDuration,
            actualDuration: decodableSeconds,
        });
        logger.warn('Trickplay: container duration over-reports decodable video', {
            sourceId,
            videoPath,
            claimedDuration,
            decodableSeconds,
        });
    } else if (endsEarly === 'clear') {
        resolved.push('video_ends_early');
    }

    // Interior holes: empty outputs that sit BEFORE the last good frame, so
    // they can't be explained by the file simply ending.
    let interiorGaps = 0;
    for (let i = 0; i < lastUsableIndex; i++) {
        if (!extraction.usableIndices.has(i)) interiorGaps++;
    }
    if (interiorGaps > 0 && interiorGaps / (lastUsableIndex + 1) > 0.02) {
        let firstGap = 0;
        while (firstGap < lastUsableIndex && extraction.usableIndices.has(firstGap)) firstGap++;
        await recordSourceHealthIssue(sourceId, 'video_decode_gaps', {
            detail:
                `${interiorGaps} sample point(s) inside the file produced no frame ` +
                `(first at ~${Math.round(firstGap * intervalSeconds)}s of ` +
                `${Math.round(claimedDuration)}s)` +
                (extraction.emptyOutputReason ? `. ffmpeg: ${extraction.emptyOutputReason}` : ''),
        });
        logger.warn('Trickplay: interior decode gaps', {
            sourceId,
            videoPath,
            interiorGaps,
            sampledFrames: expectedCount,
        });
    } else {
        resolved.push('video_decode_gaps');
    }

    await clearSourceHealthIssues(sourceId, resolved);
}

async function generateTrickplayForSingleSource(
    sql: postgres.Sql,
    mediaItemId: string,
    sourceId: string,
    videoPath: string,
    options: TrickplayOptions = {},
): Promise<SourceGenerationResult> {
    const startTime = Date.now();
    const intervalMs = options.intervalMs ?? config.TRICKPLAY_INTERVAL_MS;
    const tileWidth = options.tileWidth ?? config.TRICKPLAY_TILE_WIDTH;
    const tileHeight = options.tileHeight ?? config.TRICKPLAY_TILE_HEIGHT;
    const width = options.width ?? config.TRICKPLAY_WIDTH;

    const existing =
        !options.force && (await hasTrickplay(sourceId, width, videoPath))
            ? await getTrickplayManifest(sourceId, width, videoPath)
            : null;
    let matchesSource = false;
    if (
        existing?.reuse &&
        matchesTrickplaySettings(existing, options) &&
        (await hasCompleteTrickplayFiles({ fileId: sourceId, filePath: videoPath }, existing))
    ) {
        // Alongside storage is keyed by basename and can outlive its media_files
        // row. Settings and complete sprites alone cannot identify the source.
        try {
            const current = await fingerprintTrickplaySource(videoPath);
            matchesSource =
                current.sampledHash === existing.reuse.sampledHash &&
                current.size === existing.reuse.size &&
                current.mtimeMs === existing.reuse.mtimeMs;
        } catch {
            // Without proof, regenerate rather than serve a previous file's images.
        }
    }
    if (matchesSource && existing) {
        await persistLocalTrickplayParams(sql, mediaItemId, sourceId, existing);
        logger.info('Trickplay already exists, skipping', {
            sourceId,
            width,
        });
        return {
            success: true,
            fileId: sourceId,
            generated: 0,
            skipped: 1,
            errors: 0,
            duration: Date.now() - startTime,
        };
    }

    // In jellyfin_disk mode, defer to Jellyfin's sprites and skip generation.
    // In prefer_local / local_only the goal is for Lumastra to take over once it
    // has its own sprites, so we generate even when Jellyfin trickplay exists.
    if (
        !options.force &&
        config.TRICKPLAY_PROVIDER === 'jellyfin_disk' &&
        (await hasJellyfinTrickplay(videoPath))
    ) {
        logger.info('Jellyfin trickplay exists on disk, skipping generation', {
            sourceId,
            width,
        });
        return {
            success: true,
            fileId: sourceId,
            generated: 0,
            skipped: 1,
            errors: 0,
            duration: Date.now() - startTime,
        };
    }

    // Refused before ffprobe and every frame's ffmpeg: a library file whose
    // content became a playlist/manifest body after the last scan would have
    // both follow its references into other libraries. PERMANENT for the same
    // reason as the probe write-offs below — re-running reads the same bytes,
    // and a replaced file comes back through `file.contentChanged`. An
    // unreadable file or an fs-guard timeout is not refused (the guard leaves
    // it to ffprobe); any unexpected throw stays retryable through the
    // caller's catch. Each frame re-checks too — see extractOneFrame.
    try {
        await assertTranscodeInputIsMedia({ localFilePath: videoPath });
    } catch (err) {
        if (!(err instanceof PlaylistSourceRefusedError)) throw err;
        logger.warn('Trickplay: source is a playlist/manifest body — writing off', {
            sourceId,
            videoPath,
            magic: err.magic,
        });
        return {
            success: false,
            permanent: true,
            fileId: sourceId,
            generated: 0,
            skipped: 0,
            errors: 1,
            duration: Date.now() - startTime,
            error: err.message,
        };
    }

    const publicationStat = await safeStat(videoPath);
    const videoInfo = (await storedVideoInfoFor(sourceId)) ?? (await getVideoInfo(videoPath));
    // Both probe failures below are PERMANENT, exactly like the no-frames case
    // further down. Without `permanent: true`, `success: false` routes through
    // `resetRunningToPending`, which deliberately leaves `attempt` alone — so the
    // stage row goes straight back to `pending`, the sweep re-enqueues it 60s
    // later, and it churns forever without ever dead-lettering.
    //
    // Observed on prod 2026-08-27: one anime episode carried two file rows, one of
    // which no longer existed on disk. ffprobe returned no duration for the missing
    // file, so this path ran ~once a minute indefinitely — 41 runs in 42 minutes for
    // a single item, 7 items doing it at once, and nothing in the logs at all
    // because neither branch logged. Historically the same churn ran at 35-40
    // MINUTES per run (3,649 runs on 2026-08-23), so the wasted work was not small.
    //
    // Retrying cannot change either answer: a file ffprobe cannot read stays
    // unreadable, and an audio-only file does not grow a video stream. Recovery is
    // event-driven and already wired — the stage's `invalidatedBy` covers
    // `file.attached`, `file.contentChanged`, `file.detached` and `file.probed`, so
    // replacing or re-probing the file brings it straight back.
    if (videoInfo.probeFailed) {
        // Transient: ffprobe could not run. Retryable, and deliberately NOT
        // `permanent` — a spun-down disk or an unmounted share must not write off
        // every file in the swept slice. No health issue recorded either: nothing
        // has been learned about the file.
        logger.warn('Trickplay: ffprobe could not run — leaving retryable', {
            sourceId,
            videoPath,
        });
        return {
            success: false,
            fileId: sourceId,
            generated: 0,
            skipped: 0,
            errors: 1,
            duration: Date.now() - startTime,
            error: 'ffprobe failed to run',
        };
    }

    // `!(duration > 0)` rather than `duration <= 0`: ffprobe can report a
    // non-numeric duration ("N/A" on a damaged container), and parseFloat gives
    // NaN — which passes `NaN <= 0 === false` and flows into Math.ceil(NaN) below.
    if (!(videoInfo.duration > 0)) {
        logger.warn('Trickplay: could not determine video duration — writing off', {
            sourceId,
            videoPath,
        });
        await recordSourceHealthIssue(sourceId, 'container_unreadable', {
            detail: 'ffprobe returned no usable duration (file missing or unreadable?)',
        });
        return {
            success: false,
            permanent: true,
            fileId: sourceId,
            generated: 0,
            skipped: 0,
            errors: 1,
            duration: Date.now() - startTime,
            error: 'Could not determine video duration',
        };
    }

    if (videoInfo.width <= 0 || videoInfo.height <= 0) {
        logger.warn('Trickplay: no video stream — writing off', { sourceId, videoPath });
        await recordSourceHealthIssue(sourceId, 'container_unreadable', {
            detail: 'ffprobe reported no video stream dimensions (audio-only file?)',
        });
        return {
            success: false,
            permanent: true,
            fileId: sourceId,
            generated: 0,
            skipped: 0,
            errors: 1,
            duration: Date.now() - startTime,
            error: 'No video stream found (audio-only file?)',
        };
    }

    const intervalSeconds = intervalMs / 1000;
    const totalThumbnails = Math.ceil(videoInfo.duration / intervalSeconds);
    const thumbnailsPerSheet = tileWidth * tileHeight;
    // NOTE: the sheet count is derived later from what actually decoded
    // (`coveredSheets`), not from the container's claimed duration — an
    // over-reporting container would otherwise demand sheets for video that
    // does not exist.

    // Use actual video aspect ratio; fall back to 16:9 if ffprobe didn't return dimensions
    const aspectRatio =
        videoInfo.width > 0 && videoInfo.height > 0 ? videoInfo.height / videoInfo.width : 9 / 16;
    const height = Math.floor((width * aspectRatio) / 2) * 2;

    // Per-job unique temp dir to avoid race conditions
    // Use /tmp (container-local) for temp files — only final output goes to shared storage
    const tempDir = join('/tmp', 'trickplay-temp', sourceId, randomUUID());
    await mkdir(tempDir, { recursive: true });

    // Capture before decoding; a file replaced during extraction cannot certify
    // output for the replacement. Failure only disables reuse, not generation.
    let fingerprint: TrickplayFingerprint | undefined;
    try {
        fingerprint = await fingerprintTrickplaySource(videoPath);
    } catch {
        logger.debug('Source fingerprint unavailable; trickplay will not be reclaimable', {
            sourceId,
        });
    }
    const spriteQuality = config.TRICKPLAY_QUALITY;

    const storageGeneration = randomUUID();
    let published = false;
    const manifest: TrickplayManifest = {
        storageGeneration,
        version: '1.0',
        width,
        height,
        tileWidth,
        tileHeight,
        interval: intervalMs,
        thumbnailCount: 0, // Updated after extraction with actual count
        format: 'webp',
        sheets: [],
    };

    let errors = 0;
    let generated: number;
    // Hoisted out of the try so the completion log can report what the
    // extraction actually did (empty outputs, tail-stop) after `finally`.
    let extraction: FrameExtraction;

    try {
        // Per-frame extraction — deliberately NOT a single continuous decode
        // pass; see the long note on extractAllFrames for why the faster
        // version silently produced wrong thumbnails.
        const quality = options.quality ?? config.TRICKPLAY_QUALITY;
        extraction = await extractAllFrames(
            videoPath,
            tempDir,
            intervalSeconds,
            width,
            quality,
            totalThumbnails,
            // SOURCE dimensions + codec, not the thumbnail width: the former
            // decides how expensive one frame is (and so how long to wait for
            // it), the latter scopes the hardware-decode latch.
            videoInfo,
            options.hwaccelDenyList,
            options.signal,
        );

        // 🔴 A run cancelled mid-extraction (admin Cancel, or a pod shutting down)
        // returns the frames it got with `stoppedEarly` false and no spawn
        // failures: the per-frame workers return without recording once the
        // signal fires. Persisting that partial result banks a truncated sheet as
        // finished, and the missing tail then reads as `video_ends_early`. A
        // cancellation says nothing about the file, so return transient before
        // persisting or reporting health.
        if (options.signal?.aborted) {
            return {
                success: false,
                fileId: sourceId,
                generated: 0,
                skipped: 0,
                errors: 1,
                duration: Date.now() - startTime,
                error: 'Cancelled',
            };
        }

        if (extraction.extracted === 0) {
            // "No frames" only indicts the FILE when ffmpeg actually ran and
            // came back empty-handed. A cancelled run, a timeout, or a missing
            // binary produces the same zero, and writing THAT off permanently
            // would bar a perfectly good file from ever being retried — the
            // stage's `file.contentChanged` invalidation cannot rescue it,
            // because the file never changes.
            // A spawn failure that SURVIVED the software rescue pass means the
            // environment, not the container, is what failed — so it must never
            // reach the permanent write-off below regardless of how many empty
            // outputs sit beside it.
            const neverRan = extraction.spawnFailures > 0;
            if (neverRan || options.signal?.aborted) {
                return {
                    success: false,
                    fileId: sourceId,
                    generated: 0,
                    skipped: 0,
                    errors: 1,
                    duration: Date.now() - startTime,
                    error:
                        extraction.error ??
                        (options.signal?.aborted ? 'Cancelled' : 'ffmpeg did not run'),
                };
            }

            // Nothing in this file decodes. Permanent, not transient: retrying
            // a container ffmpeg cannot read will never produce a different
            // answer, and the stage's `file.contentChanged` invalidation is
            // what brings it back if the file is ever replaced.
            await recordSourceHealthIssue(sourceId, 'container_unreadable', {
                detail: extraction.error ?? 'ffmpeg produced no frames anywhere in this file',
            });
            return {
                success: false,
                permanent: true,
                fileId: sourceId,
                generated: 0,
                skipped: 0,
                errors: 1,
                duration: Date.now() - startTime,
                error: extraction.error ?? 'No frames extracted',
            };
        }

        // 🔴 Do NOT persist an extraction the ENVIRONMENT cut short.
        //
        // `spawnFailures` here are frames that failed twice: once in the chosen
        // mode and again on the software rescue pass. They are not facts about
        // the file — unlike `emptyOutputs`, which legitimately leave holes — and
        // the moment a manifest is written `hasTrickplay()` reports this source
        // as done forever. A GPU dying under concurrency, or a box so loaded
        // that frames blow their ceiling, would otherwise bank a one-tile sprite
        // sheet as a finished trickplay and never revisit it.
        //
        // Tolerate a handful (a genuinely flaky spawn should not cost the whole
        // source), and fail TRANSIENTLY past that so the next run retries.
        const spawnFailureBudget = Math.max(2, Math.floor(extraction.requested * 0.05));
        if (extraction.environmentFailed || extraction.spawnFailures > spawnFailureBudget) {
            return {
                success: false,
                fileId: sourceId,
                generated: 0,
                skipped: 0,
                errors: 1,
                duration: Date.now() - startTime,
                error:
                    `${extraction.spawnFailures} of ${extraction.requested} frames never ` +
                    `completed (tolerance ${spawnFailureBudget}); not persisting a partial ` +
                    `sprite sheet. First error: ${extraction.error ?? 'unknown'}`,
            };
        }

        // Assemble frames into sprite sheets one sheet at a time.
        // Frames are already on disk with deterministic names; read only the
        // thumbnailsPerSheet frames needed for the current sheet, composite
        // it, save it, then let those buffers be GC'd before the next sheet.
        // Peak memory is thus bounded to one sheet regardless of video length.
        generated = 0;

        // 🔴 Sheets are addressed POSITIONALLY by the player:
        // `tileIndex = floor(time / interval)` then `sheet = floor(tileIndex /
        // tilesPerSheet)` (TrickplayLoader.getSpriteIndexForTime). So a frame
        // that failed to extract must leave its slot EMPTY — packing the
        // survivors together would shift every later tile and show the wrong
        // scene, the same class of silent corruption documented on
        // extractAllFrames. Unfilled slots stay the sheet's black background.
        const lastUsableIndex = highestIndex(extraction.usableIndices);
        const coveredThumbnails = lastUsableIndex + 1;
        const coveredSheets = Math.ceil(coveredThumbnails / thumbnailsPerSheet);

        for (let sheetIndex = 0; sheetIndex < coveredSheets; sheetIndex++) {
            const startThumbnail = sheetIndex * thumbnailsPerSheet;
            const endThumbnail = Math.min(startThumbnail + thumbnailsPerSheet, coveredThumbnails);

            // Read only the frames that belong to this sheet AND actually
            // decoded, keeping each one's slot within the sheet.
            const sheetThumbnails: Array<{ slot: number; data: Buffer }> = [];
            for (let i = startThumbnail; i < endThumbnail; i++) {
                if (!extraction.usableIndices.has(i)) continue;
                const framePath = join(tempDir, `frame_${String(i + 1).padStart(4, '0')}.webp`);
                try {
                    const data = await readFile(framePath);
                    // Belt and braces: extractAllFrames already deleted empty
                    // outputs, but sharp treats a 0-byte Buffer as a hard
                    // error, so never hand it one under any circumstances.
                    if (data.length === 0) {
                        errors++;
                        continue;
                    }
                    sheetThumbnails.push({ slot: i - startThumbnail, data });
                    generated++;
                } catch {
                    // best-effort: a missing frame is counted in `errors` (surfaced in the result), not silently dropped.
                    errors++;
                }
            }

            if (sheetThumbnails.length > 0) {
                const sheetData = await createSpriteSheetFromFrames(
                    sheetThumbnails,
                    endThumbnail - startThumbnail,
                    width,
                    height,
                    tileWidth,
                );

                const sheetFilename = `${sheetIndex}.webp`;
                await saveSpriteSheet(
                    sourceId,
                    width,
                    sheetIndex,
                    sheetData,
                    videoPath,
                    storageGeneration,
                );

                manifest.sheets.push({
                    index: sheetIndex,
                    filename: sheetFilename,
                    startTime: startThumbnail * intervalSeconds,
                    endTime: (endThumbnail - 1) * intervalSeconds,
                    // Slots covered, NOT tiles filled — the player indexes by
                    // slot, so a gap still occupies its position.
                    thumbnailCount: endThumbnail - startThumbnail,
                });
            }
        }

        manifest.thumbnailCount = coveredThumbnails;

        if (fingerprint && !extraction.stoppedEarly && errors === 0) {
            const current = await stat(videoPath);
            if (current.size === fingerprint.size && current.mtimeMs === fingerprint.mtimeMs) {
                manifest.reuse = {
                    sampledHash: fingerprint.sampledHash,
                    mtimeMs: fingerprint.mtimeMs,
                    size: fingerprint.size,
                    quality,
                    spriteQuality,
                    providerId: 'local-trickplay',
                };
            }
        }

        if (errors > 0)
            throw new Error('Seek preview replacement is incomplete; previous previews retained.');
        const currentSource = await safeStat(videoPath);
        if (
            options.signal?.aborted ||
            currentSource.size !== publicationStat.size ||
            currentSource.mtimeMs !== publicationStat.mtimeMs ||
            currentSource.ino !== publicationStat.ino ||
            currentSource.dev !== publicationStat.dev ||
            currentSource.ctimeMs !== publicationStat.ctimeMs
        )
            throw new Error(
                'Source changed during seek preview generation; previous previews retained.',
            );
        await saveTrickplayManifest(sourceId, width, manifest, videoPath);
        published = true;

        // Sprites are safely on disk — now describe whatever was wrong with
        // the source so it shows up under Media → "Has file issues".
        await reportDecodeHealth(
            sourceId,
            videoPath,
            extraction,
            videoInfo.duration,
            intervalSeconds,
            totalThumbnails,
        );

        // Write params to DB cache so consumers can find them immediately.
        await persistLocalTrickplayParams(sql, mediaItemId, sourceId, manifest);
    } finally {
        if (!published)
            await deleteTrickplayGeneration(sourceId, width, storageGeneration, videoPath).catch(
                (error: unknown) =>
                    logger.warn('Could not remove unfinished seek previews', {
                        sourceId,
                        error: String(error),
                    }),
            );
        // Decoded temporary frames never survive the job.
        try {
            await rm(tempDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup errors
        }
    }

    const resultDuration = Date.now() - startTime;
    logger.info('Trickplay generation complete', {
        sourceId,
        generated,
        errors,
        // Sample points ffmpeg declined to render. NOT counted as errors —
        // treating "this timestamp has no picture" as a failure is what put
        // the stage in a permanent retry loop before 2026-08-20.
        emptyOutputs: extraction.emptyOutputs,
        sampledFrames: extraction.requested,
        stoppedAtTail: extraction.stoppedEarly,
        decode: extraction.decodeMode,
        duration: resultDuration,
        sheets: manifest.sheets.length,
    });

    return {
        success: errors === 0,
        fileId: sourceId,
        generated,
        skipped: 0,
        errors,
        duration: resultDuration,
        error: errors > 0 ? `${errors} frames failed` : undefined,
    };
}

async function getTrickplaySourceSpecs(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<TrickplaySourceSpec[]> {
    const files = await getFilesForMediaItem(sql, mediaItemId);
    return files.map((file) => ({
        sourceId: file.id,
        filePath: file.file_path,
    }));
}

/**
 * Composite one sheet.
 *
 * `frames` is SPARSE — each entry carries the slot it occupies, because a
 * timestamp that failed to decode must leave a hole rather than shuffle its
 * neighbours (the player addresses tiles by position; see the call site).
 * `slotCount` is how many slots the sheet spans, which is what sizes the
 * canvas — deriving it from `frames.length` would shrink the grid whenever a
 * frame is missing and misplace every tile after the gap.
 */
async function createSpriteSheetFromFrames(
    frames: Array<{ slot: number; data: Buffer }>,
    slotCount: number,
    width: number,
    height: number,
    tileWidth: number,
): Promise<Buffer> {
    const cols = tileWidth;
    const rows = Math.ceil(slotCount / cols);
    const sheetWidth = cols * width;
    const sheetHeight = rows * height;

    // Resize all frames to target dimensions in parallel
    const resizedFrames = await Promise.all(
        frames.map(async (frame) => ({
            slot: frame.slot,
            raw: await sharp(frame.data)
                .resize(width, height, { fit: 'fill' })
                .removeAlpha()
                .raw()
                .toBuffer(),
        })),
    );

    // Composite all frames onto a single canvas using sharp.
    // FFmpeg's tile filter doesn't work with image sequences — it only
    // reads the first frame, producing identical tiles across the sheet.
    const composites = resizedFrames.map(({ slot, raw }) => ({
        input: raw,
        raw: { width, height, channels: 3 as const },
        left: (slot % cols) * width,
        top: Math.floor(slot / cols) * height,
    }));

    return sharp({
        create: {
            width: sheetWidth,
            height: sheetHeight,
            channels: 3,
            background: { r: 0, g: 0, b: 0 },
        },
    })
        .composite(composites)
        .webp({ quality: config.TRICKPLAY_QUALITY })
        .toBuffer();
}

export async function generateTrickplayForMediaItem(
    sql: postgres.Sql,
    mediaItemId: string,
    options: TrickplayOptions = {},
): Promise<GenerationResult> {
    const startTime = Date.now();

    if (!config.TRICKPLAY_ENABLED) {
        return {
            success: false,
            sourcesRemaining: 0,
            fileId: mediaItemId,
            generated: 0,
            skipped: 0,
            errors: 0,
            duration: Date.now() - startTime,
            error: 'Trickplay generation is disabled',
        };
    }

    const item = await getMediaItemForTrickplay(sql, mediaItemId);
    if (!item) {
        return {
            success: false,
            sourcesRemaining: 0,
            fileId: mediaItemId,
            generated: 0,
            skipped: 0,
            errors: 0,
            duration: Date.now() - startTime,
            error: 'Media item not found',
        };
    }

    let totalGenerated = 0;
    let totalSkipped = 0;
    let totalErrors = 0;
    // Failures that re-running cannot fix (unreadable container). Tracked
    // separately so a mixed item — one good edition, one corrupt — still
    // retries rather than being written off permanently.
    let permanentFailures = 0;
    // First per-source reason, carried up so the stage row's `last_error`
    // records WHY the item was written off rather than just that it was.
    let firstSourceError: string | undefined;

    // Movie or episode: generate for the single item
    if (isMovie(item.media_type) || isEpisode(item.media_type)) {
        const sourceSpecs = await getTrickplaySourceSpecs(sql, mediaItemId);
        if (sourceSpecs.length === 0) {
            return {
                success: false,
                sourcesRemaining: 0,
                fileId: mediaItemId,
                generated: 0,
                skipped: 0,
                errors: 1,
                duration: Date.now() - startTime,
                error: 'No playable source found',
            };
        }

        // 🔴 ONE WORKING SOURCE PER RUN.
        //
        // An item can carry several sources — most commonly a 1080p and a 4K
        // edition of the same movie — and this loop used to grind through all
        // of them inside a single run's budget. It cannot: a 4K source is a
        // 15-60 minute job on its own against a 30-minute cap, so the run was
        // killed mid-second-source, every extracted frame was discarded, and
        // the item came straight back to start over. Six long movies on prod
        // did exactly that for a full day and never persisted a single sheet —
        // not even for their cheap 1080p edition, which the run never reached
        // because the expensive one went first.
        //
        // So each run does at most one source that actually needs work, then
        // reports the rest as `sourcesRemaining`. Sources already on disk cost
        // a `hasTrickplay` stat and do NOT consume the allowance, so an item
        // whose sources are done just falls straight through.
        //
        // `force` is exempt: an admin who explicitly asked to regenerate this
        // item means all of it, and there is no second pass to finish the job —
        // a sweep re-enqueue arrives WITHOUT force and would skip every source
        // on `hasTrickplay`. The deadline still applies, so a forced run stops
        // cleanly rather than being killed.
        let workedThisRun = 0;
        let processedSources = 0;
        for (let i = 0; i < sourceSpecs.length; i++) {
            // Bail out promptly on Cancel.
            if (options.signal?.aborted) break;
            // Stop cleanly rather than be killed — see TrickplayOptions.deadlineAt.
            if (pastDeadline(options)) break;
            if (workedThisRun > 0 && options.force !== true) break;
            const sourceSpec = sourceSpecs[i];
            processedSources = i + 1;
            const sourceStartedAt = Date.now();
            try {
                const result = await generateTrickplayForSingleSource(
                    sql,
                    mediaItemId,
                    sourceSpec.sourceId,
                    sourceSpec.filePath,
                    options,
                );
                totalGenerated += result.generated;
                totalSkipped += result.skipped;
                totalErrors += result.errors;
                // 🔴 Frames produced OR time spent — either counts as having
                // used this run's allowance. Frames alone is not enough: a
                // source that ground for forty minutes and returned nothing has
                // consumed the budget just as surely as one that succeeded, and
                // waving it through would start the next source with minutes
                // left, which is the watchdog kill this mechanism exists to
                // avoid. Time alone is not enough either: it would let a
                // genuinely quick source slip past. A skipped source (already
                // on disk) costs a `hasTrickplay` stat and correctly counts as
                // neither.
                //
                // EXCEPT a zero-frame `permanent` result: that verdict comes
                // only from the tail-stop guard giving up on an unreadable
                // container, which is bounded (a fixed number of failed
                // seek+decode attempts, never "every timestamp in the file"),
                // not the unbounded multi-minute grind this allowance exists to
                // protect against. Letting it consume the allowance meant a
                // multi-source item with one corrupt edition could never reach
                // its healthy edition: the corrupt source sorts first, burns
                // the allowance every run, and the item cycles pending↔run
                // forever without a single sprite ever being written for the
                // edition that would have worked.
                if (
                    result.generated > 0 ||
                    (result.permanent !== true &&
                        Date.now() - sourceStartedAt >= SOURCE_WORK_THRESHOLD_MS)
                ) {
                    workedThisRun++;
                }
                if (result.permanent) permanentFailures += result.errors;
                if (result.error !== undefined) firstSourceError ??= result.error;
            } catch (err) {
                totalErrors++;
                const message = err instanceof Error ? err.message : String(err);
                firstSourceError ??= message;
                logger.warn('Trickplay generation failed for source', {
                    sourceId: sourceSpec.sourceId,
                    error: message,
                });
            }
            options.onProgress?.(i + 1, sourceSpecs.length);
        }

        return {
            success: totalErrors === 0,
            sourcesRemaining: Math.max(0, sourceSpecs.length - processedSources),
            // Permanent only when EVERY failure was permanent and nothing at
            // all was produced — otherwise the item still has work worth
            // retrying and must not be written off.
            ...(totalErrors > 0 && totalGenerated === 0 && permanentFailures === totalErrors
                ? { permanent: true }
                : {}),
            fileId: mediaItemId,
            generated: totalGenerated,
            skipped: totalSkipped,
            errors: totalErrors,
            duration: Date.now() - startTime,
            ...(totalErrors > 0 && firstSourceError !== undefined
                ? { error: firstSourceError }
                : {}),
        };
    }

    // Series or season: generate for all child episodes
    if (isSeries(item.media_type) || isSeason(item.media_type)) {
        const episodes = isSeries(item.media_type)
            ? await findEpisodesForSeries(sql, mediaItemId)
            : await findEpisodesForSeason(sql, mediaItemId);

        const totalEpisodes = episodes.length;
        // How far the run got, so an interrupted series reports the rest as
        // remaining rather than being written off as covered.
        let episodesProcessed = 0;

        for (let i = 0; i < episodes.length; i++) {
            // Series-scope runs hit dozens to hundreds of episodes — abort
            // before fetching the next episode's sources.
            if (options.signal?.aborted) break;
            // Stop cleanly rather than be killed mid-episode and lose it all.
            if (pastDeadline(options)) break;
            episodesProcessed = i + 1;
            const episode = episodes[i];
            const sourceSpecs = await getTrickplaySourceSpecs(sql, episode.id);
            if (sourceSpecs.length === 0) {
                totalErrors++;
                options.onProgress?.(i + 1, totalEpisodes);
                continue;
            }

            for (const sourceSpec of sourceSpecs) {
                if (options.signal?.aborted) break;
                try {
                    const result = await generateTrickplayForSingleSource(
                        sql,
                        episode.id,
                        sourceSpec.sourceId,
                        sourceSpec.filePath,
                        options,
                    );
                    totalGenerated += result.generated;
                    totalSkipped += result.skipped;
                    totalErrors += result.errors;
                    if (result.permanent) permanentFailures += result.errors;
                    if (result.error !== undefined) firstSourceError ??= result.error;
                } catch (err) {
                    totalErrors++;
                    const message = err instanceof Error ? err.message : String(err);
                    firstSourceError ??= message;
                    logger.warn('Trickplay generation failed for episode source', {
                        episodeId: episode.id,
                        sourceId: sourceSpec.sourceId,
                        error: message,
                    });
                }
            }
            options.onProgress?.(i + 1, totalEpisodes);
        }

        // Fallback: if no episodes found, try generating for the item directly
        if (totalGenerated === 0 && totalSkipped === 0 && episodes.length === 0) {
            const sourceSpecs = await getTrickplaySourceSpecs(sql, mediaItemId);
            for (const sourceSpec of sourceSpecs) {
                if (options.signal?.aborted) break;
                try {
                    const result = await generateTrickplayForSingleSource(
                        sql,
                        mediaItemId,
                        sourceSpec.sourceId,
                        sourceSpec.filePath,
                        options,
                    );
                    totalGenerated += result.generated;
                    totalSkipped += result.skipped;
                    totalErrors += result.errors;
                    if (result.permanent) permanentFailures += result.errors;
                    if (result.error !== undefined) firstSourceError ??= result.error;
                } catch (err) {
                    totalErrors++;
                    const message = err instanceof Error ? err.message : String(err);
                    firstSourceError ??= message;
                    logger.warn('Trickplay generation failed for source', {
                        sourceId: sourceSpec.sourceId,
                        error: message,
                    });
                }
            }
        }

        return {
            success: totalErrors === 0,
            // Episodes, not sources: for a series-scope run the resumable unit
            // is the episode, and the next run re-walks the list with every
            // finished source short-circuiting on `hasTrickplay`.
            sourcesRemaining: Math.max(0, totalEpisodes - episodesProcessed),
            // Same rule as the movie/episode branch above. Without it a season
            // whose every source is an unreadable container never reports
            // `permanent`, so the run wrapper resets the row to `pending` and
            // the item retries forever — the loop fixed for single items in
            // 2026-08-20 was still open on this path.
            ...(totalErrors > 0 && totalGenerated === 0 && permanentFailures === totalErrors
                ? { permanent: true }
                : {}),
            fileId: mediaItemId,
            generated: totalGenerated,
            skipped: totalSkipped,
            errors: totalErrors,
            duration: Date.now() - startTime,
            ...(totalErrors > 0 && firstSourceError !== undefined
                ? { error: firstSourceError }
                : {}),
        };
    }

    return {
        success: false,
        sourcesRemaining: 0,
        fileId: mediaItemId,
        generated: 0,
        skipped: 0,
        errors: 0,
        duration: Date.now() - startTime,
        error: `Unsupported media type: ${item.media_type}`,
    };
}

export async function deleteTrickplay(mediaItemId: string): Promise<boolean> {
    try {
        const sql = await aiDbService.getSql();

        if (!sql) {
            return false;
        }

        const sourceSpecs = await getTrickplaySourceSpecs(sql, mediaItemId);
        const results = await Promise.allSettled(
            sourceSpecs.map((sourceSpec) =>
                deleteTrickplayForFile(sourceSpec.sourceId, sourceSpec.filePath),
            ),
        );

        const failures = results.filter((r) => r.status === 'rejected');
        if (failures.length > 0) {
            logger.warn(
                `Partial trickplay deletion failure [mediaItemId=${mediaItemId}, failed=${failures.length}/${sourceSpecs.length}]`,
            );
        }

        return failures.length === 0;
    } catch (error) {
        logger.error('Failed to delete trickplay', error instanceof Error ? error : undefined, {
            mediaItemId,
        });
        return false;
    }
}

export async function getTrickplayStatus(
    mediaItemId: string,
    width?: number,
): Promise<{ exists: boolean; width?: number; thumbnailCount?: number }> {
    const sql = await aiDbService.getSql();
    if (!sql) {
        return { exists: false };
    }

    const sourceSpecs = await getTrickplaySourceSpecs(sql, mediaItemId);

    if (width !== undefined) {
        for (const sourceSpec of sourceSpecs) {
            const manifest = await getTrickplayManifest(
                sourceSpec.sourceId,
                width,
                sourceSpec.filePath,
            );

            if (manifest) {
                return {
                    exists: true,
                    width: manifest.width,
                    thumbnailCount: manifest.thumbnailCount,
                };
            }
        }

        return { exists: false };
    }

    for (const sourceSpec of sourceSpecs) {
        const info = await getBestTrickplayInfo(sourceSpec.sourceId, sourceSpec.filePath);
        if (info) {
            return {
                exists: true,
                width: info.width,
                thumbnailCount: info.thumbnailCount,
            };
        }
    }

    return { exists: false };
}

export { getTrickplayStats };
