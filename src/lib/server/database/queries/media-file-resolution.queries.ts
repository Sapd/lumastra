// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { getFilesForMediaItem, type MediaFileRow } from './media-files.queries.js';

export interface PlaybackSelectionOptions {
    /** File ID to select. Maps from API `fileId` param. */
    fileId?: string | null;
}

export interface PlaybackSelectionResult {
    files: MediaFileRow[];
    /** The resolved media_files.id UUID, or null if no files found. */
    fileId: string | null;
}

/**
 * Resolve which file(s) to use for playback of a media item.
 *
 * - If fileId is specified, returns only that file.
 * - Otherwise returns all files, with fileId set to the default file's ID.
 */
export async function resolvePlaybackSelection(
    sql: postgres.Sql,
    mediaItemId: string,
    options?: PlaybackSelectionOptions,
): Promise<PlaybackSelectionResult> {
    const files = await getFilesForMediaItem(sql, mediaItemId);
    if (files.length === 0) return { files: [], fileId: null };

    if (options?.fileId) {
        const match = files.find((f) => f.id === options.fileId);
        if (match) return { files: [match], fileId: match.id };
        return { files: [], fileId: null };
    }

    const defaultFile = files.find((f) => f.is_default) ?? files[0];
    return { files, fileId: defaultFile?.id ?? null };
}

/**
 * Convenience wrapper — returns just the files array.
 */
export async function resolveMediaFiles(
    sql: postgres.Sql,
    mediaItemId: string,
    options?: PlaybackSelectionOptions,
): Promise<MediaFileRow[]> {
    const selection = await resolvePlaybackSelection(sql, mediaItemId, options);
    return selection.files;
}
