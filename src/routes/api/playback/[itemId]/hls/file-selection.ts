// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { MediaFileRow } from '$lib/server/database/queries/media-files.queries.js';

export type FileSelection =
    | { type: 'single'; path: string; fileId: string }
    | { type: 'concat'; paths: string[]; fileIds: string[] };

/**
 * Given the files for a media item and an optional edition selection,
 * returns either a single file path or an ordered list for FFmpeg concat.
 *
 * Edition logic:
 * - No edition param → use files where edition IS NULL (theatrical/default)
 * - Edition param → use files matching that edition
 * - Falls back to first file if nothing matches
 *
 * Part logic:
 * - At least two DISTINCT part numbers → concat the parts in part order, one
 *   file per part number (the first in the item's file order)
 * - Anything else → the first file: un-numbered files, a lone part, or several
 *   files sharing one part number are versions, not parts. Concatenating them
 *   played the film twice in a row — two unlabelled copies of "Deathly Hallows
 *   Part 1" both carried "part 1" (2026-10-03).
 */
export function selectFileForPlayback(
    files: Pick<MediaFileRow, 'id' | 'file_path' | 'edition' | 'part_number'>[],
    requestedEdition: string | null,
): FileSelection {
    // Filter by edition
    const editionFiles =
        requestedEdition !== null
            ? files.filter((f) => f.edition === requestedEdition)
            : files.filter((f) => f.edition === null || f.edition === undefined);

    // Fall back to all files if filter yields nothing
    const candidates = editionFiles.length > 0 ? editionFiles : files;

    // One file per part number, in part order; un-numbered files are versions.
    const parts = new Map<number, (typeof candidates)[number]>();
    for (const file of candidates) {
        if (file.part_number !== null && !parts.has(file.part_number)) {
            parts.set(file.part_number, file);
        }
    }
    const sorted = [...parts.entries()].sort(([a], [b]) => a - b).map(([, file]) => file);

    if (sorted.length < 2) {
        return {
            type: 'single',
            path: candidates[0].file_path,
            fileId: candidates[0].id,
        };
    }

    // Multiple parts → concat
    return {
        type: 'concat',
        paths: sorted.map((f) => f.file_path),
        fileIds: sorted.map((f) => f.id),
    };
}
