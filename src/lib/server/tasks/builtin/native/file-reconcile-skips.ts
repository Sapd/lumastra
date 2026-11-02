// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Files that file-delta-ingest deliberately left out of the library.
 *
 * file-reconcile diffs the disk listing against `media_files`. A file the ingest
 * SKIPS on purpose never gets a `media_files` row — e.g. a multi-episode file
 * whose every episode already has a dedicated file
 * (`spongebob.s11e15e14-….mp4` on prod) — so reconcile saw it as new on EVERY
 * 5-minute cycle and dispatched it again, forever. Each pass re-ran the series
 * side effects too (external-id upsert + afterMatched → a series-sync run), so
 * one duplicate file cost 312 series-sync runs a day.
 *
 * Ingest records such paths here and reconcile withholds them for
 * {@link SKIP_WINDOW_MS}. The window is short on purpose: a skip is a verdict
 * about the file's CURRENT neighbours (the dedicated episode files could be
 * deleted), so it is re-evaluated daily rather than trusted forever. The full
 * scan never consults this and still sees every file.
 *
 * Best-effort: lives on the coordination Valkey. If the key is missing the only
 * cost is the old behaviour (one more dispatch).
 */

import { requireClient } from '../../valkey-types.js';

export const SKIP_WINDOW_MS = 24 * 60 * 60 * 1000;

export function reconcileSkipKey(libraryPathId: string): string {
    return `file-reconcile:skipped:${libraryPathId}`;
}

/** Remember that ingest skipped these (relative) paths of a library path just now. */
export async function recordReconcileSkips(
    libraryPathId: string,
    relPaths: readonly string[],
    now: number = Date.now(),
): Promise<void> {
    if (relPaths.length === 0) return;
    const client = requireClient();
    const key = reconcileSkipKey(libraryPathId);
    const members = relPaths.flatMap((p) => [String(now), p]);
    await client.customCommand(['ZADD', key, ...members]);
    await client.customCommand(['ZREMRANGEBYSCORE', key, '-inf', String(now - SKIP_WINDOW_MS)]);
    await client.customCommand(['PEXPIRE', key, String(SKIP_WINDOW_MS)]);
}

/** Relative paths of this library path skipped by ingest within the window. */
export async function listRecentReconcileSkips(
    libraryPathId: string,
    now: number = Date.now(),
): Promise<Set<string>> {
    const client = requireClient();
    const members = await client.customCommand([
        'ZRANGEBYSCORE',
        reconcileSkipKey(libraryPathId),
        String(now - SKIP_WINDOW_MS),
        '+inf',
    ]);
    return new Set(Array.isArray(members) ? members.map((m) => String(m)) : []);
}
