// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { getDb } from '$lib/server/database/connection.js';
import { handleTriggerFailure } from '$lib/server/tasks/handle-trigger-failure.js';
import { StageStateService, type StartRunFn } from './stage-state.service.js';
import { getRegistry } from '$lib/server/tasks/registry.js';
import { FEATURE_PIPELINE_EVENT_OUTBOX } from '$lib/server/config.js';
import { isMovie, isSeries } from '$lib/server/utils/media-types.js';
import { wasStageCompletedWithin } from '$lib/server/database/queries/stage-state.queries.js';

const logger = Logger.for('MediaLifecycleService');

/**
 * Example names are fictional; production shapes and measurements are retained.
 * A per-item metadata sync that completed this recently is not re-enqueued by a
 * background match (see afterMatched). Long enough to cover a show's episodes
 * arriving file by file; short enough that a later change still resyncs.
 */
const RECENT_METADATA_SYNC_MS = 30 * 60 * 1000;

let _orchestratorStartRun: StartRunFn | undefined;

async function getOrchestratorStartRun(): Promise<StartRunFn> {
    if (!_orchestratorStartRun) {
        const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
        _orchestratorStartRun = orchestrator.startRun.bind(orchestrator) as StartRunFn;
    }
    return _orchestratorStartRun;
}

/**
 * Emit one of the lifecycle-scoped pipeline events that no DB trigger
 * covers: `item.created`, `item.reclaimed`, `item.dismissed`,
 * `item.deleted`. The DB trigger taxonomy handles file/identity/metadata
 * events; lifecycle events live here because they require app-level
 * orchestration (stage_state seed/delete, cache invalidation), and the
 * trigger can't reliably distinguish them from raw row INSERT/UPDATE
 * sequences.
 *
 * The underlying SQL function silently no-ops when the feature flag is
 * off, so this call is safe on both code paths during the migration
 * window. Failures are non-fatal — the caller logs and continues.
 */
async function emitItemLifecycleEvent(
    sql: postgres.Sql,
    event: 'item.created' | 'item.reclaimed' | 'item.dismissed' | 'item.deleted',
    mediaId: string,
    extra: Record<string, unknown>,
): Promise<void> {
    const payload = { event, mediaId, ...extra };
    await sql`
        SELECT emit_pipeline_event(
            ${event},
            ${mediaId}::uuid,
            ${sql.json(payload)}
        )
    `;
}

/**
 * Look up external IDs and media type for a given media item UUID.
 * Returns the data needed to build per-media cache keys.
 */
async function resolveMediaCacheKeys(
    mediaId: string,
    sql: postgres.Sql | null,
): Promise<{ tmdbId: string; mediaType: string } | null> {
    if (!sql) return null;

    const rows = await sql<Array<{ external_id: string; media_type: string }>>`
        SELECT ei.external_id, ei.media_type
        FROM external_ids ei
        WHERE ei.media_id = ${mediaId} AND ei.provider = 'tmdb'
        ORDER BY ei.is_primary DESC
        LIMIT 1
    `;

    if (rows.length === 0) return null;
    return { tmdbId: rows[0].external_id, mediaType: rows[0].media_type };
}

/**
 * Invalidate embedding and similar content caches for a specific media item.
 * Uses per-media cache keys instead of clearing entire namespaces.
 */
async function invalidateMediaCaches(mediaId: string, sql: postgres.Sql | null): Promise<void> {
    const resolved = await resolveMediaCacheKeys(mediaId, sql);

    const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache');

    if (resolved) {
        const mediaKey = `${resolved.tmdbId}:${resolved.mediaType}`;

        // Delete specific embedding cache entry
        const embeddingCache = cacheManager.for(CACHE_NAMESPACES.mediaEmbeddings);
        await embeddingCache.delete(`media:${mediaKey}`);

        // Delete similar content cache entries for this media.
        // Keys are suffixed with limit/denied params (e.g. similar:550:movie:20)
        // so we use pattern-based deletion via Valkey SCAN.
        try {
            const { deleteKeysByPattern, isValkeyReady } = await import('$lib/server/cache/valkey');
            if (isValkeyReady()) {
                // Unified cache keys: similar-content:*:similar:550:movie*
                const nsName = CACHE_NAMESPACES.similarContent.name;
                await deleteKeysByPattern(`${nsName}:*:similar:${mediaKey}*`, 50);
            }
        } catch {
            // Valkey unavailable — skip
        }

        logger.debug('Invalidated per-media embedding and similar caches', {
            mediaId,
            mediaKey,
        });
    } else {
        logger.debug('No TMDB external ID found for media — skipping cache invalidation', {
            mediaId,
        });
    }
}

export class MediaLifecycleService {
    // Pool routing: every hook that resolves its own handle takes an optional
    // trailing `providedSql`. Web callers omit it and fall back to getDb() (web
    // pool — unchanged behaviour); task callers pass `ctx.sql` (task pool) so a
    // lifecycle hook fired from a queued run can't pin a web connection. See the
    // db pool-split work.

    /**
     * Called when a media file's content has changed (e.g. file replaced on disk).
     * Invalidates ALL content-dependent data:
     *   DB: streams, chapters, intro/outro segments, trickplay params,
     *       local artwork rows, music analysis processing_state, probe data
     *   Disk: trickplay sprite sheets, locally-extracted artwork JPGs
     *
     * This is the single entry point for file-content invalidation — callers
     * should use this instead of calling invalidateFileProbeData() directly.
     */
    static async onFileContentChanged(
        sql: postgres.Sql,
        fileId: string,
        filePath: string,
    ): Promise<{ invalidatedMediaItemIds: string[] }> {
        const { invalidateFileProbeData } =
            await import('$lib/server/database/queries/media-files.queries.js');

        // 1. Collect on-disk artwork file paths BEFORE the DB transaction
        //    deletes the image_candidates rows (we need the paths to unlink files)
        let artworkPaths: string[] = [];
        let mediaItemIdCount = 0;
        try {
            const linked = await sql<{ media_item_id: string }[]>`
                SELECT media_item_id FROM media_file_items WHERE file_id = ${fileId}
            `;
            const mediaItemIds = linked.map((r) => r.media_item_id);
            mediaItemIdCount = mediaItemIds.length;
            if (mediaItemIds.length > 0) {
                const rows = await sql<{ file_path: string }[]>`
                    SELECT file_path FROM image_candidates
                    WHERE media_item_id = ANY(${mediaItemIds})
                      AND source = 'local' AND NOT locked
                      AND file_path IS NOT NULL
                `;
                artworkPaths = rows.map((r) => r.file_path);
            }
        } catch (err) {
            // Non-fatal but observable — artwork files may linger on disk
            // when the SELECT fails, then invalidateFileProbeData() deletes
            // the DB rows that pointed at them, leaving orphan JPGs forever.
            // Warn so an operator can spot rising local-art disk usage.
            logger.warn(
                'Failed to enumerate artwork paths before file-probe invalidation; on-disk files may linger',
                { fileId, mediaItemIdCount },
                err instanceof Error ? err : new Error(String(err)),
            );
        }

        // 2. Invalidate all DB-level content-dependent data in a single transaction
        const result = await invalidateFileProbeData(sql, fileId);

        // 3. Delete on-disk trickplay sprite sheets so hasTrickplay() returns
        //    false and the next trickplay-generation run regenerates them
        try {
            const { deleteTrickplay } = await import('./trickplay-storage.service.js');
            await deleteTrickplay(fileId, filePath);
        } catch (err) {
            logger.warn('Failed to delete on-disk trickplay sprites', {
                fileId,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        // 3b. Delete bitmap subtitles stored alongside the file. The probed_at
        //     check would retire them on the next read anyway; this stops the
        //     media folder carrying dead bytes for tracks nobody requests again.
        try {
            const { SubtitleFileCacheService } =
                await import('./cache/subtitle-file-cache.service.js');
            await SubtitleFileCacheService.deleteAlongside(filePath);
        } catch (err) {
            logger.warn('Failed to delete alongside bitmap subtitles', {
                fileId,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        // 4. Delete on-disk locally-extracted artwork JPGs
        if (artworkPaths.length > 0) {
            const { unlink } = await import('fs/promises');
            for (const artworkPath of artworkPaths) {
                try {
                    await unlink(artworkPath);
                } catch {
                    // File may already be gone — harmless
                }
            }
            logger.debug('Deleted local artwork files', {
                fileId,
                count: artworkPaths.length,
            });
        }

        logger.info('File content changed — invalidated all dependent data', {
            fileId,
            mediaItems: result.invalidatedMediaItemIds.length,
        });

        for (const mid of result.invalidatedMediaItemIds) {
            try {
                await MediaLifecycleService.afterContentChanged(mid, sql);
            } catch (err) {
                logger.warn('afterContentChanged stage invalidation failed (per-item)', {
                    mid,
                    err,
                });
            }
        }

        return result;
    }

    /**
     * Called after a media item's file content has changed.
     * Promotes file-content-invalidated stage rows back to pending so they
     * are re-processed by the next pipeline run.
     */
    static async afterContentChanged(
        mediaId: string,
        providedSql?: postgres.Sql | null,
    ): Promise<void> {
        // When the pipeline event outbox is active, `media_files.content_hash`
        // UPDATE triggers already emit `file.contentChanged` for each linked
        // item; running this direct invalidation in parallel would double-write
        // the stage_state UPDATE (harmless but wasteful). Phase B leaves both
        // paths gated until Phase C deletes this method outright.
        if (FEATURE_PIPELINE_EVENT_OUTBOX) return;
        const sql = providedSql ?? getDb();
        if (!sql) return;
        try {
            const startRun = await getOrchestratorStartRun();
            const svc = new StageStateService(sql, getRegistry(), startRun);
            await svc.invalidateByKind(mediaId, 'file-content');
        } catch (err) {
            logger.error('Failed to invalidate file-content-bound stages', err as Error, {
                mediaId,
            });
        }
    }

    /**
     * Called when a higher-quality file becomes the new default for a media item
     * (bug #8 fix). Cleans up ALL per-file artifacts tied to the old default file:
     *   DB: streams, chapters, trickplay_params, local artwork rows, probe data
     *   Disk: trickplay sprite sheets, locally-extracted artwork JPGs
     * Then invalidates file-content-bound stages so they re-run against the new
     * default file.
     *
     * Delegates to `onFileContentChanged` which already covers all of the above.
     * The old file remains linked to the item (is_default=false) — its probe data
     * is cleared so it will be re-probed on the next media-probe cycle, at which
     * point `promoteHighestQualityVersion` will re-evaluate both files' rankings.
     */
    static async afterDefaultFileChanged(
        sql: postgres.Sql,
        mediaItemId: string,
        oldFileId: string,
        _newFileId: string,
    ): Promise<void> {
        // Resolve the old file's path so we can delete on-disk trickplay sprites.
        let oldFilePath: string | null = null;
        try {
            const rows = await sql<{ file_path: string }[]>`
                SELECT file_path FROM media_files WHERE id = ${oldFileId} LIMIT 1
            `;
            oldFilePath = rows[0]?.file_path ?? null;
        } catch (err) {
            logger.warn('afterDefaultFileChanged: failed to resolve old file path', {
                oldFileId,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        if (!oldFilePath) {
            logger.warn(
                'afterDefaultFileChanged: old file path not found — skipping per-file cleanup',
                { mediaItemId, oldFileId },
            );
            return;
        }

        logger.info('Default file changed — cleaning up old default file artifacts', {
            mediaItemId,
            oldFileId,
            oldFilePath,
        });

        try {
            await MediaLifecycleService.onFileContentChanged(sql, oldFileId, oldFilePath);
        } catch (err) {
            logger.error(
                'afterDefaultFileChanged: per-file cleanup failed',
                err instanceof Error ? err : new Error(String(err)),
                { mediaItemId, oldFileId },
            );
        }
    }

    /**
     * File replaced — re-encode, container change, etc. Phase 1a treats this
     * identically to afterContentChanged (per-media-item scope). Phase 3 will
     * extend this with per-file cleanup for bug #8 (4K-replacing-1080p sprites).
     */
    static async afterReplaced(mediaId: string, providedSql?: postgres.Sql | null): Promise<void> {
        // See afterContentChanged — DB trigger covers the same invalidation
        // when the outbox is active.
        if (FEATURE_PIPELINE_EVENT_OUTBOX) return;
        const sql = providedSql ?? getDb();
        if (!sql) return;
        try {
            const startRun = await getOrchestratorStartRun();
            const svc = new StageStateService(sql, getRegistry(), startRun);
            await svc.invalidateByKind(mediaId, 'file-content');
        } catch (err) {
            logger.error('Failed to invalidate stages on afterReplaced', err as Error, { mediaId });
        }
    }

    /**
     * Item soft-dismissed. DELETEs all coverage rows and fires embedding/sprite
     * cleanup IMMEDIATELY (fixes bug #4 — embeddings used to linger 30 days until
     * hard-delete). Caller in MediaDeletionService.softDismiss invokes this.
     */
    static async afterDismissed(mediaId: string, providedSql?: postgres.Sql | null): Promise<void> {
        const sql = providedSql ?? getDb();
        if (!sql) return;

        // 1. Drop coverage rows. Safe even if none exist.
        try {
            const svc = new StageStateService(sql, getRegistry());
            await svc.deleteRowsForItem(mediaId);
        } catch (err) {
            logger.error('Failed to delete stage-state rows on afterDismissed', err as Error, {
                mediaId,
            });
        }

        await emitItemLifecycleEvent(sql, 'item.dismissed', mediaId, {}).catch((err) => {
            logger.warn('Failed to emit item.dismissed event (non-fatal)', err as Error);
        });

        // 2. Run the existing post-deletion cleanup (embeddings, caches).
        //    afterDeleted is idempotent — safe to call even if no embeddings exist.
        try {
            await MediaLifecycleService.afterDeleted(mediaId, sql);
        } catch (err) {
            logger.error('Failed to run afterDeleted cleanup on afterDismissed', err as Error, {
                mediaId,
            });
        }
    }

    /**
     * Called after a media item is deleted.
     * Cleans up embeddings and invalidates display/recommendation caches.
     */
    static async afterDeleted(mediaId: string, providedSql?: postgres.Sql | null): Promise<void> {
        const sql = providedSql ?? getDb();
        if (!sql) return;

        // Emit BEFORE embeddings deletion so handlers that need the
        // pre-delete state (rare; mostly archival) have a chance to react.
        // Even handlers that need post-delete state will still see the
        // deletion because their handler runs in a later transaction.
        await emitItemLifecycleEvent(sql, 'item.deleted', mediaId, {}).catch((err) => {
            logger.warn('Failed to emit item.deleted event (non-fatal)', err as Error);
        });

        try {
            await sql`DELETE FROM media_embeddings WHERE media_id = ${mediaId}::uuid`;
            logger.debug('Cleaned up embeddings after media delete', {
                mediaId,
            });
        } catch (err) {
            logger.warn('Failed to clean up embeddings after delete', err as Error);
        }

        // Invalidate caches that may reference the deleted item
        try {
            const { cacheInvalidation } = await import('$lib/server/cache');
            await cacheInvalidation.invalidateTrending();
            logger.debug('Invalidated caches after media delete', { mediaId });
        } catch (err) {
            logger.warn('Failed to invalidate caches after delete', err as Error);
        }
    }

    /**
     * Batch variant of {@link afterDeleted} for cascade hard-deletes.
     *
     * Emits ONE aggregate `item.deleted` outbox event for the whole set
     * (payload carries all deleted ids) instead of N per-row events, and
     * invalidates the trending cache once. Unlike `afterDeleted`, no
     * explicit `media_embeddings` delete happens here — the rows were
     * already removed by the FK CASCADE on the `media_items` delete, and
     * per-item stage-state coverage rows were CASCADE-deleted the same way.
     *
     * `rootId` is the subtree root the caller intended to delete — it is
     * passed explicitly rather than derived from `ids[0]` because the id set
     * comes from an UNORDERED `RETURNING`, so `ids[0]` is not deterministically
     * the root (bug #7). Handlers/observability key on this subject.
     */
    static async afterDeletedBatch(
        ids: string[],
        rootId: string,
        providedSql?: postgres.Sql | null,
    ): Promise<void> {
        if (ids.length === 0) return;
        const sql = providedSql ?? getDb();
        if (!sql) return;

        // Single aggregate emit keyed on the explicit subtree root. Payload
        // carries the full id set for handlers/observability.
        await emitItemLifecycleEvent(sql, 'item.deleted', rootId, {
            ids,
            count: ids.length,
        }).catch((err) => {
            logger.warn('Failed to emit batched item.deleted event (non-fatal)', err as Error);
        });

        // NOTE: media_embeddings rows are removed by FK CASCADE on the
        // media_items delete — no explicit delete here.

        // Invalidate caches once for the whole batch, not per id.
        try {
            const { cacheInvalidation } = await import('$lib/server/cache');
            await cacheInvalidation.invalidateTrending();
            logger.debug('Invalidated caches after batched media delete', {
                count: ids.length,
            });
        } catch (err) {
            logger.warn('Failed to invalidate caches after batched delete', err as Error);
        }
    }

    /**
     * Called after an external ID is added, changed, or removed.
     * Invalidates per-media embedding and similar content caches
     * so they regenerate with the updated provider mapping.
     */
    static async afterExternalIdChanged(
        mediaId: string,
        providedSql?: postgres.Sql | null,
    ): Promise<void> {
        logger.debug('External ID changed, invalidating caches', { mediaId });

        try {
            await invalidateMediaCaches(mediaId, providedSql ?? getDb());
        } catch (err) {
            logger.warn('Failed to invalidate caches after external ID change', err as Error);
        }
    }

    /**
     * Called after media metadata (title, overview, genres) is updated.
     * Invalidates embedding cache (built from old metadata) and trending
     * cache (titles appear in trending).
     *
     * Re-embedding latency: up to 6h. The scheduled `discovery-embeddings`
     * task drains stale items via `pm.updated_at > emb.updated_at`. Admins
     * can drain on demand via /admin/tasks/discovery-embeddings. This hook
     * does NOT trigger a synchronous embedding run — the previous per-item
     * enqueue produced 5415+ pending runs from a single metadata-sync
     * (worker concurrency=2 → days of backlog).
     */
    static async afterMetadataChanged(
        mediaId: string,
        changedFields: string[],
        providedSql?: postgres.Sql | null,
    ): Promise<void> {
        logger.debug('Metadata changed', { mediaId, changedFields });

        const sql = providedSql ?? getDb();

        const embeddingFields = ['title', 'overview', 'genres', 'keywords'];
        const affectsEmbeddings = changedFields.some((f) => embeddingFields.includes(f));

        try {
            if (affectsEmbeddings) {
                await invalidateMediaCaches(mediaId, sql);
            }

            // Always invalidate trending (titles appear in trending)
            const { cacheInvalidation } = await import('$lib/server/cache');
            await cacheInvalidation.invalidateTrending();

            logger.debug('Invalidated caches after metadata change', {
                mediaId,
                changedFields,
                affectsEmbeddings,
            });
        } catch (err) {
            logger.warn('Failed to invalidate caches after metadata change', err as Error);
        }

        // DB trigger on media_items UPDATE of title/overview/runtime/year
        // emits metadata.changed events when the outbox is active.
        if (!FEATURE_PIPELINE_EVENT_OUTBOX) {
            if (sql) {
                try {
                    const startRun = await getOrchestratorStartRun();
                    const svc = new StageStateService(sql, getRegistry(), startRun);
                    await svc.invalidateByKind(mediaId, 'metadata');
                } catch (err) {
                    logger.error('Failed to invalidate metadata-bound stages', err as Error, {
                        mediaId,
                    });
                }
            }
        }
    }

    /**
     * Called after a new media item is created.
     * Clears browse/trending/recently-added caches so new content appears.
     */
    static async afterCreated(
        mediaId: string,
        source: string,
        providedSql?: postgres.Sql | null,
    ): Promise<void> {
        logger.debug('Media created', { mediaId, source });

        try {
            const { cacheInvalidation } = await import('$lib/server/cache');
            await cacheInvalidation.onContentAdded([mediaId]);
            logger.debug('Invalidated content caches after media create', {
                mediaId,
                source,
            });
        } catch (err) {
            logger.warn('Failed to invalidate caches after media create', err as Error);
        }

        // A newly ingested item may fulfil a pending Jellyseerr request for any user.
        // Wipe all per-user fulfilled-requests cache entries so the next page load
        // re-checks Jellyseerr and surfaces the newly available item.
        try {
            const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache');
            const cache = cacheManager.for(CACHE_NAMESPACES.fulfilledRequests);
            await cache.clear();
            logger.debug('Wiped fulfilled-requests cache after media create', {
                mediaId,
                source,
            });
        } catch (err) {
            logger.warn('Failed to wipe fulfilled-requests cache after media create', err as Error);
        }

        const sql = providedSql ?? getDb();
        if (!sql) {
            logger.warn('afterCreated: db not available; skipping stage-state seed', {
                mediaId,
                source,
            });
            return;
        }

        try {
            const startRun = await getOrchestratorStartRun();
            const svc = new StageStateService(sql, getRegistry(), startRun);
            await svc.seedRowsForCreate(mediaId);
            logger.debug('Seeded stage-state rows', { mediaId, source });
        } catch (err) {
            logger.error('Failed to seed stage-state rows on afterCreated', err as Error, {
                mediaId,
                source,
            });
        }

        // Emit item.created ONLY when the outbox is off. When it is on, the
        // AFTER INSERT trigger on media_items (migration 16.31.0) already
        // emitted item.created in the same transaction as the row INSERT, so a
        // second app-side emit here would enqueue a duplicate outbox row. The
        // dispatcher's seed is idempotent, so a duplicate would be harmless —
        // but we avoid the redundant work to match the gating pattern used by
        // afterMatched/afterMetadataChanged (the trigger is authoritative when
        // the outbox is on). The synchronous seedRowsForCreate above already
        // gave this item immediate coverage on both code paths.
        if (!FEATURE_PIPELINE_EVENT_OUTBOX) {
            await emitItemLifecycleEvent(sql, 'item.created', mediaId, {
                source,
            }).catch((err) => {
                logger.warn('Failed to emit item.created event (non-fatal)', err as Error);
            });
        }
    }

    /**
     * Called after a soft-dismissed media item has been resurrected because
     * a renamed file matched its previous content hash (bug #3 fix). The
     * item's existing user data (ratings, watch history, playlist
     * memberships) is preserved by virtue of keeping the same UUID; this
     * hook re-seeds pipeline coverage rows so the sweeper picks the item
     * back up.
     *
     * Coverage rows were DELETEd by `afterDismissed` when the item was
     * soft-dismissed, so we re-seed via the same `seedRowsForCreate` path
     * as a fresh item. `seedRowsForCreate` is upsert-safe — any row that
     * survived the dismiss DELETE (e.g. because dismissed coverage was
     * partially cleaned) is left untouched by the ON CONFLICT DO NOTHING.
     */
    static async afterReclaimed(mediaId: string, providedSql?: postgres.Sql | null): Promise<void> {
        logger.info('Media reclaimed via rename-by-hash', { mediaId });

        const sql = providedSql ?? getDb();
        if (!sql) {
            logger.warn('afterReclaimed: db not available; skipping stage-state seed', { mediaId });
            return;
        }

        try {
            const startRun = await getOrchestratorStartRun();
            const svc = new StageStateService(sql, getRegistry(), startRun);
            await svc.seedRowsForCreate(mediaId);
            logger.debug('Re-seeded stage-state rows after reclaim', {
                mediaId,
            });
        } catch (err) {
            logger.error('Failed to seed stage-state rows on afterReclaimed', err as Error, {
                mediaId,
            });
        }

        await emitItemLifecycleEvent(sql, 'item.reclaimed', mediaId, {}).catch((err) => {
            logger.warn('Failed to emit item.reclaimed event (non-fatal)', err as Error);
        });

        // Refresh content-related caches so the resurrected item reappears
        // in browse/trending/recently-added without waiting for the next
        // scheduled invalidation pass.
        try {
            const { cacheInvalidation } = await import('$lib/server/cache');
            await cacheInvalidation.onContentAdded([mediaId]);
        } catch (err) {
            logger.warn('Failed to invalidate caches after reclaim', err as Error);
        }
    }

    /**
     * Called after a media item is matched to a metadata provider.
     * Optionally enqueues metadata sync.
     *
     * `manual: true` indicates the match came from an explicit admin action
     * (e.g. picking a TMDB candidate in the unmatched-files UI). In that
     * case the follow-up sync runs with force=true so the item is fully
     * populated from the provider — the admin's choice is the ground truth.
     *
     * `manual: false` (default) is for scanner-triggered and bulk
     * auto-identify matches, where force must stay false so any previously
     * locked metadata is preserved.
     *
     * Embedding: this hook does NOT enqueue an embedding run. The scheduled
     * `discovery-embeddings` task (every 6h) picks up the freshly-matched
     * item automatically because `emb.id IS NULL`. Admins can drain on
     * demand via /admin/tasks/discovery-embeddings.
     */
    static async afterMatched(
        mediaId: string,
        mediaType: string,
        options?: {
            enqueueMetadataSync?: boolean;
            manual?: boolean;
            /**
             * Optional provider/externalId for observability — surfaced in the
             * log line emitted when identity-bound stage invalidation fails.
             * Not used by invalidateByKind itself (which is keyed on mediaId).
             */
            match?: { provider: string; externalId: string };
        },
        providedSql?: postgres.Sql | null,
    ): Promise<void> {
        logger.debug('Media matched', { mediaId, mediaType, options });

        const manual = options?.manual === true;

        if (options?.enqueueMetadataSync) {
            // Per-item metadata sync only exists for movies (tmdb-metadata-sync)
            // and series (series-sync). Episodes and seasons have NO per-item
            // sync task — both tasks reject a non-movie / non-series id with a
            // PERMANENT error — their metadata is populated as a by-product of
            // series-sync running on the parent series. Route by concrete type
            // and skip enqueue for episode/season. Previously this used
            // `isSeries(mediaType) ? 'series-sync' : 'tmdb-metadata-sync'`, which
            // sent episodes (not a "series") down the movie path and spawned a
            // guaranteed-to-fail run for every auto-identified episode.
            const metadataSyncTaskId = isMovie(mediaType)
                ? 'tmdb-metadata-sync'
                : isSeries(mediaType)
                  ? 'series-sync'
                  : null;
            // Phantom-series guard: series-sync on a series whose subtree has no
            // file will immediately phantom-skip inside syncSeriesWithChildren
            // (children expansion is declined for fileless discovery/catalog
            // rows), so enqueuing it just spawns a no-op run that still burns one
            // TMDB series-detail call. A fileless phantom series re-touched by the
            // scan/reconcile tasks otherwise spawns one such run PER CHILD every
            // cycle — prod saw ~65 series-sync runs/5min (~18k/day) for a single
            // 65-episode phantom. Skip the enqueue when no descendant has a file,
            // unless this is an admin-forced match (which the in-task phantom gate
            // itself honors with force). Fail open: if the check errors we still
            // enqueue and let the authoritative in-task gate decide.
            let skipPhantomSeries = false;
            if (metadataSyncTaskId === 'series-sync' && !manual) {
                const gateSql = providedSql ?? getDb();
                if (gateSql) {
                    try {
                        const rows = await gateSql<{ has_file: boolean }[]>`
                            WITH RECURSIVE descendants AS (
                                SELECT id FROM media_items WHERE parent_id = ${mediaId}
                                UNION ALL
                                SELECT c.id FROM media_items c
                                  JOIN descendants d ON c.parent_id = d.id
                            )
                            SELECT EXISTS (
                                SELECT 1 FROM descendants d
                                  JOIN media_file_items mfi ON mfi.media_item_id = d.id
                                LIMIT 1
                            ) AS has_file
                        `;
                        skipPhantomSeries = rows[0]?.has_file === false;
                    } catch (err) {
                        logger.debug(
                            'afterMatched phantom-series check failed — enqueuing series-sync anyway',
                            { mediaId, error: err instanceof Error ? err.message : String(err) },
                        );
                    }
                }
            }

            // Recently-synced guard: a series is matched once PER EPISODE file, and
            // file ingest runs per file, so importing a show fired series-sync
            // back to back — the idempotency key below only collapses runs that
            // are still queued/active. Prod 2026-09-28: 41 runs in 5 minutes
            // (444 TMDB calls) for one newly added show, and a duplicate file that
            // reconcile re-proposed every 5 minutes resynced Harborfolk 312
            // times a day. A sync that completed minutes ago already fetched the
            // same TMDB data; a real identity change still re-runs the stage via
            // the identity invalidation below. Admin-manual matches always sync.
            // Fail open: a check error enqueues as before.
            let recentlySynced = false;
            if (metadataSyncTaskId && !manual && !skipPhantomSeries) {
                const gateSql = providedSql ?? getDb();
                if (gateSql) {
                    try {
                        recentlySynced = await wasStageCompletedWithin(
                            gateSql,
                            mediaId,
                            metadataSyncTaskId,
                            RECENT_METADATA_SYNC_MS,
                        );
                    } catch (err) {
                        logger.debug('afterMatched recent-sync check failed — enqueuing anyway', {
                            mediaId,
                            error: err instanceof Error ? err.message : String(err),
                        });
                    }
                }
            }

            if (!metadataSyncTaskId) {
                logger.debug(
                    'Skipping per-item metadata sync — no per-item task for this media type',
                    { mediaId, mediaType },
                );
            } else if (recentlySynced) {
                logger.debug('Skipping metadata sync — it completed for this item moments ago', {
                    mediaId,
                    taskId: metadataSyncTaskId,
                });
            } else if (skipPhantomSeries) {
                logger.debug(
                    'Skipping series-sync enqueue — series has no owned files (phantom); series-sync would no-op',
                    { mediaId },
                );
            } else {
                try {
                    const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
                    // Admin-manual matches propagate force=true so the item
                    // is populated from the chosen provider. Scanner and
                    // auto-identify matches stay force=false to honor any
                    // pre-existing lock.
                    await orchestrator.startRun(
                        metadataSyncTaskId,
                        {
                            mediaItemId: mediaId,
                            force: manual,
                            // Force only cascades to children when the
                            // admin explicitly matched the series — they
                            // are choosing the canonical source of truth.
                            forceChildren: manual,
                        },
                        {
                            trigger: {
                                kind: 'in-process',
                                sourceRoute: 'media-lifecycle.afterMatched',
                            },
                            // Same `coverage:` key the eager-enqueue and stage-sweep
                            // paths use, so all three dedupe against each other.
                            //
                            // This call had no key at all, and a series is matched once
                            // PER EPISODE: every episode of a show queued a fresh
                            // series-sync, and each of those re-fetches every season. On
                            // prod, Harborfolk Adventures (773 episodes, 19 seasons) drew
                            // 2,130 runs and 44,580 TMDB calls in a week — 71% of all
                            // series-sync spend, for one show. The per-item task is
                            // idempotent, so collapsing duplicate enqueues costs nothing
                            // and the surviving run does the same work.
                            //
                            // A manual match keeps its own key so an admin-forced resync
                            // is never swallowed by a queued background run.
                            idempotencyKey: manual
                                ? `coverage:${metadataSyncTaskId}:${mediaId}:manual`
                                : `coverage:${metadataSyncTaskId}:${mediaId}`,
                        },
                    );
                    logger.info('Enqueued metadata sync after match', {
                        mediaId,
                        mediaType,
                        taskId: metadataSyncTaskId,
                        manual,
                    });
                } catch (err) {
                    handleTriggerFailure(err, {
                        logger,
                        action: 'enqueue metadata sync after match',
                        taskId: metadataSyncTaskId,
                        context: { mediaId, mediaType, manual },
                    });
                }
            }
        }

        // Invalidate identity-bound stage state so any stages skipped/completed
        // under the previous (no-match / different-match) identity are
        // re-evaluated against the freshly-established provider mapping.
        // Wrapped in try/catch so a stage-state error never blocks the match.
        //
        // DB triggers on external_ids INSERT/UPDATE/DELETE emit identity.*
        // events when the outbox is active — gate the direct path so we
        // don't double-invalidate.
        const sql = !FEATURE_PIPELINE_EVENT_OUTBOX ? (providedSql ?? getDb()) : null;
        if (sql) {
            try {
                const startRun = await getOrchestratorStartRun();
                const svc = new StageStateService(sql, getRegistry(), startRun);
                await svc.invalidateByKind(mediaId, 'identity');
            } catch (err) {
                logger.error(
                    'Failed to invalidate identity-bound stages on afterMatched',
                    err as Error,
                    {
                        mediaId,
                        mediaType,
                        provider: options?.match?.provider,
                        externalId: options?.match?.externalId,
                    },
                );
            }
        }
    }
}
