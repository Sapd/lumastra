// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { musicPrefetchUsable } from '../../database/queries/play-sessions.queries.js';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { ShutdownInterruptedError } from '$lib/server/lifecycle/shutdown-interrupted.js';
import { getWebShutdownPhase, isShuttingDown } from '$lib/server/lifecycle/web-shutdown.js';
import { assertTranscodeSourceIsMedia } from './source-guard.js';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { dirname } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import type postgres from 'postgres';

import { getCoordinationClient, subscribeToChannel } from '$lib/server/cache/valkey.js';
import { config } from '$lib/server/config.js';
import {
    insertActiveTranscodeJob,
    updateTranscodeJobStatus,
    JobStatus,
    type TranscodeJobInsert,
} from '$lib/server/database/queries/transcode-jobs.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { guardLibraryInput } from '$lib/server/utils/library-input-guard.js';
import { prepareMediaFormatWhitelist } from '$lib/server/utils/media-format-whitelist.js';

import type { UserId } from '$lib/shared/user-id';

import { cachePathFor, computeCacheKey } from './cache-key.js';
import { createMusicTranscodeCache, type CacheWriter, type MusicTranscodeCache } from './cache.js';
import { hasLibFdkAac } from './fdk-aac-detection.js';
import { acquireWithWait } from './slot-wait.js';
import {
    buildAacEncodeArgs,
    buildM4aEncodeArgs,
    buildMp3EncodeArgs,
    buildOpusEncodeArgs,
    buildStreamCopySeekArgs,
    containerFor,
    mimeFor,
} from './ffmpeg-args.js';
import type { MusicCodec, TranscodeStreamRequest, TranscodeStreamResult } from './types.js';
import { isSyntheticSessionId } from './types.js';
import { parseByteRange } from './byte-range.js';
import { expectedMp3Size, ProgressiveReaders, tailFile } from './progressive.js';

/**
 * Sources whose stored duration disagreed with the encoded output by more than
 * 2 s. Process-local and bounded: after a restart the first play retries the
 * progressive path once and lands here again.
 */
const durationMismatches = new Set<string>();
/** How long a mis-sized cache entry outlives its encode (in-flight readers). */
const DURATION_MISMATCH_ENTRY_TTL_MS = 60_000;
function durationMismatchKey(trackUuid: string, mtimeMs: number): string {
    return `${trackUuid}:${mtimeMs}`;
}
function rememberDurationMismatch(trackUuid: string, mtimeMs: number): void {
    if (durationMismatches.size >= 10_000) durationMismatches.clear();
    durationMismatches.add(durationMismatchKey(trackUuid, mtimeMs));
}
/** Test hook. */
export function clearDurationMismatchesForTests(): void {
    durationMismatches.clear();
}

const logger = Logger.for('MusicTranscodeService');

/**
 * Concrete return type of `spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })`.
 * `ChildProcessWithoutNullStreams` no longer matches this shape under modern
 * `@types/node`, so we name the precise variant the type system selects.
 */
type FfmpegProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Scratch output for an mp4 mux that no cache entry will ever own — i.e. a
 * seek, whose bytes must not be promoted because the cache key carries no
 * time offset and promoting one would poison the entry for every full-track
 * request.
 *
 * The `.partial` suffix is load-bearing rather than cosmetic: it puts the file
 * under the cache reaper's stale-partial sweep and outside its size walk, so a
 * crash between spawn and unlink leaks nothing.
 */
function scratchPathFor(key: string, codec: MusicCodec, streamId: string): string {
    return `${cachePathFor(config.MUSIC_TRANSCODE_CACHE_DIR, key, codec)}.${streamId}.partial`;
}

/**
 * How long a ranged request waits on another request's in-flight encode
 * before encoding its own copy. A primary feeding a live client is paced by
 * that client's reads, and a cellular connection can die without the server
 * seeing an abort — so the reconnect it exists to serve would otherwise wait
 * out the dead socket's timeout. A healthy encode-to-file of a normal track
 * finishes well inside this.
 */
const RANGED_PRIMARY_WAIT_MS = 10_000;

/** Rejects once `ms` elapse, unless `promise` settles first. */
function withDeadline(promise: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('deadline')), ms);
    });
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

export interface ServiceDeps {
    sql: postgres.Sql;
    cache?: MusicTranscodeCache;
}

type RecordJobMode = 'cached' | 'stream_copy_seek' | 'encode' | 'encode_no_cache';

interface ProgressiveEncode {
    sessionId: string;
    expectedSize: number;
    writer: Promise<CacheWriter>;
    completion: Promise<void>;
    controller: AbortController;
    readers: ProgressiveReaders;
}

export class MusicTranscodeService {
    private progressive = new Map<string, ProgressiveEncode>();

    /** Test-only: stop encodes a test left in their reader grace period. */
    async _drainProgressiveForTests(): Promise<void> {
        const states = [...this.progressive.values()];
        for (const state of states) state.controller.abort('test teardown');
        await Promise.all(states.map((state) => state.completion.catch(() => {})));
    }
    /**
     * Valkey counter key used to enforce the cluster-wide concurrency cap.
     * Every replica INCRs on acquire and DECRs on release; the key is given
     * a 10-minute EXPIRE refresh on each acquire so a crashed worker
     * eventually frees its slot.
     */
    private static CONCURRENT_KEY = 'music-transcode:concurrent';
    /** Safety-net TTL on the concurrency counter, in seconds. */
    private static CONCURRENT_TTL_S = 600;

    private cache: MusicTranscodeCache;
    /**
     * In-memory state below is keyed by a per-request `streamId` (UUID minted
     * in `streamFor`), NOT by `play_session_id`. The play_sessions row is
     * SHARED with the scrobble's "now playing" row (same bare key), so
     * concurrent streams for the same (user, track) would alias if we keyed
     * on `play_session_id`. The streamId is private to this service and
     * never leaves it; admin-facing kills come in by `play_session_id`, so
     * `playSessionToStreamIds` maps the inbound id to the set of streamIds
     * currently in flight.
     */
    private cancellers = new Map<string, AbortController>();
    /** Processes `killOnAbort` sent SIGTERM; their exit code 0 is not a finished encode. */
    private signalledProcs = new WeakSet<FfmpegProcess>();
    /** Streams whose process we actually signalled after HTTP draining finished. */
    private shutdownKills = new Set<string>();
    /**
     * Per-stream guard so each stream only finalizes (active_transcode_jobs
     * status → stopped/error) exactly once. Multiple cleanup paths can fire
     * — ffmpeg close + bodyFork end + cache writer error — and they must not
     * race to overwrite each other's status.
     */
    private finalized = new Set<string>();
    /**
     * Per-stream slot release fn. Each successful `streamFor` records one
     * release here; cleanup paths call `releaseSlot` which de-dupes via this
     * map (delete-after-call guarantees at-most-once DECR per stream).
     */
    private slotReleases = new Map<string, () => Promise<void>>();
    /**
     * Reverse index: play_session_id → set of streamIds. Used by
     * `cancel(playSessionId)` (admin kill / cross-replica pub/sub) to find
     * and abort every in-flight stream sharing that play_session_id.
     */
    private playSessionToStreamIds = new Map<string, Set<string>>();
    /**
     * In-process fallback counter for the concurrency cap, used only when
     * the distributed Valkey counter is unavailable (or errors). Bounds
     * concurrent slots to `MUSIC_TRANSCODE_MAX_CONCURRENT` PER POD — the
     * same guarantee `ffmpeg-transcode.service.ts` gives the video path,
     * whose cap is a pure in-process job count with no distributed
     * component at all. See `acquireLocalSlot`.
     */
    private localConcurrent = 0;
    /**
     * Per-user in-process concurrency counters, keyed by `userId`. Bounds a
     * single user to `MUSIC_TRANSCODE_MAX_PER_USER` concurrent streams (per
     * pod) so one client can't consume the entire global cap. See
     * `acquireUserSlot`.
     */
    private userConcurrent = new Map<string, number>();

    constructor(private deps: ServiceDeps) {
        this.cache =
            deps.cache ??
            createMusicTranscodeCache({
                cacheDir: config.MUSIC_TRANSCODE_CACHE_DIR,
            });
    }

    /**
     * Abort every in-flight stream attached to `playSessionId`.
     *
     * With the play_sessions row unified across scrobble + transcode, a
     * single play_session_id can have N concurrent streams (e.g. user
     * scrubs / switches device mid-track). We abort all of them and let
     * each per-stream cleanup path drop its own bookkeeping.
     *
     * Returns true if a matching in-flight stream was actually aborted,
     * false if `playSessionId` had nothing in flight on this replica —
     * callers (e.g. `session-kill.service.ts`) use this to avoid logging a
     * "cancelled" message for a no-op.
     */
    cancel(playSessionId: string): boolean {
        const streamIds = this.playSessionToStreamIds.get(playSessionId);
        if (!streamIds || streamIds.size === 0) return false;
        // Snapshot before iterating: the abort fires synchronous listeners
        // that may call into the cleanup path and mutate the map.
        const snapshot = [...streamIds];
        for (const streamId of snapshot) {
            const c = this.cancellers.get(streamId);
            if (c) {
                c.abort('killed');
                this.cancellers.delete(streamId);
            }
        }
        this.playSessionToStreamIds.delete(playSessionId);
        logger.info('Cancelled music streams', {
            playSessionId,
            count: snapshot.length,
        });
        return true;
    }

    /** Register `streamId` under `playSessionId` in the reverse index. */
    private indexStream(playSessionId: string, streamId: string): void {
        let set = this.playSessionToStreamIds.get(playSessionId);
        if (!set) {
            set = new Set();
            this.playSessionToStreamIds.set(playSessionId, set);
        }
        set.add(streamId);
    }

    /** Drop `streamId` from the reverse index; prune empty sets. */
    private deindexStream(playSessionId: string, streamId: string): void {
        const set = this.playSessionToStreamIds.get(playSessionId);
        if (!set) return;
        set.delete(streamId);
        if (set.size === 0) this.playSessionToStreamIds.delete(playSessionId);
    }

    /**
     * Begin streaming an audio response for `req`.
     *
     * Concurrency contract: when the cluster-wide cap
     * (`MUSIC_TRANSCODE_MAX_CONCURRENT`) or the per-user cap
     * (`MUSIC_TRANSCODE_MAX_PER_USER`) is reached, this method first WAITS up
     * to `MUSIC_TRANSCODE_QUEUE_WAIT_MS` for a slot to free up, and only then
     * throws an `Error & { status: 503 }`. Callers (route handlers) MUST catch
     * errors where `status === 503` and emit an HTTP 503 response with
     * `Retry-After: 5` so clients back off — but with the wait in place that
     * should now be rare rather than the normal outcome of a bulk download.
     *
     * On any other failure during setup, the slot acquired here is released
     * before the error propagates.
     */
    async streamFor(req: TranscodeStreamRequest): Promise<TranscodeStreamResult> {
        // Before anything else — slot, cache lookup, spawn: a playlist/manifest
        // body is never transcoded or served from an earlier transcode's cache
        // (ruling T7-music; throws PlaylistSourceRefusedError, status 415).
        await assertTranscodeSourceIsMedia(req.sourcePath, req.abortSignal);

        const expectedSize =
            req.codec === 'mp3' &&
            !durationMismatches.has(durationMismatchKey(req.trackUuid, req.sourceMtimeMs))
                ? expectedMp3Size(
                      req.durationSeconds,
                      req.bitrateKbps,
                      req.sourceSize,
                      req.sourceBitrate,
                  )
                : null;
        const key = computeCacheKey({
            trackUuid: req.trackUuid,
            mtimeMs: req.sourceMtimeMs,
            expectedSize,
            codec: req.codec,
            bitrateKbps: req.bitrateKbps,
        });

        // Per-request stream identity. Service state (cancellers, slot
        // releases, finalize guards) is keyed on streamId so concurrent
        // streams sharing one play_session_id don't alias.
        const streamId = randomUUID();
        const playSessionId = req.session.sessionId;

        const controller = new AbortController();
        // Wire the inbound request's abort signal (client disconnect) into
        // our internal controller so a disconnect during slot-acquisition,
        // cache-wait, or encoding releases the slot promptly rather than
        // holding it for the full duration of an unattended stream. Guard
        // against an already-fired signal (same pattern as every abort
        // listener below) so a disconnect that raced us here isn't missed.
        if (req.abortSignal) {
            if (req.abortSignal.aborted) {
                controller.abort('client disconnected');
            } else {
                req.abortSignal.addEventListener(
                    'abort',
                    () => controller.abort('client disconnected'),
                    { once: true },
                );
            }
        }
        this.cancellers.set(streamId, controller);
        this.indexStream(playSessionId, streamId);

        let admittedRelease: (() => void) | undefined;
        try {
            // Acquire the concurrency slots BEFORE any work, waiting up to
            // MUSIC_TRANSCODE_QUEUE_WAIT_MS for one to free up. Only if the window
            // elapses does this throw status:503 for the route handler to turn into
            // an HTTP 503 + Retry-After: 5.
            let admittedProgressive: ProgressiveEncode | undefined;
            const { value: releaseSlot, waitedMs } = await acquireWithWait(
                () => {
                    if (req.timeOffset === 0 && req.codec === 'mp3' && expectedSize !== null) {
                        admittedProgressive = this.progressive.get(key);
                        if (admittedProgressive?.controller.signal.aborted) {
                            this.progressive.delete(key);
                            admittedProgressive = undefined;
                        }
                        if (admittedProgressive) {
                            admittedRelease = admittedProgressive.readers.pin();
                            controller.signal.addEventListener('abort', admittedRelease, {
                                once: true,
                            });
                            return Promise.resolve(async (): Promise<void> => {});
                        }
                    }
                    return this.acquireBothSlots(req.session.userId);
                },
                {
                    timeoutMs: config.MUSIC_TRANSCODE_QUEUE_WAIT_MS,
                    // Client disconnect while queued: stop waiting rather than
                    // taking a slot nobody will read from.
                    signal: controller.signal,
                },
            );
            if (waitedMs > 0) {
                logger.info('music-transcode: queued for a free transcode slot', {
                    waitedMs,
                    trackUuid: req.trackUuid,
                    globalCap: config.MUSIC_TRANSCODE_MAX_CONCURRENT,
                    perUserCap: config.MUSIC_TRANSCODE_MAX_PER_USER,
                });
            }

            this.slotReleases.set(streamId, releaseSlot);
            controller.signal.throwIfAborted();
            if (!isSyntheticSessionId(playSessionId)) {
                const [live] = await this.deps.sql<{ id: string }[]>`
                    SELECT ps.id FROM play_sessions ps
                    WHERE ps.id = ${playSessionId}::uuid AND ps.user_id = ${req.session.userId}
                      AND ps.status IN ('ACTIVE', 'PAUSED') AND ${musicPrefetchUsable(this.deps.sql)}`;
                if (!live) {
                    throw Object.assign(new Error('Playback session ended while queued'), {
                        status: 410,
                    });
                }
            }
            controller.signal.throwIfAborted();
            const cachedFinal = await this.cache.getCachedFinalPath(key, req.codec);

            if (cachedFinal && req.timeOffset === 0) {
                return await this.serveFromCache(key, cachedFinal, req, controller, streamId);
            }
            const ranged = typeof req.rangeHeader === 'string';
            if (cachedFinal && req.timeOffset > 0) {
                return containerFor(req.codec) === 'mp4' || ranged
                    ? await this.serveSeekFromFile(key, cachedFinal, req, controller, streamId)
                    : await this.serveStreamCopySeek(key, cachedFinal, req, controller, streamId);
            }
            if (req.timeOffset === 0 && req.codec === 'mp3' && expectedSize !== null) {
                const result = await this.serveProgressive(
                    key,
                    req,
                    controller,
                    streamId,
                    expectedSize,
                    admittedProgressive,
                    admittedRelease,
                );
                if (admittedRelease)
                    controller.signal.removeEventListener('abort', admittedRelease);
                admittedRelease = undefined; // tailFile now owns the pin
                return result;
            }
            // In-flight dedupe: if another request on this replica is
            // already encoding the same (key, codec), wait for its primary
            // writer to settle and serve from the freshly promoted cache
            // file instead of spawning a second ffmpeg.
            //
            // Only the timeOffset === 0 branch can dedupe — seek requests
            // build their args from a cached file directly, and there's no
            // primary partial they can attach to.
            //
            // A ranged request skips this unbounded wait: encodeToFileAndServe
            // makes it a follower with a deadline (RANGED_PRIMARY_WAIT_MS).
            if (!ranged && req.timeOffset === 0 && this.cache.peekInFlight(key, req.codec)) {
                const deduped = await this.tryServeDeduped(key, req, controller, streamId);
                if (deduped) return deduped;
                // Primary failed (or evaporated) — fall through to encode.
            }
            // m4a is the one target that cannot be muxed onto a pipe, so it
            // gets the encode-then-serve path. Remaining cold ranges also
            // need a finished file because they have no reliable byte total.
            return containerFor(req.codec) === 'mp4' || ranged
                ? await this.encodeToFileAndServe(key, req, controller, streamId)
                : await this.encodeAndServe(key, req, controller, streamId);
        } catch (err) {
            // Clean up the registry entry on early failure.
            // The success path is cleaned up by attachCleanup when the stream ends.
            this.cancellers.delete(streamId);
            this.deindexStream(playSessionId, streamId);
            // Release the slot we just acquired — the stream never got off
            // the ground so no cleanup path will fire to do it for us.
            await this.releaseSlot(streamId);
            if (controller.signal.aborted && !(err instanceof ShutdownInterruptedError)) {
                throw Object.assign(new Error('Music delivery cancelled'), { status: 410 });
            }
            throw err;
        } finally {
            if (admittedRelease) controller.signal.removeEventListener('abort', admittedRelease);
            admittedRelease?.();
        }
    }

    /**
     * Wrap `promise` so it settles with `controller`'s abort. Rejects
     * immediately if the signal has ALREADY fired by the time this is
     * called (an already-aborted signal never re-fires 'abort', so a plain
     * `addEventListener` would hang forever) — otherwise rejects as soon as
     * it fires. Shared by every in-flight-dedupe wait (`tryServeDeduped`
     * and `encodeAndServe`'s follower path) so a client abort during a
     * cache-wait is honored the same way everywhere.
     */
    private waitAbortable(promise: Promise<void>, controller: AbortController): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            if (controller.signal.aborted) {
                reject(new Error('aborted'));
                return;
            }
            let done = false;
            const onAbort = () => {
                if (done) return;
                done = true;
                reject(new Error('aborted'));
            };
            controller.signal.addEventListener('abort', onAbort, { once: true });
            promise
                .then(() => {
                    if (done) return;
                    done = true;
                    controller.signal.removeEventListener('abort', onAbort);
                    resolve();
                })
                .catch((err: unknown) => {
                    if (done) return;
                    done = true;
                    controller.signal.removeEventListener('abort', onAbort);
                    reject(err instanceof Error ? err : new Error(String(err)));
                });
        });
    }

    /**
     * Service-layer in-flight dedupe: when a primary writer is already
     * encoding (cacheKey, codec), follower requests park on the primary
     * promise and serve from the resulting cache file. The follower owns
     * its own slot, session, and job row — only the ffmpeg work is shared
     * with the primary.
     *
     * Returns null when the primary failed; callers should fall through to
     * their own encode in that case.
     */
    private async tryServeDeduped(
        cacheKey: string,
        req: TranscodeStreamRequest,
        controller: AbortController,
        streamId: string,
    ): Promise<TranscodeStreamResult | null> {
        try {
            // Make the wait cancellable so a client abort doesn't block on
            // a primary that may still be encoding.
            await this.waitAbortable(this.cache.waitForKey(cacheKey, req.codec), controller);
        } catch {
            return null;
        }

        const cachedFinal = await this.cache.getCachedFinalPath(cacheKey, req.codec);
        if (!cachedFinal) return null;

        const result = await this.serveFromCache(cacheKey, cachedFinal, req, controller, streamId);
        // Tag this as a dedupe-served stream so admin/sessions can surface
        // the distinction in the cache-state badge.
        return { ...result, cacheState: 'dedup' };
    }

    private async serveProgressive(
        key: string,
        req: TranscodeStreamRequest,
        controller: AbortController,
        streamId: string,
        expectedSize: number,
        admitted?: ProgressiveEncode,
        admittedRelease?: () => void,
    ): Promise<TranscodeStreamResult> {
        const parsed = parseByteRange(req.rangeHeader ?? '', expectedSize);
        if (parsed.kind === 'unsatisfiable') {
            throw Object.assign(new Error('music-transcode: range not satisfiable'), {
                status: 416,
                size: expectedSize,
            });
        }
        // Keep the admitted encode even if it failed during session/cache
        // awaits. A follower without a slot must never start a new encoder.
        let state = admitted ?? this.progressive.get(key);
        if (state?.controller.signal.aborted) {
            throw Object.assign(new Error('Music encode ended during admission; retry'), {
                status: 503,
            });
        }
        const primary = !state;
        if (!state) {
            // A legacy pipe encode may already own this key. Never compete for
            // its partial or use our size rule for bytes it has not normalized.
            if (this.cache.peekInFlight(key, req.codec)) {
                try {
                    await this.waitAbortable(this.cache.waitForKey(key, req.codec), controller);
                } catch (cause) {
                    throw Object.assign(new Error('Music primary failed; retry', { cause }), {
                        status: 503,
                    });
                }
                const final = await this.cache.getCachedFinalPath(key, req.codec);
                if (!final) throw new Error('Music primary did not publish a cache file');
                return this.serveFromCache(key, final, req, controller, streamId);
            }
            const encodeId = randomUUID();
            const encodeController = new AbortController();
            const writer = this.cache.beginWrite(key, req.codec);
            state = {
                expectedSize,
                writer,
                controller: encodeController,
                readers: new ProgressiveReaders(encodeController),
                sessionId: req.session.sessionId,
                completion: Promise.resolve(),
            };
            const shared = state;
            // Publish before any await, including beginWrite's mkdir, so all
            // followers share the same size, primary and completion outcome.
            this.progressive.set(key, shared);
            encodeController.signal.addEventListener(
                'abort',
                () => {
                    if (this.progressive.get(key) === shared) this.progressive.delete(key);
                },
                { once: true },
            );
            const release = this.slotReleases.get(streamId);
            if (release) {
                this.slotReleases.delete(streamId);
                this.slotReleases.set(encodeId, release);
            }
            this.cancellers.set(encodeId, encodeController);
            this.indexStream(req.session.sessionId, encodeId);
            shared.completion = (async (): Promise<void> => {
                const fs = await import('node:fs/promises');
                let owned: CacheWriter | undefined;
                try {
                    owned = await writer;
                    if (!owned.isPrimary)
                        throw new Error('Music progressive writer lost ownership');
                    await this.runFfmpegToCompletion({
                        ffmpegArgs: await this.buildEncodeArgs(req),
                        stdoutPath: owned.partialPath,
                        req,
                        controller: encodeController,
                        streamId: encodeId,
                        cacheKey: key,
                        mode: 'encode',
                        onEncodingStopped: (ok) => {
                            if (ok) shared.readers.finish();
                            else encodeController.abort('music encoder failed');
                        },
                    });
                    encodeController.signal.throwIfAborted();
                    // Music has no video-style lastClientHeartbeatAt tracker.
                    // Session liveness is checked at admission; readers determine
                    // abandonment, so an ACTIVE preload cannot pin an idle encode.
                    // Only an already completed encode may finish its cache commit.
                    shared.readers.finish();
                    const actualSize = (await fs.stat(owned.partialPath)).size;
                    const mismatched =
                        Math.abs(actualSize - shared.expectedSize) >
                        ((req.bitrateKbps * 1000) / 8) * 2;
                    if (mismatched) {
                        logger.warn('Music MP3 duration estimate differs from encoded output', {
                            trackUuid: req.trackUuid,
                            expectedSize: shared.expectedSize,
                            actualSize,
                        });
                    }
                    // CBR frame rounding/encoder delay adds 1-2 frames: cutting
                    // the last ~40ms is acceptable to keep one stable URL length.
                    // truncate also extends with zero bytes when the encoder
                    // produced less than the duration/CBR estimate. Readers
                    // still streaming this encode were promised that length.
                    await fs.truncate(owned.partialPath, shared.expectedSize);
                    await owned.promote();
                    if (mismatched) {
                        // A wrong stored duration would keep cut or padded audio
                        // cached for good. Later requests for this source skip
                        // the sized key (encode-then-serve with the real
                        // length); the sized entry stays only long enough for
                        // the readers already streaming it, then goes.
                        rememberDurationMismatch(req.trackUuid, req.sourceMtimeMs);
                        const badEntry = owned.finalPath;
                        setTimeout(() => {
                            fs.unlink(badEntry).catch(() => {});
                        }, DURATION_MISMATCH_ENTRY_TTL_MS).unref();
                    }
                    await this.finalizeJob(req.session.sessionId, encodeId, true);
                } catch (error) {
                    encodeController.abort('music encode failed');
                    if (owned?.isPrimary) await owned.abort().catch(() => {});
                    await this.finalizeJob(
                        req.session.sessionId,
                        encodeId,
                        false,
                        error instanceof Error ? error.message : String(error),
                    );
                    throw error;
                } finally {
                    shared.readers.finish();
                    if (this.progressive.get(key) === shared) this.progressive.delete(key);
                    this.cancellers.delete(encodeId);
                    this.deindexStream(req.session.sessionId, encodeId);
                    await this.releaseSlot(encodeId);
                }
            })();
            shared.completion.catch(() => {});
        }
        const shared = state;
        const releaseReader = admittedRelease ?? shared.readers.pin();
        let detached = false;
        const detach = (error?: unknown): void => {
            if (detached) return;
            detached = true;
            releaseReader();
            controller.signal.removeEventListener('abort', onReaderAbort);
            this.cancellers.delete(streamId);
            this.deindexStream(req.session.sessionId, streamId);
            if (req.session.sessionId !== shared.sessionId) {
                void this.finalizeJob(
                    req.session.sessionId,
                    streamId,
                    !error,
                    error instanceof Error ? error.message : undefined,
                );
            }
        };
        const onReaderAbort = (): void => detach(new Error('Music range aborted'));
        controller.signal.addEventListener('abort', onReaderAbort, { once: true });
        if (controller.signal.aborted) onReaderAbort();
        try {
            // Count the follower before awaiting slot release: a disconnect
            // from another reader during that await must see this reader.
            if (!primary) await this.releaseSlot(streamId);
            const writer = await shared.writer.catch((cause: unknown) => {
                throw Object.assign(new Error('Music encode unavailable; retry', { cause }), {
                    status: 503,
                });
            });
            controller.signal.throwIfAborted();
            // Primary's job row belongs to the background encoder; followers
            // have their own session visibility but never another ffmpeg pid.
            if (req.session.sessionId !== shared.sessionId)
                await this.recordJob({
                    req,
                    cacheKey: key,
                    mode: 'cached',
                    pid: null,
                    streamId,
                });
            if (shared.controller.signal.aborted) {
                throw Object.assign(new Error('Music encode failed before response; retry'), {
                    status: 503,
                });
            }
            const start = parsed.kind === 'range' ? parsed.start : 0;
            const end = parsed.kind === 'range' ? parsed.end : shared.expectedSize - 1;
            return {
                body: tailFile({
                    partialPath: writer.partialPath,
                    finalPath: writer.finalPath,
                    start,
                    end,
                    expectedSize: shared.expectedSize,
                    completion: shared.completion,
                    signal: controller.signal,
                    onClose: detach,
                }),
                contentType: mimeFor(req.codec),
                contentLength: end - start + 1,
                acceptRanges: 'bytes',
                status: parsed.kind === 'range' ? 206 : 200,
                ...(parsed.kind === 'range'
                    ? {
                          contentRange: `bytes ${start}-${end}/${shared.expectedSize}`,
                      }
                    : {}),
                cacheState: primary ? 'live' : 'dedup',
            };
        } catch (error) {
            detach(error);
            throw error;
        }
    }

    private async serveFromCache(
        cacheKey: string,
        path: string,
        req: TranscodeStreamRequest,
        controller: AbortController,
        streamId: string,
    ): Promise<TranscodeStreamResult> {
        return await this.respondWithFile({
            path,
            req,
            controller,
            streamId,
            cacheKey,
            mode: 'cached',
            cacheState: 'cached',
        });
    }

    /**
     * Wire a finished file up as the response body: read stream, abort
     * plumbing, job row, finalize hooks, Content-Length.
     *
     * Split out of `serveFromCache` because the mp4 targets end up here too.
     * They cannot stream off ffmpeg's stdout (see `buildM4aEncodeArgs`), so
     * they mux to a file first and then serve it exactly like a cache hit —
     * the only differences being that they have already written their own job
     * row (`mode: null`) and that a seek's scratch file has no cache entry to
     * own it (`unlinkAfterOpen`).
     *
     * Unlinking on 'open' is safe and deliberate: the read stream already
     * holds the fd, so every byte still reaches the client, and the file
     * cannot outlive the response — not on a mid-stream disconnect, not on a
     * SIGKILL.
     */
    private async respondWithFile(args: {
        path: string;
        req: TranscodeStreamRequest;
        controller: AbortController;
        streamId: string;
        cacheKey: string;
        /** Job row to write, or null when the caller already recorded one. */
        mode: RecordJobMode | null;
        cacheState: TranscodeStreamResult['cacheState'];
        /** Drop the file as soon as the read stream owns its fd. */
        unlinkAfterOpen?: boolean;
    }): Promise<TranscodeStreamResult> {
        const { path, req, controller, streamId, cacheKey, mode, cacheState } = args;
        const fs = await import('node:fs/promises');
        const st = await fs.stat(path);
        // A finished file can be sliced, so a caller that handles ranges gets
        // them honoured: an unsatisfiable range is a 416, a malformed one is
        // ignored (the whole file, as RFC 9110 asks) — see parseByteRange.
        const honoursRanges = req.rangeHeader !== undefined;
        let range: { start: number; end: number } | null = null;
        if (honoursRanges && req.rangeHeader) {
            const parsed = parseByteRange(req.rangeHeader, st.size);
            if (parsed.kind === 'unsatisfiable') {
                if (args.unlinkAfterOpen) await fs.unlink(path).catch(() => {});
                // An encode that just ran recorded its own job row and left
                // finishing it to the read stream's hooks, which never get
                // attached now — close it here or it shows as running forever.
                if (mode === null) {
                    await this.finalizeJob(
                        req.session.sessionId,
                        streamId,
                        false,
                        'range not satisfiable',
                    );
                }
                throw Object.assign(new Error('music-transcode: range not satisfiable'), {
                    status: 416,
                    size: st.size,
                });
            }
            if (parsed.kind === 'range') range = { start: parsed.start, end: parsed.end };
        }
        const node = range ? createReadStream(path, range) : createReadStream(path);
        if (args.unlinkAfterOpen) {
            node.once('open', () => void fs.unlink(path).catch(() => {}));
        }
        // Guard against an abort that already fired before we got here
        // (e.g. an admin kill landing during the fs.stat await above) — an
        // already-fired AbortSignal never re-fires 'abort', so a plain
        // addEventListener would leave `node` open forever.
        if (controller.signal.aborted) {
            node.destroy();
        } else {
            controller.signal.addEventListener('abort', () => node.destroy());
        }

        if (mode !== null) {
            await this.recordJob({
                req,
                cacheKey,
                mode,
                pid: null,
                streamId,
            });
        }

        // Finalize-on-cleanup hooks. The file-read stream emits 'end' on
        // clean drain, 'error' on read errors, and 'close' when destroy()
        // is called via the abort path (controller.signal → node.destroy()).
        // Track whether 'end' fired so 'close' fallback only marks error
        // for early-termination paths.
        let cleanlyEnded = false;
        node.once('end', () => {
            cleanlyEnded = true;
            void this.finalizeJob(req.session.sessionId, streamId, true);
        });
        node.once(
            'error',
            (err) =>
                void this.finalizeJob(
                    req.session.sessionId,
                    streamId,
                    false,
                    err instanceof Error ? err.message : String(err),
                ),
        );
        // 'close' fires after destroy() (no error). Without this hook the
        // job row would remain 'ready' forever when the client aborts.
        node.once('close', () => {
            if (!cleanlyEnded) {
                void this.finalizeJob(req.session.sessionId, streamId, false, 'stream aborted');
            }
        });
        this.attachCleanup(req.session.sessionId, streamId, node);

        const body = Readable.toWeb(node) as ReadableStream<Uint8Array>;
        return {
            body,
            contentType: mimeFor(req.codec),
            contentLength: range ? range.end - range.start + 1 : st.size,
            // `none` for a caller that doesn't handle ranges: advertising
            // `bytes` and then answering a Range with a 200 full body is
            // exactly the lie that splices a track's start into its middle.
            acceptRanges: honoursRanges ? 'bytes' : 'none',
            status: range ? 206 : 200,
            ...(range ? { contentRange: `bytes ${range.start}-${range.end}/${st.size}` } : {}),
            cacheState,
        };
    }

    private async serveStreamCopySeek(
        cacheKey: string,
        cachedPath: string,
        req: TranscodeStreamRequest,
        controller: AbortController,
        streamId: string,
    ): Promise<TranscodeStreamResult> {
        // The mp4 muxer seeks back over its own output, so it cannot write to
        // stdout like every other container here. Divert to a file.
        if (containerFor(req.codec) === 'mp4') {
            return await this.serveSeekFromFile(cacheKey, cachedPath, req, controller, streamId);
        }

        const args = buildStreamCopySeekArgs({
            cachedPath,
            codec: req.codec,
            timeOffset: req.timeOffset,
        });
        const ff = this.spawnFfmpeg(args, streamId);
        // Guard against an abort that already fired before this point (e.g.
        // an admin kill landing during the cold-start libfdk_aac probe or
        // spawn setup) — an already-fired AbortSignal never re-fires
        // 'abort', so a plain addEventListener would leave ffmpeg running.
        this.killOnAbort(ff, controller, streamId);

        await this.recordJob({
            req,
            cacheKey,
            mode: 'stream_copy_seek',
            pid: ff.pid ?? null,
            streamId,
        });

        // ffmpeg-driven finalize: success when exit==0, error otherwise.
        ff.on('close', (code) => {
            if (this.exitedCleanly(ff, code)) {
                void this.finalizeJob(req.session.sessionId, streamId, true);
            } else {
                void this.finalizeJob(
                    req.session.sessionId,
                    streamId,
                    false,
                    this.exitReason(ff, code),
                );
            }
        });
        ff.on(
            'error',
            (err) =>
                void this.finalizeJob(
                    req.session.sessionId,
                    streamId,
                    false,
                    err instanceof Error ? err.message : String(err),
                ),
        );

        const body = Readable.toWeb(ff.stdout) as ReadableStream<Uint8Array>;
        this.attachCleanup(req.session.sessionId, streamId, ff.stdout, ff);
        return {
            body,
            contentType: mimeFor(req.codec),
            contentLength: null,
            acceptRanges: 'none',
            status: 200,
            cacheState: 'seek',
        };
    }

    private async encodeAndServe(
        key: string,
        req: TranscodeStreamRequest,
        controller: AbortController,
        streamId: string,
    ): Promise<TranscodeStreamResult> {
        // Register the cache in-flight marker BEFORE any async work below —
        // buildEncodeArgs' libfdk_aac probe can take up to 5s. The old code
        // didn't call beginWrite() until after that probe AND after
        // spawning ffmpeg, so two concurrent requests for the same (key,
        // codec) would both sail past streamFor's peekInFlight() pre-check
        // (neither had registered yet) and each spawn their own ffmpeg.
        // beginWrite() registers synchronously before its first await, so
        // calling it here — as early as possible — closes that window: the
        // second caller sees the first as primary and never touches ffmpeg.
        let writer: CacheWriter | null = null;
        if (req.timeOffset === 0) {
            writer = await this.cache.beginWrite(key, req.codec);
            if (!writer.isPrimary) {
                try {
                    await this.waitAbortable(writer.waitForPrimary(), controller);
                    const cachedFinal = await this.cache.getCachedFinalPath(key, req.codec);
                    if (cachedFinal) {
                        const result = await this.serveFromCache(
                            key,
                            cachedFinal,
                            req,
                            controller,
                            streamId,
                        );
                        return { ...result, cacheState: 'dedup' };
                    }
                } catch {
                    // Primary aborted/failed, or the promoted file vanished —
                    // fall through to re-attempt as primary below.
                }
                // The writer we lost the race with has since settled (cache
                // hit handled above) or evaporated (its own abort() already
                // cleared the in-flight entry) — re-attempt to become
                // primary ourselves, mirroring the pre-fix fallback
                // behavior in streamFor's tryServeDeduped → encodeAndServe path.
                writer = await this.cache.beginWrite(key, req.codec);
            }
        }

        let ff: FfmpegProcess;
        try {
            const args = await this.buildEncodeArgs(req);
            ff = this.spawnFfmpeg(args, streamId);
        } catch (error) {
            if (writer?.isPrimary) await writer.abort().catch(() => {});
            throw error;
        }
        // Guard against an abort that already fired before this point (e.g.
        // an admin kill landing during the cold-start libfdk_aac probe
        // above) — an already-fired AbortSignal never re-fires 'abort', so
        // a plain addEventListener would leave ffmpeg running.
        this.killOnAbort(ff, controller, streamId);

        // Job lifecycle finalize: status → stopped on ffmpeg exit 0,
        // error otherwise. These run regardless of the cache-writer branch
        // so cache misses still get a clean stopped row.
        ff.on('close', (code) => {
            if (this.exitedCleanly(ff, code)) {
                void this.finalizeJob(req.session.sessionId, streamId, true);
            } else {
                void this.finalizeJob(
                    req.session.sessionId,
                    streamId,
                    false,
                    this.exitReason(ff, code),
                );
            }
        });
        ff.on(
            'error',
            (err) =>
                void this.finalizeJob(
                    req.session.sessionId,
                    streamId,
                    false,
                    err instanceof Error ? err.message : String(err),
                ),
        );

        // We need a single ReadableStream for the HTTP body. When timeOffset === 0
        // we ALSO want to tee the bytes to the disk cache. A raw
        // `ff.stdout.pipe(file)` plus `Readable.toWeb(ff.stdout)` does NOT
        // duplicate data: both subscribers compete for chunks from the same
        // underlying readable. Fix: pipe ff.stdout into a PassThrough fork for
        // the body, and (optionally) a second PassThrough for the cache writer.
        //
        // The cache fork must NOT back-pressure ffmpeg (and therefore the body
        // fork / HTTP client) when the disk is slow. We decouple it by giving
        // the cacheFork a large high-watermark buffer (4 MB) so disk write
        // latency is absorbed in memory rather than propagated upstream.
        const bodyFork = new PassThrough();
        ff.stdout.pipe(bodyFork);

        if (writer && writer.isPrimary) {
            // Alias to a non-null const so the closures below (which run
            // asynchronously, long after this block's synchronous checks)
            // get a type-narrowed reference instead of the outer `let
            // writer: CacheWriter | null`.
            const primaryWriter = writer;
            // highWaterMark of 4 MB: disk writes can lag up to this much
            // before any back-pressure reaches ff.stdout / the HTTP body.
            const cacheFork = new PassThrough({ highWaterMark: 4 * 1024 * 1024 });
            cacheFork.on('error', (err) => {
                logger.warn('music-transcode cacheFork error', {
                    err: String(err),
                });
                void finalizeErr();
            });
            // { end: true } (default) so the WriteStream closes after the
            // cacheFork ends. `allowHalfOpen` on the PassThrough is already
            // false by default, so draining the body fork won't close the
            // cache fork early.
            ff.stdout.pipe(cacheFork);
            const file = createWriteStream(primaryWriter.partialPath);
            cacheFork.pipe(file);

            // Two-condition barrier: ffmpeg must have exited cleanly AND
            // the disk file must have flushed (`finish`) before we rename
            // the partial into place. If we promote on ffmpeg close
            // alone, the WriteStream may still have buffered bytes, so
            // the rename can publish a truncated cache entry that a
            // later cache hit would serve.
            let ffExited = false;
            let ffExitCode: number | null = null;
            let fileFinished = false;
            let settled = false;

            const finalizeOk = async (): Promise<void> => {
                if (settled) return;
                settled = true;
                await primaryWriter.promote().catch((err: unknown) => {
                    logger.warn('cache promote failed', {
                        err: err instanceof Error ? err.message : String(err),
                    });
                });
            };
            const finalizeErr = async (): Promise<void> => {
                if (settled) return;
                settled = true;
                // Stop further writes into the doomed partial so the
                // unlink in writer.abort() races nothing.
                cacheFork.unpipe(file);
                if (!file.destroyed) file.destroy();
                await primaryWriter.abort().catch(() => {});
            };

            const maybeFinalize = (): void => {
                if (settled) return;
                if (!ffExited || !fileFinished) return;
                if (this.exitedCleanly(ff, ffExitCode)) void finalizeOk();
                else void finalizeErr();
            };

            ff.on('close', (code) => {
                ffExited = true;
                ffExitCode = code;
                maybeFinalize();
            });
            ff.on('error', () => void finalizeErr());
            // 'finish' fires after all buffered writes have been
            // flushed to disk. Only after we see BOTH this and the
            // ffmpeg close is the partial safe to promote.
            file.on('finish', () => {
                fileFinished = true;
                maybeFinalize();
            });
            // If the writable file errors (disk full, permission), abort the
            // cache entry but keep the body fork flowing to the HTTP client.
            file.on('error', (err) => {
                logger.warn('cache file write failed', {
                    err: err instanceof Error ? err.message : String(err),
                });
                void finalizeErr();
            });
        }

        // If ffmpeg errors before bodyFork ends, propagate so the Web stream
        // sees an error rather than hanging.
        ff.on('error', (err) => bodyFork.destroy(err));

        const body = Readable.toWeb(bodyFork) as ReadableStream<Uint8Array>;
        this.attachCleanup(req.session.sessionId, streamId, bodyFork, ff);

        await this.recordJob({
            req,
            cacheKey: key,
            mode: req.timeOffset === 0 ? 'encode' : 'encode_no_cache',
            pid: ff.pid ?? null,
            streamId,
        });
        return {
            body,
            contentType: mimeFor(req.codec),
            contentLength: null,
            acceptRanges: 'none',
            status: 200,
            cacheState: 'live',
        };
    }

    /**
     * Encode an mp4 target (today: `m4a`) and serve the finished FILE.
     *
     * Every other target streams off ffmpeg's stdout while it is still
     * working. This one cannot: a plain faststart MP4 is only writable to a
     * seekable output, because the muxer patches `moov` in place and then
     * rewrites the file to hoist it ahead of `mdat` (see
     * `buildM4aEncodeArgs`, which documents what a pipe silently produces
     * instead).
     *
     * So first-byte latency here is the whole encode — order 4s for a
     * 3.5-minute track. What that buys is a file that actually opens: a real
     * `Content-Length`, and at `timeOffset === 0` a cache entry, so every
     * later request for the same rung is a plain file read.
     *
     * A ranged request for a piped codec (mp3/aac/opus) comes here too, for
     * the length and the ability to start mid-file. Those still mux to
     * `pipe:1` and have stdout copied into the file, so the bytes are the
     * same as a live encode's: an mp3 muxer given a seekable file would add
     * a Xing frame, shifting every offset against a copy a live-streamed
     * client already holds.
     */
    private async encodeToFileAndServe(
        key: string,
        req: TranscodeStreamRequest,
        controller: AbortController,
        streamId: string,
    ): Promise<TranscodeStreamResult> {
        // Only a full-track encode is cacheable: the cache key carries no time
        // offset, so promoting a seek would serve a truncated track to every
        // later caller asking for the whole thing.
        let writer: CacheWriter | null = null;
        if (req.timeOffset === 0) {
            writer = await this.cache.beginWrite(key, req.codec);
            if (!writer.isPrimary) {
                // Bounded for a ranged request — see RANGED_PRIMARY_WAIT_MS.
                const ranged = typeof req.rangeHeader === 'string';
                let gaveUpWaiting = false;
                try {
                    const primary = ranged
                        ? withDeadline(writer.waitForPrimary(), RANGED_PRIMARY_WAIT_MS).catch(
                              (err: unknown) => {
                                  if (err instanceof Error && err.message === 'deadline') {
                                      gaveUpWaiting = true;
                                  }
                                  throw err;
                              },
                          )
                        : writer.waitForPrimary();
                    await this.waitAbortable(primary, controller);
                    const cachedFinal = await this.cache.getCachedFinalPath(key, req.codec);
                    if (cachedFinal) {
                        const result = await this.serveFromCache(
                            key,
                            cachedFinal,
                            req,
                            controller,
                            streamId,
                        );
                        return { ...result, cacheState: 'dedup' };
                    }
                } catch {
                    // Primary aborted, or its promoted file vanished — fall
                    // through and re-attempt as primary ourselves, same as
                    // encodeAndServe's follower path.
                }
                if (gaveUpWaiting) {
                    // The primary is still running; its cache entry stays
                    // its own. Encode a private copy instead.
                    logger.info(
                        'music-transcode: ranged request stopped waiting on a slow encode',
                        {
                            trackUuid: req.trackUuid,
                            waitedMs: RANGED_PRIMARY_WAIT_MS,
                        },
                    );
                }
                writer = gaveUpWaiting ? null : await this.cache.beginWrite(key, req.codec);
                // Still a follower on the retry — a third caller claimed the
                // slot while we were falling through. Unlike the piped encode
                // (which tees into the partial regardless), two ffmpeg
                // processes writing one file would interleave into a corrupt
                // cache entry, so this request opts out of the cache and
                // encodes to its own scratch file instead.
                if (writer && !writer.isPrimary) writer = null;
            }
        }

        const outPath = writer ? writer.partialPath : scratchPathFor(key, req.codec, streamId);
        const fs = await import('node:fs/promises');
        // beginWrite() already made the shard directory for the cached case;
        // a scratch file has no writer to do it.
        if (!writer) await fs.mkdir(dirname(outPath), { recursive: true });
        const piped = containerFor(req.codec) !== 'mp4';

        try {
            await this.runFfmpegToCompletion({
                ffmpegArgs: await this.buildEncodeArgs(req, piped ? undefined : outPath),
                stdoutPath: piped ? outPath : undefined,
                req,
                controller,
                streamId,
                cacheKey: key,
                mode: writer ? 'encode' : 'encode_no_cache',
            });
        } catch (err) {
            if (writer) await writer.abort().catch(() => {});
            else await fs.unlink(outPath).catch(() => {});
            throw err;
        }

        if (!writer) {
            return await this.respondWithFile({
                path: outPath,
                req,
                controller,
                streamId,
                cacheKey: key,
                mode: null,
                cacheState: 'seek',
                unlinkAfterOpen: true,
            });
        }

        // ffmpeg has exited 0 and closed the file, so unlike the piped
        // encode there is no second flush to wait on before renaming.
        await writer.promote();
        return await this.respondWithFile({
            path: writer.finalPath,
            req,
            controller,
            streamId,
            cacheKey: key,
            mode: null,
            cacheState: 'live',
        });
    }

    /**
     * Stream-copy seek for the mp4 targets: the same `-c:a copy` cut
     * `serveStreamCopySeek` makes, muxed into a scratch file because mp4
     * cannot go on a pipe. The scratch file is unlinked as soon as the read
     * stream owns its fd, so nothing has to clean up after it.
     */
    private async serveSeekFromFile(
        cacheKey: string,
        cachedPath: string,
        req: TranscodeStreamRequest,
        controller: AbortController,
        streamId: string,
    ): Promise<TranscodeStreamResult> {
        const outPath = scratchPathFor(cacheKey, req.codec, streamId);
        const fs = await import('node:fs/promises');
        await fs.mkdir(dirname(outPath), { recursive: true });
        try {
            await this.runFfmpegToCompletion({
                ffmpegArgs: buildStreamCopySeekArgs({
                    cachedPath,
                    codec: req.codec,
                    timeOffset: req.timeOffset,
                    outPath,
                }),
                // Only mp4 writes the file itself; the rest mux to pipe:1.
                stdoutPath: containerFor(req.codec) === 'mp4' ? undefined : outPath,
                req,
                controller,
                streamId,
                cacheKey,
                mode: 'stream_copy_seek',
            });
        } catch (err) {
            await fs.unlink(outPath).catch(() => {});
            throw err;
        }
        return await this.respondWithFile({
            path: outPath,
            req,
            controller,
            streamId,
            cacheKey,
            mode: null,
            cacheState: 'seek',
            unlinkAfterOpen: true,
        });
    }

    /**
     * Spawn ffmpeg, record its job row, and WAIT for it to exit.
     *
     * The piped paths hand the caller a live stream and let the process run
     * behind it; the mp4 paths have to block here, because the file is not a
     * valid MP4 until the muxer has finished seeking back over it. Throws on
     * any non-zero exit, having already marked the job failed — the caller
     * owns deleting whatever half-written output is left behind.
     */
    private async runFfmpegToCompletion(args: {
        ffmpegArgs: string[];
        /** Copy stdout into this file (for args that mux to `pipe:1`). */
        stdoutPath?: string;
        req: TranscodeStreamRequest;
        controller: AbortController;
        streamId: string;
        cacheKey: string;
        mode: RecordJobMode;
        /** Notify progressive readers before asynchronous DB/file cleanup. */
        onEncodingStopped?: (ok: boolean) => void;
    }): Promise<void> {
        const ff = this.spawnFfmpeg(args.ffmpegArgs, args.streamId);
        // Same already-fired-signal guard as every other spawn site: an
        // AbortSignal that fired during the libfdk_aac probe never re-fires.
        this.killOnAbort(ff, args.controller, args.streamId);

        const recorded = this.recordJob({
            req: args.req,
            cacheKey: args.cacheKey,
            mode: args.mode,
            pid: ff.pid ?? null,
            streamId: args.streamId,
        });

        // Both have to be done before the file is read: ffmpeg's exit, and
        // (when stdout is being copied) the write stream's final flush.
        const file = args.stdoutPath ? createWriteStream(args.stdoutPath) : undefined;
        const flushed = file
            ? new Promise<Error | null>((resolve) => {
                  file.once('finish', () => resolve(null));
                  file.once('error', (err) => {
                      // pipe() unhooks on a write error, nothing reads
                      // stdout any more, and ffmpeg would block on a full
                      // pipe forever, holding its slot.
                      args.onEncodingStopped?.(false);
                      ff.kill('SIGTERM');
                      resolve(err);
                  });
                  ff.stdout.pipe(file);
              })
            : Promise.resolve(null);
        const exited = await new Promise<{
            code: number | null;
            clean: boolean;
            err?: Error;
        }>((resolve) => {
            ff.once('close', (code) => {
                // A killed encode is unfinished whatever code it exits with.
                const clean = this.exitedCleanly(ff, code);
                args.onEncodingStopped?.(clean);
                resolve({ code, clean });
            });
            ff.once('error', (err) => {
                args.onEncodingStopped?.(false);
                resolve({ code: null, clean: false, err });
            });
        });
        // An unsuccessful process may leave pending disk writes. Close the
        // fd before the caller unlinks its partial or releases its slot.
        if (!exited.clean && file && !file.closed) {
            await new Promise<void>((resolve) => {
                file.once('close', resolve);
                file.destroy();
            });
        }
        await recorded;
        const writeErr = exited.clean ? await flushed : null;
        const outcome = writeErr ? { code: null, clean: false, err: writeErr } : exited;
        if (this.shutdownKills.has(args.streamId)) {
            await this.finalizeJob(args.req.session.sessionId, args.streamId, false);
            throw new ShutdownInterruptedError();
        }
        if (!outcome.clean) {
            const reason = outcome.err ? outcome.err.message : this.exitReason(ff, outcome.code);
            await this.finalizeJob(args.req.session.sessionId, args.streamId, false, reason);
            throw new Error(`music-transcode: encode to file failed (${reason})`);
        }
        // Success is NOT finalized here — the job stays open until the file
        // has actually been streamed, which respondWithFile's hooks handle.
    }

    /**
     * True when ffmpeg finished its job. An exit code of 0 is not enough: a
     * SIGTERM that lands while ffmpeg is starting up makes it exit 0 having
     * written nothing (measured with the pinned jellyfin-ffmpeg: ~1 in 8 at a
     * 3-4 ms delay, otherwise 255 or death by signal). Treating that as
     * success recorded a cancelled stream as `stopped` and promoted an empty
     * file into the cache. Once we have signalled the process, no exit code
     * counts as a completed encode.
     */
    private exitedCleanly(proc: FfmpegProcess, code: number | null): boolean {
        return code === 0 && !this.signalledProcs.has(proc);
    }

    private exitReason(proc: FfmpegProcess, code: number | null): string {
        return code === 0 && this.signalledProcs.has(proc)
            ? 'ffmpeg cancelled (exit 0 after SIGTERM)'
            : `ffmpeg exit ${code}`;
    }

    private killOnAbort(proc: FfmpegProcess, controller: AbortController, streamId: string): void {
        const kill = (): void => {
            // An exit that already happened is not a shutdown kill. The drain
            // window alone is never evidence that a failure was intentional.
            if (proc.exitCode !== null || proc.signalCode !== null) return;
            this.signalledProcs.add(proc);
            if (getWebShutdownPhase() === 'closing') this.shutdownKills.add(streamId);
            proc.kill('SIGTERM');
        };
        if (controller.signal.aborted) kill();
        else controller.signal.addEventListener('abort', kill, { once: true });
    }

    private spawnFfmpeg(args: string[], streamId: string): FfmpegProcess {
        // Cache/slot/probe waits may have outlived the request's admission.
        if (isShuttingDown()) {
            throw new ShutdownInterruptedError();
        }
        const proc = spawn(config.FFMPEG_PATH, ['-hide_banner', '-loglevel', 'error', ...args], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        proc.on('error', (err) => {
            if (this.shutdownKills.has(streamId)) logger.info('ffmpeg terminated during shutdown');
            else logger.error('ffmpeg error', err);
        });
        let stderrTail = '';
        proc.stderr.on('data', (b: Buffer) => {
            stderrTail = (stderrTail + b.toString()).slice(-2048);
        });
        proc.on('close', (code) => {
            if (code !== 0 && code !== null) {
                if (this.shutdownKills.has(streamId))
                    logger.info('ffmpeg terminated during shutdown', { code });
                else logger.warn('ffmpeg non-zero exit', { code, stderrTail });
            }
        });
        return proc;
    }

    /**
     * @param outPath Required for the mp4 targets and ignored by the rest,
     *   which mux to `pipe:1`. `buildM4aEncodeArgs` throws rather than
     *   silently emitting a broken file if it is missing.
     */
    private async buildEncodeArgs(
        req: TranscodeStreamRequest,
        outPath?: string,
    ): Promise<string[]> {
        const enc = {
            srcPath: req.sourcePath,
            bitrateKbps: req.bitrateKbps,
            timeOffset: req.timeOffset,
        };
        const warm = prepareMediaFormatWhitelist();
        if (warm) await warm;
        return guardLibraryInput(await this.buildCodecArgs(req, enc, outPath), enc.srcPath);
    }

    private async buildCodecArgs(
        req: TranscodeStreamRequest,
        enc: { srcPath: string; bitrateKbps: number; timeOffset: number },
        outPath?: string,
    ): Promise<string[]> {
        switch (req.codec) {
            case 'mp3':
                return buildMp3EncodeArgs(enc);
            case 'opus':
                return buildOpusEncodeArgs(enc);
            case 'aac': {
                const fdk = await hasLibFdkAac();
                return buildAacEncodeArgs(enc, { hasFdkAac: fdk });
            }
            case 'm4a': {
                // Same AAC encoder as above, wrapped in a plain faststart MP4
                // written to a file — see buildM4aEncodeArgs for why this one
                // cannot go on a pipe.
                const fdk = await hasLibFdkAac();
                return buildM4aEncodeArgs(enc, { hasFdkAac: fdk }, outPath ?? '');
            }
        }
    }

    private attachCleanup(
        playSessionId: string,
        streamId: string,
        stream: Readable | PassThrough,
        proc?: FfmpegProcess,
    ): void {
        const cleanup = (): void => {
            this.cancellers.delete(streamId);
            this.deindexStream(playSessionId, streamId);
            if (proc && !proc.killed) proc.kill('SIGTERM');
            // Release the cluster-wide concurrency slot. The releaseSlot
            // helper is idempotent (delete-on-call), so wiring it to all
            // three terminal events here cannot double-DECR.
            void this.releaseSlot(streamId);
        };
        stream.once('end', cleanup);
        stream.once('close', cleanup);
        stream.once('error', cleanup);
    }

    /**
     * Acquire one slot from the cluster-wide concurrency counter.
     *
     * Atomic protocol: INCR yields a unique counter value to each pod, then
     * each pod checks whether its slot is within the cap. If over, the pod
     * DECRs (restoring the prior count) and throws an Error with
     * `status === 503`. Two pods racing INCR each get distinct values so
     * exactly N pods see `count <= cap` and the rest bail.
     *
     * If `MUSIC_TRANSCODE_MAX_CONCURRENT <= 0` the cap is disabled and the
     * returned release fn is a no-op.
     *
     * If Valkey is unavailable (or an INCR/EXPIRE call throws), the cap
     * falls back to `acquireLocalSlot()` — an in-process counter bounding
     * this pod alone to `cap`. This used to fail OPEN (log and let every
     * request through, unbounded), which meant a Valkey outage removed the
     * concurrency cap entirely across every replica simultaneously. Falling
     * back to a local cap instead mirrors how `ffmpeg-transcode.service.ts`
     * enforces the video-transcode cap: a pure in-process job count with no
     * distributed component, so it's immune to Valkey outages by
     * construction.
     */
    /**
     * Acquire the global slot and then the per-user slot, returning a single
     * release fn that frees both. If the per-user cap trips we release the
     * global slot we just took before propagating the 503 — nothing else has
     * registered yet to do that cleanup for us.
     *
     * One unit of retry for `acquireWithWait`: either both slots are held or
     * neither is, so a retry never leaks a slot.
     */
    private async acquireBothSlots(userId: UserId): Promise<() => Promise<void>> {
        const releaseGlobalSlot = await this.acquireSlot();
        let releaseUserSlot: () => void;
        try {
            releaseUserSlot = this.acquireUserSlot(userId);
        } catch (err) {
            await releaseGlobalSlot().catch(() => {});
            throw err;
        }
        return async () => {
            releaseUserSlot();
            await releaseGlobalSlot();
        };
    }

    private async acquireSlot(): Promise<() => Promise<void>> {
        const cap = config.MUSIC_TRANSCODE_MAX_CONCURRENT;
        if (cap <= 0) {
            // Unlimited — but still return a release fn so callers don't
            // branch on the cap value.
            return async () => {};
        }

        const valkey = getCoordinationClient();
        if (!valkey) {
            // Valkey unavailable — cluster-wide enforcement is impossible.
            // Fall back to a per-pod in-process cap rather than letting
            // every request through unbounded.
            logger.warn(
                'music-transcode: Valkey unavailable, falling back to in-process concurrency cap',
                { cap },
            );
            return this.acquireLocalSlot(cap);
        }

        try {
            const current = await valkey.incr(MusicTranscodeService.CONCURRENT_KEY);
            // Refresh the safety-net TTL on every acquire. Isolate its error
            // path: if EXPIRE fails the INCR has already succeeded, so
            // letting the rejection propagate would skip the cap check and
            // leak the slot entirely. The TTL is only a fallback for crashed
            // workers; missing one refresh is fine.
            await valkey
                .expire(
                    MusicTranscodeService.CONCURRENT_KEY,
                    MusicTranscodeService.CONCURRENT_TTL_S,
                )
                .catch((err: unknown) => {
                    logger.warn('music-transcode: EXPIRE refresh failed', {
                        err: err instanceof Error ? err.message : String(err),
                    });
                });
            if (current > cap) {
                // Over the cap — restore the counter and reject.
                await valkey.decr(MusicTranscodeService.CONCURRENT_KEY).catch(() => {});
                const err = new Error(
                    `Music transcode concurrency limit reached: ${cap}`,
                ) as Error & { status: number };
                err.status = 503;
                throw err;
            }
            // Return a release fn that DECRs exactly once. The release
            // tracking map ensures the caller can't double-call it.
            // We also refresh the TTL on DECR to prevent the counter from
            // expiring mid-flight: without this a TTL expiry can reset the
            // key to 0 while slots are still held, and the next DECR would
            // drive it negative, permanently disabling the limit until the
            // next acquire zeroes it out via a fresh INCR.
            return async () => {
                try {
                    const remaining = await valkey.decr(MusicTranscodeService.CONCURRENT_KEY);
                    if (remaining < 0) {
                        // Counter went negative — most likely the key expired (TTL)
                        // while streams were still in flight. Clamp back to 0 so
                        // subsequent acquires don't see a permanently-broken limit.
                        // INCR after expiry returns 1 (fresh key), so setting 0
                        // lets the next acquire create a clean key.
                        await valkey.incr(MusicTranscodeService.CONCURRENT_KEY).catch(() => {});
                        logger.warn(
                            'music-transcode: concurrency counter went negative; incremented back',
                            { remaining },
                        );
                    } else if (remaining >= 0) {
                        // Refresh the safety-net TTL on each release so the key
                        // stays alive as long as at least one stream is active.
                        await valkey
                            .expire(
                                MusicTranscodeService.CONCURRENT_KEY,
                                MusicTranscodeService.CONCURRENT_TTL_S,
                            )
                            .catch((expErr: unknown) => {
                                logger.warn('music-transcode: EXPIRE refresh on DECR failed', {
                                    err: expErr instanceof Error ? expErr.message : String(expErr),
                                });
                            });
                    }
                } catch (err) {
                    logger.warn('music-transcode: slot release decr failed', {
                        err: err instanceof Error ? err.message : String(err),
                    });
                }
            };
        } catch (err) {
            // Re-throw 503 as-is so the route handler can detect it.
            if (err instanceof Error && (err as { status?: number }).status === 503) {
                throw err;
            }
            // Other Valkey errors: fall back to the local cap rather than
            // failing open — see the doc comment above.
            logger.warn(
                'music-transcode: acquireSlot failed, falling back to in-process concurrency cap',
                { err: err instanceof Error ? err.message : String(err) },
            );
            return this.acquireLocalSlot(cap);
        }
    }

    /**
     * In-process fallback slot acquire, used by `acquireSlot()` whenever the
     * distributed Valkey counter is unreachable. Bounds THIS POD ALONE to
     * `cap` concurrent slots via `this.localConcurrent` — it does not
     * coordinate with other replicas, so the cluster-wide total can exceed
     * `cap` while Valkey is down, but no single pod can run away unbounded.
     *
     * Throws the same `Error & { status: 503 }` contract as the distributed
     * path. The returned release fn decrements exactly once (idempotent)
     * regardless of how many times it's called.
     */
    private acquireLocalSlot(cap: number): () => Promise<void> {
        if (this.localConcurrent >= cap) {
            const err = new Error(`Music transcode concurrency limit reached: ${cap}`) as Error & {
                status: number;
            };
            err.status = 503;
            throw err;
        }
        this.localConcurrent++;
        let released = false;
        return async () => {
            if (released) return;
            released = true;
            this.localConcurrent = Math.max(0, this.localConcurrent - 1);
        };
    }

    /**
     * Acquire a per-user in-process slot, capping a single user to
     * `MUSIC_TRANSCODE_MAX_PER_USER` concurrent streams on this pod so one
     * client can't consume the entire global cap. Always in-process (not
     * distributed via Valkey) — a per-pod bound is sufficient to stop a
     * single client from starving every other user of a pod's transcode
     * budget, and keeps this check synchronous so it can run without an
     * extra network round-trip on the hot path.
     *
     * Throws the same `Error & { status: 503 }` contract as `acquireSlot`.
     * The returned release fn decrements exactly once (idempotent)
     * regardless of how many times it's called.
     */
    private acquireUserSlot(userId: UserId): () => void {
        const cap = config.MUSIC_TRANSCODE_MAX_PER_USER;
        if (cap <= 0) return () => {};

        const key = String(userId);
        const current = this.userConcurrent.get(key) ?? 0;
        if (current >= cap) {
            const err = new Error(
                `Music transcode per-user concurrency limit reached: ${cap}`,
            ) as Error & { status: number };
            err.status = 503;
            throw err;
        }
        this.userConcurrent.set(key, current + 1);
        let released = false;
        return () => {
            if (released) return;
            released = true;
            const remaining = (this.userConcurrent.get(key) ?? 1) - 1;
            if (remaining <= 0) this.userConcurrent.delete(key);
            else this.userConcurrent.set(key, remaining);
        };
    }

    /**
     * Release the cluster concurrency slot for `streamId`, exactly once.
     *
     * Multiple cleanup paths (ffmpeg close, body fork end, abort) can fire
     * for the same stream — the map delete-on-call here mirrors the
     * `finalized` Set pattern used for `finalizeJob` so we never
     * double-DECR.
     */
    private async releaseSlot(streamId: string): Promise<void> {
        const release = this.slotReleases.get(streamId);
        if (!release) return;
        this.slotReleases.delete(streamId);
        await release().catch(() => {});
    }

    private async recordJob(args: {
        req: TranscodeStreamRequest;
        cacheKey: string;
        mode: RecordJobMode;
        pid: number | null;
        streamId: string;
    }): Promise<void> {
        const { req, cacheKey, mode, pid, streamId } = args;
        const playSessionId = req.session.sessionId;

        // A download's session id is synthetic — there is no play_sessions row
        // to point at, and the column is `uuid NOT NULL` with an FK to one. The
        // insert could only ever raise 22P02, be swallowed by the catch below,
        // and log a warning on every single download. Nothing to record.
        if (isSyntheticSessionId(playSessionId)) return;

        // Reset the per-stream finalize guard so a fresh request reusing a
        // streamId (won't happen — UUIDs are unique — but defensive) can
        // record a new terminal status. recordJob is called exactly once
        // per serve path, so clearing it here is safe.
        this.finalized.delete(streamId);

        const now = new Date();
        const cachedFinal = cachePathFor(config.MUSIC_TRANSCODE_CACHE_DIR, cacheKey, req.codec);
        const jobIdSuffix = req.timeOffset > 0 ? `-seek-${req.timeOffset}` : '';

        const row: TranscodeJobInsert = {
            play_session_id: playSessionId,
            job_id: `${cacheKey}${jobIdSuffix}`,
            item_id: req.trackUuid,
            user_id: req.session.userId,
            device_id: req.session.deviceId,
            config: {
                type: 'music',
                target_codec: req.codec,
                target_bitrate: req.bitrateKbps,
                source_path: req.sourcePath,
                time_offset: req.timeOffset,
                transcode_mode: mode,
            },
            output_dir: dirname(cachedFinal),
            status: pid !== null ? JobStatus.Running : JobStatus.Ready,
            mode: 'full',
            segment_offset: 0,
            segments_ready: 0,
            master_playlist_ready: false,
            pod_name: null,
            ffmpeg_pid: pid,
            created_at: now,
            last_accessed_at: now,
            last_progress_at: now,
            transcode_decision: null,
            can_restore: false,
        };

        try {
            await insertActiveTranscodeJob(this.deps.sql, row);
        } catch (err) {
            // Persistence is non-fatal for the streaming HTTP response — the
            // stream still flows; we just lose admin-visibility for this job.
            logger.warn('Failed to record music transcode job', {
                playSessionId,
                streamId,
                err: err instanceof Error ? err.message : String(err),
            });
        }
    }

    /**
     * Mark the active_transcode_jobs row for `playSessionId` as terminated.
     * Idempotent per-`streamId` — first caller wins, subsequent calls are
     * no-ops. Multiple cleanup paths (ffmpeg close, cache writer error,
     * stream end) are wired to call this; only the first actually writes
     * to the DB.
     *
     * NOTE: this does NOT transition the parent play_sessions row. The
     * unified scrobble+transcode play_sessions row's lifecycle is owned by
     * the scrobble path (submission=true → COMPLETED) or the stale-session
     * reaper. Marking it COMPLETED here would prematurely close a row
     * whose audio playback is still live on the client.
     *
     * After 5 minutes the per-stream guard is removed so the `finalized`
     * set doesn't grow unbounded over the lifetime of the process.
     */
    private async finalizeJob(
        playSessionId: string,
        streamId: string,
        ok: boolean,
        errorMessage?: string,
    ): Promise<void> {
        if (this.finalized.has(streamId)) return;
        this.finalized.add(streamId);

        // FFmpeg can report 255 with no signal when it catches SIGTERM.
        // Shutdown is a stopped job, with no stored failure for the player.
        if (!ok && this.shutdownKills.has(streamId)) {
            ok = true;
            errorMessage = undefined;
            logger.info('Music transcode stopped during shutdown', { playSessionId, streamId });
        }

        // Nothing was recorded for a synthetic session, so there is nothing to
        // transition. See recordJob.
        if (isSyntheticSessionId(playSessionId)) return;

        try {
            // The active_transcode_jobs row's PK is play_session_id (UNIQUE
            // constraint added in 0dfad34f2). Multiple concurrent streams
            // sharing one play_session_id will land on the same row via the
            // ON CONFLICT (play_session_id) DO UPDATE path in
            // insertActiveTranscodeJob — last-write-wins on the job config.
            // Finalize here transitions whichever row currently holds that
            // play_session_id; that's acceptable for the admin-visibility
            // UX (one transcode badge per (user, track) at a time).
            await updateTranscodeJobStatus(this.deps.sql, playSessionId, {
                status: ok ? JobStatus.Stopped : JobStatus.Error,
                stopped_at: new Date(),
                ffmpeg_pid: null,
                error_message: ok ? null : (errorMessage ?? 'unknown error'),
            });
        } catch (err) {
            logger.warn('Failed to finalize music transcode job', {
                playSessionId,
                streamId,
                err: err instanceof Error ? err.message : String(err),
            });
        } finally {
            // Drop the per-stream guard well after any racing cleanup paths
            // would have fired. 5 minutes is comfortably longer than the
            // longest expected ffmpeg-close-vs-stream-end window. .unref()
            // so a pending timer doesn't keep the process alive.
            setTimeout(
                () => {
                    this.finalized.delete(streamId);
                    this.shutdownKills.delete(streamId);
                },
                5 * 60 * 1000,
            ).unref();
        }
    }
}

let singleton: MusicTranscodeService | null = null;

export function getMusicTranscodeService(sql: postgres.Sql): MusicTranscodeService {
    if (!singleton) singleton = new MusicTranscodeService({ sql });
    return singleton;
}

/** Test-only: reset singleton between tests. */
export function _resetServiceForTests(): void {
    singleton = null;
}

/**
 * Test-only: inject a pre-constructed service so that the singleton getter
 * returns it without instantiating a new instance (which would read
 * `config.MUSIC_TRANSCODE_CACHE_DIR` and try to create a directory the
 * test environment cannot write to).
 */
export function _setServiceForTests(svc: MusicTranscodeService): void {
    singleton = svc;
}

// ---------------------------------------------------------------------------
// Cross-replica kill via pub/sub (Task 3.6)
//
// When a session is killed on replica A, `session-kill.service.ts` calls
// `notifySessionKilled()` which publishes to the shared 'play-sessions:kill'
// Valkey channel. All replicas subscribe to that channel, so replica B also
// receives the message and can call `cancel()` against its local cancellers Map.
//
// This closes the gap: a kill on replica A now propagates to replica B's
// in-process AbortController, stopping the ffmpeg process on B even though
// `cancelMusicStreamForSession` ran on A's process (where no canceller exists).
//
// The subscription is established once at module init. If Valkey is
// unavailable the subscribe call returns null (no-op) — the cross-replica path
// is best-effort; single-replica kills still work via the direct call in
// `cancelMusicStreamForSession`.
// ---------------------------------------------------------------------------

// Superseding a prepared deck ends the old track through the typed termination
// event; cancel its music delivery on the owning replica just like an admin kill.
for (const channel of ['play-sessions:kill', 'play-sessions:terminated']) {
    void subscribeToChannel(channel, (message) => {
        if (!singleton) return; // No active service on this replica — nothing to cancel.
        try {
            const parsed = JSON.parse(message) as {
                session_id: string;
                reason: string;
            };
            singleton.cancel(parsed.session_id);
        } catch {
            logger.warn('MusicTranscodeService: received invalid kill message on pub/sub channel', {
                message,
            });
        }
    }).catch((err: unknown) => {
        logger.warn(
            'MusicTranscodeService: failed to subscribe to kill channel — cross-replica music stream kills will not propagate',
            {},
            err as Error,
        );
    });
}
