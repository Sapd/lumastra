// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who wrote a generation directory's output? (HLS re-measure 2026-09-27 §6.3.)
 *
 * A session's generation dirs are named per SESSION (`<sid>/gen-0001` for
 * every job under it, whichever item), so a row's `output_dir` can name a
 * path that holds another job's leftover output: a pod that lost the session
 * to a start of a different item keeps its output (08a037df8 — it may be the
 * new owner's on a shared mount), and on a per-container transcode dir a later
 * takeover on that pod found the old item's segments at exactly the path the
 * new row names and served them. Every row check held; the bytes were wrong.
 *
 * So every spawn stamps the dir it writes into, and whatever reads output it
 * did not itself just produce — the persisted-segment disk-serve, restoreJob's
 * adopt/respawn — first checks the stamp names the row's item. The pod and job
 * id let a loser tell "still only my output" (reclaim it) from "a peer has
 * spawned into this dir since" (leave it).
 */

import * as fs from 'fs/promises';
import * as path from 'path';

import { normalizeItemId } from './job-item-binding.js';

/** Dot-file inside each generation dir. Never a client-servable asset. */
export const OUTPUT_MARKER_FILE = '.lumastra-output.json';

export interface OutputMarker {
    itemId: string;
    podName: string;
    jobId: string;
}

export function outputMarkerPath(outputDir: string): string {
    return path.join(outputDir, OUTPUT_MARKER_FILE);
}

/** Is `segmentPath` (relative to an output dir) the marker itself? */
export function isOutputMarkerPath(segmentPath: string): boolean {
    return path.basename(segmentPath) === OUTPUT_MARKER_FILE;
}

export async function writeOutputMarker(outputDir: string, marker: OutputMarker): Promise<void> {
    await fs.writeFile(outputMarkerPath(outputDir), JSON.stringify(marker));
}

/** The dir's marker, or null when it is missing, unreadable or malformed —
 *  callers treat null as "not provably this item's output" (fail closed). */
export async function readOutputMarker(
    outputDir: string,
    readFile: (filePath: string) => Promise<Buffer | string> = (p) => fs.readFile(p),
): Promise<OutputMarker | null> {
    try {
        const parsed: unknown = JSON.parse(String(await readFile(outputMarkerPath(outputDir))));
        if (!parsed || typeof parsed !== 'object') return null;
        const { itemId, podName, jobId } = parsed as Record<string, unknown>;
        if (typeof itemId !== 'string' || typeof podName !== 'string' || typeof jobId !== 'string')
            return null;
        return { itemId, podName, jobId };
    } catch {
        return null;
    }
}

export function outputMarkerNamesItem(marker: OutputMarker | null, itemId: string): boolean {
    return marker !== null && normalizeItemId(marker.itemId) === normalizeItemId(itemId);
}
