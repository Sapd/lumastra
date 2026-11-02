// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ONE definition of "does this episode have a usable thumbnail", and what it
 * would take to fix it.
 *
 * Before this module there were three, each owned by a different scheduled task
 * and each subtly wrong on the reference library (measured 2026-07-20):
 *
 *   episode-thumbnail-backfill  "no media_artwork row exists"
 *                               -> 0 candidates across 2,823 runs, because the
 *                                  broken episodes DID have a row; it pointed at
 *                                  a sibling's file.
 *   episode-thumbnail-repair (retired) "several episodes in a season share one
 *                                file_path"
 *                               -> found them, then enqueued a folder re-scan
 *                                  that cannot help when no file exists. 1,370
 *                                  runs, `remaining` frozen, success reported.
 *   episode-thumbnail-generate  "no file on disk"
 *                               -> correct, but a fourth opinion.
 *
 * They partitioned the problem space only by accident, and the gap between them
 * is where ~18,000 episodes sat. The fix is not a fourth definition: it is one
 * classifier that every strategy consults.
 *
 * The distinction that matters is REMAP vs GENERATE. An episode whose own
 * artwork file is already on disk needs a database update costing nothing; an
 * episode with no file needs an ffmpeg decode over NFS. Conflating them is what
 * made the repair task burn series walks twice an hour for nothing.
 */

import { basename, dirname } from 'path';
import { ownsEpisodeThumb } from '../utils/episode-thumbnail-ownership.js';
import { artworkFileName } from '$lib/server/utils/artwork-filename.js';
import type { EpisodeThumbnailWorkRow } from '$lib/server/database/queries/media-artwork.queries.js';

export type EpisodeThumbnailState =
    /** Own artwork file exists on disk but the row does not point at it. Fix: UPDATE. */
    | 'unmapped'
    /** No artwork file exists for this episode. Fix: decode a frame. */
    | 'missing'
    /** The selected image legitimately belongs to this episode or its combined video. */
    | 'shared-file'
    /** Cannot act: no video path, or no duration to derive a sampling window from. */
    | 'not-actionable';

export interface EpisodeThumbnailClassification {
    episodeId: string;
    state: EpisodeThumbnailState;
    /** For `unmapped`: the on-disk file the row should point at. */
    resolvedPath?: string;
}

/** Filenames this episode's artwork may legitimately carry, newest first. */
export function expectedThumbNames(videoPath: string, episodeId: string): string[] {
    return [artworkFileName(videoPath, 'thumb', episodeId), artworkFileName(videoPath, 'thumb')];
}

/**
 * Classify one episode.
 *
 * @param dirNames filenames present in the episode's directory. The caller owns
 *        the listing so it can memoise per directory — these are NFS reads on a
 *        mount that also serves playback.
 */
export function classifyEpisodeThumbnail(
    row: EpisodeThumbnailWorkRow,
    dirNames: ReadonlySet<string>,
): EpisodeThumbnailClassification {
    if (!row.videoPath || !(Number(row.durationSeconds) > 0)) {
        return { episodeId: row.episodeId, state: 'not-actionable' };
    }

    const dir = dirname(row.videoPath);
    // Legitimate combined-file sidecars can be PNG/WebP too. Do not regenerate
    // forever just because expectedThumbNames lists the extractor's JPEG names.
    if (
        row.artworkPath &&
        dirname(row.artworkPath) === dir &&
        dirNames.has(basename(row.artworkPath)) &&
        ownsEpisodeThumb(row.artworkPath, [row.videoPath], row.episodeId)
    ) {
        return { episodeId: row.episodeId, state: 'shared-file' };
    }

    for (const name of expectedThumbNames(row.videoPath, row.episodeId)) {
        if (!dirNames.has(name)) continue;
        const full = `${dir}/${name}`;
        // Already correct — the caller's query only returns episodes that look
        // broken, so a row already pointing here means nothing to do.
        if (full === row.artworkPath) return { episodeId: row.episodeId, state: 'shared-file' };
        return { episodeId: row.episodeId, state: 'unmapped', resolvedPath: full };
    }

    return { episodeId: row.episodeId, state: 'missing' };
}
