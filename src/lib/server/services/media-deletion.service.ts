// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MediaDeletionService — consolidates 5 divergent media deletion paths
 * into 3 strategies: hardDelete, softDismiss, mergeInto.
 *
 * Every strategy that removes a media_items row fires the deletion
 * lifecycle hooks (afterDeleted / afterDeletedBatch), ensuring embeddings
 * and caches stay in sync.
 */

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import { Logger } from '$lib/server/utils/logger.js';
import { MediaLifecycleService } from '$lib/server/services/media-lifecycle.service.js';
import { CatalogService } from '$lib/server/services/catalog.service.js';
import {
    mergeDuplicateSeries,
    mergeDuplicateSeriesInTx,
    type MergeDuplicateSeriesOptions,
} from '$lib/server/database/queries/media-items.queries.js';
import {
    evaluateRetentionUnits,
    type RetentionUnitCandidate,
} from '$lib/server/database/queries/media-retention.queries.js';
import {
    lockRetentionUnit,
    NO_FK_REFERENCE_TABLES_LOCK,
    type RetentionHealthMemo,
} from './media-retention.service.js';
import {
    recomputeHasFiles,
    recomputeHasFilesBatch,
} from '$lib/server/database/queries/media-files.queries.js';
import {
    findRetentionArtists,
    findEmptyRetentionArtists,
} from '$lib/server/database/queries/music-retention.queries.js';
import { remapAdditionalArtistId } from '$lib/server/database/queries/artist-merge.queries.js';
import { NEVER_OWNED_NO_FK_LOCK_TABLES } from '$lib/server/database/queries/never-owned-media-gc.queries.js';

const logger = Logger.for('MediaDeletionService');

export interface HardDeleteResult {
    deleted: boolean;
    /** Number of media_items rows actually removed (root + descendants when cascading). */
    deletedCount: number;
    skipReason?: string;
}

/**
 * Thrown by {@link MediaDeletionService.hardDelete} when `opts.maxDescendants`
 * is set and the in-tx subtree exceeds it. Throwing inside the transaction
 * rolls back the delete, so the cap is a hard backstop even when a concurrent
 * insert grew the subtree between the route's pre-check and the delete. Carries
 * `childCount` so the caller (admin endpoint) can surface it in a 409.
 */
export class CascadeLimitExceededError extends Error {
    readonly childCount: number;
    constructor(childCount: number, max: number) {
        super(
            `Cascade delete would remove ${childCount} descendants, exceeding the configured limit of ${max}.`,
        );
        this.name = 'CascadeLimitExceededError';
        this.childCount = childCount;
    }
}

/** Depth cap for the recursive subtree walk — guards against pathological parent_id cycles. */
const MAX_SUBTREE_DEPTH = 64;

/**
 * Per-table cleanup for rows about to be deleted, run inside the caller's
 * transaction: null inbound aliases, drop files linked only to the doomed
 * rows (a file shared with a surviving item is kept) and the junction rows,
 * then provider/session/user rows keyed on the ids. The caller deletes the
 * media_items rows themselves; remaining FKs cascade.
 */
export async function deleteMediaDependentsTx(
    tx: postgres.Sql,
    idsToDelete: string[],
): Promise<void> {
    await tx`UPDATE media_items SET canonical_id = NULL WHERE canonical_id = ANY(${idsToDelete})`;
    // No FK to media_items: a derived mapping observation cannot outlive its season.
    // Participant UUIDs name files, so only the season reference is matched here.
    await tx`DELETE FROM file_range_mapping_proofs WHERE season_id = ANY(${idsToDelete}::uuid[])`;
    await tx`DELETE FROM episode_orderings  WHERE episode_media_id = ANY(${idsToDelete})`;
    await tx`DELETE FROM episode_chapters    WHERE file_id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ANY(${idsToDelete}))`;
    await tx`
        DELETE FROM media_files mf
        WHERE mf.id IN (SELECT file_id FROM media_file_items WHERE media_item_id = ANY(${idsToDelete}))
          AND NOT EXISTS (
              SELECT 1 FROM media_file_items o
              WHERE o.file_id = mf.id AND o.media_item_id <> ALL(${idsToDelete})
          )
    `;
    await tx`DELETE FROM media_file_items    WHERE media_item_id   = ANY(${idsToDelete})`;

    // external_ids removal routed through CatalogService (composite-key
    // ownership). Bound to the transaction handle; lifecycle hooks are
    // skipped because callers fire afterDeletedBatch() once after commit.
    const txCatalog = new CatalogService(tx, {
        skipLifecycleHooks: true,
    });
    await txCatalog.deleteExternalIdsForMediaIds(idsToDelete);
    await tx`DELETE FROM provider_metadata   WHERE media_id        = ANY(${idsToDelete})`;
    await tx`DELETE FROM watchlist_activities WHERE media_id        = ANY(${idsToDelete})`;
    await tx`DELETE FROM user_ratings        WHERE media_id        = ANY(${idsToDelete})`;
    await tx`DELETE FROM play_sessions       WHERE media_id        = ANY(${idsToDelete})`;
    // Used to go with play_sessions through an FK cascade, dropped in mig
    // 16.282.0. item_id is text holding the id as the client sent it — /j
    // clients send it dashless — so compare the dashless lowercase form.
    const dashlessIds = idsToDelete.map((id) => id.replace(/-/g, '').toLowerCase());
    await tx`DELETE FROM active_transcode_jobs WHERE lower(replace(item_id, '-', '')) = ANY(${dashlessIds})`;
    await tx`UPDATE hls_playback_tokens SET media_item_id = NULL WHERE media_item_id = ANY(${idsToDelete})`;
}

/** Raised inside the unit transaction to roll back a partial delete; reported as a skip. */
class RetentionUnitChangedError extends Error {
    constructor(rootId: string, deleted: number, expected: number) {
        super(`retention unit ${rootId}: deleted ${deleted} of ${expected} rows`);
        this.name = 'RetentionUnitChangedError';
    }
}

export interface RetentionDeleteResult {
    deleted: boolean;
    /** Rows removed: the unit root plus every member. */
    deletedCount: number;
    deletedIds: string[];
    skipReason?: string;
}

export async function afterHardDelete(
    sql: postgres.Sql,
    survivingParentIds: string[],
    deletedIds: string[],
    rootId: string,
): Promise<void> {
    // Recompute has_files on surviving ancestors (deleted items can no longer
    // contribute files), then batched side-effects. One batch: it dedupes the
    // ancestor chains and locks their union in one ordered statement, instead of
    // a transaction (and lock round) per parent.
    if (survivingParentIds.length > 0) {
        try {
            await recomputeHasFilesBatch(sql, survivingParentIds);
        } catch (err) {
            // One bad chain (lock timeout, deadlock) must not leave every other
            // surviving parent stale: retry them one by one, as before batching.
            logger.warn(
                `recomputeHasFilesBatch failed for ${survivingParentIds.length} surviving parent(s) during hardDelete; retrying per parent`,
                err as Error,
            );
            for (const parentId of survivingParentIds) {
                try {
                    await recomputeHasFiles(sql, parentId);
                } catch (parentErr) {
                    logger.warn(
                        `recomputeHasFiles failed for parent ${parentId} during hardDelete`,
                        parentErr as Error,
                    );
                }
            }
        }
    }
    if (deletedIds.length > 0) {
        try {
            await MediaLifecycleService.afterDeletedBatch(deletedIds, rootId, sql);
        } catch (err) {
            logger.warn('afterDeletedBatch failed during hardDelete', err as Error);
        }
    }
}

export interface MergeResult {
    seasonsReparented: number;
    itemsDeleted: number;
}

export class MediaDeletionService {
    /**
     * Count the recursive descendants of a media item (excludes the root).
     * Depth-capped so a pathological parent_id cycle can never spin forever.
     */
    static async countDescendants(sql: postgres.Sql, mediaId: string): Promise<number> {
        const rows = await sql<{ count: string }[]>`
            WITH RECURSIVE subtree(id, depth) AS (
                SELECT id, 0 FROM media_items WHERE id = ${mediaId}
                UNION ALL
                SELECT m.id, s.depth + 1
                FROM media_items m JOIN subtree s ON m.parent_id = s.id
                WHERE s.depth < ${MAX_SUBTREE_DEPTH}
            )
            SELECT COUNT(*)::text AS count FROM subtree WHERE id <> ${mediaId}
        `;
        return parseInt(rows[0]?.count ?? '0', 10);
    }

    /**
     * Full removal — admin-initiated or orphan cleanup.
     * Calls afterDeletedBatch() once for the whole deleted id set.
     *
     * `cascade: true` deletes the entire subtree (recursive over parent_id)
     * in one transaction so children are never left behind as
     * parent_id=NULL orphans (the media_items self-FK is ON DELETE SET
     * NULL). Without cascade, only the single row is removed — the caller
     * decides the children policy (e.g. the admin route returns 409 with
     * the descendant count if children exist).
     */
    static async hardDelete(
        sql: postgres.Sql,
        mediaId: string,
        opts: {
            cascade?: boolean;
            /**
             * In-tx cap on the number of descendants (subtree size minus the
             * root). When set and exceeded, throws {@link CascadeLimitExceededError}
             * which rolls back the whole delete. The admin route also pre-checks
             * this before calling — this is the race-proof backstop.
             */
            maxDescendants?: number;
            /**
             * When true, before deleting take the same per-item advisory lock
             * `attachFileToItem` uses and re-check that no row in the delete set
             * is file-backed. If any regained a file (e.g. a rename-reclaim
             * re-attached one mid-retention-loop), abort without deleting so the
             * concurrent reclaim's link is not destroyed (data-loss guard).
             * Admin cascade deliberately does NOT set this — it intends to
             * delete file-backed rows.
             */
            guardFileBacked?: boolean;
            /**
             * Caller-owned eligibility, re-evaluated after the row lock inside
             * this transaction. Returning false skips the delete
             * (`skipReason: 'eligibility-changed'`).
             */
            eligibility?: (tx: postgres.Sql) => Promise<boolean>;
            signal?: AbortSignal;
        } = {},
    ): Promise<HardDeleteResult> {
        const result = await withTx(sql, async (txRaw) => {
            const tx = txRaw as unknown as postgres.Sql;

            opts.signal?.throwIfAborted();

            // A caller-owned eligibility recheck reads no-FK reference tables
            // (polymorphic interactions/reactions/flags, the event archive,
            // watch-sync logs). Hold them SHARE until commit so a reference
            // cannot appear between that recheck and the delete; NOWAIT lets an
            // active writer win (55P03) and the caller skip this row.
            if (opts.eligibility) {
                await tx`SET LOCAL lock_timeout = '2s'`;
                await NO_FK_REFERENCE_TABLES_LOCK(tx);
            }

            // Lock ordering (#6 deadlock fix). When guardFileBacked, take the
            // advisory lock BEFORE the FOR UPDATE row lock below. attachFileToItem
            // (the reclaim reattach) acquires advisory-then-row; taking
            // row-then-advisory here would ABBA-deadlock a concurrent
            // rename-reclaim on the same item — exactly the race this guard
            // exists to handle. Same key (hashtext(mediaId)); retention calls
            // hardDelete per single id, so mediaId is the contended row.
            if (opts.guardFileBacked) {
                await tx`SELECT pg_advisory_xact_lock(hashtext(${mediaId}))`;
            }

            // 1. Ground-truth id set, computed IN-TX so concurrent inserts of
            //    new children can't slip between count and delete. Cascade →
            //    whole subtree; else just the row. The JOIN back onto
            //    media_items exists so FOR UPDATE locks the real rows (row
            //    locks cannot be taken on CTE output).
            const idRows = opts.cascade
                ? await tx<{ id: string }[]>`
                    WITH RECURSIVE subtree(id, depth) AS (
                        SELECT id, 0 FROM media_items WHERE id = ${mediaId}
                        UNION ALL
                        SELECT m.id, s.depth + 1
                        FROM media_items m JOIN subtree s ON m.parent_id = s.id
                        WHERE s.depth < ${MAX_SUBTREE_DEPTH}
                    )
                    SELECT m.id FROM media_items m JOIN subtree s ON m.id = s.id
                    FOR UPDATE OF m
                  `
                : await tx<
                      { id: string }[]
                  >`SELECT id FROM media_items WHERE id = ${mediaId} FOR UPDATE`;
            const idsToDelete = idRows.map((r) => r.id);
            if (idsToDelete.length === 0) {
                return {
                    deleted: false,
                    deletedCount: 0,
                    survivingParentIds: [] as string[],
                    deletedIds: [] as string[],
                };
            }

            if (opts.eligibility && !(await opts.eligibility(tx))) {
                return {
                    skipReason: 'eligibility-changed',
                    deleted: false,
                    deletedCount: 0,
                    survivingParentIds: [] as string[],
                    deletedIds: [] as string[],
                };
            }
            opts.signal?.throwIfAborted();

            // In-tx cascade cap (#5). Checked here — not only in the route —
            // so a concurrent insert that grew the subtree after the route's
            // pre-check still can't blow past the limit: the throw rolls back.
            if (opts.maxDescendants != null && idsToDelete.length - 1 > opts.maxDescendants) {
                throw new CascadeLimitExceededError(idsToDelete.length - 1, opts.maxDescendants);
            }

            // File-backed guard (#6). Retention hard-delete keys on a stale
            // pre-loop snapshot; a rename-reclaim can re-attach a file to a
            // status='deleted' row between snapshot and delete. The advisory
            // lock (taken at the top of the tx, before FOR UPDATE) already
            // serialized us against attachFileToItem; now re-check: if any
            // doomed row regained a file, abort so the reclaim's link survives.
            if (opts.guardFileBacked) {
                const fileBacked = await tx<{ exists: boolean }[]>`
                    SELECT EXISTS (
                        SELECT 1 FROM media_file_items WHERE media_item_id = ANY(${idsToDelete})
                    ) AS exists
                `;
                if (fileBacked[0]?.exists) {
                    return {
                        deleted: false,
                        deletedCount: 0,
                        survivingParentIds: [] as string[],
                        deletedIds: [] as string[],
                    };
                }
            }

            // Surviving parents = parents of deleted rows NOT themselves
            // deleted (e.g. the artist above a deleted album) — they need a
            // has_files recompute after the tx.
            const survRows = await tx<{ parent_id: string | null }[]>`
                SELECT DISTINCT parent_id FROM media_items
                WHERE id = ANY(${idsToDelete})
                  AND parent_id IS NOT NULL
                  AND parent_id <> ALL(${idsToDelete})
            `;
            const survivingParentIds = survRows
                .map((r) => r.parent_id)
                .filter((id): id is string => id !== null);

            // 2–3. Null self-FKs, orphaned files, junction and per-table cleanups.
            await deleteMediaDependentsTx(tx, idsToDelete);

            // Artists are also credited by id inside tracks' JSON
            // (`additional_artist_ids`, no FK). Capture them before the rows
            // go so those ids can be dropped in the same transaction instead of
            // being left pointing at nothing.
            const doomedArtists = await tx<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE id = ANY(${idsToDelete}) AND media_type = 'artist'
            `;

            // 4. Terminal delete — CASCADE handles remaining FKs
            //    (media_embeddings, media_streams, trickplay_params,
            //    media_item_stage_state). No explicit embeddings delete needed.
            const deleted = await tx<{ id: string }[]>`
                DELETE FROM media_items WHERE id = ANY(${idsToDelete}) RETURNING id
            `;
            for (const { id } of doomedArtists) await remapAdditionalArtistId(tx, id, null);
            opts.signal?.throwIfAborted();
            return {
                deleted: deleted.length > 0,
                deletedCount: deleted.length,
                survivingParentIds,
                deletedIds: deleted.map((r) => r.id),
            };
        });

        await afterHardDelete(sql, result.survivingParentIds, result.deletedIds, mediaId);

        return {
            deleted: result.deleted,
            deletedCount: result.deletedCount,
            ...('skipReason' in result && result.skipReason
                ? { skipReason: result.skipReason }
                : {}),
        };
    }

    /**
     * Unavailable-media retention: delete one whole retention unit (a track,
     * album or audiobook alone; a movie with its extras; a series with its
     * seasons, episodes and extras) in one guarded transaction.
     *
     * Locks via {@link lockRetentionUnit} (library config + group health,
     * no-FK reference tables, sorted advisory locks, row locks), re-derives
     * membership, then re-evaluates the unit's full eligibility before any
     * write. Every deleted row is a checked member — nothing cascades through
     * an unchecked child — and rows go level by level, deepest first, so no
     * parent_id is ever nulled. Physical files are never touched.
     */
    static async retentionDeleteUnit(
        sql: postgres.Sql,
        target: RetentionUnitCandidate,
        opts: { signal?: AbortSignal; healthMemo?: RetentionHealthMemo } = {},
    ): Promise<RetentionDeleteResult> {
        type UnitOutcome = RetentionDeleteResult & { survivingParentIds: string[] };
        const skip = (skipReason: string): UnitOutcome => ({
            deleted: false,
            deletedCount: 0,
            deletedIds: [],
            survivingParentIds: [],
            skipReason,
        });
        const unitTx = withTx(sql, async (txRaw): Promise<UnitOutcome> => {
            const tx = txRaw as unknown as postgres.Sql;
            opts.signal?.throwIfAborted();
            await tx`SET LOCAL lock_timeout = '2s'`;
            await tx`SET LOCAL statement_timeout = '30s'`;
            const locked = await lockRetentionUnit(tx, target, opts.signal, opts.healthMemo);
            if ('skipReason' in locked) return skip(locked.skipReason);
            const music = target.kind === 'track' || target.kind === 'album';
            if (music) {
                // JSON artist credits have no FK. Serialize their writers and new
                // children with this short transaction; a busy scanner wins (NOWAIT).
                await tx`LOCK TABLE media_items IN SHARE ROW EXCLUSIVE MODE NOWAIT`;
                for (const table of NEVER_OWNED_NO_FK_LOCK_TABLES)
                    await tx`LOCK TABLE ${tx(table)} IN SHARE MODE NOWAIT`;
            }
            const recheck = await evaluateRetentionUnits(
                tx,
                { [target.kind]: [target.group_key] },
                1,
                { rootId: target.id, mode: 'eligible', signal: opts.signal },
            );
            if (recheck.candidates.length !== 1) return skip('eligibility-changed');
            opts.signal?.throwIfAborted();

            const ids = locked.members.map((m) => m.id);
            const root = locked.members.find((m) => m.depth === 0);
            const artistIds = music ? await findRetentionArtists(tx, ids) : [];
            await deleteMediaDependentsTx(tx, ids);
            const depths = [...new Set(locked.members.map((m) => m.depth))].sort((a, b) => b - a);
            const deletedIds: string[] = [];
            for (const depth of depths) {
                const level = locked.members.filter((m) => m.depth === depth).map((m) => m.id);
                const rows = await tx<{ id: string }[]>`
                    DELETE FROM media_items WHERE id = ANY(${level}::uuid[]) RETURNING id::text AS id
                `;
                deletedIds.push(...rows.map((r) => r.id));
            }
            // Locked rows cannot vanish; a mismatch means the unit changed under
            // us. Throwing rolls the partial delete back; it is reported as a skip.
            if (deletedIds.length !== ids.length)
                throw new RetentionUnitChangedError(target.id, deletedIds.length, ids.length);
            const emptyArtists = await findEmptyRetentionArtists(tx, artistIds);
            if (emptyArtists.length) {
                await deleteMediaDependentsTx(tx, emptyArtists);
                const artists = await tx<{ id: string }[]>`
                    DELETE FROM media_items WHERE id = ANY(${emptyArtists}::uuid[]) RETURNING id
                `;
                deletedIds.push(...artists.map((a) => a.id));
            }
            opts.signal?.throwIfAborted();
            return {
                deleted: true,
                deletedCount: deletedIds.length,
                deletedIds,
                survivingParentIds: root?.parent_id ? [root.parent_id] : [],
            };
        });
        let result: UnitOutcome;
        try {
            result = await unitTx;
        } catch (error) {
            if (!(error instanceof RetentionUnitChangedError)) throw error;
            logger.warn('Retention unit changed during delete; rolled back', error);
            return { deleted: false, deletedCount: 0, deletedIds: [], skipReason: 'unit-changed' };
        }

        await afterHardDelete(sql, result.survivingParentIds, result.deletedIds, target.id);

        return {
            deleted: result.deleted,
            deletedCount: result.deletedCount,
            deletedIds: result.deletedIds,
            ...(result.skipReason ? { skipReason: result.skipReason } : {}),
        };
    }

    /**
     * Soft dismiss — file gone but preserve user data.
     * Sets is_dismissed = true. Used by the file scanner for primary items
     * that lost their files.
     *
     * Fires `afterDismissed` to DELETE coverage rows and clean up embeddings
     * eagerly (bug #4 fix — embeddings previously lingered ~30 days until
     * hard-delete).
     */
    static async softDismiss(sql: postgres.Sql, mediaId: string): Promise<void> {
        // Stamp dismissed_at so the rename-by-hash reclaim path (bug #3) can
        // bound its lookup window. An operator dismissal (dismissed, NULL
        // dismissed_at) keeps its NULL: that NULL is what marks the row as
        // operator-curated for unavailable-media retention, and an automatic
        // dismissal on top must not turn it into a scanner one.
        await sql`
            UPDATE media_items
               SET is_dismissed = true,
                   dismissed_at = CASE WHEN is_dismissed AND dismissed_at IS NULL
                                       THEN NULL ELSE NOW() END,
                   processing_state = processing_state - 'hash-reclaim-deferred' - 'hash-reclaim-refused'
             WHERE id = ${mediaId}
        `;

        // Fire lifecycle hook to drop coverage rows + cleanup embeddings/sprites eagerly.
        // Pre-fix, embeddings would linger ~30 days until hard-delete.
        try {
            await MediaLifecycleService.afterDismissed(mediaId, sql);
        } catch (err) {
            logger.warn(`afterDismissed lifecycle hook failed for ${mediaId}`, err as Error);
        }
    }

    /**
     * Merge — migrate all user data from mergeId to keepId, then delete mergeId.
     * Calls afterDeleted(mergeId) after deletion.
     * Returns merge statistics.
     */
    static async mergeInto(
        sql: postgres.Sql,
        keepId: string,
        mergeId: string,
        opts: MergeDuplicateSeriesOptions = {},
    ): Promise<MergeResult> {
        const result = await mergeDuplicateSeries(sql, keepId, mergeId, opts);
        await MediaDeletionService.runMergeHooks(sql, keepId, mergeId);
        return result;
    }

    /**
     * The database half of {@link mergeInto}, on a handle that is already
     * inside the caller's transaction. Opens no transaction or savepoint of its
     * own (a nested withTx on a ReservedSql in a manual BEGIN would commit the
     * caller's transaction early). The caller must run
     * {@link runMergeHooks} after its own commit; running them earlier would
     * recompute and enqueue against rows that may still roll back.
     */
    static async mergeIntoTx(
        tx: postgres.Sql,
        keepId: string,
        mergeId: string,
        opts: MergeDuplicateSeriesOptions = {},
    ): Promise<MergeResult> {
        return mergeDuplicateSeriesInTx(tx, keepId, mergeId, opts);
    }

    /**
     * Post-commit side effects of a merge: lifecycle hooks and the has_files
     * recompute of the kept row. Every step is non-fatal.
     */
    static async runMergeHooks(sql: postgres.Sql, keepId: string, mergeId: string): Promise<void> {
        // Fix bug: mergeId embeddings were orphaned in cache
        try {
            await MediaLifecycleService.afterDeleted(mergeId, sql);
        } catch (err) {
            logger.warn(`afterDeleted failed for merged item ${mergeId}`, err as Error);
        }

        // GAP A: keepId can be a file-less discovery row that just inherited a
        // direct file link; without a recompute it stays has_files=false and
        // vanishes from library views. Recompute it the same way hardDelete does.
        //
        // NOTE: this covers keepId ONLY. The descendants that gain links during a
        // merge (the keeper's own episode rows, which the merge re-points
        // media_file_items onto) are recomputed inside mergeDuplicateSeries'
        // transaction — see the hasFilesSeeds set there. Do not assume this call
        // fixes episode-level availability; it does not, and that gap is exactly
        // what left 7 prod episodes reporting "not on disk" after a correct merge
        // on 2026-08-21.
        try {
            await recomputeHasFiles(sql, keepId);
        } catch (err) {
            logger.warn(
                `recomputeHasFiles failed for kept item ${keepId} after merge`,
                err as Error,
            );
        }

        // GAP B: external_ids are moved onto keepId via UPDATE (not INSERT), so the
        // identity.assigned DB trigger that drives TMDB metadata enrichment never
        // fires. Fire afterMatched(keepId) so the survivor re-enqueues its metadata
        // sync and any identity-bound stage state (e.g. tmdb-metadata-sync stuck at
        // skipped_permanent before it had a provider id) is re-evaluated.
        try {
            const keepRows = await sql<{ media_type: string | null }[]>`
                SELECT media_type FROM media_items WHERE id = ${keepId}
            `;
            const keepMediaType = keepRows[0]?.media_type;
            if (keepMediaType) {
                await MediaLifecycleService.afterMatched(
                    keepId,
                    keepMediaType,
                    { enqueueMetadataSync: true },
                    sql,
                );
            }
        } catch (err) {
            logger.warn(`afterMatched failed for kept item ${keepId} after merge`, err as Error);
        }
    }
}
