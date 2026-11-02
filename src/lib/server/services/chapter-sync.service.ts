// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Chapter Sync Service
 *
 * Extracts chapter metadata from local media files using ffprobe.
 * Falls back to Jellyfin API when no local file is available.
 * Handles series, season, episode, and movie media types.
 */

import type postgres from 'postgres';
import { jellyfinSeriesService } from '$lib/server/jellyfin/index.js';
import {
    loadKnownFileChapters,
    upsertChaptersForFile,
} from '$lib/server/database/queries/episode-chapters.queries.js';
import { refreshSegmentsForFile } from '$lib/server/database/queries/file-segments.queries.js';
import { getFilesForMediaItem } from '$lib/server/database/queries/media-files.queries.js';
import { probeChaptersWithStat } from '$lib/server/utils/chapter-probe-stat.js';
import { resolveMediaPath } from '$lib/server/utils/media-path-resolver.js';
import { replaceProbedFileChapters } from './file-chapters.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { isSeries, isSeason } from '$lib/server/utils/media-types.js';

const logger = Logger.for('ChapterSync');

export interface ChapterSyncProgress {
    phase: 'fetching' | 'storing' | 'done';
    message: string;
    episodesProcessed: number;
    totalEpisodes: number;
    chaptersFound: number;
}

export interface ChapterSyncResult {
    episodesProcessed: number;
    episodesWithChapters: number;
    totalChapters: number;
    /**
     * Episodes whose linked file was present in the DB but could NOT be read
     * this run (`resolveMediaPath` returned inaccessible) and were not rescued
     * by the Jellyfin fallback. Distinct from "file read, genuinely no chapters"
     * — the caller uses this to avoid marking the coverage stage `completed`
     * when nothing could actually be determined (which would permanently strand
     * the item; see chapter-sync task).
     */
    inaccessibleFiles: number;
}

/**
 * Outcome of probing a single file for chapters.
 * - `stored`: file read, chapters found and persisted
 * - `empty`: file read successfully, but it has no embedded chapters
 * - `inaccessible`: file path could not be resolved/read this run
 */
type FileChapterOutcome = 'stored' | 'empty' | 'inaccessible' | 'retry';

interface EpisodeRow {
    media_item_id: string;
    jellyfin_id: string | null;
    file_id: string | null;
    file_path: string | null;
    season_number: number | null;
    episode_number: number | null;
}

/** Options for {@link syncSeriesChapters}. */
export interface ChapterSyncOptions {
    /**
     * Probe every file again, even when its chapters are already known from the
     * scanner or an earlier sync. The admin "re-sync chapters" path sets it.
     */
    force?: boolean;
}

/**
 * Sync chapter metadata for a media item of any type.
 * - series: syncs all episodes across all seasons
 * - season: syncs all episodes in that season
 * - episode/movie: syncs just that single item
 *
 * Primary: extract from local media files via ffprobe, unless the file's
 * chapters are already known (see {@link syncFromFile}).
 * Fallback: fetch from Jellyfin API when no file is linked.
 */
export async function syncSeriesChapters(
    sql: postgres.Sql,
    mediaId: string,
    jellyfinUserId?: string,
    onProgress?: (progress: ChapterSyncProgress) => void,
    signal?: AbortSignal,
    options: ChapterSyncOptions = {},
): Promise<ChapterSyncResult> {
    const force = options.force === true;
    const [row] = await sql<{ media_type: string }[]>`
        SELECT media_type FROM media_items WHERE id = ${mediaId}
    `;
    if (!row) {
        return {
            episodesProcessed: 0,
            episodesWithChapters: 0,
            totalChapters: 0,
            inaccessibleFiles: 0,
        };
    }

    const mediaType = row.media_type;

    if (isSeries(mediaType)) {
        return syncEpisodeList(
            sql,
            await sql<EpisodeRow[]>`
                SELECT * FROM (
                    SELECT DISTINCT ON (mi.id)
                           mi.id AS media_item_id,
                           ei.external_id AS jellyfin_id,
                           mf.id AS file_id,
                           mf.file_path,
                           mi.season_number, mi.episode_number
                    FROM media_items mi
                    JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
                    LEFT JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'jellyfin'
                    LEFT JOIN media_file_items mfi ON mfi.media_item_id = mi.id
                    LEFT JOIN media_files mf ON mf.id = mfi.file_id
                    WHERE season.parent_id = ${mediaId} AND mi.media_type = 'episode'
                    ORDER BY mi.id, mfi.is_default DESC NULLS LAST, mfi.sort_order NULLS LAST
                ) sub
                ORDER BY sub.season_number, sub.episode_number
            `,
            jellyfinUserId,
            onProgress,
            signal,
            force,
        );
    }

    if (isSeason(mediaType)) {
        return syncEpisodeList(
            sql,
            await sql<EpisodeRow[]>`
                SELECT * FROM (
                    SELECT DISTINCT ON (mi.id)
                           mi.id AS media_item_id,
                           ei.external_id AS jellyfin_id,
                           mf.id AS file_id,
                           mf.file_path,
                           mi.season_number, mi.episode_number
                    FROM media_items mi
                    LEFT JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'jellyfin'
                    LEFT JOIN media_file_items mfi ON mfi.media_item_id = mi.id
                    LEFT JOIN media_files mf ON mf.id = mfi.file_id
                    WHERE mi.parent_id = ${mediaId} AND mi.media_type = 'episode'
                    ORDER BY mi.id, mfi.is_default DESC NULLS LAST, mfi.sort_order NULLS LAST
                ) sub
                ORDER BY sub.episode_number
            `,
            jellyfinUserId,
            onProgress,
            signal,
            force,
        );
    }

    // episode or movie — single item, prefer the default file
    const [item] = await sql<EpisodeRow[]>`
        SELECT mi.id AS media_item_id,
               ei.external_id AS jellyfin_id,
               mf.id AS file_id,
               mf.file_path,
               mi.season_number, mi.episode_number
        FROM media_items mi
        LEFT JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'jellyfin'
        LEFT JOIN media_file_items mfi ON mfi.media_item_id = mi.id
        LEFT JOIN media_files mf ON mf.id = mfi.file_id
        WHERE mi.id = ${mediaId}
        ORDER BY mfi.is_default DESC NULLS LAST, mfi.sort_order ASC NULLS LAST
        LIMIT 1
    `;

    if (!item) {
        return {
            episodesProcessed: 0,
            episodesWithChapters: 0,
            totalChapters: 0,
            inaccessibleFiles: 0,
        };
    }

    return syncEpisodeList(sql, [item], jellyfinUserId, onProgress, signal, force);
}

async function syncEpisodeList(
    sql: postgres.Sql,
    episodes: EpisodeRow[],
    jellyfinUserId: string | undefined,
    onProgress?: (progress: ChapterSyncProgress) => void,
    signal?: AbortSignal,
    force = false,
): Promise<ChapterSyncResult> {
    let episodesProcessed = 0;
    let episodesWithChapters = 0;
    let totalChapters = 0;
    let inaccessibleFiles = 0;

    for (const ep of episodes) {
        if (signal?.aborted) break;
        onProgress?.({
            phase: 'fetching',
            message: `Extracting chapters for S${ep.season_number ?? 0}E${ep.episode_number ?? 0}`,
            episodesProcessed,
            totalEpisodes: episodes.length,
            chaptersFound: totalChapters,
        });

        try {
            let stored = false;
            // True only when a file was linked but couldn't be read — NOT when a
            // file was read and simply had no chapters, and NOT when the episode
            // has no file at all (a legitimately-absent file is not a failure).
            let fileInaccessible = false;
            let staleProbe = false;

            if (ep.file_path) {
                const outcome = await syncFromFile(
                    sql,
                    ep.media_item_id,
                    ep.file_id,
                    ep.file_path,
                    signal,
                    force,
                );
                if (outcome === 'stored') stored = true;
                else if (outcome === 'inaccessible') fileInaccessible = true;
                else if (outcome === 'retry') {
                    staleProbe = true;
                    fileInaccessible = true;
                }
            }

            if (!stored && !staleProbe && ep.jellyfin_id && jellyfinUserId) {
                const jellyfinStored = await syncFromJellyfin(
                    sql,
                    ep.media_item_id,
                    ep.jellyfin_id,
                    jellyfinUserId,
                );
                // The Jellyfin fallback rescued an otherwise-unreadable file —
                // no longer counts as inaccessible.
                if (jellyfinStored) {
                    stored = true;
                    fileInaccessible = false;
                }
            }

            if (stored) {
                episodesWithChapters++;
                const [row] = await sql`
                    SELECT COUNT(*) AS count FROM episode_chapters ec
                    JOIN media_file_items mfi ON mfi.file_id = ec.file_id
                    WHERE mfi.media_item_id = ${ep.media_item_id}
                `;
                totalChapters += Number(row?.count ?? 0);
            } else if (fileInaccessible) {
                inaccessibleFiles++;
            }
        } catch (err) {
            // A rolled-back replacement/refresh is unfinished work. The task
            // consumes this count to retain retryable stage state.
            inaccessibleFiles++;
            logger.warn('Failed to sync chapters for episode', {
                mediaItemId: ep.media_item_id,
                error: err,
            });
        }

        episodesProcessed++;
    }

    onProgress?.({
        phase: 'done',
        message: `Synced chapters: ${episodesWithChapters}/${episodes.length} episodes have chapters (${totalChapters} total)`,
        episodesProcessed,
        totalEpisodes: episodes.length,
        chaptersFound: totalChapters,
    });

    return { episodesProcessed, episodesWithChapters, totalChapters, inaccessibleFiles };
}

/**
 * Extract chapters from a local file using ffprobe.
 *
 * The file's chapters are reused, with no ffprobe, when they are already known:
 * the scanner or an earlier run stored them and the file's chapter marker still
 * matches its stat (see `loadKnownFileChapters`). A `force` run always probes.
 * A successful probe is marked, even when it found no chapters; a failed one is
 * not, so the next run tries again.
 */
async function syncFromFile(
    sql: postgres.Sql,
    mediaItemId: string,
    fileId: string | null,
    filePath: string,
    signal?: AbortSignal,
    force = false,
): Promise<FileChapterOutcome> {
    const resolved = await resolveMediaPath(filePath, { skipLocalAccessCheck: true }, sql);
    // File path is recorded in the DB but cannot be read this run (not mounted,
    // not yet imported, NFS blip, …). This is NOT "no chapters" — surface it as
    // inaccessible so the caller can retry rather than mark the stage complete.
    if (!resolved || !resolved.isAccessible) return 'inaccessible';

    if (!force && fileId) {
        const known = await loadKnownFileChapters(sql, fileId);
        if (known) {
            // Nothing stored means the file was probed and has no chapters.
            if (known.chapters.length === 0) return 'empty';
            await refreshSegmentsForFile(sql, fileId);
            return 'stored';
        }
    }

    // The probe reports the stat it ran against. The marker records that stat,
    // not the row's, so a file rewritten during the probe is never marked.
    const result = await probeChaptersWithStat(resolved.containerPath, { signal });
    if (!result.success) return 'inaccessible';
    if (!result.stat || signal?.aborted) return 'retry';

    let resolvedFileId = fileId;
    if (!resolvedFileId) {
        const files = await getFilesForMediaItem(sql, mediaItemId);
        const defaultFile = files.find((f) => f.is_default) ?? files[0];
        if (!defaultFile) {
            logger.warn('No file linked to media item, cannot store chapters', {
                mediaItemId,
            });
            // We read the file fine — the inability to store is a data issue, not
            // an access failure; don't trigger a retry loop. Treat as empty.
            return 'empty';
        }
        resolvedFileId = defaultFile.id;
    }
    const stored = await replaceProbedFileChapters(
        sql,
        resolvedFileId,
        result,
        resolved.containerPath,
        { signal },
    );
    if (!stored) return 'retry';
    return result.chapters.length === 0 ? 'empty' : 'stored';
}

/**
 * Fetch chapters from Jellyfin API (fallback).
 */
async function syncFromJellyfin(
    sql: postgres.Sql,
    mediaItemId: string,
    jellyfinId: string,
    jellyfinUserId: string,
): Promise<boolean> {
    const result = await jellyfinSeriesService.getItemWithChapters(jellyfinId, jellyfinUserId);

    if (!result?.chapters || result.chapters.length === 0) return false;

    const chapters = result.chapters.map((ch, idx) => ({
        chapterIndex: ch.index ?? idx,
        chapterName: ch.name || null,
        startTicks: String(ch.startPositionTicks),
        endTicks:
            idx < result.chapters.length - 1
                ? String(result.chapters[idx + 1].startPositionTicks)
                : result.runTimeTicks > 0
                  ? String(result.runTimeTicks)
                  : null,
        source: 'jellyfin',
    }));

    const files = await getFilesForMediaItem(sql, mediaItemId);
    const defaultFile = files.find((f) => f.is_default) ?? files[0];
    if (!defaultFile) {
        logger.warn('No file linked to media item, cannot store Jellyfin chapters', {
            mediaItemId,
        });
        return false;
    }
    await upsertChaptersForFile(sql, defaultFile.id, chapters);
    await refreshSegmentsForFile(sql, defaultFile.id);
    return true;
}
