// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Chapters for a file the scanner is about to link.
 *
 * `probeFileForScan` probes every new file with `chapters: true`, so the scan
 * probe already holds the chapters. This reads them from that probe while the
 * file's stat still matches the probed one. It falls back to a chapter probe of
 * its own when there is no scan probe for the current bytes, or when the file is
 * reached through a different container path. The scan probe is only peeked, so
 * media-probe Phase A can still take it.
 *
 * The chapters are stored in full, generic titles included: the intro analyzer's
 * chapter detector reads "Opening" and "Credits" marks, and chapter-sync stores
 * the same full list, so nothing is filtered out here.
 */

import type { ChapterInfo } from '$lib/server/utils/ffprobe.js';
import { probeChaptersWithStat } from '$lib/server/utils/chapter-probe-stat.js';
import { peekScanProbe } from '$lib/server/utils/scan-probe-cache.js';
import type { ProbedStat } from '$lib/server/utils/scan-probe-cache.js';
import { safeStat } from '$lib/server/utils/safe-fs.js';
import { replaceProbedFileChapters } from '$lib/server/services/file-chapters.service.js';
import type postgres from 'postgres';

export interface ScanChapters {
    chapters: ChapterInfo[];
    /** False when the chapters could not be read; `chapters` is then not evidence. */
    success: boolean;
    /**
     * The stat the chapters describe, or null when it is not known to be stable.
     * The chapter marker is written with this stat only, so a file that changed
     * while it was probed is never stored or used to derive windows.
     */
    stat: ProbedStat | null;
    physicalPath?: string;
}

/**
 * Read the chapters of `containerPath`, the file the scanner resolved for
 * `filePath`. Uses the scanner's own probe of `filePath` when it still describes
 * the file on disk.
 */
export async function readScanChapters(
    filePath: string,
    containerPath: string,
    signal?: AbortSignal,
): Promise<ScanChapters> {
    if (containerPath === filePath) {
        const scanned = await peekScanChapters(filePath);
        if (scanned) return scanned;
    }
    const result = await probeChaptersWithStat(containerPath, { signal });
    return {
        chapters: result.chapters,
        success: result.success,
        stat: result.stat,
        physicalPath: containerPath,
    };
}

async function peekScanChapters(filePath: string): Promise<ScanChapters | null> {
    let stat: ProbedStat;
    try {
        const st = await safeStat(filePath);
        stat = { mtime: st.mtime, size: st.size };
    } catch {
        return null;
    }
    const probe = peekScanProbe(filePath, stat);
    if (!probe?.chapters) return null;
    // The peek matched the probed stat, so the chapters describe exactly `stat`.
    return { chapters: probe.chapters, success: true, stat, physicalPath: filePath };
}

/**
 * Store a scanned chapter set for `fileId` and mark it as probed.
 *
 * - A failed probe says nothing about the file: nothing is stored or marked, so
 *   the next chapter read tries again.
 * - A probe with no chapters is marked (the file genuinely has none).
 * - Chapters are stored whole, the same rows chapter-sync writes for this probe,
 *   and marked at the probe's stat. Without a stable matching stat nothing
 *   is changed, so chapter-sync probes the file again before trusting it.
 */
export async function storeScanChapters(
    sql: postgres.Sql,
    fileId: string,
    scanned: ScanChapters,
    options: { signal?: AbortSignal; isCancelled?: () => boolean } = {},
): Promise<boolean> {
    return replaceProbedFileChapters(sql, fileId, scanned, scanned.physicalPath, options);
}
