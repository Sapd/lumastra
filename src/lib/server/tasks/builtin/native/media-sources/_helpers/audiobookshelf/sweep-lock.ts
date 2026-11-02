// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * In-process single-flight guard for the Audiobookshelf reconcile sweep.
 *
 * Two overlapping sweeps of the same ABS library are not merely wasteful, they
 * corrupt the catalogue: both diffs read the same "absent locally" set before
 * either has committed, so both insert a `media_items` row for the same
 * `libraryItemId`. `external_ids` is unique on `(provider, external_id,
 * media_type)` and the write goes through
 * `INSERT … ON CONFLICT DO UPDATE`, so the second insert silently *steals* the
 * mapping instead of failing — leaving the first row with no external id at
 * all. Such a row is invisible to {@link listAudiobooksForAbsLibrary} (which
 * joins through `external_ids`), so no later sweep can ever update, dismiss or
 * reconcile it, while browse, stats and the admin media browser show it
 * forever.
 *
 * Overlap is reachable today: the Extensions admin page can trigger a scan by
 * hand while a scheduled run is mid-flight, and a large first sweep easily
 * outlives the 15-minute cadence.
 *
 * This guard covers one process. The cross-process half is a
 * `pg_advisory_xact_lock` around the check-then-insert in `sweep-store.ts`;
 * neither replaces the other — the lock keeps a clustered deployment correct,
 * this keeps a single node from doing redundant work at all.
 *
 * Key semantics mirror the file scanner (`file-scanner.ts`'s `_activeScans`):
 * {@link SWEEP_ALL_KEY} conflicts with every key, a per-path key conflicts with
 * itself and with a running full sweep.
 */

/** Key used when a run covers every configured ABS library. */
export const SWEEP_ALL_KEY = 'all';

const activeSweeps = new Set<string>();

/** True while any sweep is running in this process. Feeds `getStatus`. */
export function isAudiobookSweepRunning(): boolean {
    return activeSweeps.size > 0;
}

/**
 * Would starting a sweep for `key` collide with one already running here?
 *
 * Exported for the guard's own tests; callers should use
 * {@link withAudiobookSweepLock}, which checks and claims atomically (there is
 * no `await` between the two, so no interleaving is possible).
 */
export function isAudiobookSweepBlocked(key: string): boolean {
    if (activeSweeps.has(key)) return true;
    if (key === SWEEP_ALL_KEY) return activeSweeps.size > 0;
    return activeSweeps.has(SWEEP_ALL_KEY);
}

/**
 * Run `operation` unless a conflicting sweep is already in flight, in which
 * case `onBusy` decides what to return instead.
 *
 * Skipping (rather than queueing) is deliberate: the sweep is a full reconcile,
 * so the in-flight run already covers everything the queued one would have
 * done, and every cycle is 15 minutes from the next one anyway.
 */
export async function withAudiobookSweepLock<T>(
    key: string,
    operation: () => Promise<T>,
    onBusy: () => T,
): Promise<T> {
    if (isAudiobookSweepBlocked(key)) return onBusy();

    activeSweeps.add(key);
    try {
        return await operation();
    } finally {
        activeSweeps.delete(key);
    }
}

/**
 * Drop all claimed keys. Test-only — production code must release through
 * {@link withAudiobookSweepLock}'s `finally`, or a crashed run would wedge the
 * source permanently.
 */
export function _resetAudiobookSweepLocksForTests(): void {
    activeSweeps.clear();
}
