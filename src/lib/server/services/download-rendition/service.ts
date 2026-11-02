// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Offline-download rendition service — election, encode, cache, reap.
 *
 * The lifecycle, end to end:
 *
 *   request → electOrGetRendition (unique key picks ONE encoder cluster-wide)
 *           → winner spawns ffmpeg into `<name>.partial`, heartbeating progress
 *           → atomic rename to `<name>` + status ready
 *           → everyone else polls the same row and downloads the finished file
 *
 * Losers never spawn anything; they just watch the winner's row. That is the
 * whole point of keying the table on (file, rung, audio): the artifact is
 * identical no matter who asked, so N requests cost one encode.
 *
 * ## Partial files are never served
 *
 * The encode writes to `<name>.partial` and the row only names the artifact once
 * the rename has happened. A client therefore cannot be handed a truncated MP4
 * whose Content-Length it would treat as the whole file — which, combined with
 * Range resume, would silently produce a corrupt download.
 */

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { promises as fs, type Stats } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { guardLibraryInput } from '$lib/server/utils/library-input-guard.js';
import { prepareMediaFormatWhitelist } from '$lib/server/utils/media-format-whitelist.js';
import { getDownloadRung, type DownloadRung } from '$lib/shared/download-rungs.js';
import { buildRenditionArgs, parseProgressPct } from './ffmpeg-args.js';
import { resolveRenditionHwPlan, type RenditionHwPlan } from './hw-plan.js';
import { assertTranscodeInputIsMedia } from '$lib/server/services/transcoding/input-guard.js';
import {
    electOrGetRendition,
    getRendition,
    markEncoding,
    markFailed,
    markReady,
    reclaimStaleEncode,
    reopenFailed,
    updateProgress,
    evictionCandidates,
    totalCachedBytes,
    deleteRendition,
    type DownloadRenditionRow,
} from '$lib/server/database/queries/download-renditions.queries.js';

const logger = Logger.for('DownloadRendition');

/** Encodes running in THIS process. Guards DOWNLOAD_RENDITION_MAX_CONCURRENT. */
const inFlight = new Set<string>();

const UUID_FILENAME_PART = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const OWNED_ARTIFACT_NAME = new RegExp(
    `^(${UUID_FILENAME_PART})(?:\\.(?:[0-9a-f]{64}|${UUID_FILENAME_PART}))?\\.mp4(?:\\.partial)?$`,
);
// Keep aligned with config.DOWNLOAD_RENDITION_CACHE_DIR's dedicated default.
const DEFAULT_CACHE_DIR = '/config/cache/download-renditions';

/** A configured short stale lease cannot outrun the owner's stall watchdog. */
function staleEncodeSeconds(): number {
    return Math.max(
        config.DOWNLOAD_RENDITION_STALE_SECONDS,
        config.DOWNLOAD_RENDITION_STALL_TIMEOUT_SECONDS + 60,
    );
}

/** Mount stalls must not prevent subsequent watchdog ticks from running. */
async function statEncodeOutput(path: string): Promise<Stats | null> {
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            fs.stat(path).catch(() => null),
            new Promise<null>((resolve) => {
                deadline = setTimeout(() => resolve(null), 5000);
                deadline.unref();
            }),
        ]);
    } finally {
        if (deadline) clearTimeout(deadline);
    }
}

class EncodeAbortedError extends Error {
    constructor(
        readonly errorCode: 'encode_stalled' | 'encode_failed',
        message: string,
    ) {
        super(message);
    }
}

/**
 * Run one ffmpeg to completion, reporting progress.
 *
 * Extracted so the GPU attempt and its software retry are literally the same
 * code path with a different args vector — the retry must not be able to drift
 * from the thing it is retrying.
 */
function spawnEncode(
    args: string[],
    durationMs: number | null,
    partialPath: string,
    onProgress: (pct: number) => Promise<boolean>,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(config.FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderrTail = '';
        let progressBuffer = '';
        let lastPct = 0;
        let outTime = -1;
        let heartbeatOutTime = -1;
        let size = 0;
        let mtime = 0;
        let lastAdvancedAt = Date.now();
        let ticking = false;
        let settled = false;
        let aborted: EncodeAbortedError | undefined;

        const abort = (error: EncodeAbortedError) => {
            if (settled || aborted) return;
            aborted = error;
            // A wedged child must release its slot even if it ignores SIGTERM.
            child.kill('SIGKILL');
        };
        child.stdout.on('data', (buf: Buffer) => {
            progressBuffer += buf.toString();
            const lines = progressBuffer.split(/\r?\n/);
            progressBuffer = lines.pop()!.slice(-4096);
            for (const line of lines) {
                const match = /^out_time_(?:ms|us)=(\d+)$/.exec(line);
                if (match && Number(match[1]) > outTime) {
                    outTime = Number(match[1]);
                    lastAdvancedAt = Date.now();
                }
                const pct = parseProgressPct(line, durationMs);
                if (pct !== null) lastPct = Math.max(lastPct, pct);
            }
        });
        child.stderr.on('data', (buf: Buffer) => {
            stderrTail = `${stderrTail}${buf.toString()}`.slice(-4000);
        });
        const tick = async () => {
            if (ticking || settled || aborted) return;
            ticking = true;
            try {
                const stat = await statEncodeOutput(partialPath);
                if (settled || aborted) return;
                const fileAdvanced = stat !== null && (stat.size > size || stat.mtimeMs > mtime);
                if (stat) {
                    size = stat.size;
                    mtime = stat.mtimeMs;
                }
                const timeAdvanced = outTime > heartbeatOutTime;
                heartbeatOutTime = outTime;
                if (fileAdvanced || timeAdvanced) {
                    lastAdvancedAt = Date.now();
                    // A stuck database call must not block later watchdog ticks.
                    void onProgress(lastPct)
                        .then((owned) => {
                            if (!owned)
                                abort(
                                    new EncodeAbortedError(
                                        'encode_failed',
                                        'Rendition owner was superseded',
                                    ),
                                );
                        })
                        .catch(() => {});
                } else if (
                    Date.now() - lastAdvancedAt >=
                    config.DOWNLOAD_RENDITION_STALL_TIMEOUT_SECONDS * 1000
                ) {
                    abort(
                        new EncodeAbortedError('encode_stalled', 'ffmpeg stopped making progress'),
                    );
                }
            } finally {
                ticking = false;
            }
        };
        const heartbeat = setInterval(() => {
            void tick().catch(() => {});
        }, 15_000);
        heartbeat.unref();
        child.on('error', (err) => {
            settled = true;
            clearInterval(heartbeat);
            reject(aborted ?? err);
        });
        child.on('close', (code) => {
            settled = true;
            clearInterval(heartbeat);
            if (aborted) return reject(aborted);
            if (code === 0) return resolve();
            reject(new Error(`ffmpeg exited ${code}: ${stderrTail.trim().slice(-500)}`));
        });
    });
}

/**
 * Artifact filename. Derived purely from server-generated ids, including an attempt
 * token — no user-controlled component reaches the filesystem, so there is no path
 * to traverse out of the cache directory.
 */
export function artifactNameFor(renditionId: string, attemptId: string): string {
    // The persisted owner token identifies an attempt across pod restarts. Hashing
    // keeps even legacy pod names out of the filesystem path.
    return `${renditionId}.${createHash('sha256').update(attemptId).digest('hex')}.mp4`;
}

export function cacheDir(): string {
    return config.DOWNLOAD_RENDITION_CACHE_DIR;
}

export function artifactPath(artifactName: string): string {
    return join(cacheDir(), artifactName);
}

export interface StartRenditionParams {
    sql: postgres.Sql;
    fileId: string;
    mediaItemId: string;
    rungId: string;
    audioIndex: number | null;
    /** Absolute on-disk path of the source file (already access-checked). */
    inputPath: string;
    durationMs: number | null;
    isHdr: boolean;
}

/**
 * Request a rendition. Idempotent: calling it repeatedly for the same
 * (file, rung, audio) returns the same row and never starts a second encode.
 *
 * A `failed` row is reopened so the client can retry a transient failure without
 * an admin having to clear anything by hand.
 */
export async function requestRendition(
    params: StartRenditionParams,
): Promise<DownloadRenditionRow> {
    const rung = getDownloadRung(params.rungId);
    if (!rung) throw new Error(`Unknown rung: ${params.rungId}`);

    // Reuse the existing owner column as a fencing token. Pod name alone cannot
    // distinguish retries on the same pod.
    const podId = `${config.INSTANCE_ID}:${randomUUID()}`;
    const { row, elected } = await electOrGetRendition(params.sql, {
        fileId: params.fileId,
        mediaItemId: params.mediaItemId,
        rungId: params.rungId,
        audioIndex: params.audioIndex,
        podId,
    });

    if (elected) {
        void runEncode(params, row, rung, podId);
        return row;
    }

    if (row.status === 'ready' || inFlight.has(row.id)) return row;

    if (row.status === 'failed') {
        if (await reopenFailed(params.sql, row.id, podId)) {
            void runEncode(params, row, rung, podId);
        }
        return (await getRendition(params.sql, row.id)) ?? row;
    }

    // queued/encoding owned by someone else — adopt it only if that owner has
    // stopped heartbeating (pod killed mid-encode). The UPDATE is guarded on the
    // stale heartbeat, so two replicas racing to adopt cannot both win.
    const stale = await reclaimStaleEncode(params.sql, row.id, podId, staleEncodeSeconds());
    if (stale) {
        logger.warn('Adopting a rendition whose owner stopped heartbeating', {
            renditionId: row.id,
            previousOwner: row.owner_pod,
        });
        void runEncode(params, row, rung, podId);
    }

    return (await getRendition(params.sql, row.id)) ?? row;
}

/**
 * Run one encode to completion. Never throws into the caller — a rendition
 * failure is a row state the client polls for, not a request-time error (the
 * request that triggered it has usually already been answered with a 202).
 */
async function runEncode(
    params: StartRenditionParams,
    row: DownloadRenditionRow,
    rung: DownloadRung,
    ownerToken: string,
): Promise<void> {
    const { sql } = params;

    if (inFlight.has(row.id)) return;

    if (inFlight.size >= config.DOWNLOAD_RENDITION_MAX_CONCURRENT) {
        // Leave the row queued and owned: whoever polls next re-enters
        // requestRendition, and the stale-heartbeat path will pick it up when a
        // slot frees. Deliberately not an in-memory queue — that would not
        // survive a restart, and the row already is the durable queue.
        logger.info('Rendition deferred — encode slots full', {
            renditionId: row.id,
            inFlight: inFlight.size,
        });
        return;
    }

    inFlight.add(row.id);
    const artifactName = artifactNameFor(row.id, ownerToken);
    const finalPath = artifactPath(artifactName);
    const partialPath = `${finalPath}.partial`;

    try {
        // The source is a library file, and the artifact is handed to the user:
        // a file whose content became a playlist/manifest body after the last
        // scan would have ffmpeg follow its references into other libraries.
        // Refused before any spawn — ahead of the GPU attempt, whose catch would
        // otherwise retry the refusal on CPU — and failed like any encode.
        await assertTranscodeInputIsMedia({ localFilePath: params.inputPath });
        await fs.mkdir(cacheDir(), { recursive: true });
        if (!(await markEncoding(sql, row.id, ownerToken))) return;

        // The claim is fenced before removing only the predecessor's files.
        if (row.owner_pod && row.owner_pod !== ownerToken) {
            const previousPath = artifactPath(artifactNameFor(row.id, row.owner_pod));
            await fs.rm(previousPath, { force: true });
            await fs.rm(`${previousPath}.partial`, { force: true });
        }
        const hw = await resolveRenditionHwPlan();

        const runFfmpeg = async (plan: RenditionHwPlan | null): Promise<void> => {
            const warm = prepareMediaFormatWhitelist();
            if (warm) await warm;
            return spawnEncode(
                guardLibraryInput(
                    buildRenditionArgs({
                        inputPath: params.inputPath,
                        outputPath: partialPath,
                        rung,
                        audioIndex: params.audioIndex,
                        isHdr: params.isHdr,
                        hw: plan,
                    }),
                    params.inputPath,
                ),
                params.durationMs,
                partialPath,
                (pct) => updateProgress(sql, row.id, pct, ownerToken),
            );
        };

        if (hw) {
            try {
                await runFfmpeg(hw);
            } catch (err) {
                if (err instanceof EncodeAbortedError && err.errorCode !== 'encode_stalled')
                    throw err;
                // Fall back to software for THIS encode only, and remember
                // nothing. A persistent "this doesn't work on the GPU" verdict is
                // exactly what turned a fixed -color_range bug into 30 days of
                // wrong behaviour across pods; a stateless retry cannot outlive
                // its cause.
                logger.warn('GPU rendition encode failed — retrying on CPU', {
                    renditionId: row.id,
                    encoder: hw.encoder,
                    error: err,
                });
                await fs.rm(partialPath, { force: true }).catch(() => {});
                // Start the software watchdog window under a renewed, fenced lease.
                // A best-effort percent reset must not suppress the CPU retry.
                if (!(await markEncoding(sql, row.id, ownerToken))) {
                    throw new EncodeAbortedError('encode_failed', 'Rendition owner was superseded');
                }
                if (!(await updateProgress(sql, row.id, 0, ownerToken).catch(() => true))) {
                    throw new EncodeAbortedError('encode_failed', 'Rendition owner was superseded');
                }
                await runFfmpeg(null);
            }
        } else {
            await runFfmpeg(null);
        }

        const stat = await fs.stat(partialPath);
        if (stat.size === 0) throw new Error('ffmpeg produced an empty file');

        // Atomic within the cache directory — a reader either sees no artifact or
        // the complete one, never a growing file.
        await fs.rename(partialPath, finalPath);
        if (!(await markReady(sql, row.id, artifactName, stat.size, ownerToken))) {
            // A takeover won while this encoder was finishing. Its files have
            // different names, so discarding ours cannot damage the winner.
            await fs.rm(finalPath, { force: true });
            return;
        }

        logger.info('Rendition ready', {
            renditionId: row.id,
            rung: rung.id,
            sizeBytes: stat.size,
        });

        void reapToCap(sql).catch((err: unknown) =>
            logger.warn('Rendition reap failed', { error: err }),
        );
    } catch (err) {
        await fs.rm(partialPath, { force: true }).catch(() => {});
        await markFailed(
            sql,
            row.id,
            err instanceof EncodeAbortedError ? err.errorCode : 'encode_failed',
            ownerToken,
        ).catch(() => {});
        logger.error('Rendition encode failed', undefined, {
            renditionId: row.id,
            rung: rung.id,
            error: err,
        });
    } finally {
        inFlight.delete(row.id);
    }
}

/** Reclaim abandoned attempts, including artifacts written before a crashed rename/commit. */
async function reapUnreferencedArtifacts(sql: postgres.Sql): Promise<void> {
    const entries = await fs
        .readdir(cacheDir(), { withFileTypes: true })
        .catch((err: { code?: string }) => {
            if (err.code === 'ENOENT') return [];
            throw err;
        });
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const entry of entries) {
        const match = OWNED_ARTIFACT_NAME.exec(entry.name);
        if (!entry.isFile() || !match) continue;
        const path = artifactPath(entry.name);
        const stat = await fs.lstat(path).catch(() => null);
        if (!stat?.isFile() || stat.mtimeMs >= cutoff) continue;
        const id = match[1];
        if (id) {
            if (inFlight.has(id)) continue;
            // Read immediately before unlinking: a recently adopted attempt or a
            // ready row protects its files even when their mtime is old.
            const row = await getRendition(sql, id);
            if (row?.status === 'ready' && row.artifact_name === entry.name) continue;
            if (
                row &&
                (row.status === 'queued' || row.status === 'encoding') &&
                row.heartbeat_at &&
                row.heartbeat_at.getTime() >= Date.now() - staleEncodeSeconds() * 1000
            )
                continue;
        }
        await fs.rm(path, { force: true });
    }
}

/**
 * Evict coldest-first until the cache is under its byte budget.
 *
 * File first, then row: a row without a file is a miss the next request simply
 * re-encodes, whereas a file without a row is unreachable bytes that nothing will
 * ever reclaim. Getting this order backwards leaks the disk.
 */
export async function reapToCap(sql: postgres.Sql): Promise<void> {
    try {
        if (config.FEATURE_DOWNLOAD_RENDITIONS || resolvePath(cacheDir()) === DEFAULT_CACHE_DIR) {
            await reapUnreferencedArtifacts(sql);
        }
    } catch (err) {
        logger.warn('Rendition orphan sweep failed; continuing cap eviction', { error: err });
    }
    const capBytes = config.DOWNLOAD_RENDITION_CACHE_MAX_GB * 1024 ** 3;
    let total = await totalCachedBytes(sql);
    if (total <= capBytes) return;

    const candidates = await evictionCandidates(sql, 100);
    for (const candidate of candidates) {
        if (total <= capBytes) break;
        // Never evict something a client is actively downloading right now.
        //
        // `inFlight` is per-PROCESS and only ever populated by `runEncode`, so
        // it says nothing about a download being SERVED, and nothing at all
        // about another replica. The cross-pod half of that is handled by
        // `evictionCandidates`, which excludes anything recently touched by
        // the serve path — this check remains for the encode it does know
        // about.
        if (inFlight.has(candidate.id)) continue;

        if (candidate.artifact_name) {
            await fs.rm(artifactPath(candidate.artifact_name), { force: true }).catch(() => {});
        }
        await deleteRendition(sql, candidate.id);
        total -= Number(candidate.size_bytes ?? 0);

        logger.info('Evicted a cold rendition', {
            renditionId: candidate.id,
            lastAccessedAt: candidate.last_accessed_at,
        });
    }
}
