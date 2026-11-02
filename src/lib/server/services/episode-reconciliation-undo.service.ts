// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Undo for the moves the reconciliation services applied
 * (`episode_reconciliation_moves`).
 *
 * Undo restores the whole identity group when the selected move belongs to one.
 * All members are validated before releasing their current identities, then
 * their previous identities and metadata are restored together.
 *
 * One transaction, under the same per-series advisory lock the apply paths take
 * (waited for at most {@link UNDO_LOCK_TIMEOUT}; a longer wait is refused as
 * `busy`, which the endpoint answers with 409 so the admin can simply retry):
 *   - removes the TMDB id the reconciliation bound,
 *   - moves the episode row back to its position before the move,
 *   - restores title, overview, still_path and title_binding (a title that was
 *     empty before is re-derived from the file name, not left as the TMDB title),
 *   - writes a resolved `dismissed` sync_quarantine row, keyed by the
 *     (episode, TMDB episode) pair, so detection does not bind or move the same
 *     pair again,
 *   - for season-structure moves: when no applied move of the series is left and
 *     its ordering was activated automatically, deactivates that ordering,
 *   - stamps undone_at / undone_by.
 *
 * Watch state, ratings and playlist membership that the apply merged from the
 * placeholder onto the episode stay on the episode: undo does not split them
 * back. The ghost the apply merged away is not recreated here; the next
 * metadata sync does that (a fresh row, with a new id).
 *
 * Preconditions are checked before anything is written and reported as a
 * {@link ReconciliationUndoError} with a code the endpoint maps to 404/409.
 */

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import { createCatalogService } from '$lib/server/services/catalog.service.js';
import { MediaLifecycleService } from '$lib/server/services/media-lifecycle.service.js';
import { recomputeHasFilesBatch } from '$lib/server/database/queries/media-files.queries.js';
import {
    RECONCILIATION_QUARANTINE_PROVIDER,
    getReconciliationMoveForUpdate,
    getReconciliationMoveGroupForUpdate,
    markReconciliationMoveUndone,
    reconciliationPairKey,
} from '$lib/server/database/queries/episode-reconciliation-moves.queries.js';
import {
    deleteSeriesOrdering,
    getSeriesOrdering,
    unlinkEpisodeMediaIds,
} from '$lib/server/database/queries/episode-orderings.queries.js';
import { episodeTitleFromFileName } from '$lib/server/utils/episode-release-title.js';
import { quarantineWriteResolved } from '$lib/server/database/queries/sync-quarantine.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { refreshSortTitles } from '$lib/server/database/queries/sort-title.queries.js';

const logger = Logger.for('EpisodeReconciliationUndo');

/** How long an undo waits for the series lock and for the rows it locks. */
export const UNDO_LOCK_TIMEOUT = '10s';

/** SQLSTATE lock_not_available, raised when `lock_timeout` expires. */
const LOCK_NOT_AVAILABLE = '55P03';

export type ReconciliationUndoErrorCode =
    | 'not-found'
    | 'already-undone'
    | 'episode-gone'
    | 'identity-changed'
    | 'season-gone'
    | 'slot-taken'
    | 'locked'
    | 'busy';

export class ReconciliationUndoError extends Error {
    readonly code: ReconciliationUndoErrorCode;
    constructor(code: ReconciliationUndoErrorCode, message: string) {
        super(message);
        this.name = 'ReconciliationUndoError';
        this.code = code;
    }
}

export interface ReconciliationUndoResult {
    moveId: string;
    episodeId: string;
    seasonNumber: number;
    episodeNumber: number;
}

export async function undoReconciliationMove(
    sql: postgres.Sql,
    moveId: string,
    undoneBy: string,
    opts: { lockTimeout?: string } = {},
): Promise<ReconciliationUndoResult> {
    const result = await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;

        // Bounded wait: an apply or sync holding the series lock must not leave
        // the admin's request hanging. SET LOCAL ends with this transaction.
        // set_config(..., true) is SET LOCAL with a bind parameter.
        await tx`SELECT set_config('lock_timeout', ${opts.lockTimeout ?? UNDO_LOCK_TIMEOUT}, true)`;

        // The series id is needed for the lock before the move row can be
        // locked; it never changes, so reading it unlocked is safe.
        const [head] = await tx<{ series_id: string }[]>`
            SELECT series_id FROM episode_reconciliation_moves WHERE id = ${moveId}
        `;
        if (!head) throw new ReconciliationUndoError('not-found', 'Reconciliation move not found');
        await tx`SELECT pg_advisory_xact_lock(hashtext(${head.series_id})::bigint)`;

        const requested = await getReconciliationMoveForUpdate(tx, moveId);
        if (!requested)
            throw new ReconciliationUndoError('not-found', 'Reconciliation move not found');
        const moves = await getReconciliationMoveGroupForUpdate(tx, requested);
        const prepared = [];
        for (const move of moves) {
            if (move.undoneAt) {
                throw new ReconciliationUndoError('already-undone', 'This move was already undone');
            }
            if (!move.episodeId) {
                throw new ReconciliationUndoError(
                    'episode-gone',
                    'The episode was deleted; there is nothing left to move back',
                );
            }
            const episodeId = move.episodeId;

            // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin undo keyed by a specific episode UUID; not user-facing
            const [episode] = await tx<
                {
                    parent_id: string | null;
                    season_number: number;
                    episode_number: number;
                    metadata_locked: boolean;
                    title_binding: string | null;
                }[]
            >`
            SELECT parent_id, season_number, episode_number, metadata_locked, title_binding
            FROM media_items
            WHERE id = ${episodeId} AND media_type = 'episode'
            FOR UPDATE
        `;
            if (!episode) {
                throw new ReconciliationUndoError('episode-gone', 'The episode no longer exists');
            }
            // An admin locked the episode or set its title by hand after the move:
            // restoring the old title fields would overwrite that.
            if (episode.metadata_locked || episode.title_binding === 'manual') {
                throw new ReconciliationUndoError(
                    'locked',
                    'The episode is locked or has a manually set title; unlock it first',
                );
            }

            // The id to remove must still be the one this move bound. Anything else
            // (rebound by an admin, replaced by a later sync) is not ours to delete.
            const [boundId] = await tx<{ external_id: string }[]>`
            SELECT external_id FROM external_ids
            WHERE media_id = ${episodeId}
              AND provider = 'tmdb'
              AND media_type = 'episode'
        `;
            if (
                (boundId?.external_id ?? null) !==
                (move.identityReleased ? null : move.tmdbEpisodeId)
            ) {
                throw new ReconciliationUndoError(
                    'identity-changed',
                    'The episode no longer carries the TMDB id this move bound',
                );
            }

            const atFromPosition =
                episode.parent_id === move.fromParentId &&
                episode.season_number === move.fromSeason &&
                episode.episode_number === move.fromEpisode;
            if (!atFromPosition) {
                if (!move.fromParentId) {
                    throw new ReconciliationUndoError('season-gone', 'The original season is gone');
                }
                // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin undo keyed by a specific season UUID; not user-facing
                const [season] = await tx<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE id = ${move.fromParentId} AND media_type = 'season'
            `;
                if (!season) {
                    throw new ReconciliationUndoError('season-gone', 'The original season is gone');
                }
                // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin undo keyed by a specific season UUID; not user-facing
                const [occupant] = await tx<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE parent_id = ${move.fromParentId}
                  AND media_type = 'episode'
                  AND season_number = ${move.fromSeason}
                  AND episode_number = ${move.fromEpisode}
                  AND id <> ${episodeId}
                LIMIT 1
            `;
                if (occupant) {
                    throw new ReconciliationUndoError(
                        'slot-taken',
                        `Season ${move.fromSeason} episode ${move.fromEpisode} is taken by another episode`,
                    );
                }
            }

            prepared.push({ move, episodeId, episode });
        }

        // Release every group's applied identity before restoring any previous
        // identity. A later refusal rolls back all releases and restorations.
        const catalog = createCatalogService(tx, { skipLifecycleHooks: true });
        for (const { episodeId } of prepared)
            await catalog.deleteExternalId(episodeId, 'tmdb', 'episode');
        for (const { move, episodeId, episode } of prepared) {
            if (move.prevTmdbEpisodeId) {
                // The group has released its identities; an outside owner still
                // causes refusal and rolls back the entire undo.
                const restored = await createCatalogService(tx, {
                    skipLifecycleHooks: true,
                }).upsertExternalId(
                    episodeId,
                    {
                        provider: 'tmdb',
                        id: move.prevTmdbEpisodeId,
                        mediaType: 'episode',
                        source: 'reconciliation-undo',
                    },
                    false,
                );
                if (!restored)
                    throw new ReconciliationUndoError(
                        'identity-changed',
                        'The previous identity is owned by another episode',
                    );
            }

            // A title that was empty before the move is not restored as "empty": the
            // TMDB title would stay. Derive it from the file name, as the scanner does.
            let restoredTitle = move.prevTitle;
            if (restoredTitle === null) {
                const [file] = await tx<{ file_path: string }[]>`
                SELECT mf.file_path
                FROM media_file_items mfi
                JOIN media_files mf ON mf.id = mfi.file_id
                WHERE mfi.media_item_id = ${episodeId}
                ORDER BY mfi.is_default DESC, mfi.sort_order, mf.file_path
                LIMIT 1
            `;
                if (file) {
                    restoredTitle = episodeTitleFromFileName(
                        file.file_path.split('/').pop() ?? file.file_path,
                        move.fromEpisode,
                    );
                }
            }

            await tx`
            UPDATE media_items
            SET parent_id = ${move.fromParentId},
                season_number = ${move.fromSeason},
                episode_number = ${move.fromEpisode},
                title = COALESCE(${restoredTitle}, title),
                overview = ${move.prevOverview},
                title_binding = ${move.prevTitleBinding},
                updated_at = NOW()
            WHERE id = ${episodeId}
        `;
            await refreshSortTitles(tx, [episodeId]);

            // The apply stored the TMDB still on the episode; put back what was there.
            await tx`
            UPDATE provider_metadata
            SET metadata = CASE
                    WHEN ${move.prevStillPath}::text IS NULL THEN metadata - 'still_path'
                    ELSE metadata || jsonb_build_object('still_path', ${move.prevStillPath}::text)
                END,
                updated_at = NOW()
            WHERE media_id = ${episodeId}
              AND provider = 'tmdb'
              AND jsonb_typeof(metadata) = 'object'
        `;

            if (!move.identityReleased)
                await quarantineWriteResolved(
                    tx,
                    {
                        provider: RECONCILIATION_QUARANTINE_PROVIDER[move.service],
                        externalId: reconciliationPairKey(episodeId, move.tmdbEpisodeId),
                        mediaType: 'episode',
                        expectedSeriesId: move.seriesId,
                        payload: {
                            seriesMediaId: move.seriesId,
                            episodeId,
                            tmdbEpisodeId: move.tmdbEpisodeId,
                            moveId: move.id,
                            undoneBy,
                        },
                        reason: `${move.service}:undone`,
                        source: 'reconciliation-undo',
                    },
                    { resolvedBy: undoneBy, resolution: 'dismissed' },
                );

            await markReconciliationMoveUndone(tx, move.id, undoneBy);

            if (move.service === 'season-structure') {
                // The group became the series' display ordering because of the moves.
                // With the last of them undone nothing backs it any more. A move whose
                // episode was deleted (episode_id cleared) can never be undone and
                // backs nothing. A manual
                // ordering is the admin's own choice and stays.
                const [remaining] = await tx<{ id: string }[]>`
                SELECT id FROM episode_reconciliation_moves
                WHERE series_id = ${move.seriesId}
                  AND service = 'season-structure'
                  AND undone_at IS NULL
                  AND episode_id IS NOT NULL
                LIMIT 1
            `;
                if (!remaining) {
                    const ordering = await getSeriesOrdering(tx, move.seriesId);
                    if (ordering?.ordering_source === 'auto') {
                        await unlinkEpisodeMediaIds(tx, move.seriesId);
                        await deleteSeriesOrdering(tx, move.seriesId);
                        logger.info(
                            'Deactivated the automatic episode ordering with its last move',
                            {
                                seriesId: move.seriesId,
                                moveId: move.id,
                            },
                        );
                    }
                }
            }

            await recomputeHasFilesBatch(
                tx,
                [episodeId, move.fromParentId, episode.parent_id].filter(
                    (id): id is string => id !== null,
                ),
            );
        }
        return { requested, prepared };
    }).catch((err: unknown) => {
        if ((err as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE) {
            throw new ReconciliationUndoError(
                'busy',
                'The series is being reconciled right now; try again in a moment',
            );
        }
        throw err;
    });

    const { requested: move, prepared } = result;
    const episodeId = move.episodeId!;
    for (const { episodeId } of prepared) {
        try {
            await MediaLifecycleService.afterExternalIdChanged(episodeId, sql);
            await MediaLifecycleService.afterMetadataChanged(episodeId, ['title', 'overview'], sql);
        } catch (err) {
            logger.warn('Lifecycle hooks failed after undo (non-fatal)', {
                episodeId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    try {
        const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache/index.js');
        await cacheManager.for(CACHE_NAMESPACES.nextEpisode).clear();
        await cacheManager.for(CACHE_NAMESPACES.heroNextUp).clear();
        await cacheManager.for(CACHE_NAMESPACES.newEpisodes).clear();
    } catch (err) {
        logger.warn('Cache clear failed after undo (non-fatal)', {
            episodeId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    logger.info('Undid reconciliation move', {
        moveId: move.id,
        service: move.service,
        episodeId,
        restored: `S${move.fromSeason}E${move.fromEpisode}`,
        undoneBy,
    });

    return {
        moveId: move.id,
        episodeId,
        seasonNumber: move.fromSeason,
        episodeNumber: move.fromEpisode,
    };
}
