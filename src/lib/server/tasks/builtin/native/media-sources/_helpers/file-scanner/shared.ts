// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared types and utilities for the file scanner module.
 */

import { queueRecencyRefresh } from './watcher-recency.js';
import path from 'node:path';
import type { Stats } from 'node:fs';
import { safeStat } from '$lib/server/utils/safe-fs.js';
import type postgres from 'postgres';
import { withTx } from '../../../../../../database/with-tx.js';
import { TaskError, type ScanResult } from '@sapd/lumastra-plugin-sdk';
import type { PluginContext } from '../../../../../../plugins/types/base-plugin.js';
import type { SyncExecutionContext } from '../../../../../sync-context-types.js';
import {
    updateFileStat,
    restoreMissingFile,
    deleteStaleMediaFile,
    recordFileScanIssue,
    getFileScanRetryAt,
    recordDecodeHealthIssue,
    clearFileScanIssue,
    clearUnlinkedFileScanIssue,
} from '../../../../../../database/queries/media-files.queries.js';
import type { KnownFileRow } from '../../../../../../database/queries/media-files.queries.js';
import { hashFileHead } from '../../../../../../utils/file-hash.js';
import { assessFilePresence } from '../../../../../../utils/file-presence.js';
import { isExtrasFilePath } from '$lib/server/utils/media-extras.js';
import { episodeTitleFromFileName } from '$lib/server/utils/episode-release-title.js';
import { probeMediaFile, type MediaProbeResult } from '../../../../../../utils/ffprobe.js';
import { rememberScanProbe } from '../../../../../../utils/scan-probe-cache.js';
import { MediaLifecycleService } from '../../../../../../services/media-lifecycle.service.js';
import { isPlaylistClassContainer } from './playlist-container.js';
import { sniffFileForPlaylist } from '$lib/server/utils/playlist-sniff.js';

// ---------------------------------------------------------------------------
// FileScannerContext — narrow context shared by watcher (PluginContext) and
// sync-plugin (SyncExecutionContext) callers.
//
// Both `PluginContext` and `SyncExecutionContext` structurally satisfy this
// shape, so callers can pass whichever they hold without casting. The file
// scanner and its sub-processors only touch `sql` + `logger` + (occasionally)
// `onProgress`, so we deliberately keep this surface minimal — reaching for
// `cache`/`http`/`ffmpeg` from inside the scanner is a bug, not a feature.
// ---------------------------------------------------------------------------
export interface FileScannerContext {
    sql: postgres.Sql;
    logger: PluginContext['logger'];
    abortSignal?: AbortSignal;
    onProgress?: SyncExecutionContext['onProgress'];
    /** runGroupId from BullMQ job (sync path only — undefined for watcher path). */
    runGroupId?: string;
    /**
     * BullMQ jobId for the enclosing file-library-scan invocation. Used to
     * attach the post-scan FlowProducer tree as a real BullMQ child so the
     * coordinator can gate the entire pipeline. Undefined on the watcher path.
     */
    jobId?: string;
    /**
     * Files the metadata provider could not be ASKED about in this scan (key
     * rejected, or provider not configured/registered) — they were added
     * without metadata. `performScan` creates it and copies it onto the
     * ScanResult so the scan summary stops reporting "unmatched: 0" when
     * matching never happened (Windows e2e S5).
     */
    metadataStats?: MetadataScanStats;
}

export interface MetadataScanStats {
    unavailable: number;
    /** 'auth' wins over 'unavailable' when both occur. */
    error?: 'auth' | 'unavailable';
    /** Provider id behind `error` (e.g. 'tmdb-metadata-provider'). */
    providerId?: string;
}

/** Record a file that was added without asking its metadata provider. */
export function noteMetadataUnavailable(
    context: Pick<FileScannerContext, 'metadataStats'>,
    reason: 'auth' | 'unavailable',
    providerId?: string,
): void {
    const stats = context.metadataStats;
    if (!stats) return;
    stats.unavailable++;
    if (stats.error !== 'auth') {
        stats.error = reason;
        stats.providerId = providerId;
    }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScanOutcome = 'added' | 'updated' | 'skipped' | 'unmatched';

/**
 * Map any media type string to the narrower 'movie' | 'tv' expected by the DB.
 * @deprecated Use `toTmdbMediaType` from `$lib/shared/media-type-domain` directly.
 */
export { toTmdbMediaType as toDbMediaType } from '$lib/shared/media-type-domain';

/** Increment the appropriate counter in the scan result. */
export function countOutcome(result: ScanResult, outcome: ScanOutcome): void {
    result[outcome]++;
}

/**
 * Run-level failure guard: a scan that touched files but produced ZERO
 * successful outcomes (added/updated/skipped/unmatched all 0) while errors
 * accumulated is a total I/O outage (e.g. the NFS mount vanished mid-run) — NOT
 * a clean "nothing to do". Returning the result records the run COMPLETED and
 * reports SUCCESS to the circuit breaker, hiding the outage. Throw a transient
 * TaskError so the run is marked failed, retried, and the breaker can trip.
 *
 * `removed` is deliberately NOT counted as work here: a scan whose only effect
 * was stale-cleanup while every file read errored is still an outage.
 *
 * Genuine no-work (empty/stable library) has `errors.length === 0` and returns
 * normally. Aborts (which push a sentinel error) are excluded by the caller via
 * the `aborted` flag.
 */
export function assertScanProducedWorkOrThrow(result: ScanResult, aborted: boolean): void {
    if (aborted) return;
    const producedWork = result.added + result.updated + result.skipped + result.unmatched > 0;
    if (result.errors.length > 0 && !producedWork) {
        throw new TaskError({
            message:
                `file-scanner: scan produced no successful outcomes with ` +
                `${result.errors.length} error(s) — treating as a transient I/O outage.`,
            kind: 'transient',
        });
    }
}

/**
 * Record a per-library-path walk failure (readdir/stat errors surfaced by
 * `walkDirectoryWithResult`) into `result.errors`.
 *
 * Without this, a fully-unreadable library root (e.g. a dead NFS mount at
 * scan start) yields `files=[]` with `hadErrors=true` — zero per-file work
 * happens, so zero per-file errors accumulate, and the run completes looking
 * clean instead of tripping `assertScanProducedWorkOrThrow` above (whose
 * docstring names exactly this scenario). One entry per errored library path
 * is enough to make the outage visible and, in a total-outage run, trigger
 * the run-level failure guard.
 */
export function recordWalkErrors(
    result: ScanResult,
    libraryPathPath: string,
    errorPaths: string[],
): void {
    const sample = errorPaths.slice(0, 5).join(', ');
    result.errors.push(
        `${libraryPathPath}: walk had readdir/stat errors` + (sample ? ` (sample: ${sample})` : ''),
    );
}

export {
    extractSeriesTitleFromPath,
    extractSeasonNumberFromPath,
    resolveSeasonNumber,
} from '$lib/server/utils/path-parsing.js';

/**
 * Derive a human-readable title for a personal episode from its file path.
 * Release-style names are reduced to the real episode title or `Episode N`
 * (see `episode-release-title.ts`).
 */
export function episodeTitleFromPath(filePath: string, episodeNumber: number): string {
    return episodeTitleFromFileName(path.basename(filePath), episodeNumber);
}

/**
 * Best-effort 64KB head-hash computation for populating file_hash_head at
 * ingest time (fix #5 — rename-race follow-up). Failures are silently
 * swallowed, matching initFileChangeDetection's existing non-fatal contract:
 * a transient read error must never block file ingestion — the file simply
 * falls back to the lazy hash write on a later scan.
 */
export async function tryHashFileHead(filePath: string): Promise<string | undefined> {
    try {
        return await hashFileHead(filePath);
    } catch {
        return undefined;
    }
}

/**
 * Whether every one of `filePaths` is gone from this library: each lies under
 * `libraryRoot` and is missing while the library itself is mounted. A rename
 * reclaim takes over an item only when its old file(s) went away. A copy
 * (the old file is still there), a file in another library, or a mount that
 * looks offline ('transient') keeps the item apart. An empty list is false.
 */
export async function filesAllMissingFromLibrary(
    filePaths: readonly string[],
    libraryRoot: string,
): Promise<boolean> {
    if (filePaths.length === 0) return false;
    const root = libraryRoot.replace(/\/+$/, '') || '/';
    for (const filePath of filePaths) {
        if (!filePath.startsWith(`${root}/`)) return false;
        if ((await assessFilePresence(filePath, { mountRoot: root })) !== 'missing') return false;
    }
    return true;
}

/**
 * Store initial mtime/size/hash for a newly created media_files row.
 * Non-fatal — stat or hash failure is silently ignored.
 *
 * Pass `precomputedHash` when the caller already hashed the file (e.g. to
 * populate `upsertMediaFile`'s `fileHashHead` param) so this doesn't perform
 * a second 64KB read of the same file.
 */
export async function initFileChangeDetection(
    sql: postgres.Sql,
    fileId: string,
    filePath: string,
    precomputedHash?: string,
): Promise<void> {
    try {
        const fileStat = await safeStat(filePath);
        const hash = precomputedHash ?? (await hashFileHead(filePath));
        await updateFileStat(sql, fileId, fileStat.mtime, fileStat.size, hash);
    } catch {
        /* non-fatal */
    }
}

/**
 * Record a control-char / playlist-container scan issue against an
 * UNLINKED (or not-yet-linked) file, honoring the same backoff cooldown as
 * the tag-parse path so a persistently-rejected file doesn't get its
 * `health_issues` row rewritten (and `attempt_count` bumped) on every single
 * scan pass. Shared by every call site across the scanner that records one
 * of these two issue types, so the cooldown check can't drift between
 * copies.
 */
export async function recordScanIssueWithCooldown(
    sql: postgres.Sql,
    filePath: string,
    libraryGroupId: string | null,
    type:
        | 'unsafe_filename'
        | 'playlist_container_rejected'
        | 'episode_number_unparsed'
        | 'series_identity_conflict'
        | 'series_folder_contention'
        | 'movie_identity_conflict',
    detail: string,
): Promise<void> {
    const cooldown = await getFileScanRetryAt(sql, filePath, [type]);
    if (!cooldown || cooldown.retryAt.getTime() <= Date.now()) {
        await recordFileScanIssue(sql, { filePath, libraryGroupId, type, detail });
    }
}

/**
 * What a scan-time ffprobe of one file came to. Ruling T7-probe-outcomes (fix
 * plan 6, Task 7 fix round 3): every scanner caller — the main file and
 * extras, on both the content-change path and the new-file path — acts on
 * exactly these four outcomes, through {@link applyContentChange} or
 * {@link probeNewFileForScan}, never on a raw probe result of its own.
 *
 * - `ok` — a real media container; proceed.
 * - `refused` — a playlist/manifest body (ruling T7-probe-outcomes-2): the
 *   content sniff found its magic (`sniffFileForPlaylist`), ffprobe named a
 *   playlist-class container (`isPlaylistClassContainer`), or ffprobe failed
 *   inside a reference-following demuxer (`reference-demuxer`). The file is
 *   never linked (and a linked one is retired).
 * - `aborted` — the scan was cancelled mid-probe; nothing about the file is
 *   known, so nothing may be written.
 * - `failed` — split by `ProbeFailureKind`: `invalid-data` is a verdict on
 *   the file's bytes; `transient` (timeout, I/O, spawn failure) is not.
 */
export type ScanProbeOutcome =
    | { kind: 'ok'; probe: MediaProbeResult }
    | { kind: 'refused'; container: string }
    | { kind: 'aborted' }
    | { kind: 'failed'; failure: 'invalid-data' | 'transient'; error: string };

/** The sniff half of {@link ScanProbeOutcome}: `clear` means "not a playlist body". */
export type SniffOutcome = { kind: 'clear' } | Exclude<ScanProbeOutcome, { kind: 'ok' }>;

/**
 * Sniff `filePath`'s content for a playlist/manifest body
 * (`sniffFileForPlaylist`, `utils/playlist-sniff.ts`) — the content half of
 * every scanner decision. The video plane runs it inside
 * {@link probeFileForScan}, before ffprobe; the music plane, which reads tags
 * with music-metadata instead of probing, runs it through
 * {@link sniffNewFileForScan} and {@link sniffContentChangeForScan}.
 *
 * ENOENT is `clear`, so a vanished file still reaches the callers' existing
 * missing-file handling; any other read error (EIO, a guarded-fs timeout) is a
 * `transient` failure; the scan's `abortSignal` is forwarded and an abort is
 * `aborted`. A non-regular file (a FIFO) is `clear` and left to the next step.
 */
export async function sniffFileForScan(
    filePath: string,
    abortSignal?: AbortSignal,
): Promise<SniffOutcome> {
    if (abortSignal?.aborted) return { kind: 'aborted' };
    try {
        const sniff = await sniffFileForPlaylist(filePath, { signal: abortSignal });
        if (sniff?.magic) {
            return { kind: 'refused', container: `${sniff.magic}, from the file's content` };
        }
    } catch (err) {
        const e = err as { code?: unknown; name?: unknown } | null;
        if (e?.name === 'AbortError') return { kind: 'aborted' };
        if (e?.code !== 'ENOENT') {
            const message = err instanceof Error ? err.message : String(err);
            return {
                kind: 'failed',
                failure: 'transient',
                error: `could not read the file content: ${message}`,
            };
        }
    }
    if (abortSignal?.aborted) return { kind: 'aborted' };
    return { kind: 'clear' };
}

/**
 * Probe `filePath` for the scanner and reduce the result to a
 * {@link ScanProbeOutcome} — the one place a video-plane scan decides what a
 * file is.
 *
 * 1. {@link sniffFileForScan} BEFORE ffprobe: a playlist/manifest body is
 *    refused whatever ffprobe would say about it.
 * 2. Run ffprobe, forwarding the scan's `abortSignal` so a cancel kills an
 *    in-flight probe instead of waiting out its 15 s timeout.
 * 3. Leave an `ok` result for media-probe Phase A (`rememberScanProbe`), tagged
 *    with the file's stat, when that stat was the same before and after the
 *    probe. Phase A then writes the streams without probing the file again.
 *
 * A failed result without a `failureKind` counts as `transient`: the outcome
 * that links nothing and commits nothing, so the next scan decides again.
 */
export async function probeFileForScan(
    filePath: string,
    abortSignal?: AbortSignal,
): Promise<ScanProbeOutcome> {
    const sniff = await sniffFileForScan(filePath, abortSignal);
    if (sniff.kind !== 'clear') return sniff;

    const before = await statOrNull(filePath);
    // `chapters: true`: the same ffprobe run also reads the chapters, so
    // extractChapters (video-processor.ts) does not probe the file a second time.
    const probe = await probeMediaFile(filePath, undefined, {
        chapters: true,
        ...(abortSignal ? { signal: abortSignal } : {}),
    });
    if (!probe.success) {
        const failureKind = probe.failureKind ?? 'transient';
        const error = probe.error ?? 'unknown error';
        if (failureKind === 'aborted') return { kind: 'aborted' };
        if (failureKind === 'reference-demuxer') {
            const demuxer = /^\[(concat|hls|dash|imf) @ /m.exec(error)?.[1] ?? 'a playlist';
            return { kind: 'refused', container: `${demuxer}, from ffprobe's error output` };
        }
        return { kind: 'failed', failure: failureKind, error };
    }
    if (isPlaylistClassContainer(probe.container)) {
        return { kind: 'refused', container: probe.container ?? '' };
    }
    if (before) {
        const after = await statOrNull(filePath);
        if (after && after.size === before.size && after.mtimeMs === before.mtimeMs) {
            rememberScanProbe(filePath, { mtime: before.mtime, size: before.size }, probe);
        }
    }
    return { kind: 'ok', probe };
}

/** The file's stat for the probe hand-over; null when it cannot be read. */
async function statOrNull(filePath: string): Promise<Stats | null> {
    try {
        return (await safeStat(filePath)) ?? null;
    } catch {
        return null;
    }
}

/** Record the refusal of a file that is about to be linked (never linked). */
async function recordNewFileRefusal(
    sql: postgres.Sql,
    filePath: string,
    libraryGroupId: string | null,
    container: string,
    context: FileScannerContext,
): Promise<void> {
    await recordScanIssueWithCooldown(
        sql,
        filePath,
        libraryGroupId,
        'playlist_container_rejected',
        `Identified as a playlist/reference container (${container}), which is never ingested.`,
    );
    context.logger.warn(
        '[FileScanner] Skipping file — identified as a playlist-class container; recorded as scan issue',
        { filePath, container },
    );
}

/**
 * Retire a LINKED file whose content changed into a playlist/manifest body:
 * `deleteStaleMediaFile` (the treatment a vanished file gets — the
 * `media_files` row and its `media_file_items` links go, so no playback query
 * can select it) and the `playlist_container_rejected` issue.
 */
async function retireRefusedContentChange(
    sql: postgres.Sql,
    filePath: string,
    libraryGroupId: string | null,
    container: string,
    context: FileScannerContext,
): Promise<void> {
    const removed = await deleteStaleMediaFile(sql, filePath);
    queueRecencyRefresh(sql, removed?.affectedItemIds ?? [], context.logger);
    await recordScanIssueWithCooldown(
        sql,
        filePath,
        libraryGroupId,
        'playlist_container_rejected',
        `Identified as a playlist/reference container (${container}) after its content changed; the existing library entry was retired.`,
    );
    context.logger.warn(
        '[FileScanner] Retired an existing library entry — its content changed into a playlist-class container',
        { filePath, container },
    );
}

/**
 * Music plane, new file (ruling T7-music): sniff a track that is about to be
 * linked and record the refusal. The caller links it only on `clear`.
 */
export async function sniffNewFileForScan(
    sql: postgres.Sql,
    filePath: string,
    libraryGroupId: string | null,
    context: FileScannerContext,
    abortSignal?: AbortSignal,
): Promise<SniffOutcome> {
    const outcome = await sniffFileForScan(filePath, abortSignal);
    if (outcome.kind === 'refused') {
        await recordNewFileRefusal(sql, filePath, libraryGroupId, outcome.container, context);
    }
    return outcome;
}

/**
 * Music plane, content change (ruling T7-music): sniff a LINKED track whose
 * bytes changed and retire it on a hit, exactly as {@link applyContentChange}
 * retires a video file. On `aborted` or `failed` nothing is written — the
 * caller must not commit the new stat/hash, so the next scan sniffs again.
 */
export async function sniffContentChangeForScan(
    sql: postgres.Sql,
    filePath: string,
    libraryGroupId: string | null,
    context: FileScannerContext,
    abortSignal?: AbortSignal,
): Promise<SniffOutcome> {
    const outcome = await sniffFileForScan(filePath, abortSignal);
    if (outcome.kind === 'refused') {
        await retireRefusedContentChange(sql, filePath, libraryGroupId, outcome.container, context);
    }
    return outcome;
}

/**
 * {@link ScanProbeOutcome}, plus `cooling-down`: an earlier probe of this new
 * file found invalid data and its retry window is still open, so it was not
 * probed. The caller skips it (never links it) without counting an error.
 */
export type NewFileProbeOutcome = ScanProbeOutcome | { kind: 'cooling-down'; retryAt: Date };

/**
 * Whether a new file is inside the retry window an earlier invalid-data probe
 * set. A file modified since that failure is retried at once (the same mtime
 * bust the audio tag-parse path uses); a file that cannot be stat'd is left to
 * the probe, so the callers' missing-file handling still runs.
 */
async function newFileProbeCooldown(sql: postgres.Sql, filePath: string): Promise<Date | null> {
    const cooldown = await getFileScanRetryAt(sql, filePath, ['container_unreadable']);
    if (!cooldown || cooldown.retryAt.getTime() <= Date.now()) return null;
    try {
        const { mtime } = await safeStat(filePath);
        if (mtime > cooldown.latestDetectedAt) return null;
    } catch {
        return null;
    }
    return cooldown.retryAt;
}

/**
 * The new-file half of ruling T7-probe-outcomes, shared by `processVideoFile`
 * and `processExtra`: probe a file that is about to be linked. The caller
 * links the file only when the outcome is `ok`.
 *
 * - `refused` records `playlist_container_rejected`.
 * - `ok` clears a `container_unreadable` the scanner left on the (still
 *   unlinked) stub row.
 * - `failed` with invalid data records `container_unreadable` on the file's
 *   stub row with the scanner's retry tiers (`recordFileScanIssue`: attempts
 *   1-2 retry on the next scan, then 24 h, then 7 d), and inside that window
 *   the file is not probed again (`cooling-down`) until it changes on disk.
 *   Without this a permanently broken new file was probed, and counted as a
 *   scan error, on every scan, with nothing on the Ingest Map.
 * - `aborted` and transient failures record nothing: they say nothing about
 *   the file's bytes.
 */
export async function probeNewFileForScan(
    sql: postgres.Sql,
    filePath: string,
    libraryGroupId: string | null,
    context: FileScannerContext,
    abortSignal?: AbortSignal,
): Promise<NewFileProbeOutcome> {
    const retryAt = await newFileProbeCooldown(sql, filePath);
    if (retryAt) return { kind: 'cooling-down', retryAt };

    const outcome = await probeFileForScan(filePath, abortSignal);
    if (outcome.kind === 'ok') {
        // The scanner's own earlier verdict is refuted; a linked row's
        // decode verdict (trickplay) is not, so only an unlinked stub is
        // cleared — before the caller links it.
        await clearUnlinkedFileScanIssue(sql, filePath, 'container_unreadable');
    } else if (outcome.kind === 'refused') {
        await recordNewFileRefusal(sql, filePath, libraryGroupId, outcome.container, context);
    } else if (outcome.kind === 'failed' && outcome.failure === 'invalid-data') {
        const issue = await recordFileScanIssue(sql, {
            filePath,
            libraryGroupId,
            type: 'container_unreadable',
            detail: outcome.error,
        });
        context.logger.warn(
            '[FileScanner] New file is not readable media; recorded as scan issue',
            {
                filePath,
                attemptCount: issue.attempt_count,
                nextRetryAt: issue.next_retry_at ?? 'next scan',
            },
        );
    }
    return outcome;
}

/** Result of {@link applyContentChange}. */
export type ContentChangeOutcome =
    /** Playlist-class content: the row was retired; stop processing the file. */
    | { kind: 'refused' }
    /** Scan cancelled mid-probe: nothing written; the next scan re-detects the change. */
    | { kind: 'aborted' }
    /** Transient probe failure: nothing written; the next scan re-detects the change. */
    | { kind: 'retry-next-scan' }
    /**
     * Probe data invalidated and the new stat/hash committed. `readable` is
     * false when the probe rejected the content (`container_unreadable` was
     * recorded after the invalidation). `durationSeconds` is the new content's
     * probed duration when the probe read one: the caller revalidates windows
     * an admin set by hand against it (manual-file-links.service.ts).
     */
    | {
          kind: 'committed';
          readable: boolean;
          invalidatedMediaItemIds: string[];
          durationSeconds?: number;
      };

/**
 * The content-change half of ruling T7-probe-outcomes, shared by
 * `processVideoFile`'s content-changed branch and `processExtra`: a LINKED
 * file whose bytes changed is re-probed before its row is trusted again, and
 * the outcome decides what is written.
 *
 * - `refused` → retire the row via `deleteStaleMediaFile` (the treatment a
 *   vanished file gets: the `media_files` row and its `media_file_items`
 *   links go, so no playback query can select it) and record
 *   `playlist_container_rejected`. A probe failure never retires a row.
 * - `aborted` / transient `failed` → write nothing: no stat, no hash, no
 *   issue. The stored hash still differs from the file, so the next scan
 *   detects the change and probes again. Committing the hash here would make
 *   the next scan see `unchanged` and never re-run the refusal.
 * - `ok` / invalid-data `failed` → invalidate the file's probe data
 *   (`MediaLifecycleService.onFileContentChanged`, the one entry point for
 *   that), then — for invalid data only — record `container_unreadable`,
 *   then commit the new stat/hash. The issue is written AFTER the
 *   invalidation because the invalidation sets `health_issues = NULL`; the
 *   same invalidation is what clears an earlier `container_unreadable` once
 *   the file changes into something readable.
 */
export async function applyContentChange(
    sql: postgres.Sql,
    file: { id: string; filePath: string; libraryGroupId: string | null },
    stat: { mtime: Date; size: number; hash: string },
    context: FileScannerContext,
    abortSignal?: AbortSignal,
): Promise<ContentChangeOutcome> {
    const outcome = await probeFileForScan(file.filePath, abortSignal);

    if (outcome.kind === 'refused') {
        await retireRefusedContentChange(
            sql,
            file.filePath,
            file.libraryGroupId,
            outcome.container,
            context,
        );
        return { kind: 'refused' };
    }
    if (outcome.kind === 'aborted') {
        context.logger.debug('[FileScanner] Probe aborted for a content-changed file', {
            filePath: file.filePath,
        });
        return { kind: 'aborted' };
    }
    if (outcome.kind === 'failed' && outcome.failure === 'transient') {
        context.logger.warn(
            '[FileScanner] Probe failed transiently for a content-changed file — nothing recorded, retried next scan',
            { filePath: file.filePath, error: outcome.error },
        );
        return { kind: 'retry-next-scan' };
    }

    const { invalidatedMediaItemIds } = await MediaLifecycleService.onFileContentChanged(
        sql,
        file.id,
        file.filePath,
    );
    const readable = outcome.kind === 'ok';
    if (outcome.kind === 'failed') {
        await recordDecodeHealthIssue(sql, {
            fileId: file.id,
            type: 'container_unreadable',
            detail: `ffprobe rejected the file's new content: ${outcome.error}`,
        });
        context.logger.warn(
            '[FileScanner] Content-changed file is not a readable container — recorded as a decode issue, never retired',
            { filePath: file.filePath, error: outcome.error },
        );
    }
    await updateFileStat(sql, file.id, stat.mtime, stat.size, stat.hash);
    const durationSeconds = outcome.kind === 'ok' ? outcome.probe.duration : undefined;
    return {
        kind: 'committed',
        readable,
        invalidatedMediaItemIds,
        ...(durationSeconds ? { durationSeconds } : {}),
    };
}

/**
 * Generic iteration helper for scan passes (files, extras, artwork, subtitles).
 *
 * Handles abort checking, error collection, and outcome counting.
 * The optional `onEach` callback runs after every item for progress tracking.
 *
 * NOTE: When called in parallel via Promise.all, all instances mutate the
 * shared `result` object. This is safe because JS is single-threaded — async
 * iteration interleaves at await points but never runs concurrently. Do NOT
 * refactor into worker threads without addressing shared mutation.
 */
export interface TriageResult {
    /** Files where mtime+size match cached values and hash exists — skip entirely */
    unchanged: string[];
    /** Files where mtime or size differs from cache — need hash check */
    maybeChanged: string[];
    /** Files not in the knownFiles cache — need full processing */
    newFiles: string[];
    /**
     * Physical identity (`fileIdentityKey`) of every known file the triage
     * stat'ed, mapped to its path: lets a new path that is another name for a
     * known file (hard link, symlink) be recognised without another stat.
     */
    knownFileIds: Map<string, string>;
}

/**
 * Device + inode + size of a stat result, or null where the filesystem gives
 * no usable inode (0). Two paths with the same key are one physical file
 * (hard link, symlink — stat follows it — or a case variant on a
 * case-insensitive share).
 */
export function fileIdentityKey(st: { dev: number; ino: number; size: number }): string | null {
    if (!st.ino) return null;
    return `${st.dev}:${st.ino}:${st.size}`;
}

/** Confirm a scanned file again under the availability locks before restoring it. */
export async function restoreScannedFile(
    sql: postgres.Sql,
    fileId: string,
    filePath: string,
): Promise<boolean> {
    return restoreMissingFile(sql, fileId, async () => {
        try {
            return (await safeStat(filePath)).isFile();
        } catch {
            return false;
        }
    });
}

/**
 * Fast triage: classify files as unchanged/changed/new using batched stat() calls.
 *
 * For the 'unchanged' bucket, no hash is computed: compare cached mtime/size,
 * then reconcile missing state in a bounded locked batch before skipping.
 *
 * NOTE: A file modified between triage stat() and later processing will produce
 * a hash mismatch. This is benign — the file gets reprocessed next scan. All DB
 * writes are idempotent (upserts).
 *
 * Extras guard: a path matching {@link isExtrasFilePath} is dropped from every
 * bucket entirely — never `newFiles`, `maybeChanged`, nor `unchanged`. This
 * matters even though the disk walk (`walk-directory.ts`) already excludes
 * extras subfolders/suffixes from its own listing, because `knownFiles` is
 * loaded straight from the DB (`loadMediaFilesByPrefix`) and can carry an
 * orphaned extras row — e.g. one left DB-known-but-unlinked by a junction-row
 * repair (see `reconcile-series-fix-report.md`). Without this guard, a caller
 * that ever feeds such a path into `files` would have it classified `newFiles`
 * (an unlinked known row looks identical to a genuinely new one) and fed into
 * `processVideoFile`'s attach flow as a primary/version instead of being left
 * for the dedicated `walkExtras` → `processExtra` pass. `processVideoFile`
 * carries the same guard independently (defense in depth for callers that
 * bypass triage, e.g. the watcher's `ingestSingleFile`).
 */
export async function triageFiles(
    files: string[],
    knownFiles: Map<string, KnownFileRow>,
    batchSize: number = Number.parseInt(process.env.LUMASTRA_SCAN_STAT_BATCH_SIZE ?? '200', 10) ||
        200,
    /** The library path the files are under; its own segments never mark an extra. */
    libraryRoot?: string,
    sql?: postgres.Sql,
): Promise<TriageResult> {
    const unchanged: string[] = [];
    const maybeChanged: string[] = [];
    const newFiles: string[] = [];
    const knownFileIds = new Map<string, string>();

    const knownPaths: string[] = [];
    for (const f of files) {
        if (isExtrasFilePath(f, libraryRoot)) continue;
        const cached = knownFiles.get(f);
        if (!cached || !cached.is_linked) {
            newFiles.push(f);
        } else {
            knownPaths.push(f);
        }
    }

    for (let i = 0; i < knownPaths.length; i += batchSize) {
        const batch = knownPaths.slice(i, i + batchSize);
        const results = await Promise.allSettled(
            batch.map(async (fp) => {
                const cached = knownFiles.get(fp)!;
                const fileStat = await safeStat(fp);
                const id = fileIdentityKey(fileStat);
                if (id !== null && !knownFileIds.has(id)) knownFileIds.set(id, fp);

                if (!cached.file_mtime && !cached.file_hash_head) {
                    return { path: fp, status: 'maybe-changed' as const };
                }

                const mtimeChanged =
                    !cached.file_mtime ||
                    Math.abs(fileStat.mtimeMs - cached.file_mtime.getTime()) > 1000;

                const sizeChanged =
                    cached.file_size_bytes !== null && cached.file_size_bytes !== fileStat.size;

                if (!mtimeChanged && !sizeChanged && cached.file_hash_head) {
                    return { path: fp, status: 'unchanged' as const };
                }

                return { path: fp, status: 'maybe-changed' as const };
            }),
        );

        if (sql) {
            // Reconcile after stat, including cache entries that said present.
            // Lock in one bounded batch so an uncommitted missing observation
            // cannot hide behind the cache (or a fresh MVCC snapshot).
            const present = batch.filter((_, j) => results[j].status === 'fulfilled');
            const pathsById = new Map(present.map((fp) => [knownFiles.get(fp)!.id, fp]));
            await withTx(sql, async (tx) => {
                const rows = await tx<{ id: string; is_missing: boolean }[]>`
                    SELECT id, is_missing FROM media_files
                    WHERE id = ANY(${[...pathsById.keys()]}::uuid[])
                    ORDER BY id FOR UPDATE
                `;
                for (const row of rows) {
                    if (!row.is_missing) continue;
                    const fp = pathsById.get(row.id)!;
                    if (await restoreScannedFile(tx, row.id, fp))
                        knownFiles.get(fp)!.is_missing = false;
                }
            });
        }

        for (let j = 0; j < results.length; j++) {
            const r = results[j];
            if (r.status === 'fulfilled') {
                if (r.value.status === 'unchanged') {
                    unchanged.push(r.value.path);
                } else {
                    maybeChanged.push(r.value.path);
                }
            } else {
                // stat() failed — treat as maybe-changed
                maybeChanged.push(batch[j]);
            }
        }
    }

    return { unchanged, maybeChanged, newFiles, knownFileIds };
}

export interface FileScanResult extends ScanResult {
    /** Internal causes for classification; errors[] remains the display sample. */
    errorDetails?: { path: string; err: unknown }[];
}

/** The file an item names: its `filePath` (extras, artwork, subtitles) or the item itself. */
function itemLabel(item: unknown): string {
    if (typeof item === 'object' && item !== null && 'filePath' in item) {
        return String((item as { filePath: unknown }).filePath);
    }
    return String(item);
}

export async function processItems<T>(
    items: T[],
    processor: (item: T) => Promise<ScanOutcome | 'error'>,
    result: FileScanResult,
    context: FileScannerContext,
    isAborted: () => boolean,
    onEach?: () => void,
): Promise<void> {
    for (const item of items) {
        if (isAborted()) break;
        try {
            const outcome = await processor(item);
            if (outcome !== 'error') {
                countOutcome(result, outcome);
            } else {
                // An 'error' outcome must NOT vanish from the tally — record it
                // in result.errors so a partially-broken scan shows up in run
                // history instead of being silently dropped.
                result.errors.push(`${itemLabel(item)}: processing failed`);
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            context.logger.error(
                'File scanner processing error',
                err instanceof Error ? err : new Error(msg),
            );
            result.errors.push(msg);
            (result.errorDetails ??= []).push({ path: itemLabel(item), err });
        }
        onEach?.();
    }
}

/**
 * {@link processItems} across groups: items sharing a `groupKey` run strictly
 * in their original order (so "last write wins" between two files aimed at the
 * same row stays deterministic), while up to `concurrency` groups run at once.
 * The ancillary passes used to walk thousands of files one at a time.
 */
export async function processItemsGrouped<T>(
    items: T[],
    groupKey: (item: T) => string,
    concurrency: number,
    processor: (item: T) => Promise<ScanOutcome | 'error'>,
    result: FileScanResult,
    context: FileScannerContext,
    isAborted: () => boolean,
    onEach?: () => void,
): Promise<void> {
    const groups = new Map<string, T[]>();
    for (const item of items) {
        const key = groupKey(item);
        const group = groups.get(key);
        if (group) group.push(item);
        else groups.set(key, [item]);
    }
    const queue = [...groups.values()];
    const worker = async (): Promise<void> => {
        for (let group = queue.shift(); group; group = queue.shift()) {
            if (isAborted()) return;
            await processItems(group, processor, result, context, isAborted, onEach);
        }
    };
    const width = Math.max(1, Math.min(concurrency, queue.length));
    await Promise.all(Array.from({ length: width }, worker));
}

/**
 * M2 (fix plan 6, Task 7 fix round 2): a previously-refused file
 * (`unsafe_filename` / `playlist_container_rejected`) may reuse the SAME
 * `media_files` stub row on successful re-ingest at the same path —
 * `upsertMediaFile`'s `ON CONFLICT` never touches `health_issues`, and the
 * scanner's `if (created) initFileChangeDetection(...)` guards all skip
 * re-initializing change detection for a row that already existed
 * (`created=false` on the `ON CONFLICT` branch). Without this, the stale
 * badge stays on the Ingest Map forever and the file never gets a hash, so
 * every future scan treats it as a fresh first-backfill.
 *
 * Called by both `processVideoFile` and `processExtra` once a file's probe
 * came back `ok`, so the list of refusal types it clears lives in one place.
 *
 * `existingRow` is the row this file resolved to BEFORE the current probe —
 * null for a genuinely brand-new file (nothing to clear, nothing to
 * (re-)init here; the normal new-file attach path below initializes it).
 * `!existingRow.file_hash_head` scopes the (re-)init to a row that
 * genuinely has no change-detection data yet — an already-linked file
 * falling through this same code (e.g. the multi-episode-range
 * re-processing escape in `processVideoFile`) keeps its existing hash
 * untouched.
 */
export async function clearStaleRefusalAndEnsureChangeDetection(
    sql: postgres.Sql,
    existingRow: { id: string; file_hash_head: string | null } | null,
    filePath: string,
): Promise<void> {
    await clearFileScanIssue(sql, filePath, ['unsafe_filename', 'playlist_container_rejected']);
    if (existingRow && !existingRow.file_hash_head) {
        await initFileChangeDetection(sql, existingRow.id, filePath);
    }
}
