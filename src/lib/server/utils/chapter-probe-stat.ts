// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Chapter probes that report the file stat they describe.
 *
 * The chapter marker (`media_files.chapters_probed_mtime/size`) says "these
 * stored chapters were probed at this stat". The marker must record the stat
 * the probe actually saw, not the row's stat at write time: a file rewritten
 * between the probe and the marker write would otherwise be marked fresh with
 * chapters from its old bytes, and those would be reused forever. So the stat is
 * taken before and after the probe, and reported only when both agree.
 */

import type { ChapterInfo, ChapterProbeResult } from './ffprobe.js';
import { probeChapters } from './ffprobe.js';
import type { ProbedStat } from './scan-probe-cache.js';
import { safeStat } from './safe-fs.js';

export interface ChapterProbeWithStat extends ChapterProbeResult {
    /**
     * The stat the file had before and after the probe, when it did not change
     * in between. Null when the file could not be stat-ed, or changed while it
     * was probed: the chapters then describe no stat the marker may vouch for.
     */
    stat: ProbedStat | null;
}

/**
 * Probe `filePath` for chapters and report the stat the result belongs to.
 * The stat is read before and after the probe; see the module comment.
 */
export async function probeChaptersWithStat(
    filePath: string,
    options: { signal?: AbortSignal } = {},
): Promise<ChapterProbeWithStat> {
    const before = await statOrNull(filePath);
    const probe = await probeChapters(filePath, undefined, { signal: options.signal });
    const after = await statOrNull(filePath);

    const stable =
        before !== null &&
        after !== null &&
        before.mtime.getTime() === after.mtime.getTime() &&
        before.size === after.size;
    return { ...probe, stat: stable ? before : null };
}

async function statOrNull(filePath: string): Promise<ProbedStat | null> {
    try {
        const st = await safeStat(filePath);
        return { mtime: st.mtime, size: st.size };
    } catch {
        return null;
    }
}

/** A stored chapter row for a file, as `upsertChaptersForFile` takes it. */
export interface FileChapterRow {
    chapterIndex: number;
    chapterName: string | null;
    startTicks: string;
    endTicks: string | null;
    source: 'file';
}

/**
 * Map probed chapters to the rows stored for a file. Shared by chapter-sync and
 * the scanner so both write the same rows for the same probe. Ticks are 100 ns,
 * hence the factor of 10000 from milliseconds.
 */
export function toFileChapterRows(chapters: ChapterInfo[]): FileChapterRow[] {
    return chapters.map((ch) => ({
        chapterIndex: ch.index,
        chapterName: ch.title,
        startTicks: String(ch.startTimeMs * 10000),
        endTicks: String(ch.endTimeMs * 10000),
        source: 'file',
    }));
}
