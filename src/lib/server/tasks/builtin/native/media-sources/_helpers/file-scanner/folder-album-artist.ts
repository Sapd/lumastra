// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import path from 'node:path';
import type postgres from 'postgres';
import { findMusicAlbumFolderTracks } from '$lib/server/database/queries/music-album-folder.queries.js';
import { safeReaddir, safeStat } from '$lib/server/utils/safe-fs.js';
import { isAudioFile } from '$lib/server/utils/walk-directory.js';
import {
    resolveAlbumDir,
    deriveArtistName,
    folderAlbumTitle,
    hasMatchingDiscTitles,
} from '$lib/server/utils/music-scanner-utils.js';
import type { LibraryPathRow } from '$lib/server/database/queries/library-paths.queries.js';
import { parseAudioTags, type AudioTagResult } from './audio-tag-parser.js';
import { resolveArtistCredit } from './artist-credit.js';
import { getArtistCreditEvidence } from './artist-credit-evidence.js';
import {
    resolveAlbumArtist,
    normalizeAlbumArtist,
    type AlbumFileCredit,
    type AlbumArtistDecision,
} from './album-artist-rule.js';
import type { FileScannerContext } from './shared.js';

// Keep only small credit records, never cover bytes/lyrics. Re-stat on every
// run: watcher additions and retags get a fresh context at ingress.
type FolderCredit = AlbumFileCredit & { multiValuePrimary: boolean };
const tagCache = new Map<string, { signature: string; credit: FolderCredit }>();

async function folderFiles(albumDir: string, dir = albumDir): Promise<string[]> {
    const files: string[] = [];
    for (const entry of await safeReaddir(dir)) {
        const file = path.join(dir, entry.name);
        if (entry.isFile() && isAudioFile(path.extname(file).toLowerCase())) files.push(file);
        // Only descend CD/Disc folders belonging to THIS album, never another
        // release/subfolder and never symlinks.
        else if (
            entry.isDirectory() &&
            resolveAlbumDir(path.join(file, '_track.mp3')).albumDir === albumDir
        )
            files.push(...(await folderFiles(albumDir, file)));
    }
    return files.sort();
}

// One listing and tag snapshot per folder per run, including failed reads. Each
// decision filters that snapshot to its release, so flat folders are safe too.
const runFolders = new WeakMap<
    FileScannerContext,
    Map<string, Promise<Map<string, FolderCredit>>>
>();

export async function resolveFolderAlbumArtist(
    sql: postgres.Sql,
    filePath: string,
    tags: AudioTagResult,
    libraryPath: LibraryPathRow,
    context: FileScannerContext,
): Promise<AlbumArtistDecision & { discEvidence: boolean }> {
    const { albumDir } = resolveAlbumDir(filePath);
    const evidence = await getArtistCreditEvidence(sql);
    const credit = (t: AudioTagResult): FolderCredit => ({
        trackTitle: t.title,
        albumTitle: t.album,
        albumArtist: t.albumArtist,
        albumArtists: t.albumArtists,
        primaryArtist: t.artists?.[0] ?? t.artist ?? t.artistFromFilename,
        rawPrimaryArtist: t.artists?.[0] ?? t.artist ?? t.artistFromFilename,
        multiValuePrimary: Boolean(t.artists?.length),
        releaseGroupMbid: t.releaseGroupMbid,
        releaseMbid: t.releaseMbid,
        releaseArtistIds: t.musicbrainzAlbumArtistIds,
        compilation: t.compilation,
    });
    let folders = runFolders.get(context);
    if (!folders) {
        folders = new Map();
        runFolders.set(context, folders);
    }
    let pending = folders.get(albumDir);
    if (!pending) {
        pending = (async () => {
            let files: string[];
            try {
                files = await folderFiles(albumDir);
            } catch (error) {
                context.logger.info('[FileScanner] Album folder evidence unavailable', {
                    albumDir,
                    error: error instanceof Error ? error.message : String(error),
                });
                files = [filePath];
            }
            const snapshot = new Map<string, FolderCredit>();
            for (const file of files) {
                if (context.abortSignal?.aborted) throw new Error('Album evidence read aborted');
                if (file === filePath) {
                    if (!tags.parseError) snapshot.set(file, credit(tags));
                    continue;
                }
                try {
                    const stat = await safeStat(file);
                    const signature = `${stat.mtimeMs}:${stat.size}`;
                    let cached = tagCache.get(file);
                    if (cached?.signature !== signature) {
                        const parsed = await parseAudioTags(file, {
                            signal: context.abortSignal,
                            skipCovers: true,
                        });
                        if (parsed.parseError) continue;
                        cached = { signature, credit: credit(parsed) };
                        if (tagCache.size >= 2000) tagCache.clear();
                        tagCache.set(file, cached);
                    }
                    snapshot.set(file, cached.credit);
                } catch {
                    // Unreadable files are not part of the readable population.
                    if (context.abortSignal?.aborted)
                        throw new Error('Album evidence read aborted');
                }
            }
            return snapshot;
        })();
        folders.set(albumDir, pending);
    }
    let snapshot: Map<string, FolderCredit>;
    try {
        snapshot = await pending;
    } catch (error) {
        folders.delete(albumDir);
        throw error;
    }
    // Incoming tags may be newer than the snapshot (retag/retry within a run).
    if (!tags.parseError) snapshot.set(filePath, credit(tags));
    else snapshot.delete(filePath);
    const stored = await findMusicAlbumFolderTracks(
        sql,
        albumDir + path.sep,
        libraryPath.library_group_id,
    );
    const storedTitles =
        stored.length >= 1001
            ? []
            : stored
                  .filter(
                      (row) =>
                          row.file_path !== filePath &&
                          resolveAlbumDir(row.file_path).albumDir === albumDir,
                  )
                  .flatMap((row) => [row.album_title, row.track_metadata.album]);
    const otherTitles = [...snapshot.entries()]
        .filter(([file]) => file !== filePath)
        .map(([, file]) => file.albumTitle);
    const discEvidence =
        resolveAlbumDir(filePath).discNumber !== null ||
        hasMatchingDiscTitles(tags.album ?? '', [...storedTitles, ...otherTitles]);
    const credits = [...snapshot.values()].filter(
        (file) =>
            !(
                tags.album &&
                file.albumTitle &&
                normalizeAlbumArtist(folderAlbumTitle(tags.album, discEvidence)) !==
                    normalizeAlbumArtist(folderAlbumTitle(file.albumTitle, discEvidence))
            ) && !(tags.releaseMbid && file.releaseMbid && tags.releaseMbid !== file.releaseMbid),
    );
    // Classification uses available file/stored MB artist credits only. No HTTP
    // from placement: callers may already hold an album lock in a transaction.
    const result = resolveAlbumArtist(
        credits.map((file) => ({
            ...file,
            primaryArtist: file.multiValuePrimary
                ? file.primaryArtist
                : resolveArtistCredit(file.primaryArtist ?? '', evidence)[0],
        })),
        {
            creditEvidence: evidence,
            fallbackArtist: deriveArtistName({ filePath, albumDir, libraryRoot: libraryPath.path }),
        },
    );
    if (result.inconsistentAlbumArtists)
        context.logger.info(
            '[FileScanner] Inconsistent ALBUMARTIST tags; using album fallback evidence',
            { albumDir },
        );
    return { ...result, discEvidence };
}
