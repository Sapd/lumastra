// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import path from 'node:path';
import { hashLocalArtworkFile } from '$lib/server/utils/local-artwork-content-hash.js';
import type { Dirent } from 'node:fs';
import { safeExists, safeReaddir } from '$lib/server/utils/safe-fs.js';
import type postgres from 'postgres';
import type { ExtraEntry, ArtworkEntry } from '../../../../../../utils/walk-directory.js';
import { MEDIA_EXTENSIONS } from '../../../../../../utils/walk-directory.js';
import {
    parseMediaFilename,
    parseSubtitleFilename,
} from '../../../../../../utils/filename-parser.js';
import {
    insertExtraMediaItem,
    findSeasonByNumber,
} from '../../../../../../database/queries/media-items.queries.js';
import {
    upsertMediaFile,
    attachFileToItem,
    touchLibraryAddedAt,
    isFileLinkedToMediaItem,
    findParentMediaItemByFolder,
    findParentMediaItemsByFolders,
    findMediaItemByFilePath,
    findSeasonParentIfEpisode,
    findMediaFileByPath,
    findArtistByChildFolder,
    findRootMediaItemByFolderRecursive,
    findTvSeriesByFolderWithSeasonDirectory,
    loadMediaFileIdsByPrefix,
    updateFileStat,
} from '../../../../../../database/queries/media-files.queries.js';
import { hasControlChars } from './filename-safety.js';
import {
    upsertLocalArtworkWithOutcome,
    findManagedArtworkClaimForPath,
    type LocalArtworkUpsertOutcome,
} from '../../../../../../database/queries/media-artwork.queries.js';
import {
    upsertExternalSubtitle,
    loadExternalSubtitlesByPrefix,
    type ExternalSubtitleKey,
    type ExternalSubtitleUpsertOutcome,
} from '../../../../../../database/queries/external-subtitles.queries.js';
import { refreshLanguagesForFile } from '../../../../../../database/queries/media-item-languages.queries.js';
import { findLibraryGroupForItemTree } from '../../../../../../database/queries/media-extras.queries.js';
import { withTx } from '../../../../../../database/with-tx.js';
import {
    initFileChangeDetection,
    recordScanIssueWithCooldown,
    applyContentChange,
    probeNewFileForScan,
    clearStaleRefusalAndEnsureChangeDetection,
    type FileScannerContext,
} from './shared.js';
import { detectFileChanges } from './change-detection.js';
import { findLocalArtworkOwnedByOtherLibrary } from '../../../../../../database/queries/local-artwork-owner.queries.js';
import type { ScanOutcome } from './shared.js';

/**
 * Translate an artwork upsert into a scan outcome.
 *
 * The interesting mapping is 'unchanged' → 'skipped'. A library scan re-walks
 * every poster/fanart/banner sidecar on every cycle, so re-registering a row
 * that already points at exactly this file is the STEADY STATE, not a change:
 * counting it as 'added' is what made the admin scan table report `+8866 added`
 * for /data/movies against 159 artwork rows genuinely created in 24 hours.
 *
 * 'suppressed' (an admin-removed sidecar the write refused to resurrect) is
 * also 'skipped' — the scan summary must not claim a write that didn't happen.
 */
function scanOutcomeFor(outcome: LocalArtworkUpsertOutcome): 'added' | 'updated' | 'skipped' {
    if (outcome === 'inserted') return 'added';
    if (outcome === 'updated') return 'updated';
    return 'skipped';
}

export async function processExtra(
    sql: postgres.Sql,
    entry: ExtraEntry,
    context: FileScannerContext,
    abortSignal?: AbortSignal,
): Promise<'added' | 'skipped' | 'error'> {
    // A LINKED extra gets the same mtime/size/hash change detection
    // processVideoFile uses (detectFileChanges), and a content change goes
    // through the same applyContentChange (shared.ts) — one table decides
    // what each probe outcome writes (ruling T7-probe-outcomes), including
    // the probe-data invalidation, so a stale container_format cannot hide a
    // changed extra from the operator queries.
    const existingExtraFile = await findMediaFileByPath(sql, entry.filePath);
    const isLinked = existingExtraFile ? await isFileLinkedToMediaItem(sql, entry.filePath) : false;

    if (existingExtraFile && isLinked) {
        const changeResult = await detectFileChanges(existingExtraFile, entry.filePath);
        switch (changeResult.status) {
            case 'content-changed': {
                // Every outcome leaves the extra's own row in the state
                // applyContentChange chose; none of them is an ingest. A
                // transient probe failure is reported as 'error', like the
                // main path, so it shows in the scan's errors — the only
                // place a file that keeps failing that way is visible.
                const change = await applyContentChange(
                    sql,
                    {
                        id: existingExtraFile.id,
                        filePath: entry.filePath,
                        libraryGroupId: existingExtraFile.library_group_id ?? null,
                    },
                    {
                        mtime: changeResult.fileStat!.mtime,
                        size: changeResult.fileStat!.size,
                        hash: changeResult.currentHash!,
                    },
                    context,
                    abortSignal,
                );
                return change.kind === 'retry-next-scan' ? 'error' : 'skipped';
            }
            case 'first-backfill':
            case 'metadata-only':
                await updateFileStat(
                    sql,
                    existingExtraFile.id,
                    changeResult.fileStat!.mtime,
                    changeResult.fileStat!.size,
                    changeResult.currentHash!,
                );
                return 'skipped';
            case 'unchanged':
            case 'deleted':
            case 'error':
                return 'skipped';
        }
    }

    // F1b (fix plan 6, Task 7 fix round 1): extras go through this own
    // ingest path — upsertMediaFile + attachFileToItem below — so they get
    // processVideoFile's two guards through the same shared helpers: record a
    // scan issue and skip rather than link, honoring the same backoff
    // cooldown as the primary-file path.
    if (hasControlChars(entry.filePath)) {
        await recordScanIssueWithCooldown(
            sql,
            entry.filePath,
            null,
            'unsafe_filename',
            'Filename contains a control character (e.g. a newline). Rename the file to remove it so it can be ingested.',
        );
        context.logger.warn(
            '[FileScanner] Skipping extra — filename contains a control character; recorded as scan issue',
            { filePath: entry.filePath },
        );
        return 'skipped';
    }

    // Linked only when the probe came back `ok` — the same rule as a new
    // main file (ruling T7-probe-outcomes), which also reports a failed probe
    // as 'error'.
    const probeOutcome = await probeNewFileForScan(sql, entry.filePath, null, context, abortSignal);
    if (probeOutcome.kind === 'failed') {
        context.logger.warn('[FileScanner] Skipping extra — ffprobe failed', {
            filePath: entry.filePath,
            error: probeOutcome.error,
            failure: probeOutcome.failure,
        });
        return 'error';
    }
    // refused (recorded), aborted, or cooling-down (an unreadable extra
    // inside its retry window — see probeNewFileForScan).
    if (probeOutcome.kind !== 'ok') return 'skipped';

    // A previously-refused extra may reuse the SAME stub row on successful
    // re-ingest (upsertMediaFile's ON CONFLICT never touches health_issues).
    await clearStaleRefusalAndEnsureChangeDetection(sql, existingExtraFile, entry.filePath);

    // Resolve the parent item, in order:
    //   1. primaryFilePath match — when walkExtras matched a specific sibling
    //      primary by name (`B-trailer.mkv` → `B.mkv`), attach to THAT item.
    //      This disambiguates a folder holding several primaries.
    //   2. Folder direct match — the extra's folder has a primary file
    //      directly inside it (subfolder extras beside a movie, or a
    //      standalone `trailer.mp4` with no specific sibling to match).
    //   3. Recursive-root fallback — a series/artist folder has NO files of
    //      its own (only its episodes/tracks do, one or more subfolders
    //      down), so step 2 always misses for a series-level extra
    //      (`Series X/trailers/trailer.mp4`). Walk any linked file
    //      recursively under the folder up to its top-level ancestor
    //      (episode → season → series) instead.
    const parentMediaItemId =
        (entry.primaryFilePath
            ? await findMediaItemByFilePath(sql, entry.primaryFilePath)
            : null) ??
        (await findParentMediaItemByFolder(sql, entry.parentFolder)) ??
        (await findRootMediaItemByFolderRecursive(sql, entry.parentFolder));
    if (!parentMediaItemId) {
        context.logger.debug(
            `File scanner: no parent found for extra ${entry.filePath} — skipping`,
        );
        return 'skipped';
    }

    const parsed = parseMediaFilename(entry.filePath);
    const extraId = await insertExtraMediaItem(sql, {
        parentId: parentMediaItemId,
        title: parsed.title || path.basename(entry.filePath),
        extraType: entry.extraType,
    });

    // Inherit the parent's library group so access control (which treats
    // library_group_id = NULL as world-readable) gates the extra exactly like
    // the movie/series it belongs to. A series/season parent has no files of
    // its own — findLibraryGroupForItemTree falls back to walking its
    // descendants (episodes) for a group when the direct lookup comes up
    // empty, so a series trailer isn't stuck world-readable forever.
    const libraryGroupId = (await findLibraryGroupForItemTree(sql, parentMediaItemId)) ?? undefined;

    const { id: fileId } = await upsertMediaFile(sql, {
        filePath: entry.filePath,
        libraryGroupId,
    });
    await attachFileToItem(sql, fileId, extraId);
    // Stamp library_added_at on the extra row so its first-add date is recorded,
    // matching every other new-file attach path (the `attachFile` wrapper does
    // this for primary scan paths). propagateToAncestors=false: an extra
    // arriving must NOT resurface the parent movie in "Recently Added" — the
    // ancestors get COALESCE (no-op when already set).
    await touchLibraryAddedAt(sql, extraId, false);
    await initFileChangeDetection(sql, fileId, entry.filePath);

    return 'added';
}

/**
 * Where an artwork file attaches, or why it doesn't. A pure function of the
 * file's folder (plus the season number a flat `seasonNN-*` name carries), so a
 * scan resolves each folder once — a show root's poster/backdrop/logo/landscape/
 * folder.jpg used to repeat the same 3-6 lookups five times over.
 */
type ArtworkTarget = { kind: 'target'; id: string } | { kind: 'skip'; message: string };

/** Resolved targets for one scan, keyed by {@link artworkTargetKey}. */
export type ArtworkTargetCache = Map<string, ArtworkTarget>;

/** What an artwork file's target depends on: its folder, plus a flat season number. */
export function artworkTargetKey(entry: ArtworkEntry): string {
    return entry.seasonNumber !== undefined
        ? `season:${entry.seasonNumber}:${path.dirname(entry.filePath)}`
        : path.dirname(entry.filePath);
}

/**
 * Resolve every distinct folder's target once, `width` at a time. A failed
 * lookup is left OUT of the map rather than cached, so each file of that
 * folder retries it in {@link processArtwork} and reports its own error — one
 * pool timeout must not fail a whole folder's artwork.
 */
export async function resolveArtworkTargets(
    sql: postgres.Sql,
    entries: readonly ArtworkEntry[],
    width: number,
    isAborted: () => boolean,
): Promise<ArtworkTargetCache> {
    const firstByKey = new Map<string, ArtworkEntry>();
    for (const entry of entries) {
        const key = artworkTargetKey(entry);
        if (!firstByKey.has(key)) firstByKey.set(key, entry);
    }
    const queue = [...firstByKey];
    const targets: ArtworkTargetCache = new Map();
    const folderLookup = await createFolderLookup(sql, queue, isAborted);
    const worker = async (): Promise<void> => {
        for (let next = queue.shift(); next && !isAborted(); next = queue.shift()) {
            const [key, entry] = next;
            try {
                targets.set(key, await resolveArtworkTarget(sql, entry, folderLookup));
            } catch {
                /* retried per file by processArtwork, which records the error */
            }
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(width, queue.length)) }, worker));
    return targets;
}

/**
 * The media_artwork row a file writes, once its target is known: files sharing
 * this key must be processed in walk order so "last write wins" stays what a
 * serial pass produced. Two top-level folders can resolve to ONE series (anime
 * `Show/` + `Show Final Season/`), so grouping by folder is not enough. Files
 * that write nothing (skipped, or unresolved) are independent.
 */
export function artworkWriteKey(entry: ArtworkEntry, targets: ArtworkTargetCache): string {
    const target = targets.get(artworkTargetKey(entry));
    return target?.kind === 'target'
        ? `${target.id}\u0000${entry.artworkType}`
        : `file:${entry.filePath}`;
}

/** {@link findParentMediaItemByFolder}, or a phase-scoped memo of it. */
type FolderLookup = (folder: string) => Promise<string | null>;

/**
 * The {@link findParentMediaItemByFolder} answers for ONE target-resolution
 * phase: every generic entry's own folder prefetched in one batched statement
 * per 1,000 folders, and every other folder (the parent-folder fallback)
 * queried on first use, its answer shared after that.
 *
 * Same answers as a query per call, because nothing this scan does while the
 * phase runs can change them. The scanner reaches this pass only after the
 * library's file pass has drained (every primary written — the same fact the
 * {@link ArtworkTargetCache} already relies on), and the passes that run beside
 * it link nothing the lookup can see: the extras pass links only
 * media_type = 'extra' items, which the lookup excludes, and the sidecar pass
 * writes subtitle rows. What the memo saves: prod's /data/music has ~280 artist
 * folders with no file of their own, and each one fell back to the SAME
 * library-root lookup — a ~45 ms walk of the whole file_path index — every scan.
 *
 * Only answers are memoised, never failures or in-flight queries: a failed
 * prefetch falls back to the per-folder query, and a failed per-folder query
 * throws to its caller alone (which leaves that key out, as before) while the
 * next caller queries again.
 */
async function createFolderLookup(
    sql: postgres.Sql,
    queue: ReadonlyArray<readonly [string, ArtworkEntry]>,
    isAborted: () => boolean,
): Promise<FolderLookup> {
    const memo = new Map<string, string | null>();
    const ownFolders = queue
        .filter(([, entry]) => entry.seasonNumber === undefined)
        .map(([, entry]) => path.dirname(entry.filePath));
    if (ownFolders.length > 0 && !isAborted()) {
        try {
            const prefetched = await findParentMediaItemsByFolders(sql, ownFolders);
            for (const [folder, id] of prefetched) memo.set(folder, id);
        } catch {
            /* no prefetch: each folder is queried on first use below */
        }
    }
    return async (folder) => {
        if (memo.has(folder)) return memo.get(folder)!;
        const id = await findParentMediaItemByFolder(sql, folder);
        memo.set(folder, id);
        return id;
    };
}

async function resolveArtworkTarget(
    sql: postgres.Sql,
    entry: ArtworkEntry,
    lookupFolder: FolderLookup = (folder) => findParentMediaItemByFolder(sql, folder),
): Promise<ArtworkTarget> {
    // FLAT SEASON CONVENTION (`Show/season01-poster.jpg`) — walkArtwork tagged
    // this entry with the season it names. These files live in the SERIES root,
    // and the generic resolution below gets it wrong in BOTH layouts:
    //   - season-foldered: findParentMediaItemByFolder is direct-children only
    //     (`NOT LIKE '<folder>/%/%'`, media-files.queries.ts:740) and the series
    //     root owns no files, so the file was dropped silently.
    //   - folderless: it resolves the episode sitting in the same directory and
    //     findSeasonParentIfEpisode redirects to SEASON 1 whatever number the
    //     filename carries — season07-poster.jpg landed on season 1.
    // Resolve the series RECURSIVELY from the folder (episode -> season ->
    // series), then pick its season by number.
    //
    // No fallback into the generic resolution below: a season-named file
    // attached to the series would overwrite the series' own poster, and
    // attached to season 1 would corrupt an unrelated season. An unresolvable
    // season is a 'skipped' — the next scan retries it once the season row
    // exists. findRootMediaItemByFolderRecursive does not check media_type, but
    // findSeasonByNumber only matches media_type = 'season' children, so a
    // non-series root (movie, music artist) yields null and we skip.
    if (entry.seasonNumber !== undefined) {
        const seriesFolder = path.dirname(entry.filePath);
        const seriesId = await findRootMediaItemByFolderRecursive(sql, seriesFolder);
        if (!seriesId) {
            return { kind: 'skip', message: 'no series resolved for season artwork' };
        }
        const seasonId = await findSeasonByNumber(sql, seriesId, entry.seasonNumber);
        if (!seasonId) {
            return {
                kind: 'skip',
                message: `series ${seriesId} has no season ${entry.seasonNumber} for`,
            };
        }
        return { kind: 'target', id: seasonId };
    }

    // Artwork is at <movie_folder>/backdrop.jpg
    // or at <movie_folder>/Season 01/backdrop.jpg for TV
    const folder = path.dirname(entry.filePath);
    let targetId = await lookupFolder(folder);
    let isArtist = false;

    if (!targetId) {
        // Series-root artwork normally has no primary file beside it: episodes
        // live in a season subdirectory. Resolve that constrained layout back
        // to its TV-series root so `Show/backdrop.jpg` is not skipped. This is
        // intentionally a fallback: artwork beside an episode in a season
        // folder keeps the direct-match behavior below and is routed there.
        targetId = await findTvSeriesByFolderWithSeasonDirectory(sql, folder);
    }

    if (!targetId) {
        // Could be a TV season folder — try the parent folder too.
        // No season redirect here: parent-folder artwork (e.g. /Show/backdrop.jpg)
        // should attach to whatever item is found, not to a specific season.
        const parentFolder = path.dirname(folder);
        targetId = await lookupFolder(parentFolder);
        if (!targetId) {
            // Artist-level artwork: folder contains album subdirectories
            targetId = await findArtistByChildFolder(sql, folder);
            isArtist = !!targetId;
        }
    }

    if (!targetId) return { kind: 'skip', message: 'no media_item for artwork' };

    // Season redirect only applies to video items, not artists
    if (!isArtist) {
        // If the folder contains episodes, artwork should attach to the season
        // parent — not to an arbitrary episode. findParentMediaItemByFolder can
        // only return items with files, which are episodes in a season folder.
        const seasonId = await findSeasonParentIfEpisode(sql, targetId);
        if (seasonId) targetId = seasonId;
    }
    return { kind: 'target', id: targetId };
}

/**
 * What one artwork file did to its row. `ownsRow` is true when the row now
 * points at THIS file — written, or already exactly right — or is held by
 * another enabled library; either way no earlier file in the same write group
 * may touch it. False when the file wrote nothing it could stand behind
 * (unresolved target, a managed claim elsewhere, an admin tombstone), so the
 * next candidate in the group gets its turn — exactly the file that won under
 * the old "every file writes, last write wins" pass.
 */
export interface ArtworkWriteResult {
    outcome: 'added' | 'updated' | 'skipped';
    ownsRow: boolean;
}

/**
 * Process a single artwork image: find linked media_item for the folder,
 * upsert into media_artwork.
 *
 * `targets` holds the scan's pre-resolved folder targets
 * ({@link resolveArtworkTargets}) — valid because the scanner runs this pass
 * after every video in the library is written, and nothing here creates items.
 *
 * `libraryRoot` (the library path being scanned) enables the cross-library
 * rule: a row that points at a live file of ANOTHER enabled library is left
 * alone. One item with sidecars in two library folders otherwise has its single
 * local row re-pointed by each folder's scan in turn — prod reported the same
 * "216 updated" for /data/movies and /data/4kmovies every hour for that reason.
 */
export async function processArtworkDetailed(
    sql: postgres.Sql,
    entry: ArtworkEntry,
    context: FileScannerContext,
    targets?: ArtworkTargetCache,
    libraryRoot?: string,
): Promise<ArtworkWriteResult> {
    const target =
        targets?.get(artworkTargetKey(entry)) ?? (await resolveArtworkTarget(sql, entry));
    if (target.kind === 'skip') {
        context.logger.debug(`File scanner: ${target.message} ${entry.filePath}`);
        return { outcome: 'skipped', ownsRow: false };
    }
    const targetId = target.id;

    // Do not re-attribute a file that a MANAGED row on a different item already
    // claims. In a season-folderless layout `Show/poster.jpg` is the SERIES poster
    // this application materialized, but the folder holds the episode files, so the
    // resolution above lands on season 1 — and the season's row would be silently
    // re-pointed at the series' image one scan after every backfill.
    //
    // Scoped to a DIFFERENT item on purpose: without the exclusion, the legitimate
    // re-registration of `Show/Season 01/poster.jpg` onto the season that already
    // claims it would report 'skipped' and under-count every scan.
    const claim = await findManagedArtworkClaimForPath(sql, entry.filePath, targetId);
    if (claim) {
        context.logger.debug(
            `File scanner: ${entry.filePath} is already claimed by managed artwork on ${claim.media_item_id} — not re-attributing to ${targetId}`,
        );
        return { outcome: 'skipped', ownsRow: false };
    }

    if (libraryRoot) {
        const owner = await findLocalArtworkOwnedByOtherLibrary(
            sql,
            targetId,
            entry.artworkType,
            libraryRoot,
        );
        // Only while that file still exists: a deleted sidecar must not pin the
        // row to nothing until its own library's next cleanup.
        if (owner && (await safeExists(owner))) {
            return { outcome: 'skipped', ownsRow: true };
        }
    }

    // Keep measurement at the filesystem boundary; DB registration remains pure SQL.
    // Unreadable legacy sidecars may still register, but cannot claim byte identity.
    let localContentHash: string | undefined;
    try {
        localContentHash = await hashLocalArtworkFile(
            entry.filePath,
            libraryRoot ? [libraryRoot] : [],
        );
    } catch {
        context.logger.debug(`File scanner: could not measure artwork ${entry.filePath}`);
    }
    const upsert = await upsertLocalArtworkWithOutcome(sql, {
        mediaItemId: targetId,
        artworkType: entry.artworkType,
        filePath: entry.filePath,
        localContentHash,
    });
    return { outcome: scanOutcomeFor(upsert), ownsRow: upsert !== 'suppressed' };
}

/** {@link processArtworkDetailed}, reduced to the scan outcome. */
export async function processArtwork(
    sql: postgres.Sql,
    entry: ArtworkEntry,
    context: FileScannerContext,
    targets?: ArtworkTargetCache,
    libraryRoot?: string,
): Promise<'added' | 'updated' | 'skipped'> {
    return (await processArtworkDetailed(sql, entry, context, targets, libraryRoot)).outcome;
}

/**
 * The artwork list with every write group (files aimed at one row, see
 * {@link artworkWriteKey}) in REVERSE walk order, groups otherwise in the order
 * they were first seen. Paired with {@link createArtworkGroupProcessor}.
 */
export function orderArtworkLastWriterFirst(
    entries: readonly ArtworkEntry[],
    targets: ArtworkTargetCache,
): ArtworkEntry[] {
    const groups = new Map<string, ArtworkEntry[]>();
    for (const entry of entries) {
        const key = artworkWriteKey(entry, targets);
        const group = groups.get(key);
        if (group) group.push(entry);
        else groups.set(key, [entry]);
    }
    return [...groups.values()].flatMap((group) => group.reverse());
}

/**
 * Artwork processor for one scan that writes each row ONCE.
 *
 * Several files can aim at one row (`poster.jpg` + `folder.jpg`, or anime
 * `Show/` + `Show Final Season/` resolving to one series). The old pass wrote
 * every one of them in walk order, so the row flipped A→B within every scan and
 * each file reported 'updated' — hourly, forever, with nothing on disk
 * changing. Fed {@link orderArtworkLastWriterFirst}'s order, the first file that
 * owns its row settles the group and the rest are 'skipped': the same final
 * row as "last write wins", and a no-op on a scan where nothing changed.
 * Relies on processItemsGrouped running one write group strictly serially.
 */
export function createArtworkGroupProcessor(
    sql: postgres.Sql,
    context: FileScannerContext,
    targets: ArtworkTargetCache,
    libraryRoot: string,
): (entry: ArtworkEntry) => Promise<ScanOutcome> {
    const settled = new Set<string>();
    return async (entry) => {
        const key = artworkWriteKey(entry, targets);
        if (settled.has(key)) return 'skipped';
        const result = await processArtworkDetailed(sql, entry, context, targets, libraryRoot);
        if (result.ownsRow) settled.add(key);
        return result.outcome;
    };
}

/**
 * Per-library state for a scan's sidecar pass. With it, `processExternalSubtitle`
 * recognises an unchanged sidecar from memory (no DB round trip), reads each
 * directory once instead of once per sidecar, and leaves the language
 * projection to one {@link convergeSidecarLanguagesByPrefix} call after the
 * pass. Without it (the tests' legacy path) every sidecar is upserted and its
 * file's projection refreshed on the spot.
 */
export interface SubtitleScanBatch {
    /** Existing sidecar rows under the library path, by subtitle_path. */
    existing: Map<string, ExternalSubtitleKey>;
    /** media_files.id by file_path under the library path. */
    fileIdByPath: Map<string, string>;
    /** Memoised directory listings — sidecars of one season share a folder. */
    dirEntries: Map<string, Promise<Dirent[] | null>>;
    /**
     * Files a sidecar was re-paired AWAY from this pass. They no longer own that
     * sidecar, so the prefix-scoped convergence would not otherwise revisit them.
     */
    orphanedFileIds: Set<string>;
}

export async function loadSubtitleScanBatch(
    sql: postgres.Sql,
    libraryPath: string,
): Promise<SubtitleScanBatch> {
    const [existing, fileIdByPath] = await Promise.all([
        loadExternalSubtitlesByPrefix(sql, libraryPath),
        loadMediaFileIdsByPrefix(sql, libraryPath),
    ]);
    return { existing, fileIdByPath, dirEntries: new Map(), orphanedFileIds: new Set() };
}

/**
 * Process a single external subtitle file:
 * 1. Find the video file in the same directory with matching base name
 * 2. Look up the media_files.id for that video path
 * 3. Parse subtitle filename for language, forced, SDH flags
 * 4. Upsert into external_subtitle_files
 *
 * The outcome distinguishes a FIRST sighting ('added') from a re-registration
 * that changed something ('updated') from the steady state ('skipped'). It used
 * to return 'added' unconditionally on every paired sidecar, which is the
 * dominant term in the admin scan table's change count: production reported
 * `+9781 added` for /data/series against zero rows created in 24 hours.
 */
export async function processExternalSubtitle(
    sql: postgres.Sql,
    subtitlePath: string,
    context: FileScannerContext,
    batch?: SubtitleScanBatch,
): Promise<'added' | 'updated' | 'skipped'> {
    const subtitleDir = path.dirname(subtitlePath);
    const subtitleExt = path.extname(subtitlePath).toLowerCase();
    const subtitleStem = path.basename(subtitlePath, subtitleExt);

    // Parse subtitle filename to get base name and metadata
    const parsed = parseSubtitleFilename(subtitlePath);

    // Find the video file in the same directory with matching base name
    let videoFilePath: string | null = null;
    let listing = batch?.dirEntries.get(subtitleDir);
    if (!listing) {
        // best-effort: unreadable subtitle dir → skip pairing this subtitle.
        listing = safeReaddir(subtitleDir).catch(() => null);
        batch?.dirEntries.set(subtitleDir, listing);
    }
    const entries = await listing;
    if (!entries) return 'skipped';

    for (const entry of entries) {
        if (!entry.isFile()) continue;
        const videoExt = path.extname(entry.name).toLowerCase();
        if (!MEDIA_EXTENSIONS.has(videoExt)) continue;
        const videoStem = path.basename(entry.name, videoExt);
        // Match: video stem equals subtitle base name, or subtitle stem starts with video stem
        if (videoStem === parsed.baseName || subtitleStem.startsWith(videoStem + '.')) {
            videoFilePath = path.join(subtitleDir, entry.name);
            break;
        }
    }

    if (!videoFilePath) {
        context.logger.debug(`File scanner: no video file found for subtitle ${subtitlePath}`);
        return 'skipped';
    }

    // Look up media_files row for the video file
    const fileId =
        batch?.fileIdByPath.get(videoFilePath) ??
        (await findMediaFileByPath(sql, videoFilePath))?.id;
    if (!fileId) {
        context.logger.debug(`File scanner: video file not yet in media_files: ${videoFilePath}`);
        return 'skipped';
    }

    const params = {
        fileId,
        subtitlePath,
        language: parsed.language,
        format: parsed.format,
        isForced: parsed.isForced,
        isSDH: parsed.isSDH,
    };

    if (batch) {
        // The same comparison upsertExternalSubtitle's IS DISTINCT FROM guard
        // makes, done in memory: a match is exactly the upsert's 'unchanged'.
        const prior = batch.existing.get(subtitlePath);
        if (
            prior &&
            prior.file_id === params.fileId &&
            prior.language === params.language &&
            prior.format === params.format &&
            prior.is_forced === params.isForced &&
            prior.is_sdh === params.isSDH
        ) {
            return 'skipped';
        }
        const upsert = await upsertExternalSubtitle(sql, params);
        if (prior && prior.file_id !== params.fileId) batch.orphanedFileIds.add(prior.file_id);
        if (upsert === 'inserted') return 'added';
        return upsert === 'updated' ? 'updated' : 'skipped';
    }

    // Upsert into external_subtitle_files, then refresh the language
    // projection in the same transaction so a sidecar added next to an
    // already-probed file surfaces in the /browse subtitle filter without
    // waiting for a re-probe/rebuild.
    const upsert: ExternalSubtitleUpsertOutcome = await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        const result = await upsertExternalSubtitle(tx, params);
        // Deliberately NOT gated on `upsert !== 'unchanged'`: this is also the
        // only thing that back-fills the projection for a sidecar that was
        // registered BEFORE its video file was linked to a media_item, and that
        // file's subtitle row never changes again. (The batch path above covers
        // the same case with convergeSidecarLanguagesByPrefix after the pass.)
        await refreshLanguagesForFile(tx, fileId);
        return result;
    });

    // 'unchanged' — the row was already exactly right, so nothing was added.
    if (upsert === 'inserted') return 'added';
    return upsert === 'updated' ? 'updated' : 'skipped';
}
