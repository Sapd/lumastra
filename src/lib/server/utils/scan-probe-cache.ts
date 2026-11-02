// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Hand-over of the library scanner's ffprobe result to media-probe Phase A.
 *
 * The scanner probes every new (and every content-changed) video file before
 * it links it (`probeFileForScan`, file-scanner/shared.ts). Phase A
 * (tasks/builtin/native/media-probe.ts) used to probe the same file again
 * seconds later to write its streams, so a first ingest ran two full
 * `ffprobe -show_streams -show_format` per file. The scanner leaves its
 * successful result here; Phase A takes it instead of probing when the
 * file's `media_files` row describes the same bytes.
 *
 * - Keyed by path, valid only for the mtime + size the file had both before
 *   and after the probe (the scanner does not store a result for a file that
 *   changed while it was probed). Phase A compares that with the row's
 *   `file_mtime` / `file_size_bytes`: the scanner commits exactly that stat
 *   (or, when the file moved on during the scan, its pre-scan stat, see
 *   `keepProbedFileStat`), so a mismatch means other bytes and a fresh probe.
 *   A file changing after the row was written is the scanner's change
 *   detection's job, as it is for a Phase A probe.
 * - Process-local and best effort: another replica, a restart or an evicted
 *   entry is a miss, and a miss probes exactly as before.
 * - Taken once: a hit removes the entry, so a later re-probe (invalidation,
 *   admin retry) always runs ffprobe.
 * - Bounded: at most {@link MAX_ENTRIES} entries (oldest evicted first), each
 *   valid for {@link TTL_MS}.
 */

import type { MediaProbeResult } from './ffprobe.js';

/** ~2-3 KB per entry; enough for a large first ingest that runs ahead of Phase A. */
const MAX_ENTRIES = 5000;
/** Phase A normally runs within seconds to minutes of the scan. */
const TTL_MS = 30 * 60 * 1000;

interface Entry {
    mtimeMs: number;
    size: number;
    storedAt: number;
    probe: MediaProbeResult;
}

const entries = new Map<string, Entry>();

/** The file's stat when it was probed, unchanged across the probe. */
export interface ProbedStat {
    mtime: Date;
    size: number;
}

/** Remember a successful scan-time probe of `filePath` taken at `stat`. */
export function rememberScanProbe(
    filePath: string,
    stat: ProbedStat,
    probe: MediaProbeResult,
): void {
    if (!probe.success) return;
    entries.delete(filePath);
    entries.set(filePath, {
        mtimeMs: stat.mtime.getTime(),
        size: stat.size,
        storedAt: Date.now(),
        probe,
    });
    while (entries.size > MAX_ENTRIES) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
    }
}

/** A file's stat as the `media_files` row or the disk reports it. */
export interface ProbeStat {
    mtime: Date | null;
    size: number | string | null;
}

function matchesStat(entry: Entry, stat: ProbeStat): boolean {
    if (stat.mtime === null || stat.size === null) return false;
    return stat.mtime.getTime() === entry.mtimeMs && Number(stat.size) === entry.size;
}

/**
 * Take the scanner's probe of `filePath` when the `media_files` row's stat
 * matches the probed one. Returns null (and probes nothing) otherwise. The
 * entry is removed either way.
 */
export function takeScanProbe(filePath: string, row: ProbeStat): MediaProbeResult | null {
    const entry = entries.get(filePath);
    if (!entry) return null;
    entries.delete(filePath);
    if (Date.now() - entry.storedAt > TTL_MS) return null;
    return matchesStat(entry, row) ? entry.probe : null;
}

/**
 * Read the scanner's probe of `filePath` without taking it, when `stat` matches
 * the probed one and the entry is still within its TTL. Phase A can still take
 * the same entry afterwards. Used by the scanner's own follow-up reads (chapters)
 * that run before Phase A.
 */
export function peekScanProbe(filePath: string, stat: ProbeStat): MediaProbeResult | null {
    const entry = entries.get(filePath);
    if (!entry) return null;
    if (Date.now() - entry.storedAt > TTL_MS) return null;
    return matchesStat(entry, stat) ? entry.probe : null;
}

/** Tests only. */
export function clearScanProbeCache(): void {
    entries.clear();
}
