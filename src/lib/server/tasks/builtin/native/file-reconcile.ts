// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * File Reconcile — near-real-time library reconciliation.
 *
 * Why this exists: native inotify/FSEvents notifications do NOT fire for remote
 * writes on NFS mounts. The native watcher's periodic reconciliation and the
 * hourly file-library-scan provide safety nets; this task detects path changes
 * more frequently without the cost of a full ingest scan.
 *
 * This task is the cheap, frequent bridge between the two: every few minutes it
 * does a directory-enumeration-only diff (recursive `readdir`, NO ffprobe / hash
 * / per-file stat) of each enabled library path against the `media_files` rows
 * already known for that path, and enqueues ONLY the new/removed paths into the
 * existing `file-delta-ingest` task (which does the actual upsert/remove + drives
 * the downstream probe/metadata/embedding pipeline). Because it never probes, it
 * is far cheaper than the full scan and safe to run often.
 *
 * Scope of detection: ADDS and REMOVES (path presence). In-place content changes
 * to an existing path (re-encode at the same path) are left to the hourly full
 * scan's mtime/size/hash triage — detecting those here would require statting
 * every file every cycle, which is the NFS stat-storm we explicitly avoid.
 *
 * Cadence: a scheduled global run reconciles ONE library path per cycle
 * (round-robin, cursor in the namespaced cache), so a single run's recursive
 * walk always fits the 20m hard timeout even on a large NFS library — full
 * coverage takes one cycle per enabled path. (The old "walk every path each run"
 * blew the timeout and was hard-killed, so it never completed.) A targeted run
 * (`libraryPathId`) reconciles just that path immediately.
 *
 * Safety: when the walk reports `hadErrors` (a readdir/stat failed mid-walk) we
 * do NOT compute removes for that path — an incomplete walk must never be read
 * as "these files were deleted". We also skip removes when a walk returns zero
 * media files but the DB has some (an unmounted/misread root looks empty), and
 * cap the number of deltas enqueued per path per cycle (the remainder is
 * re-detected next cycle — eventual consistency).
 *
 * Configuration:
 * - SYNC_FILE_RECONCILE_INTERVAL: duration-string override for the cadence.
 * - DISABLE_FILE_LIBRARY_SCAN: shared kill switch — disables reconcile too.
 */

import { z } from 'zod';
import { join, relative } from 'node:path';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { config } from '$lib/server/config.js';
import { isExtrasFilePath, isThemeAssetPath } from '$lib/server/utils/media-extras.js';
import { listRecentReconcileSkips } from './file-reconcile-skips.js';
import { assessFilePresence } from '$lib/server/utils/file-presence.js';

const inputSchema = z
    .object({
        /** When provided, reconcile only this specific library path id. */
        libraryPathId: z.string().optional(),
    })
    .passthrough();

type FileReconcileInput = z.infer<typeof inputSchema>;

interface FileReconcileResult {
    pathsChecked: number;
    upserts: number;
    removes: number;
    deltaRunsDispatched: number;
    walkErrors: number;
    capped: number;
    /** New disk paths withheld from upsert because they are extras (see isExtrasPath). */
    excludedExtras: number;
    /** Known DB paths that are extras and were withheld from remove consideration entirely. */
    excludedExtrasDb: number;
    /** New disk paths withheld from upsert because they are theme assets (see isThemeAssetPath). */
    excludedThemes: number;
    /** Known DB paths that are theme assets and were withheld from remove consideration. */
    excludedThemesDb: number;
    /** New disk paths withheld because ingest skipped them on purpose recently. */
    excludedSkipped: number;
    /**
     * Known paths absent from the walk but still on disk (a new ignore rule
     * hides them), or whose presence could not be decided: never removed.
     */
    keptPresent: number;
}

/**
 * Max adds (and, separately, removes) enqueued per library path per cycle. Keeps
 * each `file-delta-ingest` run's serialized input well under the 256 KB cap
 * (LUMASTRA_MAX_TASK_INPUT_BYTES) AND means we issue exactly ONE delta run per
 * path per cycle — `file-delta-ingest` is `exclusiveWith` per path, so a second
 * run for the same path this cycle would just dedup and be lost. Any remainder
 * is still missing from the DB next cycle, so it is re-detected then.
 */
const MAX_DELTAS_PER_PATH = 500;

/**
 * Refuse to remove more than this fraction of a path's known files in one cycle
 * (belt-and-suspenders on top of the zero-files guard). A reconcile that wants to
 * delete most of a library is almost always a transiently-unhealthy mount, not a
 * real mass deletion — the hourly scan's own stale-cleanup will handle a genuine
 * bulk removal more deliberately.
 */
const MAX_REMOVE_FRACTION = 0.5;

/**
 * The fraction guard only engages once the absolute remove count is at least
 * this large. Without a floor, the fraction guard misfires on tiny libraries —
 * deleting 1 of 2 files is 50% and would be wrongly suppressed forever. Normal
 * day-to-day deletions (a handful of files) must always propagate; the guard is
 * strictly a MASS-removal backstop, so it needs both a large fraction AND a
 * large absolute count.
 */
const MIN_REMOVE_GUARD_COUNT = 25;

/**
 * Valkey cache key (namespaced per-plugin) holding the id of the library path
 * reconciled in the previous scheduled cycle — the round-robin cursor. Evictable:
 * if it's lost, the rotation simply restarts at the first path (harmless).
 */
const CURSOR_CACHE_KEY = 'reconcile-path-cursor';

/**
 * Cursor TTL. Comfortably exceeds the reconcile cadence (default 5m, rewritten
 * every cycle) so a running task never loses its place between cycles, but
 * self-cleans if the task is disabled for a long stretch.
 */
const CURSOR_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Round-robin selector: given the enabled paths' ids (stable order) and the id
 * reconciled last cycle, return the index of the NEXT path to reconcile. Wraps
 * around; starts at 0 when there is no cursor or the cursor's path is gone
 * (removed/disabled since last cycle). Pure — unit-testable.
 */
export function nextReconcilePathIndex(pathIds: string[], lastId: string | null): number {
    if (pathIds.length === 0) return -1;
    const prev = lastId ? pathIds.indexOf(lastId) : -1;
    return (prev + 1) % pathIds.length;
}

export interface ReconcileDelta {
    /** Relative (to library root) paths to upsert. */
    upsert: string[];
    /** Relative (to library root) paths to remove, capped at `maxDeltas`. */
    remove: string[];
    /**
     * Every remove candidate, uncapped (after the safety guards). The task
     * checks presence on these before capping, so files a new ignore rule
     * hides (still on disk, never removed) cannot fill the cap every cycle
     * and starve the real removals behind them.
     */
    removeAll: string[];
    /** Set when removes were suppressed by a safety guard (for logging). */
    removesSuppressed?: 'walk-errors' | 'empty-listing' | 'exceeds-fraction';
    /** True when the upsert or remove set was capped this cycle. */
    capped: boolean;
    /**
     * Count of otherwise-new disk paths withheld from `upsert` because they
     * are extras (a named extras subfolder like `trailers/`, or a Jellyfin
     * filename-suffix extra like `Film-trailer.mkv`) — see `isExtrasPath`.
     * Zero in the common case; present for logging visibility.
     */
    excludedExtras: number;
    /**
     * Count of known DB paths that are extras and were therefore excluded
     * from remove consideration entirely — see the "symmetric exclusion"
     * note on `computeReconcileDeltas`. Without this, a legitimately-ingested
     * extra (which DOES have a `media_files` row, but is never present in
     * reconcile's own extras-excluded disk listing) would look like "not on
     * disk" on EVERY cycle and get deleted. Zero in the common case; present
     * for logging visibility.
     */
    excludedExtrasDb: number;
    /**
     * Count of otherwise-new disk paths withheld from `upsert` because they are
     * THEME assets (`theme.mp3` beside an item, `theme-music/`) — see
     * `isThemeAssetPath`. These are owned by nobody: not primary media, not
     * extras. Before they were excluded, reconcile proposed the same 76 of them
     * every 5 minutes forever, because file-delta-ingest reported them
     * "upserted" without persisting a `media_files` row for reconcile to find
     * on the next cycle.
     */
    excludedThemes: number;
    /**
     * Theme assets among known DB paths, excluded from remove consideration for
     * the same symmetry reason as `excludedExtrasDb`.
     */
    excludedThemesDb: number;
    /**
     * New disk paths withheld because file-delta-ingest skipped them on purpose
     * within the last day and wrote no `media_files` row (see
     * file-reconcile-skips.ts) — proposing them again only repeats the skip.
     */
    excludedSkipped: number;
}

/**
 * True when an absolute (or root-relative) disk path lives inside a named
 * extras subfolder (`trailers/`, `behind the scenes/`, …) or is itself a
 * Jellyfin filename-suffix / single-file extra (`Film-trailer.mkv`, standalone
 * `trailer.mp4`).
 *
 * Why this exists here too: `walkDirectoryWithResult` (the walk reconcile
 * diffs against `media_files`) already excludes extras subfolders/suffixes
 * from its own listing during traversal — so in the common case this check is
 * redundant with that exclusion. It is kept as an explicit, independent guard
 * on reconcile's OWN diff output so "extras never get claimed as a primary
 * file/version" is an invariant of `computeReconcileDeltas` itself, not
 * something reconcile only gets for free by relying on exactly how its caller
 * built the disk listing. A path that matches is left OUT of `upsert`
 * entirely rather than routed through `processExtra` here: `processExtra`
 * needs folder-listing context (the specific sibling primary a filename-suffix
 * extra belongs to, via `walkExtras`'s `primaryFilePath`) that this cheap,
 * per-path check does not have — reconcile's cheap enumeration deliberately
 * skips the dedicated extras walk (see the module doc above). Excluded paths
 * are picked up correctly on the next full scan's `walkExtras` → `processExtra`
 * pass. Pure — unit-testable.
 *
 * Thin wrapper over {@link isExtrasFilePath} (`media-extras.ts`) — the single
 * source of truth shared with the scanner's triage (`shared.ts`) and
 * `processVideoFile` (`video-processor.ts`) guards. Kept as a named export
 * here (rather than re-exporting the import directly) so existing callers/
 * tests importing `isExtrasPath` from this module are unaffected.
 */
export function isExtrasPath(absPath: string, libraryRoot?: string): boolean {
    return isExtrasFilePath(absPath, libraryRoot);
}

/**
 * Pure add/remove diff between the on-disk listing and the DB's known paths for
 * one library path. Compares on an NFC-normalized key so an NFC/NFD encoding
 * mismatch doesn't masquerade as add+remove; emits verbatim relative paths.
 * Applies the remove-safety guards (incomplete walk, suspected-unmounted empty
 * listing, mass-removal fraction) and the per-cycle cap. No I/O — unit-testable.
 *
 * Symmetric extras exclusion: reconcile does not MANAGE extras at all — its
 * own disk listing (`walkDirectoryWithResult`) already excludes them, so
 * `dbAbs` is filtered through `isExtrasPath` up front, before any diffing.
 * This must be symmetric with the upsert-side exclusion below: a
 * legitimately-ingested extra (which DOES have a `media_files` row) would
 * otherwise never appear in the extras-excluded disk listing and would look
 * like "removed from disk" on every single cycle, permanently deleting it —
 * see the `excludedExtrasDb` regression this fixes. Extras' entire lifecycle
 * (ingest via `walkExtras` → `processExtra`, and stale cleanup) belongs to
 * the full scan, never to reconcile.
 */
export function computeReconcileDeltas(
    lpPath: string,
    diskAbs: string[],
    dbAbs: string[],
    walk: { hadErrors: boolean },
    opts: {
        maxDeltas: number;
        maxRemoveFraction: number;
        minRemoveGuard: number;
        /** Relative paths ingest deliberately skipped recently. */
        recentlySkipped?: ReadonlySet<string>;
    },
): ReconcileDelta {
    const dbAbsNoExtras = dbAbs.filter((p) => !isExtrasPath(p, lpPath));
    const excludedExtrasDb = dbAbs.length - dbAbsNoExtras.length;
    const dbAbsManaged = dbAbsNoExtras.filter((p) => !isThemeAssetPath(p));
    const excludedThemesDb = dbAbsNoExtras.length - dbAbsManaged.length;

    const dbKeySet = new Set(dbAbsManaged.map((p) => p.normalize('NFC')));
    const diskKeySet = new Set(diskAbs.map((p) => p.normalize('NFC')));

    const newAbs = diskAbs.filter((p) => !dbKeySet.has(p.normalize('NFC')));
    // Extras (subfolder or filename-suffix) must never be claimed as a
    // primary file/version via reconcile's upsert path — see isExtrasPath.
    // Left out entirely (not capped, not upserted); the next full scan's
    // walkExtras → processExtra pass attaches them correctly.
    const newAbsNoExtras = newAbs.filter((p) => !isExtrasPath(p, lpPath));
    const excludedExtras = newAbs.length - newAbsNoExtras.length;
    // Theme assets are withheld for the same reason as extras: reconcile does not
    // manage them. Unlike extras they have no other owner either, so proposing them
    // was guaranteed non-convergence — nothing downstream ever made them stop
    // being "new".
    const upsertNoThemes = newAbsNoExtras.filter((p) => !isThemeAssetPath(p));
    const excludedThemes = newAbsNoExtras.length - upsertNoThemes.length;
    const skippedSet = opts.recentlySkipped;
    const upsertAbs =
        skippedSet && skippedSet.size > 0
            ? upsertNoThemes.filter((p) => !skippedSet.has(relative(lpPath, p)))
            : upsertNoThemes;
    const excludedSkipped = upsertNoThemes.length - upsertAbs.length;
    let removeAbs = dbAbsManaged.filter((p) => !diskKeySet.has(p.normalize('NFC')));
    let removesSuppressed: ReconcileDelta['removesSuppressed'];

    if (walk.hadErrors) {
        if (removeAbs.length > 0) removesSuppressed = 'walk-errors';
        removeAbs = [];
    } else if (diskAbs.length === 0 && dbAbsManaged.length > 0) {
        // Empty listing but DB has files → suspected unmounted/misread root.
        removesSuppressed = 'empty-listing';
        removeAbs = [];
    } else if (
        dbAbsManaged.length > 0 &&
        removeAbs.length >= opts.minRemoveGuard &&
        removeAbs.length > dbAbsManaged.length * opts.maxRemoveFraction
    ) {
        // Mass-removal backstop: only when BOTH a large absolute count AND more
        // than the fraction. Normal small deletions always propagate.
        removesSuppressed = 'exceeds-fraction';
        removeAbs = [];
    }

    const capped = upsertAbs.length > opts.maxDeltas || removeAbs.length > opts.maxDeltas;

    return {
        upsert: upsertAbs.slice(0, opts.maxDeltas).map((abs) => relative(lpPath, abs)),
        remove: removeAbs.slice(0, opts.maxDeltas).map((abs) => relative(lpPath, abs)),
        removeAll: removeAbs.map((abs) => relative(lpPath, abs)),
        removesSuppressed,
        capped,
        excludedExtras,
        excludedExtrasDb,
        excludedThemes,
        excludedThemesDb,
        excludedSkipped,
    };
}

/**
 * Keep only the removes whose file is really gone from disk.
 *
 * The walk leaves out files an ignore rule (`.lumastraignore`, Jellyfin
 * `.ignore`) hides, so a known file that becomes ignored looked "deleted" and
 * file-delta-ingest removed its row: the item was dismissed, and once the 24 h
 * reclaim window passed, its watch history, ratings and playlist entries were
 * stranded. An ignore rule must not destroy user state, and the full scan's
 * stale cleanup already keeps such rows (it checks presence); reconcile now
 * does the same. A file whose presence cannot be decided (the mount looks
 * offline) is kept too. One stat per remove candidate, never per file.
 */
export async function dropStillPresentRemoves(
    lpPath: string,
    removeRel: string[],
    opts: { limit?: number; concurrency?: number; signal?: AbortSignal } = {},
): Promise<{ remove: string[]; stillPresent: number; more: boolean }> {
    const limit = opts.limit ?? Number.POSITIVE_INFINITY;
    const width = Math.max(1, opts.concurrency ?? 16);
    const remove: string[] = [];
    let stillPresent = 0;
    for (let i = 0; i < removeRel.length; i += width) {
        if (remove.length >= limit) return { remove, stillPresent, more: true };
        if (opts.signal?.aborted) return { remove, stillPresent, more: true };
        const batch = removeRel.slice(i, i + width);
        const verdicts = await Promise.all(
            batch.map((rel) =>
                assessFilePresence(join(lpPath, rel), { mountRoot: lpPath, signal: opts.signal }),
            ),
        );
        batch.forEach((rel, j) => {
            if (verdicts[j] === 'missing') {
                if (remove.length < limit) remove.push(rel);
            } else {
                stillPresent++;
            }
        });
    }
    return { remove, stillPresent, more: false };
}

export const fileReconcileTask = defineTask<FileReconcileInput, FileReconcileResult>({
    id: 'file-reconcile',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'library',
    name: 'File Reconcile',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true, cache: true },

    schedule: {
        every: '5m',
        runOnStartup: true,
        // Let the boot-time full scan settle first; reconcile is the steady-state
        // bridge, not the cold-start path.
        startupDelay: '3m',
        envOverride: 'SYNC_FILE_RECONCILE_INTERVAL',
    },

    // The deltas it produces flow through file-delta-ingest → media-probe etc.;
    // declared so trigger-coverage sees the linkage.
    feedsInto: ['file-delta-ingest'],

    identityFor: (input) => (input.libraryPathId ? `path-${input.libraryPathId}` : 'global'),
    scope: 'global',
    // One reconcile in flight cluster-wide; TTL comfortably exceeds the hard
    // timeout so the lock can't expire mid-run.
    exclusiveWith: { scope: 'global', ttl: '30m' },
    quotas: { maxConcurrent: 1 },

    // Bulk (not io/ingest): the recursive readdir over a large NFS tree can take
    // minutes, and bulk has the widened BullMQ lock so a slow walk under host
    // load won't lose its job lock. It must not head-of-line-block the fast-path
    // ingest classes.
    resourceClass: 'bulk',

    inputSchema,

    timeout: { hard: '20m', soft: '15m' },

    async execute(ctx) {
        const { logger, signal, sql } = ctx;

        if (config.DISABLE_FILE_LIBRARY_SCAN) {
            return {
                success: true,
                itemsProcessed: 0,
                result: {
                    pathsChecked: 0,
                    upserts: 0,
                    removes: 0,
                    deltaRunsDispatched: 0,
                    walkErrors: 0,
                    capped: 0,
                    excludedExtras: 0,
                    excludedExtrasDb: 0,
                    excludedThemes: 0,
                    excludedThemesDb: 0,
                    excludedSkipped: 0,
                    keptPresent: 0,
                },
            };
        }

        const [
            { getEnabledLibraryPaths },
            { getMediaFilePathsByLibraryPrefix },
            { walkDirectoryWithResult },
            { orchestrator },
        ] = await Promise.all([
            import('$lib/server/database/queries/library-paths.queries.js'),
            import('$lib/server/database/queries/media-files.queries.js'),
            import('$lib/server/utils/walk-directory.js'),
            import('../../orchestrator.js'),
        ]);

        const all = await getEnabledLibraryPaths(sql);

        // Path selection. A targeted run (manual/admin — libraryPathId set) does
        // exactly that path. A scheduled GLOBAL run does ONE path per cycle,
        // round-robin, so the recursive directory walk over the (large, NFS-
        // backed) library always fits the 20m hard timeout. The previous "walk
        // ALL paths every run" blew that timeout on a big library and was
        // hard-killed at 1200s, so reconcile never actually completed. Full
        // coverage now takes `all.length` cycles (~30m at the 5m cadence); the
        // real-time watcher + hourly file-library-scan bridge a path between its
        // turns.
        let paths: typeof all;
        if (ctx.input.libraryPathId) {
            paths = all.filter((p) => p.id === ctx.input.libraryPathId);
        } else if (all.length <= 1) {
            paths = all;
        } else {
            // `ctx.cache` is typed optional (the `cache` capability is a runtime
            // grant, not a compile-time narrowing). It IS present here because we
            // declare `capabilities: { cache: true }`; the optional-chaining
            // fallback (no cursor → index 0) is a safe degrade — it still does
            // exactly ONE path per run, so the hard-timeout guarantee holds even
            // in the impossible case the cache is absent.
            const lastId = (await ctx.cache?.get<string>(CURSOR_CACHE_KEY)) ?? null;
            const idx = nextReconcilePathIndex(
                all.map((p) => p.id),
                lastId,
            );
            paths = [all[idx]];
            await ctx.cache?.set(CURSOR_CACHE_KEY, all[idx].id, CURSOR_TTL_MS);
            logger.debug('File reconcile: round-robin cycle', {
                pathId: all[idx].id,
                path: all[idx].path,
                cycle: `${idx + 1}/${all.length}`,
            });
        }

        if (paths.length === 0) {
            logger.info('File reconcile: no enabled library paths to reconcile');
            return {
                success: true,
                itemsProcessed: 0,
                result: {
                    pathsChecked: 0,
                    upserts: 0,
                    removes: 0,
                    deltaRunsDispatched: 0,
                    walkErrors: 0,
                    capped: 0,
                    excludedExtras: 0,
                    excludedExtrasDb: 0,
                    excludedThemes: 0,
                    excludedThemesDb: 0,
                    excludedSkipped: 0,
                    keptPresent: 0,
                },
            };
        }

        let totalUpserts = 0;
        let totalRemoves = 0;
        let deltaRunsDispatched = 0;
        let walkErrors = 0;
        let capped = 0;
        let totalExcludedExtras = 0;
        let totalExcludedExtrasDb = 0;
        let totalExcludedThemes = 0;
        let totalExcludedSkipped = 0;
        let totalExcludedThemesDb = 0;
        let totalKeptPresent = 0;

        for (const lp of paths) {
            if (signal.aborted) break;

            // Per-path isolation: a throw walking/diffing/dispatching ONE path
            // (e.g. its root went missing and readdir threw rather than
            // returning hadErrors) must not abort the whole cycle and skip every
            // other library. Mirrors file-library-scan's per-path fan-out.
            try {
                // Cheap recursive enumeration — readdir only, filtered to media
                // extensions, no per-file stat/probe.
                const walk = await walkDirectoryWithResult(lp.path);
                const dbPaths = await getMediaFilePathsByLibraryPrefix(sql, lp.path);

                const {
                    upsert,
                    removeAll,
                    removesSuppressed,
                    capped: pathCapped,
                    excludedExtras,
                    excludedExtrasDb,
                    excludedThemes,
                    excludedThemesDb,
                    excludedSkipped,
                } = computeReconcileDeltas(lp.path, walk.files, dbPaths, walk, {
                    maxDeltas: MAX_DELTAS_PER_PATH,
                    maxRemoveFraction: MAX_REMOVE_FRACTION,
                    minRemoveGuard: MIN_REMOVE_GUARD_COUNT,
                    // Best-effort: without Valkey the file is merely proposed again.
                    recentlySkipped: await listRecentReconcileSkips(lp.id).catch(
                        () => new Set<string>(),
                    ),
                });

                const {
                    remove,
                    stillPresent,
                    more: moreRemoves,
                } = await dropStillPresentRemoves(lp.path, removeAll, {
                    limit: MAX_DELTAS_PER_PATH,
                    signal,
                });
                if (stillPresent > 0) {
                    totalKeptPresent += stillPresent;
                    // Debug: an ignored file stays on disk and is seen every cycle.
                    logger.debug(
                        'File reconcile: kept known files that the walk no longer lists but are still on disk (ignore rule?)',
                        { libraryPathId: lp.id, path: lp.path, count: stillPresent },
                    );
                }

                if (removesSuppressed) {
                    if (removesSuppressed === 'walk-errors') walkErrors++;
                    logger.warn('File reconcile: removes suppressed for this path', {
                        libraryPathId: lp.id,
                        path: lp.path,
                        reason: removesSuppressed,
                        dbFiles: dbPaths.length,
                        diskFiles: walk.files.length,
                        errorPaths: walk.hadErrors ? walk.errorPaths.slice(0, 5) : undefined,
                    });
                }

                totalExcludedThemes += excludedThemes;
                totalExcludedSkipped += excludedSkipped;
                totalExcludedThemesDb += excludedThemesDb;

                if (excludedExtras > 0) {
                    totalExcludedExtras += excludedExtras;
                    // Not an error: these files must NOT become a primary
                    // upsert (see isExtrasPath). They're deferred to the next
                    // full scan's extras pass (walkExtras → processExtra).
                    logger.debug('File reconcile: withheld extras paths from upsert', {
                        libraryPathId: lp.id,
                        path: lp.path,
                        count: excludedExtras,
                    });
                }

                if (excludedExtrasDb > 0) {
                    totalExcludedExtrasDb += excludedExtrasDb;
                    // Not an error: a known extras row is never diffed for
                    // removal by reconcile — it isn't in reconcile's own
                    // extras-excluded disk listing and never will be, so
                    // treating that absence as "deleted from disk" would wipe
                    // every ingested extra on every cycle (see excludedExtrasDb
                    // doc on ReconcileDelta). The full scan owns extras'
                    // entire lifecycle, including their stale cleanup.
                    logger.debug('File reconcile: withheld extras paths from remove', {
                        libraryPathId: lp.id,
                        path: lp.path,
                        count: excludedExtrasDb,
                    });
                }

                if (upsert.length === 0 && remove.length === 0) continue;

                if (pathCapped || moreRemoves) {
                    capped++;
                    logger.info('File reconcile: delta set capped for this cycle', {
                        libraryPathId: lp.id,
                        path: lp.path,
                        cap: MAX_DELTAS_PER_PATH,
                    });
                }

                const res = await orchestrator.startRun(
                    'file-delta-ingest',
                    { libraryPathId: lp.id, upsert, remove },
                    {
                        trigger: {
                            kind: 'in-process',
                            by: 'file-reconcile',
                            sourceRoute: 'task.file-reconcile.delta',
                        },
                        parentRunId: ctx.runId,
                        libraryGroupId: lp.library_group_id,
                    },
                );
                // Count only after a successful dispatch so the run's reported
                // totals reflect work actually handed off (not work we tried to).
                deltaRunsDispatched++;
                totalUpserts += upsert.length;
                totalRemoves += remove.length;
                if (res.deduped) {
                    // A prior delta for this path is still running; our deltas
                    // are still on disk and will be re-detected next cycle.
                    logger.debug('File reconcile: delta dispatch deduped (prior run in flight)', {
                        libraryPathId: lp.id,
                    });
                }
            } catch (err) {
                logger.warn('File reconcile: path failed — continuing with remaining paths', {
                    libraryPathId: lp.id,
                    path: lp.path,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        if (
            totalUpserts > 0 ||
            totalRemoves > 0 ||
            totalExcludedExtras > 0 ||
            totalExcludedExtrasDb > 0 ||
            totalExcludedThemes > 0
        ) {
            logger.info('File reconcile complete', {
                pathsChecked: paths.length,
                upserts: totalUpserts,
                removes: totalRemoves,
                deltaRunsDispatched,
                walkErrors,
                capped,
                excludedExtras: totalExcludedExtras,
                excludedExtrasDb: totalExcludedExtrasDb,
                excludedThemes: totalExcludedThemes,
                excludedThemesDb: totalExcludedThemesDb,
                excludedSkipped: totalExcludedSkipped,
                keptPresent: totalKeptPresent,
            });
        }

        return {
            success: true,
            itemsProcessed: totalUpserts + totalRemoves,
            result: {
                pathsChecked: paths.length,
                upserts: totalUpserts,
                removes: totalRemoves,
                deltaRunsDispatched,
                walkErrors,
                capped,
                excludedExtras: totalExcludedExtras,
                excludedExtrasDb: totalExcludedExtrasDb,
                excludedThemes: totalExcludedThemes,
                excludedThemesDb: totalExcludedThemesDb,
                excludedSkipped: totalExcludedSkipped,
                keptPresent: totalKeptPresent,
            },
        };
    },
});

registry.registerTask(fileReconcileTask);
