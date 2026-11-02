// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * File Scanner Media Source.
 *
 * Wraps the file-scanner scan/fullSync/getStatus surface plus the optional
 * filesystem-watcher slots (startWatching/stopWatching/getWatcherStatus/
 * updateWatcherTargets) under the SDK's MediaSourceDefinition contract.
 *
 * Module-level state is per-process. In a multi-replica deployment each
 * replica tracks its own active scans / abort flags. Moving to Valkey TTL
 * keys (cluster-wide state) is a separate cleanup item.
 */

import type { FileScanResult } from './_helpers/file-scanner/shared.js';
import { defineMediaSource, TaskError } from '@sapd/lumastra-plugin-sdk';
import type { SyncResult, MediaSourceStatus, WatcherStatus } from '@sapd/lumastra-plugin-sdk';
// LegacyPluginContext is the typing handle for WatcherLeader's ProcessFileFn
// callback. At runtime the SDK PluginContext is passed; both share the same
// `sql` and `logger` surface the watcher uses.
import type { PluginContext as LegacyPluginContext } from '../../../../plugins/types/base-plugin.js';
import type { ProcessFileFn } from './_helpers/file-scanner/watcher.js';
import { registry } from '../../../registry.js';
import { getEnabledLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import type { LibraryPathRow } from '$lib/server/database/queries/library-paths.queries.js';
import {
    clearCleanupHold,
    getCleanupHold,
    holdConfirmsCleanup,
    recordCleanupHold,
} from '$lib/server/database/queries/library-cleanup-holds.queries.js';
import { staleCleanupGuard } from './_helpers/file-scanner/stale-cleanup-guard.js';
import {
    findRangeFilesMissingLinks,
    partitionSupersededRangeFiles,
} from './_helpers/file-scanner/multi-episode-links.js';
import {
    renameFileRowInPlace,
    resolveSameFileAliases,
    resolveSingleFileAlias,
} from './_helpers/file-scanner/same-file-aliases.js';
import { rememberSkippedAlias } from './_helpers/file-scanner/removed-file-recheck.js';
import { countLinkedMediaItems } from '$lib/server/database/queries/media-files.queries.js';
import { findFilesNeedingChapterProbe } from '$lib/server/database/queries/episode-chapters.queries.js';
import {
    setScanProgress,
    deleteScanProgress,
    getAggregateScanProgress,
    type FileScannerProgress,
} from './_helpers/file-scanner/progress-store.js';
import { WatcherLeader, type WatcherRuntimeState } from './_helpers/file-scanner/watcher.js';
import { getWatcherFlowDebouncer } from './_helpers/file-scanner/flow-debouncer.js';
import { createProcessFileForWatcher } from './_helpers/file-scanner/watcher-process-file.js';
import { processVideoFile, extractChapters } from './_helpers/file-scanner/video-processor.js';
import type {
    MetadataSearchCache,
    SeriesIdCache,
    SeriesIdentityWriteState,
    SeasonIdCache,
} from './_helpers/file-scanner/video-processor.js';
import {
    mergeCollaborationArtists,
    mergeVariousArtistsAliases,
    mergeOversizedCompilationArtists,
    rematchUnknownArtistTracks,
    linkRemixerArtists,
} from './_helpers/file-scanner/audio-processor.js';
import { repairOrphanMusicLinks } from '$lib/server/services/music/orphan-link-repair.js';
import { withAdvisoryLock } from '$lib/server/database/with-advisory-lock.js';
import {
    processExtra,
    createArtworkGroupProcessor,
    orderArtworkLastWriterFirst,
    processExternalSubtitle,
    loadSubtitleScanBatch,
    resolveArtworkTargets,
    artworkWriteKey,
} from './_helpers/file-scanner/ancillary-processors.js';
import { convergeSidecarLanguagesByPrefix } from '$lib/server/database/queries/media-item-languages.queries.js';
import {
    assertScanProducedWorkOrThrow,
    countOutcome,
    processItems,
    processItemsGrouped,
    recordWalkErrors,
    triageFiles,
} from './_helpers/file-scanner/shared.js';
import type { FileScannerContext, MetadataScanStats } from './_helpers/file-scanner/shared.js';
import {
    buildSidecarStemIndex,
    ingestSidecarLyricsForWatchedFile,
    sidecarLyricsNeedsRefresh,
    sidecarStemKey,
    type StoredLyricsState,
} from './_helpers/file-scanner/lyrics-sidecar.js';
import { getProvidersByPriority } from '$lib/server/tasks/plugin-context.js';
import {
    walkDirectoryWithResult,
    walkExtras,
    walkArtwork,
    walkSubtitles,
    checkScannerEligibility,
    MAX_WALK_ERROR_PATHS,
    isAudioFile,
    isAppleDoubleSidecar,
    MEDIA_EXTENSIONS,
    LYRICS_SIDECAR_EXTENSIONS,
    type ExtraEntry,
    type ArtworkEntry,
} from '$lib/server/utils/walk-directory.js';
import {
    deleteStaleMediaFile,
    findFilesAwaitingMatchByPrefix,
    findMovieFilesWithContentGapByPrefix,
    findTrackFilesWithUnverifiedTitleSourceByPrefix,
    findTrackFilesMissingDiscNumberByPrefix,
    getMediaFilePathsByLibraryPrefix,
    loadMediaFilesByPrefix,
    getMediaItemIdByFilePath,
    type KnownFileRow,
} from '$lib/server/database/queries/media-files.queries.js';
import {
    insertScannerRun,
    updateScannerRun,
    markAbandonedScannerRuns,
    boundScannerRunErrorSamples,
} from '$lib/server/database/queries/file-scanner-runs.queries.js';
import { assessFilePresence } from '$lib/server/utils/file-presence.js';
import { startHeartbeat } from '$lib/server/plugins/runtime/drain-backlog.js';
import {
    cleanAlbumTitle,
    resolveAlbumDir,
    splitDiscSuffix,
} from '$lib/server/utils/music-scanner-utils.js';
import {
    ARTWORK_EXTENSIONS,
    artworkTypeFromStem,
    pickFallbackAlbumPosterImageName,
} from '$lib/server/utils/media-extras.js';
import path from 'node:path';
import { isMusic } from '$lib/server/utils/media-types.js';
import { safeReaddir, safeStat, safeAccess } from '$lib/server/utils/safe-fs.js';
import type postgres from 'postgres';

export type { FileScannerProgress } from './_helpers/file-scanner/progress-store.js';

// ---------------------------------------------------------------------------
// Module-level state (matches Jellyfin plugin pattern — see I1 comment)
// ---------------------------------------------------------------------------

let _lastScanAt: Date | null = null;
let _lastFullSyncAt: Date | null = null;
let _lastError: string | null = null;
const _activeScans = new Set<string>();
const _abortRequested = new Set<string>();

const STALE_ARTWORK_BATCH_SIZE = 500;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function albumDirHasDirectArtworkCandidate(
    albumDir: string,
    context: { logger: Pick<FileScannerContext['logger'], 'debug'> },
): Promise<boolean> {
    try {
        const entries = await safeReaddir(albumDir);
        const directImages = entries
            .filter((entry) => entry.isFile())
            .filter((entry) => ARTWORK_EXTENSIONS.has(path.extname(entry.name).toLowerCase()));
        if (directImages.length === 0) return false;
        const directPosterCount = directImages.filter((entry) => {
            const ext = path.extname(entry.name);
            return artworkTypeFromStem(path.basename(entry.name, ext)) === 'poster';
        }).length;
        return (
            directPosterCount > 0 ||
            pickFallbackAlbumPosterImageName(directImages.map((entry) => entry.name)) !== null
        );
    } catch (err) {
        context.logger.debug('[FileScanner] Album artwork candidate lookup skipped', {
            albumDir,
            error: err instanceof Error ? err.message : String(err),
        });
        return false;
    }
}

export async function findFilesWithMissingMusicArtwork(
    sql: postgres.Sql,
    files: string[],
    context: { logger: Pick<FileScannerContext['logger'], 'debug'> },
): Promise<Set<string>> {
    const audioFiles = files.filter((filePath) =>
        isAudioFile(path.extname(filePath).toLowerCase()),
    );
    if (audioFiles.length === 0) return new Set();

    const missingArtworkCache = new Map<string, boolean>();
    const albumDirCandidateCache = new Map<string, boolean>();
    const staleFiles = new Set<string>();

    for (let i = 0; i < audioFiles.length; i += STALE_ARTWORK_BATCH_SIZE) {
        const batch = audioFiles.slice(i, i + STALE_ARTWORK_BATCH_SIZE);
        const rows = await sql<{ file_path: string; artwork_path: string }[]>`
            SELECT DISTINCT mf.file_path, ma.file_path AS artwork_path
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            JOIN media_items track
              ON track.id = mfi.media_item_id
             AND track.media_type = 'track'
            LEFT JOIN media_items album
              ON album.id = track.parent_id
             AND album.media_type = 'album'
            JOIN media_artwork ma
              ON ma.media_item_id IN (track.id, album.id)
             AND ma.artwork_type = 'poster'
             AND ma.source = 'local'
             AND ma.file_path IS NOT NULL
            WHERE mf.file_path = ANY(${batch})
        `;

        for (const row of rows) {
            let missing = missingArtworkCache.get(row.artwork_path);
            if (missing === undefined) {
                try {
                    const stat = await safeStat(row.artwork_path);
                    missing = !stat.isFile() || stat.size === 0;
                } catch (err) {
                    const code =
                        err && typeof err === 'object' && 'code' in err
                            ? String((err as { code?: unknown }).code)
                            : undefined;
                    missing = code === 'ENOENT' || code === 'ESTALE';
                    if (!missing) {
                        context.logger.debug(
                            '[FileScanner] Could not stat music artwork during triage',
                            {
                                artworkPath: row.artwork_path,
                                errorCode: code,
                            },
                        );
                    }
                }
                missingArtworkCache.set(row.artwork_path, missing);
            }
            if (missing) staleFiles.add(row.file_path);
        }

        const missingAlbumRows = await sql<{ file_path: string }[]>`
            SELECT DISTINCT ON (album.id) mf.file_path
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            JOIN media_items track
              ON track.id = mfi.media_item_id
             AND track.media_type = 'track'
            JOIN media_items album
              ON album.id = track.parent_id
             AND album.media_type = 'album'
            WHERE mf.file_path = ANY(${batch})
              AND NOT EXISTS (
                  SELECT 1
                  FROM media_artwork ma
                  WHERE ma.media_item_id = album.id
                    AND ma.artwork_type = 'poster'
                    AND ma.source = 'local'
              )
              AND COALESCE((album.custom_metadata->>'needs_cover_art_fetch')::boolean, false) = false
            ORDER BY album.id, mf.file_path
        `;

        for (const row of missingAlbumRows) {
            const { albumDir } = resolveAlbumDir(row.file_path);
            let hasCandidate = albumDirCandidateCache.get(albumDir);
            if (hasCandidate === undefined) {
                hasCandidate = await albumDirHasDirectArtworkCandidate(albumDir, context);
                albumDirCandidateCache.set(albumDir, hasCandidate);
            }
            if (hasCandidate) staleFiles.add(row.file_path);
        }
    }

    return staleFiles;
}

/**
 * From the set of audio files triage classified as `unchanged`, find those
 * whose lyrics sidecar (`.lrc`/`.txt`) is newly dropped, edited, or upgraded
 * (a `.lrc` now shadowing a stored `.txt`) and therefore need reprocessing so
 * the sidecar's lyrics land in `custom_metadata.lyrics`. Audio-file change
 * detection misses these because the audio file itself never changed.
 *
 * Cost is bounded: only files whose stem actually has a walk-visible sidecar
 * hit the DB, and only file-sourced rows incur a stat (to detect in-place
 * edits). Tracks with no sidecar cost nothing beyond the in-memory stem lookup.
 */
async function findTracksWithPendingSidecarLyrics(
    sql: postgres.Sql,
    unchangedAudioPaths: string[],
    sidecarStemIndex: Map<string, string[]>,
    context: FileScannerContext,
): Promise<Set<string>> {
    const promote = new Set<string>();
    if (sidecarStemIndex.size === 0) return promote;

    // Cheap in-memory filter: keep only audio files whose stem has a sidecar.
    const candidates = unchangedAudioPaths.filter(
        (filePath) =>
            isAudioFile(path.extname(filePath).toLowerCase()) &&
            sidecarStemIndex.has(sidecarStemKey(filePath)),
    );
    if (candidates.length === 0) return promote;

    const mtimeCache = new Map<string, number | null>();
    const statMtime = async (filePath: string): Promise<number | null> => {
        const cached = mtimeCache.get(filePath);
        if (cached !== undefined) return cached;
        let value: number | null;
        try {
            value = Math.floor((await safeStat(filePath)).mtimeMs);
        } catch {
            // best-effort: unstattable file → null mtime (treated as unknown, not stale).
            value = null;
        }
        mtimeCache.set(filePath, value);
        return value;
    };

    for (let i = 0; i < candidates.length; i += STALE_ARTWORK_BATCH_SIZE) {
        const batch = candidates.slice(i, i + STALE_ARTWORK_BATCH_SIZE);
        const rows = await sql<{ file_path: string; lyrics: StoredLyricsState | null }[]>`
            SELECT mf.file_path, track.custom_metadata->'lyrics' AS lyrics
            FROM media_files mf
            JOIN media_file_items mfi ON mfi.file_id = mf.id
            JOIN media_items track
              ON track.id = mfi.media_item_id
             AND track.media_type = 'track'
            WHERE mf.file_path = ANY(${batch})
        `;

        for (const row of rows) {
            const stemSidecars = sidecarStemIndex.get(sidecarStemKey(row.file_path)) ?? [];
            const lyrics = row.lyrics;
            // Only stat the previously-stored sidecar when edit-detection is
            // actually possible (already file-sourced with a recorded path);
            // every other branch decides from metadata alone.
            let storedMtime: number | null = null;
            if (lyrics?.source === 'file' && typeof lyrics.sidecarPath === 'string') {
                storedMtime = await statMtime(lyrics.sidecarPath);
            }
            if (sidecarLyricsNeedsRefresh(lyrics, stemSidecars, storedMtime)) {
                promote.add(row.file_path);
            }
        }
    }

    if (promote.size > 0) {
        context.logger.debug(
            '[FileScanner] Sidecar lyrics catch-up — reprocessing unchanged tracks',
            { count: promote.size },
        );
    }
    return promote;
}

/**
 * True for transient Postgres conflicts that are safe to retry on the
 * find-or-create scan path: deadlock_detected (40P01) and
 * serialization_failure (40001). Both abort one txn with no partial commit, so
 * re-running the (idempotent) file processing converges.
 */
function isRetryablePgConflict(err: unknown): boolean {
    const code = (err as { code?: unknown } | null | undefined)?.code;
    return code === '40P01' || code === '40001';
}

/**
 * Run a single-file processing `fn`, retrying on a transient Postgres deadlock
 * (40P01) / serialization failure (40001). Shared by the bulk scan loop AND the
 * single-file / watcher ingest path (ingestSingleFile) so that concurrent files
 * touching the same series/album parent row converge instead of one failing —
 * every write on the path is find-or-create / idempotent, so a re-run is safe.
 * `shouldAbort` short-circuits the backoff so cancellation isn't delayed.
 */
async function runWithConflictRetry<T>(
    fn: () => Promise<T>,
    opts?: {
        shouldAbort?: () => boolean;
        onRetry?: (attempt: number, code: string | undefined) => void;
    },
): Promise<T> {
    const MAX_ATTEMPTS = 4;
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (
                attempt < MAX_ATTEMPTS &&
                isRetryablePgConflict(err) &&
                !(opts?.shouldAbort?.() ?? false)
            ) {
                opts?.onRetry?.(attempt, (err as { code?: string }).code);
                await new Promise((r) =>
                    setTimeout(r, 20 * attempt + Math.floor(Math.random() * 30)),
                );
                continue;
            }
            throw err;
        }
    }
}

async function performScan(
    libraryPathId: string | undefined,
    scanContext: FileScannerContext,
    scanKey: string = libraryPathId ?? 'all',
): Promise<FileScanResult> {
    // Per-scan metadata-availability tally (S5) — a fresh object per scan so
    // concurrent scans sharing a caller context never mix counts.
    const metadataStats: MetadataScanStats = { unavailable: 0 };
    const context: FileScannerContext = { ...scanContext, metadataStats };
    const start = Date.now();
    const startedAt = new Date();
    const result: FileScanResult = {
        added: 0,
        updated: 0,
        removed: 0,
        unmatched: 0,
        skipped: 0,
        durationMs: 0,
        errors: [],
    };

    const sql = context.sql;
    const allPaths = await getEnabledLibraryPaths(sql);
    const targets = libraryPathId ? allPaths.filter((p) => p.id === libraryPathId) : allPaths;

    if (targets.length === 0) {
        context.logger.debug('File scanner: no enabled library paths');
        result.durationMs = Date.now() - start;
        return result;
    }

    try {
        const abandoned = await markAbandonedScannerRuns(sql, libraryPathId ?? null);
        if (abandoned > 0) {
            context.logger.info('[FileScanner] Marked abandoned scanner runs', {
                count: abandoned,
            });
        }
    } catch (err) {
        context.logger.warn('[FileScanner] Failed to mark abandoned runs', {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    let scanRunId: string | undefined;
    const insertRunAttempt = async (attempt: number): Promise<string> => {
        try {
            return await insertScannerRun(sql, {
                libraryPathId,
                startedAt,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (attempt === 0) {
                context.logger.warn('[FileScanner] insertScannerRun failed — retrying once', {
                    error: message,
                });
                return insertRunAttempt(1);
            }
            context.logger.error(
                '[FileScanner] scan registration failed — refusing to scan without a retention fence',
                err instanceof Error ? err : new Error(message),
            );
            context.logger.warn('[FileScanner] failed scan registration', {
                libraryPathId: libraryPathId ?? null,
                scanKey,
                startedAt: startedAt.toISOString(),
            });
            throw err;
        }
    };
    scanRunId = await insertRunAttempt(0);

    const providerIds = getProvidersByPriority().map((p) => p.id);

    const pathFiles: Array<{
        libraryPath: (typeof targets)[number];
        files: string[];
        lyricsSidecars: string[];
        walkHadErrors: boolean;
        walkErrorPaths: string[];
        /** Extras / artwork / subtitle lists, walked alongside the main walk. */
        ancillary: Promise<[ExtraEntry[], ArtworkEntry[], string[]]>;
    }> = [];

    // Walk phase — surface a climbing "Discovering files…" count so the admin
    // UI shows progress instead of "0 / ?" while the walk runs silently.
    const discoverProgress: FileScannerProgress = {
        totalFiles: 0,
        processedFiles: 0,
        currentFile: '',
        currentLibraryPath: '',
        added: 0,
        updated: 0,
        skipped: 0,
        unmatched: 0,
        errors: 0,
        phase: 'discovering',
    };
    await setScanProgress(scanKey, discoverProgress);
    const onProgress = context.onProgress;
    onProgress?.(0, 0, { phase: 'discovering' });

    const [{ now: walkStartedAt }] = await sql<[{ now: Date }]>`SELECT NOW() AS now`;

    let totalFiles = 0;
    for (const libraryPath of targets) {
        discoverProgress.currentLibraryPath = libraryPath.path;
        await setScanProgress(scanKey, discoverProgress);

        // The ancillary walks start NOW, beside the main walk, so the progress
        // total is complete before the first processed count is published.
        // Adding their files only when the ancillary pass began made the bar
        // race to ~100% (triage marks every unchanged file done in one write)
        // and then fall back as the total grew.
        const ancillary = Promise.all([
            walkExtras(libraryPath.path),
            walkArtwork(libraryPath.path),
            walkSubtitles(libraryPath.path),
        ]);
        const walk = await walkDirectoryWithResult(libraryPath.path, (filesFound) => {
            discoverProgress.totalFiles = totalFiles + filesFound;
            void setScanProgress(scanKey, discoverProgress);
            onProgress?.(0, discoverProgress.totalFiles, { phase: 'discovering' });
        });
        pathFiles.push({
            libraryPath,
            files: walk.files,
            lyricsSidecars: walk.lyricsSidecars,
            walkHadErrors: walk.hadErrors,
            walkErrorPaths: walk.errorPaths,
            ancillary,
        });
        totalFiles += walk.files.length;
        // Align the running total after the walk completes — the throttled
        // callback fires every 250 files so the last partial batch may be
        // missing without this update.
        discoverProgress.totalFiles = totalFiles;
        if (walk.hadErrors) {
            context.logger.warn(
                `File scanner: walk of ${libraryPath.path} had readdir/stat errors — stale cleanup will be skipped for this path`,
                { errorPathSample: walk.errorPaths.slice(0, 5) },
            );
            recordWalkErrors(result, libraryPath.path, walk.errorPaths);
        }
        context.logger.info(`File scanner: ${walk.files.length} files in ${libraryPath.path}`);
    }

    // Media files plus every extra/artwork/subtitle file the ancillary pass
    // will process: the whole scan's denominator, fixed from the start.
    // An abort skips the ancillary pass, so don't wait on its walks just to
    // count them (they swallow their own errors and are simply dropped).
    let ancillaryTotal = 0;
    for (const { ancillary } of pathFiles) {
        if (_abortRequested.has(scanKey)) break;
        const [extras, artwork, subtitles] = await ancillary;
        ancillaryTotal += extras.length + artwork.length + subtitles.length;
    }

    const progress: FileScannerProgress = {
        totalFiles: totalFiles + ancillaryTotal,
        processedFiles: 0,
        currentFile: '',
        currentLibraryPath: '',
        added: 0,
        updated: 0,
        skipped: 0,
        unmatched: 0,
        errors: 0,
        phase: 'scanning',
    };
    await setScanProgress(scanKey, progress);

    onProgress?.(0, progress.totalFiles, { phase: 'scanning' });

    const heartbeat = startHeartbeat({
        onProgress,
        logger: context.logger,
        getTotal: () => progress.totalFiles,
        getProcessed: () => progress.processedFiles,
        getStatus: () => {
            const base = progress.currentFile
                ? `Scanning ${progress.currentFile}`
                : 'Scanning files';
            return `${base} (${progress.added} added, ${progress.updated} updated, ${progress.errors} errors)`;
        },
        phase: 'Scanning files',
        intervalMs: 60_000,
    });

    const abortController = new AbortController();
    const externalAbort = context.abortSignal;
    const externalListener = (): void => abortController.abort();
    if (externalAbort?.aborted) {
        abortController.abort();
    } else {
        externalAbort?.addEventListener('abort', externalListener, {
            once: true,
        });
    }
    const signalAbort = (): void => {
        if (!abortController.signal.aborted) abortController.abort();
    };

    // S3: Cache the DB-known file paths per library path so stale cleanup
    // can reuse them instead of issuing a second LIKE scan per path.
    // Populated below as each path's knownFiles is loaded.
    const knownPathsByLibraryPath = new Map<string, string[]>();

    try {
        for (const { libraryPath, files, lyricsSidecars, ancillary } of pathFiles) {
            if (_abortRequested.has(scanKey)) break;
            progress.currentLibraryPath = libraryPath.path;
            await setScanProgress(scanKey, progress);

            let knownFiles: Map<string, KnownFileRow> | undefined;
            try {
                knownFiles = await loadMediaFilesByPrefix(sql, libraryPath.path);
                // Cache the key set for stale cleanup (S3).
                if (knownFiles) {
                    knownPathsByLibraryPath.set(libraryPath.path, [...knownFiles.keys()]);
                }
            } catch (err) {
                context.logger.warn(
                    '[FileScanner] Failed to preload file cache, falling back to per-file queries',
                    {
                        libraryPath: libraryPath.path,
                        error: err instanceof Error ? err.message : String(err),
                    },
                );
            }

            let filesToProcess: string[];
            if (knownFiles && knownFiles.size > 0) {
                const triage = await triageFiles(
                    files,
                    knownFiles,
                    undefined,
                    libraryPath.path,
                    sql,
                );
                const walkedSet = new Set(files);
                // A multi-episode file whose every episode has a file of its own
                // has an unlinked stub row, so triage calls it new. Skip it while
                // it and its covering files are unchanged.
                let supersededRange: string[] = [];
                if (triage.newFiles.length > 0 && !isMusic(libraryPath.media_type)) {
                    const split = await partitionSupersededRangeFiles(
                        triage.newFiles,
                        knownFiles,
                        walkedSet,
                        sql,
                        abortController.signal,
                    );
                    supersededRange = split.superseded;
                    const chapterCatchup = libraryPath.scan_chapters
                        ? await findFilesNeedingChapterProbe(sql, split.superseded)
                        : new Set<string>();
                    // Physical chapters belong to the file even when dedicated
                    // neighbours cover every episode and identity stays unlinked.
                    for (const path of chapterCatchup) {
                        const cancelled = (): boolean =>
                            _abortRequested.has(scanKey) || abortController.signal.aborted;
                        if (cancelled()) break;
                        await extractChapters(
                            sql,
                            path,
                            { ...context, abortSignal: abortController.signal },
                            knownFiles.get(path)?.id,
                            cancelled,
                        );
                    }
                    triage.newFiles = split.process;
                    result.skipped += supersededRange.length;
                    progress.processedFiles += supersededRange.length;
                }
                // A new path that is another name for a file the library has: a
                // case-only rename on a case-insensitive share (rename the row),
                // or a hard link / symlink (skip it).
                if (triage.newFiles.length > 0) {
                    const aliases = await resolveSameFileAliases({
                        newFiles: triage.newFiles,
                        knownFileIds: triage.knownFileIds,
                        knownNotWalked: [...knownFiles.keys()].filter((k) => !walkedSet.has(k)),
                        isAborted: () => _abortRequested.has(scanKey),
                    });
                    for (const { from, to } of aliases.caseRenames) {
                        const known = knownFiles.get(from);
                        let renamed = false;
                        try {
                            renamed = !!known && (await renameFileRowInPlace(sql, from, to));
                        } catch (err) {
                            context.logger.warn(
                                '[FileScanner] Case-only rename failed; ingesting the new name',
                                {
                                    from,
                                    to,
                                    error: err instanceof Error ? err.message : String(err),
                                },
                            );
                        }
                        if (renamed && known) {
                            knownFiles.delete(from);
                            knownFiles.set(to, known);
                            context.logger.info(
                                '[FileScanner] Case-only rename: kept the file row',
                                {
                                    from,
                                    to,
                                },
                            );
                        } else {
                            aliases.process.push(to);
                        }
                    }
                    if (aliases.caseRenames.length > 0) {
                        knownPathsByLibraryPath.set(libraryPath.path, [...knownFiles.keys()]);
                    }
                    if (aliases.skipped.length > 0) {
                        context.logger.info(
                            '[FileScanner] Skipped files that are another name (hard link / symlink) for a file the library has',
                            {
                                libraryPath: libraryPath.path,
                                count: aliases.skipped.length,
                                sample: aliases.skipped.slice(0, 3),
                            },
                        );
                    }
                    // Skipped aliases and renamed rows need no processing.
                    const aliasSkips = triage.newFiles.length - aliases.process.length;
                    result.skipped += aliasSkips;
                    progress.processedFiles += aliasSkips;
                    triage.newFiles = aliases.process;
                }
                let staleArtworkFiles = new Set<string>();
                try {
                    staleArtworkFiles = await findFilesWithMissingMusicArtwork(
                        sql,
                        triage.unchanged,
                        context,
                    );
                } catch (err) {
                    context.logger.warn('[FileScanner] Stale music artwork triage skipped', {
                        libraryPath: libraryPath.path,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }
                // Single prefix-filtered query returns the (usually empty)
                // awaiting-match set without chunking — see S7 in the plan.
                // Benefits from the text_pattern_ops index (migration 16.56.0).
                const awaitingRematch = new Set<string>(
                    await findFilesAwaitingMatchByPrefix(sql, libraryPath.path),
                );

                // Promote provider-less local movies that still have a fillable
                // content gap (NULL overview/year, no tmdb/imdb id) out of the
                // unchanged-skip set, so processVideoFile's NFO re-scan heal runs
                // on them. Small by nature (matched movies carry an overview), so
                // this stays a handful of files per scan.
                let contentGapFiles = new Set<string>();
                try {
                    contentGapFiles = new Set<string>(
                        await findMovieFilesWithContentGapByPrefix(sql, libraryPath.path),
                    );
                } catch (err) {
                    context.logger.warn('[FileScanner] Content-gap triage skipped', {
                        libraryPath: libraryPath.path,
                        error: err instanceof Error ? err.message : String(err),
                    });
                }

                // Promote unchanged tracks whose lyrics sidecar was newly
                // dropped/edited so the existing backfill in processAudioFile
                // re-reads it. Audio-file change detection can't see sidecars.
                let pendingLyrics = new Set<string>();
                if (lyricsSidecars.length > 0) {
                    try {
                        pendingLyrics = await findTracksWithPendingSidecarLyrics(
                            sql,
                            triage.unchanged,
                            buildSidecarStemIndex(lyricsSidecars),
                            context,
                        );
                    } catch (err) {
                        context.logger.warn('[FileScanner] Sidecar lyrics triage skipped', {
                            libraryPath: libraryPath.path,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }

                // Promote unchanged multi-episode files linked to fewer episodes
                // than their name claims: the link heal in processVideoFile only
                // runs for files the scan processes.
                let rangeGapFiles = new Set<string>();
                if (!isMusic(libraryPath.media_type)) {
                    try {
                        rangeGapFiles = await findRangeFilesMissingLinks(sql, triage.unchanged);
                    } catch (err) {
                        context.logger.warn('[FileScanner] Multi-episode link triage skipped', {
                            libraryPath: libraryPath.path,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }

                // The audio processor already repairs title provenance from
                // real tag evidence, but unchanged triage would bypass it. Only
                // promote walked, unchanged music files until verification is
                // durable; failures remain eligible for the next normal scan.
                let unverifiedTitleFiles = new Set<string>();
                if (isMusic(libraryPath.media_type)) {
                    try {
                        const candidates = new Set(
                            await findTrackFilesWithUnverifiedTitleSourceByPrefix(
                                sql,
                                libraryPath.path,
                            ),
                        );
                        unverifiedTitleFiles = new Set(
                            triage.unchanged.filter((filePath) => candidates.has(filePath)),
                        );
                    } catch (err) {
                        context.logger.warn('[FileScanner] Title provenance triage skipped', {
                            libraryPath: libraryPath.path,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }

                // The per-track backfill cannot run behind unchanged triage.
                // Promote only fillable disc gaps, using stored tags/folder names
                // without probing the library. The processor re-reads candidates
                // to preserve tag -> folder -> suffix precedence and lock guards.
                let discGapFiles = new Set<string>();
                if (isMusic(libraryPath.media_type) && triage.unchanged.length > 0) {
                    try {
                        const candidates = new Set(
                            (await findTrackFilesMissingDiscNumberByPrefix(sql, libraryPath.path))
                                .filter(
                                    (row) =>
                                        resolveAlbumDir(row.file_path).discNumber !== null ||
                                        splitDiscSuffix(cleanAlbumTitle(row.album ?? '')).disc !==
                                            null,
                                )
                                .map((row) => row.file_path),
                        );
                        discGapFiles = new Set(
                            triage.unchanged.filter((filePath) => candidates.has(filePath)),
                        );
                    } catch (err) {
                        context.logger.warn('[FileScanner] Disc number triage skipped', {
                            libraryPath: libraryPath.path,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }

                const chapterGapFiles =
                    libraryPath.scan_chapters && !isMusic(libraryPath.media_type)
                        ? await findFilesNeedingChapterProbe(sql, triage.unchanged)
                        : new Set<string>();

                const unchangedToSkip = triage.unchanged.filter(
                    (filePath) =>
                        !staleArtworkFiles.has(filePath) &&
                        !awaitingRematch.has(filePath) &&
                        !pendingLyrics.has(filePath) &&
                        !contentGapFiles.has(filePath) &&
                        !rangeGapFiles.has(filePath) &&
                        !chapterGapFiles.has(filePath) &&
                        !unverifiedTitleFiles.has(filePath) &&
                        !discGapFiles.has(filePath),
                );

                result.skipped += unchangedToSkip.length;
                progress.processedFiles += unchangedToSkip.length;
                progress.skipped = result.skipped;
                await setScanProgress(scanKey, progress);
                // Dedupe all promotion reasons: a file may need several repairs.
                filesToProcess = [
                    ...new Set([
                        ...staleArtworkFiles,
                        ...awaitingRematch,
                        ...pendingLyrics,
                        ...contentGapFiles,
                        ...rangeGapFiles,
                        ...chapterGapFiles,
                        ...unverifiedTitleFiles,
                        ...discGapFiles,
                        ...triage.maybeChanged,
                        ...triage.newFiles,
                    ]),
                ];

                context.logger.info(
                    `File scanner: triage — ${unchangedToSkip.length} unchanged, ` +
                        `${staleArtworkFiles.size} stale-artwork, ${awaitingRematch.size} awaiting-rematch, ` +
                        `${pendingLyrics.size} pending-lyrics, ${contentGapFiles.size} content-gap, ` +
                        `${rangeGapFiles.size} multi-episode-gap, ${unverifiedTitleFiles.size} title-provenance, ` +
                        `${discGapFiles.size} disc-gap, ` +
                        `${supersededRange.length} superseded-range, ` +
                        `${triage.maybeChanged.length} maybe-changed, ${triage.newFiles.length} new`,
                );
            } else {
                // First scan of the path: two names for one file are still one.
                const aliases = await resolveSameFileAliases({
                    newFiles: files,
                    knownFileIds: new Map(),
                    knownNotWalked: [],
                    isAborted: () => _abortRequested.has(scanKey),
                });
                if (aliases.skipped.length > 0) {
                    context.logger.info(
                        '[FileScanner] Skipped files that are another name (hard link / symlink) for another file of the scan',
                        {
                            libraryPath: libraryPath.path,
                            count: aliases.skipped.length,
                            sample: aliases.skipped.slice(0, 3),
                        },
                    );
                }
                result.skipped += aliases.skipped.length;
                progress.processedFiles += aliases.skipped.length;
                filesToProcess = aliases.process;
            }

            // Bounded concurrency: process up to SCAN_CONCURRENCY files in
            // parallel. Default 8, overridable via LUMASTRA_SCAN_CONCURRENCY.
            // Operators on slow NFS should lower this; operators with NVMe
            // and a larger DB pool can raise it. Keep <= DB pool size - buffer
            // (postgres.js default pool = 10, so 8 leaves 2 for other queries).
            // JS is single-threaded at the microtask level, so counter
            // increments below are race-free (no two awaits run concurrently).
            const SCAN_CONCURRENCY = Math.max(
                1,
                Number.parseInt(process.env.LUMASTRA_SCAN_CONCURRENCY ?? '8', 10) || 8,
            );

            // One TMDB/provider search cache per library path (cleared between
            // paths). Maps "${providerId}:${type}:${title}:${year}" to a
            // positive hit or null (definitive miss). Collapses repeated
            // identical searches (e.g. all episodes of a series) to one call.
            const searchCache: MetadataSearchCache = new Map();

            // S5: Series and season ID caches — one per library path, cleared
            // between paths. Collapses the advisory-lock + findOrCreate round-
            // trip for every episode after the first one in a season/series.
            // Series keys serialize lowercased title, series media type, year,
            // candidate namespace and sorted supported cross-provider evidence.
            // Season keys remain "${seriesId}:${seasonNumber}". Populated only
            // from the function return value (miss still fires the lock).
            const seriesIdCache: SeriesIdCache = new Map();
            const seasonIdCache: SeasonIdCache = new Map();

            // Per-library announcements coalesce by UUID. Identity enrichment
            // serializes per UUID and deduplicates successful individual mappings,
            // allowing stronger evidence and failed writes to be retried.
            const seriesSideEffectsDone = new Set<string>();
            const seriesIdentityWrites: SeriesIdentityWriteState = {
                completed: new Set(),
                pending: new Map(),
            };

            // S6: Check once per path whether any dismissed content exists.
            // On a fresh install or a library with no dismissed items this is
            // false → tryReclaimByHash is skipped for every new file, saving
            // ~25 GB of 64KB head reads at 400k new files.
            let hasReclaimCandidates = true;
            try {
                const [reclaimRow] = await sql<[{ exists: boolean }?]>`
                    SELECT EXISTS(
                        SELECT 1 FROM media_items
                        WHERE (is_dismissed = true OR status = 'deleted')
                          AND (dismissed_at > NOW() - INTERVAL '30 days'
                               OR processing_state->>'hash-reclaim-deferred' = dismissed_content_hash
                               OR processing_state #>> '{hash-reclaim-deferred,hash}' = dismissed_content_hash)
                          AND dismissed_content_hash IS NOT NULL
                          AND processing_state->>'hash-reclaim-refused' IS DISTINCT FROM dismissed_content_hash
                    ) AS exists
                `;
                hasReclaimCandidates = reclaimRow?.exists ?? true;
            } catch {
                // Non-fatal: conservative default keeps reclaim logic active.
                hasReclaimCandidates = true;
            }

            // Inline semaphore — tracks the number of concurrently running
            // processVideoFile calls. Each slot acquire/releases atomically
            // around the async work; JS event-loop ordering guarantees no
            // two awaits are in-flight on the same microtask.
            let inFlight = 0;
            const waiters: Array<() => void> = [];
            const acquireSlot = (): Promise<void> => {
                if (inFlight < SCAN_CONCURRENCY) {
                    inFlight++;
                    return Promise.resolve();
                }
                return new Promise<void>((resolve) => {
                    waiters.push(resolve);
                });
            };
            const releaseSlot = (): void => {
                const next = waiters.shift();
                if (next) {
                    // Hand the slot directly to the next waiter; inFlight unchanged.
                    next();
                } else {
                    inFlight--;
                }
            };

            const filePromises: Array<Promise<void>> = [];

            for (const filePath of filesToProcess) {
                if (_abortRequested.has(scanKey)) {
                    signalAbort();
                    break;
                }

                await acquireSlot();

                if (_abortRequested.has(scanKey)) {
                    releaseSlot();
                    signalAbort();
                    break;
                }

                const fileTask = (async (): Promise<void> => {
                    try {
                        // Under a bulk scan, concurrent episodes of the same
                        // series briefly contend on the shared series row
                        // (library_added_at bump, identity-stage invalidation)
                        // and Postgres aborts one side with a deadlock. The
                        // redundant per-series side effects are already coalesced
                        // (seriesSideEffectsDone), so genuine contention is rare;
                        // runWithConflictRetry retries the (idempotent) file so
                        // it converges instead of failing.
                        // processVideoFile already knows a specific, human
                        // reason for every 'error' it returns (mangled
                        // filename, ffprobe failure, permission denied, ...)
                        // — it logs that reason right beside the return, but
                        // until now never handed it back, so every failure
                        // collapsed into the same generic "file processing
                        // failed" string in the run's error_samples. Capture
                        // it via the optional callback instead. A retry
                        // re-invokes processVideoFile; the reason is cleared
                        // per attempt so a reason-less failure never inherits
                        // an earlier attempt's text.
                        let failureReason: string | undefined;
                        const outcome = await runWithConflictRetry(
                            () => {
                                failureReason = undefined;
                                return processVideoFile(
                                    sql,
                                    filePath,
                                    libraryPath,
                                    providerIds,
                                    context,
                                    knownFiles,
                                    abortController.signal,
                                    searchCache,
                                    hasReclaimCandidates,
                                    seriesIdCache,
                                    seasonIdCache,
                                    seriesSideEffectsDone,
                                    (reason) => {
                                        failureReason = reason;
                                    },
                                    seriesIdentityWrites,
                                );
                            },
                            {
                                shouldAbort: () =>
                                    abortController.signal.aborted || _abortRequested.has(scanKey),
                                onRetry: (attempt, code) =>
                                    context.logger.debug(
                                        'File scanner: retrying file after transient DB conflict',
                                        { filePath, attempt, code },
                                    ),
                            },
                        );
                        if (outcome !== 'error') {
                            countOutcome(result, outcome);
                        } else {
                            // An 'error' outcome (e.g. a stat/hash I/O failure)
                            // must NOT vanish from the run tally. Record it in
                            // result.errors so a partially-broken scan shows up
                            // in run history instead of looking clean.
                            result.errors.push(
                                `${filePath}: ${failureReason ?? 'file processing failed'}`,
                            );
                        }
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        context.logger.error(
                            `File scanner error processing: ${filePath}`,
                            err instanceof Error ? err : new Error(msg),
                        );
                        result.errors.push(`${filePath}: ${msg}`);
                        (result.errorDetails ??= []).push({ path: filePath, err });
                    } finally {
                        releaseSlot();
                    }

                    // Progress update — runs after releaseSlot to keep the
                    // update outside the "slot held" window, keeping the slot
                    // available for the next file while we write to Valkey.
                    progress.processedFiles++;
                    progress.currentFile = path.basename(filePath);
                    progress.added = result.added;
                    progress.updated = result.updated;
                    progress.skipped = result.skipped;
                    progress.unmatched = result.unmatched;
                    progress.errors = result.errors.length;

                    if (
                        progress.processedFiles % 10 === 0 ||
                        progress.processedFiles === totalFiles
                    ) {
                        await setScanProgress(scanKey, progress);
                        onProgress?.(progress.processedFiles, progress.totalFiles, {
                            currentItem: progress.currentFile,
                            phase: 'scanning',
                        });
                    }
                })();

                filePromises.push(fileTask);
            }

            // Drain: wait for all in-flight tasks to complete before moving to
            // the ancillary pass or the next library path.
            await Promise.allSettled(filePromises);

            if (!_abortRequested.has(scanKey)) {
                const [extras, artworkFiles, subtitleFiles] = await ancillary;

                context.logger.info(
                    `File scanner: ${extras.length} extras, ${artworkFiles.length} artwork, ${subtitleFiles.length} subtitles in ${libraryPath.path}`,
                );

                onProgress?.(progress.processedFiles, progress.totalFiles, {
                    phase: 'ancillary',
                });
                // Publish the grown total, and keep publishing through the pass:
                // the admin page reads per-library progress (and derives its ETA)
                // from this key, and a key left at processed == total reads as
                // finished and drops out of the status list.
                await setScanProgress(scanKey, progress);
                const countAncillary = (): void => {
                    progress.processedFiles++;
                    if (progress.processedFiles % 25 === 0) {
                        void setScanProgress(scanKey, progress).catch(() => {
                            /* best-effort: display only */
                        });
                        // The run's own progress too — the app-wide manual-run
                        // tracker reads it from the run, not the scan key.
                        onProgress?.(progress.processedFiles, progress.totalFiles, {
                            phase: 'ancillary',
                        });
                    }
                };

                const isAborted = () => _abortRequested.has(scanKey);
                const ARTWORK_WIDTH = 3;
                // Bulk preload for the sidecar pass. On failure fall back to the
                // per-sidecar path (upsert + projection refresh each) — slow but
                // self-contained, so a preload error never fails the scan.
                const subtitleBatch = await loadSubtitleScanBatch(sql, libraryPath.path).catch(
                    (err: unknown) => {
                        context.logger.warn(
                            'File scanner: sidecar preload failed — per-file path',
                            {
                                libraryPath: libraryPath.path,
                                error: err instanceof Error ? err.message : String(err),
                            },
                        );
                        return undefined;
                    },
                );

                await Promise.all([
                    processItems(
                        extras,
                        (e) => processExtra(sql, e, context, abortController.signal),
                        result,
                        context,
                        isAborted,
                        countAncillary,
                    ),
                    // Rows are written in walk order per (item, artwork type) —
                    // what the serial pass produced — while distinct rows go in
                    // parallel. Width 3: the task pool is 7 connections for every
                    // task in the process, and the sidecar and extras passes run
                    // alongside this one.
                    // Targets first (once per folder), inside this branch so the
                    // extras and sidecar passes are not held up by it.
                    (async () => {
                        const artworkTargets = await resolveArtworkTargets(
                            sql,
                            artworkFiles,
                            ARTWORK_WIDTH,
                            isAborted,
                        );
                        // Each write group runs last-writer-first and stops at
                        // the file that owns the row, so a row several files
                        // aim at is written once, not flipped A→B every scan
                        // (see createArtworkGroupProcessor).
                        await processItemsGrouped(
                            orderArtworkLastWriterFirst(artworkFiles, artworkTargets),
                            (e) => artworkWriteKey(e, artworkTargets),
                            ARTWORK_WIDTH,
                            createArtworkGroupProcessor(
                                sql,
                                context,
                                artworkTargets,
                                libraryPath.path,
                            ),
                            result,
                            context,
                            isAborted,
                            countAncillary,
                        );
                    })(),
                    processItems(
                        subtitleFiles,
                        (s) => processExternalSubtitle(sql, s, context, subtitleBatch),
                        result,
                        context,
                        isAborted,
                        countAncillary,
                    ),
                ]);

                // Runs even after an abort: sidecars upserted before it must not
                // leave their items' language projection behind.
                if (subtitleBatch) {
                    try {
                        const converged = await convergeSidecarLanguagesByPrefix(
                            sql,
                            libraryPath.path,
                            [...subtitleBatch.orphanedFileIds],
                        );
                        context.logger.debug(
                            'File scanner: sidecar language projection converged',
                            {
                                libraryPath: libraryPath.path,
                                ...converged,
                            },
                        );
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        result.errors.push(`sidecar language refresh: ${msg}`);
                        context.logger.warn('File scanner: sidecar language refresh failed', {
                            libraryPath: libraryPath.path,
                            error: msg,
                        });
                    }
                }
            }
        }
    } finally {
        heartbeat.clear();
        if (externalAbort) {
            externalAbort.removeEventListener('abort', externalListener);
        }
    }

    if (_abortRequested.has(scanKey)) {
        context.logger.info('File scanner: scan aborted by user');
        result.errors.push('Scan aborted by user');
    }

    if (!_abortRequested.has(scanKey)) {
        for (const {
            libraryPath,
            files: walkedFiles,
            walkHadErrors,
            walkErrorPaths,
        } of pathFiles) {
            if (_abortRequested.has(scanKey)) break;

            // A walk error (a dangling symlink, an unreadable folder) protects
            // only the rows at or under the path that failed: what it hides may
            // be offline, not deleted. It used to stop stale cleanup for the
            // whole library, on every scan, while one such entry existed.
            // Too many errors to list (the walk keeps MAX_WALK_ERROR_PATHS)
            // still refuse the whole cleanup.
            if (walkHadErrors && walkErrorPaths.length >= MAX_WALK_ERROR_PATHS) {
                context.logger.warn(
                    '[FileScanner] Refusing stale cleanup — walk had readdir/stat errors',
                    {
                        libraryPath: libraryPath.path,
                        errorPathSample: walkErrorPaths.slice(0, 5),
                        errorPathCount: walkErrorPaths.length,
                    },
                );
                continue;
            }
            const underWalkError = (p: string): boolean =>
                walkErrorPaths.some((e) => p === e || p.startsWith(`${e.replace(/\/+$/, '')}/`));

            try {
                try {
                    await safeAccess(libraryPath.path);
                } catch {
                    context.logger.debug(
                        '[FileScanner] Skipping stale cleanup — library path not accessible from this process',
                        { libraryPath: libraryPath.path },
                    );
                    continue;
                }

                // S3: Reuse the knownFiles keys loaded at scan time instead
                // of a second LIKE query. Falls back to getMediaFilePathsByLibraryPrefix
                // when the bulk load failed (knownFiles was undefined).
                const knownPaths =
                    knownPathsByLibraryPath.get(libraryPath.path) ??
                    (await getMediaFilePathsByLibraryPrefix(sql, libraryPath.path));

                // Guards against an offline or half-mounted share: a walk that
                // finds under 20 % of the known files, or none, removes nothing.
                // The refusal is recorded (health finding + library scan check)
                // so it no longer lasts silently forever; an admin who confirms
                // that the files really are gone lets this scan remove them.
                const guard = staleCleanupGuard(walkedFiles.length, knownPaths.length);
                if (guard) {
                    const hold = await getCleanupHold(sql, libraryPath.id).catch(() => null);
                    const confirmed = holdConfirmsCleanup(hold, {
                        reason: guard,
                        walked: walkedFiles.length,
                        known: knownPaths.length,
                    });
                    if (!confirmed) {
                        context.logger.warn(
                            guard === 'no_files'
                                ? '[FileScanner] Refusing stale cleanup — walk returned zero files but DB has entries'
                                : '[FileScanner] Refusing stale cleanup — walk returned far fewer files than DB',
                            {
                                libraryPath: libraryPath.path,
                                walked: walkedFiles.length,
                                known: knownPaths.length,
                            },
                        );
                        await recordCleanupHold(sql, {
                            libraryPathId: libraryPath.id,
                            reason: guard,
                            walked: walkedFiles.length,
                            known: knownPaths.length,
                        }).catch((err: unknown) => {
                            context.logger.warn('[FileScanner] Could not record the cleanup hold', {
                                libraryPath: libraryPath.path,
                                error: err instanceof Error ? err.message : String(err),
                            });
                        });
                        continue;
                    }
                    context.logger.info(
                        '[FileScanner] Stale cleanup confirmed by an admin — removing missing files',
                        {
                            libraryPath: libraryPath.path,
                            walked: walkedFiles.length,
                            known: knownPaths.length,
                            confirmedBy: hold?.confirmed_by,
                        },
                    );
                }

                // S2: Set-difference — skip assessFilePresence() on paths that
                // are in the walked set. A path present in walkedFiles was just
                // seen on disk; it cannot be stale. Only check paths absent from
                // the walk (i.e. DB knows the file but the walk didn't find it).
                // This turns 400k access() syscalls → 0 at 0 deletions, which is
                // the common steady-state case. The walkHadErrors guard (above)
                // already suppresses cleanup on incomplete walks.
                const walkedSet = new Set(walkedFiles);
                const missingPaths = knownPaths.filter(
                    (p) => !walkedSet.has(p) && !underWalkError(p),
                );

                const BATCH_SIZE = 100;
                const CONCURRENCY = 10;
                let deletedSoFar = 0;
                for (let i = 0; i < missingPaths.length; i += BATCH_SIZE) {
                    if (_abortRequested.has(scanKey)) {
                        context.logger.info('[FileScanner] Stale cleanup aborted mid-loop', {
                            libraryPath: libraryPath.path,
                            deletedSoFar,
                            remaining: missingPaths.length - i,
                        });
                        break;
                    }
                    const batch = missingPaths.slice(i, i + BATCH_SIZE);
                    // Process the batch with bounded concurrency (10 parallel
                    // stat+DELETE calls) to avoid saturating NFS on large
                    // libraries.
                    //
                    // Each per-file delete runs in its own transaction inside
                    // deleteStaleMediaFile(). We wrap each call in a try/catch
                    // so a single failure (FK violation, transient Valkey blip,
                    // OOM during sibling promotion, etc.) does not poison the
                    // remaining files in the sub-batch — Promise.all rejects on
                    // first failure, which would otherwise abort the outer
                    // library loop.
                    for (let j = 0; j < batch.length; j += CONCURRENCY) {
                        if (_abortRequested.has(scanKey)) break;
                        const subBatch = batch.slice(j, j + CONCURRENCY);
                        await Promise.all(
                            subBatch.map(async (fp) => {
                                if (_abortRequested.has(scanKey)) return;
                                const presence = await assessFilePresence(fp, {
                                    mountRoot: libraryPath.path,
                                });
                                if (presence === 'present') return;
                                if (presence === 'transient') {
                                    context.logger.warn(
                                        '[FileScanner] Skipping delete — file missing but parent also missing (mount likely offline)',
                                        { filePath: fp },
                                    );
                                    return;
                                }
                                context.logger.info(
                                    '[FileScanner] Removing stale media_files entry',
                                    { filePath: fp },
                                );
                                try {
                                    const { deleted } = await deleteStaleMediaFile(
                                        sql,
                                        fp,
                                        walkStartedAt,
                                    );
                                    if (deleted) {
                                        result.removed++;
                                        deletedSoFar++;
                                    }
                                } catch (err) {
                                    context.logger.warn(
                                        '[FileScanner] Per-file stale delete failed — continuing',
                                        {
                                            filePath: fp,
                                            error: err instanceof Error ? err.message : String(err),
                                        },
                                    );
                                }
                            }),
                        );
                    }
                }
                // Not held (or the confirmed cleanup ran): forget any hold.
                if (!_abortRequested.has(scanKey)) {
                    await clearCleanupHold(sql, libraryPath.id);
                }
            } catch (err) {
                context.logger.warn(`[FileScanner] Stale cleanup failed for ${libraryPath.path}`, {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
    }

    // The music post-passes below work on the whole music catalogue; only a
    // scan that covered a music library can have given them anything new.
    // They used to follow every movie and series scan too (hourly, per path).
    const scannedMusic = targets.some((t) => isMusic(t.media_type));

    if (scannedMusic && !_abortRequested.has(scanKey)) {
        try {
            const repaired = await repairOrphanMusicLinks(sql, () => _abortRequested.has(scanKey));
            if (repaired > 0)
                context.logger.info(
                    `[FileScanner] Restored ${repaired} missing music links; saved changes can be undone from music details`,
                );
        } catch (err) {
            context.logger.warn('[FileScanner] Missing music link repair incomplete', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    if (scannedMusic && !_abortRequested.has(scanKey)) {
        try {
            const lockResult = await withAdvisoryLock(
                sql,
                'file-scanner-postpass:rematchUnknownArtistTracks',
                (tx) => rematchUnknownArtistTracks(tx, context),
            );
            if (!lockResult.acquired) {
                context.logger.info(
                    '[FileScanner] Unknown-artist rematch pass skipped — another replica is holding the lock',
                );
            } else if (lockResult.value > 0) {
                context.logger.info(
                    `[FileScanner] Rematched ${lockResult.value} track(s) from "Unknown Artist" to real artists`,
                );
            }
        } catch (err) {
            context.logger.warn('[FileScanner] Unknown-artist rematch pass failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    if (scannedMusic && !_abortRequested.has(scanKey)) {
        try {
            const lockResult = await withAdvisoryLock(
                sql,
                'file-scanner-postpass:mergeCollaborationArtists',
                (tx) => mergeCollaborationArtists(tx, context),
            );
            if (!lockResult.acquired) {
                context.logger.info(
                    '[FileScanner] Collaboration artist merge pass skipped — another replica is holding the lock',
                );
            } else if (lockResult.value > 0) {
                context.logger.info(
                    `[FileScanner] Merged ${lockResult.value} collaboration artist(s) into their base artist`,
                );
            }
        } catch (err) {
            context.logger.warn('[FileScanner] Artist merge pass failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    if (scannedMusic && !_abortRequested.has(scanKey)) {
        try {
            const lockResult = await withAdvisoryLock(
                sql,
                'file-scanner-postpass:linkRemixerArtists',
                (tx) => linkRemixerArtists(tx, context),
            );
            if (!lockResult.acquired) {
                context.logger.info(
                    '[FileScanner] Remixer link pass skipped — another replica is holding the lock',
                );
            } else if (lockResult.value > 0) {
                context.logger.info(
                    `[FileScanner] Linked remixer credits on ${lockResult.value} track(s)`,
                );
            }
        } catch (err) {
            context.logger.warn('[FileScanner] Remixer link pass failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    if (scannedMusic && !_abortRequested.has(scanKey)) {
        try {
            const lockResult = await withAdvisoryLock(
                sql,
                'file-scanner-postpass:mergeVariousArtistsAliases',
                (tx) => mergeVariousArtistsAliases(tx, context),
            );
            if (!lockResult.acquired) {
                context.logger.info(
                    '[FileScanner] Various Artists alias merge pass skipped — another replica is holding the lock',
                );
            } else if (lockResult.value > 0) {
                context.logger.info(
                    `[FileScanner] Merged ${lockResult.value} Various Artists alias(es) into canonical record`,
                );
            }
        } catch (err) {
            context.logger.warn('[FileScanner] Various Artists alias merge pass failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    if (scannedMusic && !_abortRequested.has(scanKey)) {
        try {
            const lockResult = await withAdvisoryLock(
                sql,
                'file-scanner-postpass:mergeOversizedCompilationArtists',
                (tx) => mergeOversizedCompilationArtists(tx, context),
            );
            if (!lockResult.acquired) {
                context.logger.info(
                    '[FileScanner] Oversized compilation-artist collapse pass skipped — another replica is holding the lock',
                );
            } else if (lockResult.value > 0) {
                context.logger.info(
                    `[FileScanner] Collapsed ${lockResult.value} oversized compilation artist(s) into "Various Artists"`,
                );
            }
        } catch (err) {
            context.logger.warn('[FileScanner] Oversized compilation-artist collapse pass failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    result.durationMs = Date.now() - start;

    if (scanRunId) {
        try {
            await updateScannerRun(sql, {
                id: scanRunId,
                completedAt: new Date(),
                totalFiles: progress.totalFiles,
                matched: result.added + result.updated,
                updated: result.updated,
                unmatched: result.unmatched,
                errors: result.errors.length,
                // The COUNT above was, until now, the only thing that
                // survived the run: the strings themselves went to the task
                // log buffer (a TTL'd Valkey list) and the row records no
                // task-run id, so "8 errors" led nowhere. Keep a bounded
                // sample on the row so the admin table can answer "which".
                errorSamples: boundScannerRunErrorSamples(result.errors),
            });
        } catch (err) {
            context.logger.warn('[FileScanner] Failed to update scanner run', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // Run-level failure guard (see helper): a 100%-error scan (e.g. NFS mount
    // gone) that produced zero successful outcomes must NOT be recorded as a
    // completed run. Throws a transient TaskError; scanImpl's catch re-throws it
    // (only unexpected errors are converted to a returned result).
    assertScanProducedWorkOrThrow(result, _abortRequested.has(scanKey));

    if (metadataStats.unavailable > 0) {
        result.metadataUnavailable = metadataStats.unavailable;
        result.metadataProviderError = metadataStats.error;
        result.metadataProviderId = metadataStats.providerId;
    }

    return result;
}

async function maybeEnqueuePostScan(
    addedCount: number,
    context: FileScannerContext,
): Promise<void> {
    if (addedCount === 0) return;

    // A scan that added items may have introduced episodes whose only path to
    // a local thumbnail is ffmpeg extraction (no on-disk thumb file, and TMDB
    // may lack a still). Kick a single paced episode-thumbnail-backfill run so
    // those thumbnails materialize promptly instead of waiting for the next
    // hourly tick. The task self-paces (small batch, maxConcurrent:1), so this
    // is ONE run — not a per-item ffmpeg thundering herd — and the global
    // identity + idempotencyKey collapse concurrent scans' enqueues into it.
    // Best-effort: a failed enqueue must never fail the scan, and the hourly
    // schedule is the backstop.
    try {
        const { orchestrator } = await import('../../../orchestrator.js');
        await orchestrator.startRun(
            'episode-thumbnail-backfill',
            {},
            {
                trigger: { kind: 'in-process', sourceRoute: 'file-scanner.post-scan' },
                idempotencyKey: 'coverage:episode-thumbnail-backfill:global',
            },
        );
        context.logger.debug('File scanner: enqueued episode-thumbnail-backfill after scan', {
            addedCount,
        });
    } catch (err) {
        context.logger.warn('File scanner: post-scan backfill enqueue failed (non-fatal)', {
            addedCount,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

async function scanImpl(
    libraryPathId: string | undefined,
    context: FileScannerContext,
): Promise<FileScanResult> {
    const scanKey = libraryPathId ?? 'all';
    const emptyResult = (): FileScanResult => ({
        added: 0,
        updated: 0,
        removed: 0,
        unmatched: 0,
        skipped: 0,
        durationMs: 0,
        errors: [],
    });

    if (_activeScans.has(scanKey)) {
        context.logger.debug(`File scanner: scan already running for ${scanKey}, skipping`);
        return emptyResult();
    }
    if (scanKey === 'all' && _activeScans.size > 0) {
        context.logger.debug('File scanner: per-path scans active, skipping full scan');
        return emptyResult();
    }
    if (scanKey !== 'all' && _activeScans.has('all')) {
        context.logger.debug(
            `File scanner: full scan active, skipping per-path scan for ${scanKey}`,
        );
        return emptyResult();
    }
    _activeScans.add(scanKey);
    _abortRequested.delete(scanKey);
    try {
        const result = await performScan(libraryPathId, context, scanKey);
        _lastScanAt = new Date();
        _lastError = _abortRequested.has(scanKey) ? 'Scan aborted by user' : null;
        if (!_abortRequested.has(scanKey)) {
            await maybeEnqueuePostScan(result.added, context);
            if (result.added > 0) {
                try {
                    const { cacheInvalidation } = await import('$lib/server/cache/index.js');
                    await cacheInvalidation.onContentAdded(
                        Array.from({ length: result.added }, (_, i) => `scan-${i}`),
                    );
                } catch {
                    // Non-fatal: caches will refresh on next TTL expiry
                }
            }
            if (result.added > 0 || result.updated > 0 || result.removed > 0) {
                // Keep media_items.first_file_at / season_debut_at fresh for the
                // browse 'titles'/'seasons' newness modes (see browse.queries.ts).
                // A bulk walk doesn't carry a clean per-title id set at this
                // level (per-file results, not aggregated by title), so this
                // falls back to a full refresh — best-effort, must never fail
                // the scan itself.
                try {
                    const { refreshRecentlyAddedRecency } =
                        await import('$lib/server/database/queries/browse.queries.js');
                    await refreshRecentlyAddedRecency(context.sql);
                } catch (err) {
                    context.logger.warn(
                        'File scanner: refreshRecentlyAddedRecency failed (non-fatal)',
                        { error: err instanceof Error ? err.message : String(err) },
                    );
                }
            }
        }
        return result;
    } catch (err) {
        _lastError = err instanceof Error ? err.message : String(err);
        // A TaskError from performScan is an intentional run-level failure signal
        // (total I/O outage) — it MUST propagate so the runner marks the run
        // failed and the breaker can trip. Only unexpected errors are converted
        // to a returned result (legacy behaviour preserved for those).
        if (err instanceof TaskError) {
            throw err;
        }
        return {
            ...emptyResult(),
            errors: [_lastError],
            errorDetails: [{ path: libraryPathId ?? 'all', err }],
        };
    } finally {
        _activeScans.delete(scanKey);
        _abortRequested.delete(scanKey);
        await deleteScanProgress(scanKey);
    }
}

// ---------------------------------------------------------------------------
// Watcher leader — one per process (one per replica)
// ---------------------------------------------------------------------------

export type IngestResult = {
    status: 'ingested' | 'filtered' | 'skipped' | 'error';
    mediaItemId: string | null;
};

const INELIGIBLE_WARN_INTERVAL_MS = 10 * 60_000;
const ineligibleWarnedAt = new Map<string, number>();

/**
 * Surface paths the scanner rules refuse (a notifier such as rclone/*arr may
 * have sent them), once per library root and reason per interval. Refusals that
 * were always silent (non-media extension, AppleDouble) are not reported.
 */
function warnIneligibleOnce(
    ctx: LegacyPluginContext,
    root: string,
    absPath: string,
    reason: string,
): void {
    if (reason === 'extension file' || reason === 'apple-double file') return;
    const key = `${root}\0${reason.replace(/"[^"]*"/g, '""')}`;
    const now = Date.now();
    const last = ineligibleWarnedAt.get(key);
    if (last !== undefined && now - last < INELIGIBLE_WARN_INTERVAL_MS) return;
    if (ineligibleWarnedAt.size >= 500) ineligibleWarnedAt.clear();
    ineligibleWarnedAt.set(key, now);
    ctx.logger.warn('File scanner: refusing a path the scanner rules would not walk', {
        libraryRoot: root,
        filePath: absPath,
        reason,
    });
}

/**
 * Perform the per-file ingest for a single absolute path that is already known
 * to reside under `libraryPath`. Handles lyrics-sidecar routing, extension
 * filtering, and video/audio ingest. Returns a discriminated IngestResult with
 * the status and the resulting `media_item` id when available.
 */
export async function ingestSingleFile(
    sql: postgres.Sql,
    absPath: string,
    libraryPath: LibraryPathRow,
    ctx: LegacyPluginContext,
): Promise<IngestResult> {
    // Second line of defence: whatever fed us this path (watcher, delta queue),
    // the bulk walk's rules decide - pruned folders, ignore files, samples,
    // suffix extras, symlinks out of the roots, non-UTF-8 names.
    const eligibility = await checkScannerEligibility(libraryPath.path, absPath);
    if (!eligibility.eligible) {
        ctx.logger.debug('File watcher: path is not eligible for the scanner', {
            filePath: absPath,
            reason: eligibility.reason,
        });
        warnIneligibleOnce(ctx, libraryPath.path, absPath, eligibility.reason);
        return { status: 'filtered', mediaItemId: null };
    }

    // macOS AppleDouble resource-fork sidecars (`._Song.flac`) inherit the
    // real file's extension, so they'd otherwise sail through the
    // MEDIA_EXTENSIONS/AUDIO_EXTENSIONS check below and get tag-parsed as a
    // broken copy of the real track — same reason walkDirectoryWithResult
    // skips them in the bulk walk. Must be checked before that filter, not
    // folded into it.
    if (isAppleDoubleSidecar(path.basename(absPath))) {
        ctx.logger.debug('File watcher: ignoring AppleDouble sidecar', { filePath: absPath });
        return { status: 'filtered', mediaItemId: null };
    }

    // Lyrics sidecars aren't library items — route them straight to lyrics
    // ingestion against their sibling track instead of the media pipeline
    // (which would otherwise try to parse a .lrc/.txt as audio).
    const ext = path.extname(absPath).toLowerCase();
    if (LYRICS_SIDECAR_EXTENSIONS.has(ext)) {
        const { isMusic } = await import('$lib/server/utils/media-types.js');
        if (!libraryPath.media_type || !isMusic(libraryPath.media_type))
            return { status: 'filtered', mediaItemId: null };
        try {
            const { outcome, audioPath } = await ingestSidecarLyricsForWatchedFile(sql, absPath);
            if (outcome === 'updated') {
                ctx.logger.info('File watcher: ingested sidecar lyrics', {
                    sidecar: absPath,
                    track: audioPath,
                });
            }
        } catch (err) {
            ctx.logger.warn('File watcher: sidecar lyrics ingest failed', {
                filePath: absPath,
                error: err instanceof Error ? err.message : String(err),
            });
        }
        return { status: 'filtered', mediaItemId: null };
    }

    // Only video/audio files become media_files. The bulk walk
    // (walkDirectoryWithResult) filters to MEDIA_EXTENSIONS/AUDIO_EXTENSIONS;
    // the watcher must do the same. Otherwise sidecar files written into the
    // library — artwork (e.g. the `<episode>-thumb.jpg` the thumbnail extractor
    // itself writes), plus `.nfo`/`.srt` — fire an `add` event, get pushed
    // through processVideoFile, and land as media_files that media-probe then
    // falsely flags `no_keyframes`/`truncated_video`. Artwork/subtitles are
    // picked up by the dedicated walkArtwork/walkSubtitles passes on the next
    // full scan, not here.
    if (!MEDIA_EXTENSIONS.has(ext) && !isAudioFile(ext)) {
        ctx.logger.debug('File watcher: ignoring non-media file (not video/audio)', {
            filePath: absPath,
            ext,
        });
        return { status: 'filtered', mediaItemId: null };
    }

    // One file under two names is one file, as in the full scan: a live
    // case-only rename keeps its row, a hard link / symlink is not ingested again.
    const alias = await resolveSingleFileAlias(sql, absPath, libraryPath.path).catch(
        (err: unknown) => {
            ctx.logger.warn('File watcher: same-file check failed; ingesting normally', {
                filePath: absPath,
                error: err instanceof Error ? err.message : String(err),
            });
            return { kind: 'none' } as const;
        },
    );
    if (alias.kind === 'caseRename') {
        const renamed = await renameFileRowInPlace(sql, alias.from, absPath).catch(() => false);
        if (renamed) {
            ctx.logger.info('File watcher: case-only rename: kept the file row', {
                from: alias.from,
                to: absPath,
            });
            return {
                status: 'skipped',
                mediaItemId: await getMediaItemIdByFilePath(sql, absPath),
            };
        }
        // The old row is still the same file: ingesting the new name would
        // duplicate it. The next full scan renames or cleans it up.
        ctx.logger.warn('File watcher: case-only rename could not move the row; not ingested', {
            from: alias.from,
            to: absPath,
        });
        return { status: 'skipped', mediaItemId: null };
    } else if (alias.kind === 'alias') {
        // Remembered: if the file this name shares an inode with goes away
        // (a rename done as link + unlink), this name is ingested then.
        rememberSkippedAlias(alias.sameAs, absPath);
        ctx.logger.info(
            'File watcher: skipped a file that is another name (hard link / symlink) for a file the library has',
            { filePath: absPath, sameAs: alias.sameAs },
        );
        return { status: 'skipped', mediaItemId: null };
    }

    const providerIds = getProvidersByPriority().map((p) => p.id);
    // Retry on transient deadlock/serialization: the watcher fast-path and
    // file-delta-ingest can process files of the same series/album parent
    // concurrently, briefly contending on the shared parent row (the bulk
    // scanner gets this via the same helper).
    // A watcher invocation is its own run; never reuse a prior folder snapshot.
    const fsCtx = { ...ctx } as unknown as FileScannerContext;
    const outcome = await runWithConflictRetry(
        () => processVideoFile(sql, absPath, libraryPath, providerIds, fsCtx),
        {
            onRetry: (attempt, code) =>
                fsCtx.logger.debug(
                    'File scanner: retrying single file after transient DB conflict',
                    { absPath, attempt, code },
                ),
        },
    );

    if (outcome === 'added' || outcome === 'updated') {
        const { isMusic } = await import('$lib/server/utils/media-types.js');
        // libraryPath.media_type can be undefined on malformed library_paths rows;
        // pass the original string through isMusic which already handles it,
        // but avoid letting that path silently mark a music library as non-music.
        getWatcherFlowDebouncer().signal({
            hasNewFiles: true,
            hasMusicFiles: libraryPath.media_type ? isMusic(libraryPath.media_type) : false,
        });
    }

    if (outcome === 'added' || outcome === 'updated' || outcome === 'unmatched') {
        return { status: 'ingested', mediaItemId: await getMediaItemIdByFilePath(sql, absPath) };
    }
    if (outcome === 'skipped') {
        return { status: 'skipped', mediaItemId: await getMediaItemIdByFilePath(sql, absPath) };
    }
    return { status: 'error', mediaItemId: null };
}

const processFileForWatcher: ProcessFileFn = createProcessFileForWatcher({
    getEnabledLibraryPaths,
    ingestSingleFile,
});

const watcherLeader = new WatcherLeader(processFileForWatcher);

/** Runtime state of this process's watcher (for worker health/metrics). */
export function getWatcherRuntimeState(): WatcherRuntimeState {
    return watcherLeader.getRuntimeState();
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export const fileScannerMediaSource = defineMediaSource({
    id: 'file-scanner',
    name: 'File Scanner',
    version: '1.0.0',
    description: 'Scans configured library paths for local media files',
    author: 'Lumastra',
    capabilities: { database: true },
    sourceConfig: {
        supportsIncrementalScan: true,
        defaultScanIntervalHours: 12,
        supportsWatching: true,
    },

    isConfigured: () => true,

    async scan(ctx, opts): Promise<FileScanResult> {
        const context: FileScannerContext = {
            sql: ctx.sql,
            // SDK Logger is structurally compatible at the call sites the
            // scanner uses (debug/info/warn/error); the legacy LoggerInstance
            // adds formatTimestamp/formatLogEntry etc. that the scanner never
            // calls. Cast through unknown to satisfy the nominal type gap.
            logger: ctx.logger as unknown as FileScannerContext['logger'],
            abortSignal: ctx.signal,
        };
        return scanImpl(opts.libraryPathId, context);
    },

    async fullSync(ctx): Promise<SyncResult> {
        const context: FileScannerContext = {
            sql: ctx.sql,
            logger: ctx.logger as unknown as FileScannerContext['logger'],
            abortSignal: ctx.signal,
        };
        const result = await scanImpl(undefined, context);
        _lastFullSyncAt = new Date();
        return {
            added: result.added,
            updated: result.updated,
            removed: result.removed,
            durationMs: result.durationMs,
            errors: result.errors,
        };
    },

    async getStatus(ctx): Promise<MediaSourceStatus> {
        return {
            lastScanAt: _lastScanAt ?? undefined,
            lastFullSyncAt: _lastFullSyncAt ?? undefined,
            itemCount: await countLinkedMediaItems(ctx.sql),
            isScanning: _activeScans.size > 0,
            lastError: _lastError ?? undefined,
        };
    },

    async startWatching(ctx): Promise<void> {
        const paths = await getEnabledLibraryPaths(ctx.sql);
        // Cast SDK PluginContext to legacy shape — WatcherLeader stores the
        // context and uses only .sql and .logger; both are present on the SDK
        // PluginContext at runtime.
        await watcherLeader.start(
            ctx as unknown as LegacyPluginContext,
            paths.map((p) => p.path),
        );
    },

    async stopWatching(_ctx): Promise<void> {
        await watcherLeader.stop();
    },

    async getWatcherStatus(ctx): Promise<WatcherStatus> {
        const status = watcherLeader.getStatus();
        // Valkey hiccups while polling the leader heartbeat shouldn't tear
        // down the entire admin status endpoint — fall back to local state.
        let leaderElsewhere = false;
        try {
            leaderElsewhere = await watcherLeader.isLockHeldElsewhere();
        } catch (err) {
            ctx.logger.warn('file-scanner getWatcherStatus: isLockHeldElsewhere threw', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
        if (!leaderElsewhere) {
            return {
                active: status.active,
                paths: status.paths,
                lastEventAt: status.lastEventAt,
                lastEventFile: status.lastEventFile,
                leaderElsewhere: false,
                ...(status.lastError ? { leaderError: status.lastError } : {}),
                ...(status.coverage
                    ? { coverage: status.coverage, limitations: status.limitations }
                    : {}),
                ...(status.networkReconcileSecs !== undefined
                    ? { networkReconcileSecs: status.networkReconcileSecs }
                    : {}),
            };
        }
        let leaderStatus = null;
        try {
            leaderStatus = await watcherLeader.getLeaderStatus();
        } catch (err) {
            ctx.logger.warn('file-scanner getWatcherStatus: getLeaderStatus threw', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
        return {
            active: status.active,
            paths: leaderStatus?.paths ?? status.paths,
            lastEventAt: status.lastEventAt,
            lastEventFile: status.lastEventFile,
            leaderElsewhere: true,
            leaderHeartbeatAt: leaderStatus?.lastHeartbeatAt,
            leaderError: leaderStatus?.lastError,
            ...(leaderStatus?.coverage
                ? { coverage: leaderStatus.coverage, limitations: leaderStatus.limitations ?? [] }
                : {}),
            ...(leaderStatus?.networkReconcileSecs !== undefined
                ? { networkReconcileSecs: leaderStatus.networkReconcileSecs }
                : {}),
        };
    },

    async updateWatcherTargets(ctx): Promise<void> {
        const paths = await getEnabledLibraryPaths(ctx.sql);
        await watcherLeader.updatePaths(paths.map((p) => p.path));
    },
});

registry.registerMediaSource(fileScannerMediaSource);

// ---------------------------------------------------------------------------
// Named exports for callers outside the MediaSourceDefinition contract
// ---------------------------------------------------------------------------

/** Get current scan progress. Returns aggregated progress across all active scans, or null. */
export async function getFileScannerProgress(): Promise<FileScannerProgress | null> {
    return getAggregateScanProgress();
}

/** Request all active scans to abort. No-op if not scanning. */
export function requestFileScannerAbort(): boolean {
    if (_activeScans.size === 0) return false;
    for (const key of _activeScans) _abortRequested.add(key);
    return true;
}

/**
 * Request a specific scan (by library path ID or 'all') to abort.
 *
 * Returns true only when the exact key is an active scan. Returning false
 * for "I don't know this scan" is deliberate: a per-library cancel must
 * never escalate to a global abort, because the caller (admin UI or task
 * scheduler cancelling a single library-scan run) does not have authority
 * over an unrelated parent scan.
 */
export function requestFileScannerAbortForKey(scanKey: string): boolean {
    if (_activeScans.has(scanKey)) {
        _abortRequested.add(scanKey);
        return true;
    }
    return false;
}

/** True if this replica is the active watcher leader. */
export function isWatching(): boolean {
    return watcherLeader.isActive();
}

/**
 * Entry-point for the file-library-scan task. Accepts the narrow
 * FileScannerContext directly. This is the same logic as the
 * plugin's scan method — provided as a named export for type-safe callers.
 */
export function scanForSync(
    libraryPathId: string | undefined,
    context: FileScannerContext,
): Promise<FileScanResult> {
    return scanImpl(libraryPathId, context);
}

/** Update watcher paths (called after library path changes). */
export async function updateWatcherPaths(sql: postgres.Sql): Promise<void> {
    const paths = await getEnabledLibraryPaths(sql);
    await watcherLeader.updatePaths(paths.map((p) => p.path));
}
