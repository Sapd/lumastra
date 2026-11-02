// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Artwork Reaper — removes `media_artwork` rows whose file is really gone.
 *
 * Why it exists: `getLocalArtwork` (media-artwork.queries.ts:162-188) walks the
 * parent chain with `ORDER BY depth ASC ... LIMIT 1`. A dangling row at depth 0
 * therefore BEATS the ancestor's real row at depth 1 — a season whose poster
 * file was deleted renders NOTHING instead of inheriting the series poster. The
 * dangling row is not merely useless, it actively shadows inheritance.
 *
 * Safety posture (deletion here is irreversible):
 *  - every probe goes through `assessFilePresence`, never a bare stat, so an
 *    offline mount reads as 'transient' rather than "every file is gone";
 *  - the probe is mount-aware (longest enabled library root), so a deleted
 *    FOLDER on a live share is still correctly 'missing';
 *  - a row must be 'missing' on N consecutive runs before it is deleted;
 *  - deletion goes through `deleteMissingArtwork`, which also clears the paired
 *    `media_items.custom_<type>_url` inside one transaction.
 */

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    normalizeLibraryPath,
    getEnabledLibraryPaths,
} from '$lib/server/database/queries/library-paths.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { assessFilePresence } from '$lib/server/utils/file-presence.js';
import type { FilePresence } from '$lib/server/utils/file-presence.js';
import {
    findMediaItemIdsWithLocalArtwork,
    getLocalArtworkPaths,
} from '$lib/server/database/queries/image-sync.queries.js';
import {
    deleteMissingArtwork,
    lockArtworkOwners,
} from '$lib/server/database/queries/media-artwork.queries.js';

/**
 * Longest enabled library root that boundary-contains `filePath`, or
 * `undefined` when the file lives outside every library (central artwork
 * storage, for instance).
 *
 * Containment is boundary-aware (`=== root` or `startsWith(root + '/')`), NOT
 * a bare prefix test — `/data/movies-backup` must not be treated as living
 * under `/data/movies`, or `assessFilePresence` would walk the wrong root and
 * misclassify an offline mount as a real deletion.
 */
export function resolveMountRoot(
    filePath: string,
    libraryRoots: readonly string[],
): string | undefined {
    let best: string | undefined;
    for (const raw of libraryRoots) {
        const root = normalizeLibraryPath(raw);
        if (!root) continue;
        const prefix = root.endsWith('/') ? root : `${root}/`;
        const contained = filePath === root || filePath.startsWith(prefix);
        if (!contained) continue;
        if (best === undefined || root.length > best.length) best = root;
    }
    return best;
}

/** Per-row consecutive-miss counter, persisted in the task's namespaced cache. */
export interface ArtworkMissRecord {
    /** The file_path this counter was recorded against. */
    filePath: string;
    /** Consecutive `missing` verdicts observed for that exact path. */
    misses: number;
}

/**
 * What the sweep should do with one artwork row this cycle.
 *  - `reset`  — file is back / still there: drop any counter.
 *  - `ignore` — transient (mount offline): change nothing, re-check next run.
 *  - `count`  — confirmed missing but below the threshold: persist `next`.
 *  - `delete` — confirmed missing on `threshold` consecutive runs.
 */
export type ArtworkMissDecision =
    | { action: 'reset' }
    | { action: 'ignore' }
    | { action: 'count'; next: ArtworkMissRecord }
    | { action: 'delete' };

/**
 * Pure consecutive-miss state machine.
 *
 * `transient` deliberately does NOT reset the counter and does NOT advance it:
 * an unmounted share is neither proof of deletion nor proof of life, so the
 * row keeps whatever evidence it had and is re-examined next run.
 *
 * A counter recorded against a DIFFERENT file path is discarded — the row was
 * repointed since, so the old path's history is irrelevant.
 */
export function decideArtworkMissAction(
    presence: FilePresence,
    filePath: string,
    prior: ArtworkMissRecord | null,
    threshold: number,
): ArtworkMissDecision {
    if (presence === 'present') return { action: 'reset' };
    if (presence === 'transient') return { action: 'ignore' };

    const priorMisses = prior !== null && prior.filePath === filePath ? prior.misses : 0;
    const misses = priorMisses + 1;
    if (misses >= threshold) return { action: 'delete' };
    return { action: 'count', next: { filePath, misses } };
}

const log = Logger.for('ArtworkReaper');

/**
 * Media items pulled per cursor page. The sweep checks its budgets BETWEEN
 * pages, not mid-page, so a run can overshoot `inspectLimit` by at most one
 * page's worth of artwork rows (~5 per item). Keeping the page small keeps
 * that overshoot small.
 */
const ITEM_PAGE_SIZE = 50;

/**
 * Miss-counter TTL. Long enough that an hourly sweep never loses a count
 * between runs, short enough that a row deleted by other means self-cleans.
 * If the cache evicts it early the count simply restarts — the failure mode is
 * "deletes later", which is the safe direction for an irreversible operation.
 */
export const ARTWORK_MISS_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Cache key for one artwork row's consecutive-miss counter. */
export function artworkMissKey(artworkId: string): string {
    return `miss:${artworkId}`;
}

/**
 * Cross-run store for the consecutive-miss counters. The task backs this with
 * `ctx.cache` (namespaced Valkey); tests back it with a Map.
 */
export interface ArtworkMissStore {
    get(key: string): Promise<ArtworkMissRecord | null>;
    set(key: string, value: ArtworkMissRecord, ttlMs: number): Promise<void>;
    del(key: string): Promise<void>;
}

export interface ReapMissingArtworkOptions {
    /** Max artwork rows probed on disk this run. */
    inspectLimit: number;
    /** Max rows deleted this run. */
    deleteLimit: number;
    /** Consecutive `missing` verdicts required before deleting. */
    missThreshold: number;
    /** media_item_id to resume after; null starts at the beginning. */
    cursor: string | null;
    misses: ArtworkMissStore;
    signal?: AbortSignal;
}

export interface ReapMissingArtworkResult {
    inspected: number;
    present: number;
    missing: number;
    transient: number;
    deleted: number;
    /** Feed back as `cursor` next run; null means the sweep wrapped to the start. */
    nextCursor: string | null;
}

/**
 * One bounded pass of the reaper.
 *
 * Probes are SEQUENTIAL by design: a slow NFS mount should degrade this task's
 * throughput, not saturate the global fs guard and starve playback IO.
 */
export async function reapMissingArtwork(
    sql: postgres.Sql,
    opts: ReapMissingArtworkOptions,
): Promise<ReapMissingArtworkResult> {
    // Loaded ONCE per run. `assessFilePresence` needs a mount root to tell a
    // deleted FOLDER on a live share ('missing') from an offline mount
    // ('transient'); without it, a removed `Show/` directory looks identical
    // to an unmounted library and the dangling rows are never reaped.
    const libraryRoots = (await getEnabledLibraryPaths(sql)).map((p) => p.path);

    const result: ReapMissingArtworkResult = {
        inspected: 0,
        present: 0,
        missing: 0,
        transient: 0,
        deleted: 0,
        nextCursor: opts.cursor,
    };

    let cursor = opts.cursor;

    while (
        !opts.signal?.aborted &&
        result.inspected < opts.inspectLimit &&
        result.deleted < opts.deleteLimit
    ) {
        const ids = await findMediaItemIdsWithLocalArtwork(sql, cursor, ITEM_PAGE_SIZE);
        if (ids.length === 0) {
            // Reached the end of the table — wrap on the next run.
            result.nextCursor = null;
            break;
        }

        const rows = await getLocalArtworkPaths(sql, ids);

        for (const row of rows) {
            if (opts.signal?.aborted) break;
            if (result.deleted >= opts.deleteLimit) break;

            result.inspected++;
            const presence = await assessFilePresence(row.file_path, {
                // undefined for artwork stored centrally (outside every library
                // root) — assessFilePresence then falls back to its
                // immediate-parent probe, which is the correct conservative
                // behaviour for a local volume.
                mountRoot: resolveMountRoot(row.file_path, libraryRoots),
                signal: opts.signal,
            });
            if (presence === 'present') result.present++;
            else if (presence === 'transient') result.transient++;
            else result.missing++;

            const key = artworkMissKey(row.id);
            const prior = await opts.misses.get(key);
            const decision = decideArtworkMissAction(
                presence,
                row.file_path,
                prior,
                opts.missThreshold,
            );

            if (decision.action === 'ignore') continue;
            if (decision.action === 'reset') {
                if (prior !== null) await opts.misses.del(key);
                continue;
            }
            if (decision.action === 'count') {
                await opts.misses.set(key, decision.next, ARTWORK_MISS_TTL_MS);
                continue;
            }

            try {
                // deleteMissingArtwork (not deleteMissingArtworks) — it also NULLs the
                // paired media_items.custom_<type>_url inside one transaction.
                const removed = await withTx(sql, async (raw) => {
                    const tx = raw as unknown as postgres.Sql;
                    await lockArtworkOwners(tx, [row.media_item_id]);
                    // Restoring the exact path may leave registration unchanged.
                    // A second real probe under the writer lock closes that gap.
                    const current = await assessFilePresence(row.file_path, {
                        mountRoot: resolveMountRoot(row.file_path, libraryRoots),
                        signal: opts.signal,
                    });
                    if (current !== 'missing') return false;
                    return deleteMissingArtwork(tx, row);
                });
                if (removed) result.deleted++;
                await opts.misses.del(key);
                if (removed)
                    log.info('artwork-reaper: removed dangling artwork row', {
                        artworkId: row.id,
                        mediaItemId: row.media_item_id,
                        artworkType: row.artwork_type,
                        filePath: row.file_path,
                    });
            } catch (err) {
                log.warn('artwork-reaper: delete failed', {
                    artworkId: row.id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }

        // Advance past the WHOLE page even if the for-loop broke early on the
        // delete budget. The page's unprobed rows are picked up on the next
        // wrap; they are not lost. Holding the cursor back instead would
        // livelock the sweep on any page that cannot produce deletions.
        cursor = ids[ids.length - 1];
        result.nextCursor = cursor;
    }

    return result;
}
