// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { ChapterInfo } from '$lib/server/utils/ffprobe.js';
import type { ProbedStat } from '$lib/server/utils/scan-probe-cache.js';
import { safeStat } from '$lib/server/utils/safe-fs.js';
import { toFileChapterRows } from '$lib/server/utils/chapter-probe-stat.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    upsertChaptersForFile,
    markChaptersProbed,
} from '$lib/server/database/queries/episode-chapters.queries.js';
import { refreshSegmentsForFile } from '$lib/server/database/queries/file-segments.queries.js';

/** Commit physical chapter evidence and its derived windows as one unit. A
 * result for unstable/older bytes cannot replace trusted rows or their marker. */
export async function replaceProbedFileChapters(
    sql: postgres.Sql,
    fileId: string,
    probe: { success: boolean; chapters: ChapterInfo[]; stat: ProbedStat | null },
    physicalPath?: string,
    options: { signal?: AbortSignal; isCancelled?: () => boolean } = {},
): Promise<boolean> {
    const cancelled = (): boolean =>
        options.signal?.aborted === true || options.isCancelled?.() === true;
    if (!probe.success || !probe.stat || cancelled()) return false;
    const probed = probe.stat;
    return withTx(sql, async (tx) => {
        const [file] = await tx<{ file_path: string; matches: boolean }[]>`
            SELECT file_path, ((file_mtime IS NULL OR file_mtime = ${probed.mtime}::timestamptz)
                AND (file_size_bytes IS NULL OR file_size_bytes = ${probed.size})) AS matches
            FROM media_files WHERE id = ${fileId} FOR UPDATE
        `;
        if (!file?.matches) return false;
        const current = await safeStat(physicalPath ?? file.file_path).catch(() => null);
        if (
            !current ||
            current.size !== probed.size ||
            current.mtime.getTime() !== probed.mtime.getTime()
        )
            return false;
        if (cancelled()) return false;
        // Legacy rows may predate file-stat capture. Initialize only absent
        // fields from these verified bytes; a known mismatch was rejected above.
        await tx`UPDATE media_files SET file_mtime=COALESCE(file_mtime,${probed.mtime}::timestamptz),
            file_size_bytes=COALESCE(file_size_bytes,${probed.size}) WHERE id=${fileId}`;
        await upsertChaptersForFile(tx, fileId, toFileChapterRows(probe.chapters));
        // Failure rolls back rows, marker and any partly refreshed windows.
        await refreshSegmentsForFile(tx, fileId);
        if (!(await markChaptersProbed(tx, fileId, probed)))
            throw new Error('File changed while storing chapters.');
        if (cancelled()) throw new Error('Chapter storage cancelled.');
        return true;
    });
}
