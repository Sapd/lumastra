// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Keyframe Probe Progress Service
 *
 * Side-channel that tracks in-flight keyframe probes for copy-mode playback.
 *
 * When the HLS pipeline hits the on-demand keyframe probe path (no cached
 * keyframes for a copy-video file), the m3u8 response blocks for 10-30s
 * while ffprobe walks every packet. The video player has no way to tell the
 * user what is happening during that blocked fetch — this service gives it
 * a separate endpoint to poll for progress.
 *
 * Keyed by fileId (the internal media_files PK). Entries expire on their own
 * via Valkey TTL as a safety net if the producer crashes before clearing.
 */

import { cacheDel, cacheGet, setEx } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('KeyframeProbeProgress');

const FILE_KEY_PREFIX = 'v1:keyframe-probe-progress:file:';
const ITEM_KEY_PREFIX = 'v1:keyframe-probe-progress:item:';
/**
 * TTL safety net. probeKeyframes has its own 120s timeout; 10min gives more
 * than enough slack for very long files while still self-healing if the
 * producer dies before clearing the key.
 */
const TTL_SECONDS = 600;

/**
 * Phase of the blocking pre-segment startup the server is in right now.
 *  - `probing`: walking packets with ffprobe to build keyframe offsets
 *  - `starting`: spawning FFmpeg and waiting for the first HLS playlist to
 *    land on disk (moov-atom read, muxer init, etc.)
 *  - `error`:    FFmpeg crashed or exited non-zero before any segment was
 *                produced. See `errorCode` / `errorMessage` for details.
 */
export type ProbePhase = 'probing' | 'starting' | 'error';

/**
 * Error-phase entries live for much less time than progress entries — the
 * player shows them immediately and the user retries. Keeping them around
 * past ~30s would surface the old failure on the next fresh play attempt.
 */
const ERROR_TTL_SECONDS = 30;

export interface KeyframeProbeProgress {
    fileId: string;
    itemId: string;
    /**
     * Which phase of startup the server is in. Optional for back-compat —
     * readers should treat a missing phase as `'probing'`.
     */
    phase?: ProbePhase;
    /** Unix ms when the phase started */
    startedAt: number;
    /** Latest video packet PTS seen by ffprobe (seconds), 0 when not probing */
    currentPts: number;
    /** File duration used to compute progress (seconds), 0 if unknown */
    totalDuration: number;
    /** 0..1 progress fraction, or 0 when totalDuration is unknown */
    progress: number;
    /**
     * Present only when `phase === 'error'`. Stable machine-readable code —
     * currently `ffmpeg_exit` (non-zero exit) or `ffmpeg_spawn` (spawn failure).
     */
    errorCode?: string;
    /**
     * Present only when `phase === 'error'`. One-line human summary suitable
     * for rendering in the player overlay. Bounded length, no raw stderr.
     */
    errorMessage?: string;
}

function fileKey(fileId: string): string {
    return `${FILE_KEY_PREFIX}${fileId}`;
}

function itemKey(itemId: string): string {
    return `${ITEM_KEY_PREFIX}${itemId}`;
}

/**
 * Publish progress. The same payload is written under both the fileId and
 * itemId keys. This lets the probe-status endpoint look up by either ID
 * without having to replicate the server's edition-selection logic.
 */
export async function setProbeProgress(progress: KeyframeProbeProgress): Promise<void> {
    const payload = JSON.stringify(progress);
    try {
        await Promise.all([
            setEx(fileKey(progress.fileId), TTL_SECONDS, payload),
            setEx(itemKey(progress.itemId), TTL_SECONDS, payload),
        ]);
    } catch (err) {
        logger.debug('Failed to set probe progress', {
            fileId: progress.fileId,
            itemId: progress.itemId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Publish a terminal error for the player overlay. Writes a short-TTL entry
 * under both fileId and itemId so either lookup path returns it. Keep
 * `message` user-safe and short — the raw stderr stays in the server log.
 */
export async function setProbeError(params: {
    fileId: string;
    itemId: string;
    code: string;
    message: string;
}): Promise<void> {
    const { fileId, itemId, code, message } = params;
    const payload: KeyframeProbeProgress = {
        fileId,
        itemId,
        phase: 'error',
        startedAt: Date.now(),
        currentPts: 0,
        totalDuration: 0,
        progress: 0,
        errorCode: code,
        errorMessage: message,
    };
    const serialised = JSON.stringify(payload);
    try {
        await Promise.all([
            setEx(fileKey(fileId), ERROR_TTL_SECONDS, serialised),
            setEx(itemKey(itemId), ERROR_TTL_SECONDS, serialised),
        ]);
    } catch (err) {
        logger.debug('Failed to set probe error', {
            fileId,
            itemId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

async function readKey(key: string): Promise<KeyframeProbeProgress | null> {
    let raw: string | null;
    try {
        raw = await cacheGet(key);
    } catch (err) {
        logger.debug('Failed to read probe progress', {
            key,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
    if (!raw) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (
            typeof parsed === 'object' &&
            parsed !== null &&
            typeof (parsed as KeyframeProbeProgress).fileId === 'string'
        ) {
            return parsed as KeyframeProbeProgress;
        }
    } catch {
        /* fall through */
    }
    return null;
}

export async function getProbeProgressByFile(
    fileId: string,
): Promise<KeyframeProbeProgress | null> {
    return readKey(fileKey(fileId));
}

export async function getProbeProgressByItem(
    itemId: string,
): Promise<KeyframeProbeProgress | null> {
    return readKey(itemKey(itemId));
}

/**
 * Conditional delete: skip keys whose current payload is in `phase: 'error'`.
 *
 * Race guard between the playback pipeline's happy-path cleanup ("playlist is
 * ready, clear the startup hint") and the FFmpeg side-channel ("I just wrote
 * an error for the overlay"). Both are fire-and-forget; without this guard a
 * racing DEL can wipe a freshly written error payload and the player reverts
 * to a silent spinner-then-404.
 *
 * The check-then-delete is not atomic — the window is a single Valkey round-
 * trip inside one replica — but the 30s error TTL provides a second line of
 * defense if a write slips in between GET and DEL.
 */
async function delUnlessError(key: string): Promise<void> {
    const existing = await readKey(key);
    if (existing?.phase === 'error') return;
    await cacheDel(key);
}

export async function clearProbeProgress(fileId: string, itemId: string): Promise<void> {
    try {
        await Promise.all([delUnlessError(fileKey(fileId)), delUnlessError(itemKey(itemId))]);
    } catch (err) {
        logger.debug('Failed to clear probe progress', {
            fileId,
            itemId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
