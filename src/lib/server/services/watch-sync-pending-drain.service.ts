// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Drains the `watch_state_pending_resolution` buffer.
 *
 * Buffered items are watch-state pulls (from Jellyfin/etc.) whose media was not
 * yet ingested at pull time. This re-resolves them against the now-larger
 * catalog using the SAME resolver as the live pull ({@link resolvePulledItems}),
 * imports the ones that now resolve as watch-state events, deletes those rows,
 * drops rows that have aged out unresolved, and bumps the rest for the next pass.
 *
 * Triggered at the START of every watch-sync pull cycle (default every 5 min),
 * so a fresh-migration library that finishes scanning after the first pull still
 * gets its history within one cycle. `drainPendingResolution` is also exported so
 * an ingest hook could call it for immediate resolution, but no such caller
 * exists today — resolution latency is bounded by the pull interval.
 *
 * Imports use `appendEventAndRebuild`, so the rebuilder arbitrates against any
 * local state the user produced in the meantime (a manual mark always outranks a
 * sync import) — the drain never clobbers user actions.
 */

import type postgres from 'postgres';
import { getTaskDb } from '../database/connection.js';
import { Logger } from '../utils/logger.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { watchStateEvents } from './watch-state-events.service.js';
import { appendEventAndRebuild } from './watch-state-rebuilder.service.js';
import { applyAutoCompleteFromProgress } from '../utils/watch-constants.js';
import { isEpisode } from '../utils/media-types.js';
import {
    getLaterCombinedFileEpisodes,
    resolvePulledItems,
    type ResolvableItem,
} from './watch-sync-resolution.js';
import {
    planPendingDrain,
    eventSourceForProvider,
    importedWatchEventIds,
    PENDING_MAX_AGE_MS,
    type PendingResolutionRow,
} from './watch-sync-pending.js';
import {
    loadPendingResolution,
    deletePendingResolution,
    bumpPendingAttempts,
} from '../database/queries/watch-state-pending.queries.js';

const logger = Logger.for('WatchSyncPendingDrain');

// Cap rows drained per pass so a huge backlog doesn't hold a task-pool
// connection or run unbounded; oldest-first means it drains fairly across passes.
const DRAIN_BATCH_LIMIT = 2000;
// Chunk the event writes so no single transaction stays open for the whole batch.
const IMPORT_CHUNK_SIZE = 100;

export interface DrainStats {
    provider: string;
    loaded: number;
    imported: number;
    deleted: number;
    dropped: number;
    bumped: number;
}

function toResolvable(row: PendingResolutionRow): ResolvableItem {
    return {
        providerId: row.provider_id,
        mediaType: row.media_type,
        tmdbId: row.tmdb_id,
        imdbId: row.imdb_id,
        internalMediaId: row.internal_media_id,
        seriesTmdbId: row.series_tmdb_id,
        seasonNumber: row.season_number,
        episodeNumber: row.episode_number,
    };
}

/**
 * Drain the pending buffer for one provider.
 *
 * @param provider provider name (e.g. 'jellyfin')
 * @param opts.sql    override the task DB (tests / shared txn)
 * @param opts.now    injectable clock for the age-out decision (tests)
 * @param opts.limit  max rows to load this pass
 * @param opts.signal abort between chunks
 * @param opts.onlyUserIds eligible pull audience; an empty list drains nobody
 */
export async function drainPendingResolution(
    provider: string,
    opts?: {
        sql?: postgres.Sql | null;
        now?: Date;
        limit?: number;
        signal?: AbortSignal;
        onlyUserIds?: string[];
    },
): Promise<DrainStats> {
    const stats: DrainStats = {
        provider,
        loaded: 0,
        imported: 0,
        deleted: 0,
        dropped: 0,
        bumped: 0,
    };

    const sql = opts?.sql ?? getTaskDb();
    if (!sql) {
        logger.warn('Database unavailable — pending drain skipped', { provider });
        return stats;
    }

    const eventSource = eventSourceForProvider(provider);
    if (!eventSource) {
        logger.warn('No EventSource mapping for provider — pending drain skipped', { provider });
        return stats;
    }

    const now = opts?.now ?? new Date();
    const limit = opts?.limit ?? DRAIN_BATCH_LIMIT;
    if (opts?.onlyUserIds?.length === 0) return stats;

    const rows = await loadPendingResolution(sql, provider, limit, opts?.onlyUserIds);
    stats.loaded = rows.length;
    if (rows.length === 0) return stats;

    // Resolve the whole batch once (resolution is user-agnostic).
    const { resolved } = await resolvePulledItems(sql, provider, rows.map(toResolvable));
    const plan = planPendingDrain(rows, resolved, now, PENDING_MAX_AGE_MS);
    // A watched combined-file item covers the later episodes on the file too,
    // exactly as on the live pull (watch-sync-engine.service.ts): only an
    // explicit provider Played spreads, never an auto-complete. Not caught: a
    // failed lookup fails this pass before any row is deleted, so the rows stay
    // buffered and the next pass retries them.
    const siblingsByEpisode = await getLaterCombinedFileEpisodes(
        sql,
        plan.toImport.filter((i) => i.isWatched && isEpisode(i.mediaType)).map((i) => i.mediaId),
    );
    // An episode the provider reported itself keeps its own verdict.
    const reported = new Set(plan.toImport.map((i) => `${i.userId}:${i.mediaId}`));
    const markSiblings = async (
        txSql: postgres.Sql,
        item: (typeof plan.toImport)[number],
        occurredAt: string,
    ): Promise<void> => {
        for (const sibling of siblingsByEpisode.get(item.mediaId) ?? []) {
            if (reported.has(`${item.userId}:${sibling.mediaId}`)) continue;
            for (const eventId of importedWatchEventIds(item.watchCount, item.lastWatchedAt)) {
                await appendEventAndRebuild(txSql, {
                    user_id: toUserId(item.userId),
                    media_id: sibling.mediaId,
                    event_type: 'mark_watched',
                    source: eventSource,
                    position_ms: null,
                    runtime_ms: sibling.runtimeMs,
                    source_event_id: eventId,
                    session_id: null,
                    event_seq: null,
                    occurred_at: occurredAt,
                });
            }
        }
    };

    // Import resolved rows as watch-state events, chunked. The buffer-row
    // deletion happens INSIDE the same transaction as the event writes, so the
    // two can never diverge: a crash (or abort) before a chunk commits leaves
    // both the events unwritten AND the rows still buffered (retried next
    // cycle); a committed chunk has both. This both fixes the abort-loss (a
    // break here can't delete un-imported rows) and prevents duplicate events
    // on a crash between import and delete.
    let committedDeleted = 0;
    for (let offset = 0; offset < plan.toImport.length; offset += IMPORT_CHUNK_SIZE) {
        if (opts?.signal?.aborted) {
            logger.info('Pending drain aborted mid-import', { provider, imported: stats.imported });
            break;
        }
        const chunk = plan.toImport.slice(offset, offset + IMPORT_CHUNK_SIZE);
        const changedUsers = new Map<UserId, string>();
        await withTx(sql, async (rawTxSql) => {
            const txSql = rawTxSql as unknown as postgres.Sql;
            for (const item of chunk) {
                const occurredAt = (item.lastWatchedAt ?? now).toISOString();
                const runtimeMs = item.runtimeMs > 0 ? item.runtimeMs : null;
                const userId = toUserId(item.userId);

                const importedBefore = stats.imported;
                if (item.isWatched) {
                    for (const eventId of importedWatchEventIds(
                        item.watchCount,
                        item.lastWatchedAt,
                    )) {
                        await appendEventAndRebuild(txSql, {
                            user_id: userId,
                            media_id: item.mediaId,
                            event_type: 'mark_watched',
                            source: eventSource,
                            position_ms: null,
                            runtime_ms: runtimeMs,
                            source_event_id: eventId,
                            session_id: null,
                            event_seq: null,
                            occurred_at: occurredAt,
                        });
                    }
                    stats.imported++;
                    await markSiblings(txSql, item, occurredAt);
                } else {
                    // Not watched: import a progress event only when there's a
                    // meaningful resume position. Normalise the near-end "should be
                    // watched" case so CW/Next Up don't keep a stale tail item.
                    // Use the row's real media_type so episodes get the episode
                    // completion threshold, matching the live pull.
                    const normalized = applyAutoCompleteFromProgress(
                        {
                            isWatched: false,
                            resumePositionMs: item.resumePositionMs,
                            runtimeMs: item.runtimeMs,
                        },
                        item.mediaType,
                    );
                    if (normalized.item.isWatched) {
                        await appendEventAndRebuild(txSql, {
                            user_id: userId,
                            media_id: item.mediaId,
                            event_type: 'mark_watched',
                            source: eventSource,
                            position_ms: null,
                            runtime_ms: runtimeMs,
                            // Deterministic id — see the watched branch above.
                            source_event_id: `drain:autocomplete:${item.mediaId}`,
                            session_id: null,
                            event_seq: null,
                            occurred_at: occurredAt,
                        });
                        stats.imported++;
                    } else if (item.resumePositionMs > 0) {
                        await appendEventAndRebuild(txSql, {
                            user_id: userId,
                            media_id: item.mediaId,
                            event_type: 'progress',
                            source: eventSource,
                            position_ms: item.resumePositionMs,
                            runtime_ms: runtimeMs,
                            // Deterministic id keyed by position so a concurrent/
                            // repeated drain of the identical buffered row dedups,
                            // while a genuinely new position (a later re-buffer)
                            // still records.
                            source_event_id: `drain:progress:${item.mediaId}:${item.resumePositionMs}`,
                            session_id: null,
                            event_seq: null,
                            session_elapsed_ms: item.resumePositionMs,
                            occurred_at: occurredAt,
                        });
                        stats.imported++;
                    }
                    // else: unwatched with no progress — no event worth writing,
                    // but it resolved, so its row is still deleted below.
                }
                if (stats.imported > importedBefore) changedUsers.set(userId, item.mediaId);
            }
            // Atomic with the events: drop this chunk's now-resolved rows.
            await deletePendingResolution(
                txSql,
                chunk.map((i) => i.pendingId),
            );
        });
        for (const [userId, mediaId] of changedUsers) {
            watchStateEvents.emit(userId, {
                type: 'watch_state_set_changed',
                mediaId,
                reason: 'sync_pending_import',
            });
        }
        committedDeleted += chunk.length;
    }

    // Aged-out drops and attempt-bumps are independent of the import and safe to
    // run even if the import loop aborted early.
    await deletePendingResolution(sql, plan.toDropIds);
    await bumpPendingAttempts(sql, plan.toBumpIds);

    stats.deleted = committedDeleted;
    stats.dropped = plan.toDropIds.length;
    stats.bumped = plan.toBumpIds.length;

    if (stats.imported > 0 || stats.dropped > 0) {
        logger.info('Pending watch-state drain pass', { ...stats });
    }
    return stats;
}
