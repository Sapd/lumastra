// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { UserContext } from '$lib/server/types.js';
import type { AddPlaylistItemsResponse, PlaylistSummary } from '$lib/schemas/playlists.js';
import {
    getPlaylistItems,
    getPlaylistSummary,
} from '$lib/server/database/queries/playlists.queries.js';
import { transformPlaylistItemRow } from '$lib/server/utils/playlist-transforms.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    resolvePreferredToMediaId,
    resolveEpisodeContext,
    insertPlaylistItem,
    touchPlaylist,
    getItemPosition,
    deletePlaylistItem,
    reorderItemsAfterDelete,
} from '$lib/server/database/queries/playlists.queries.js';
import {
    getSeriesEpisodesForPlaylist,
    getAlbumTracks,
} from '$lib/server/database/queries/playlist-items.queries.js';
import { getExternalIdFor, getPreferredExternalId } from '$lib/utils/external-ids.js';
import { transformInsertedItemRow } from '$lib/server/utils/playlist-transforms.js';
import { mapLegacyJellyfinExternalIds } from '$lib/server/utils/media-resolution.js';
import type { PartialExternalIds } from '$lib/schemas/common.js';
import type { PlaylistEntry } from '$lib/types/api-playlists.js';
import { isEpisode, isSeries } from '$lib/server/utils/media-types.js';
import { type ApiSurface } from '$lib/shared/api-urls.js';
import { getPlaylistKindPolicy, isMediaTypeAllowed } from './playlist-kind-policy.js';
import type { PlaylistTypeValue } from '$lib/server/database/queries/playlists.queries.js';

const logger = Logger.for('PlaylistItemManager');

/** Most expanded candidates (episodes/tracks) one add request may touch under the playlist lock. */
const MAX_ADD_CANDIDATES = 2000;

// =============================================================================
// Interfaces
// =============================================================================

export interface AddItemParams {
    sql: postgres.Sql;
    playlistId: number;
    /**
     * The target playlist's kind. Omit for an ordinary playlist — absent means
     * the open policy, which is the historical behaviour.
     */
    playlistType?: PlaylistTypeValue;
    externalIds: PartialExternalIds;
    mediaType: string;
    title: string;
    seasonNumber?: number | null;
    episodeNumber?: number | null;
    seriesExternalIds?: PartialExternalIds;
    seriesName?: string;
    overview?: string | null;
    posterPath?: string | null;
    username: string;
    /** Surface the 201 body's URLs must be built for. */
    surface: ApiSurface;
}

export interface AddItemsResult {
    type: 'expanded' | 'single' | 'rejected';
    expanded?: boolean;
    seriesName?: string;
    episodesAdded?: number;
    item?: PlaylistEntry;
    items?: PlaylistEntry[];
    /** Set when `type === 'rejected'`. */
    reason?: 'media_type_not_allowed';
}

export interface RemoveItemParams {
    sql: postgres.Sql;
    playlistId: number;
    itemId: number;
    username: string;
}

// =============================================================================
// Service
// =============================================================================

class PlaylistItemManager {
    /** Catalog-only public add. The lock covers duplicate detection, positions and revision. */
    async addMediaItems(params: {
        sql: postgres.Sql;
        playlistId: number;
        playlistType: PlaylistTypeValue | null;
        mediaIds: string[];
        user: UserContext;
        surface: ApiSurface;
        access: MediaAccessBoundary;
    }): Promise<AddPlaylistItemsResponse> {
        const { sql, playlistId, mediaIds, user, surface } = params;
        return withTx(sql, async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(${playlistId})`;
            let candidateBudget = MAX_ADD_CANDIDATES;
            const results: AddPlaylistItemsResponse['results'] = [];
            const resultEntryIds: number[][] = [];
            const policy = getPlaylistKindPolicy(params.playlistType);
            let changed = false;
            for (const mediaId of mediaIds) {
                const result: AddPlaylistItemsResponse['results'][number] = {
                    mediaId,
                    status: 'rejected',
                    entries: [],
                    expanded: false,
                    reason: null,
                };
                results.push(result);
                const entryIds: number[] = [];
                resultEntryIds.push(entryIds);
                // Access is checked before any metadata is exposed, including expansion children.
                if (!(await checkMediaAccess(tx, mediaId, user))) {
                    result.reason = 'not_found_or_no_access';
                    continue;
                }
                // This lookup follows checkMediaAccess; it does not bypass the viewer boundary.
                const [media] = await tx<{ id: string; title: string; media_type: string }[]>`
                    SELECT id, title, media_type FROM media_items WHERE id = ${mediaId}::uuid
                `;
                if (!media) {
                    result.reason = 'not_found';
                    continue;
                }
                if (!isMediaTypeAllowed(policy, media.media_type)) {
                    result.reason = 'media_type_not_allowed';
                    continue;
                }
                const expanded =
                    policy.expandContainers &&
                    ['tv', 'series', 'season', 'album'].includes(media.media_type);
                result.expanded = expanded;
                // Child metadata stays internal until each child passes checkMediaAccess below.
                const candidates = expanded
                    ? await tx<{ id: string; title: string; media_type: string }[]>`
                        SELECT m.id, m.title, m.media_type FROM media_items m
                        LEFT JOIN media_items parent ON parent.id = m.parent_id
                        WHERE (m.parent_id = ${mediaId}::uuid OR parent.parent_id = ${mediaId}::uuid)
                          AND m.media_type IN ('episode', 'track') AND m.has_files = true
                        ORDER BY m.season_number NULLS FIRST, COALESCE(m.sort_order, m.episode_number, 0), m.id
                        LIMIT ${candidateBudget + 1}
                      `
                    : [media];
                // The lock is held for the whole request: bound the expansion.
                if (candidates.length > candidateBudget) {
                    result.reason = 'too_many_entries';
                    continue;
                }
                candidateBudget -= candidates.length;
                let added = false;
                for (const candidate of candidates) {
                    if (!(await checkMediaAccess(tx, candidate.id, user))) continue;
                    const [existing] = await tx<{ id: number }[]>`
                        SELECT id FROM playlist_items WHERE playlist_id = ${playlistId} AND media_id = ${candidate.id}::uuid
                    `;
                    if (existing) {
                        entryIds.push(existing.id);
                        continue;
                    }
                    const context =
                        candidate.media_type === 'episode' && policy.expandContainers
                            ? await resolveEpisodeContext(tx, candidate.id)
                            : null;
                    const inserted = await insertPlaylistItem(tx, {
                        playlistId,
                        mediaId: candidate.id,
                        title: candidate.title,
                        seasonNumber: context?.seasonNumber ?? null,
                        episodeNumber: context?.episodeNumber ?? null,
                        seriesName: context?.seriesName ?? null,
                        overview: null,
                        posterPath: null,
                    });
                    if (inserted) {
                        entryIds.push(inserted.id);
                        added = true;
                        changed = true;
                    }
                }
                if (entryIds.length === 0) {
                    result.reason = 'no_accessible_entries';
                    continue;
                }
                result.status = added ? 'added' : 'duplicate';
            }
            if (changed) await touchPlaylist(tx, playlistId);
            // Only the rows this request touched: loading the whole playlist
            // under the lock made a big-list add cost O(list).
            const rows = await getPlaylistItems(
                tx,
                playlistId,
                user.userId,
                undefined,
                params.access,
                { mode: 'offset' },
                'position',
                resultEntryIds.flat(),
            );
            const entriesById = new Map(
                rows.map((row) => [row.id, transformPlaylistItemRow(row, surface)]),
            );
            for (const [index, result] of results.entries()) {
                result.entries = resultEntryIds[index].flatMap((id) => {
                    const entry = entriesById.get(id);
                    return entry ? [entry] : [];
                });
                // Access filtering or a concurrent conflict can leave nothing the
                // viewer may see: that is a rejection, not an add.
                if (
                    (result.status === 'added' || result.status === 'duplicate') &&
                    result.entries.length === 0
                ) {
                    result.status = 'rejected';
                    result.reason = 'no_accessible_entries';
                }
            }
            return { results, summary: await getPlaylistSummary(tx, playlistId) };
        });
    }

    /**
     * Add one or more items to a playlist.
     *
     * TV series and music albums are automatically expanded to their children
     * (episodes and tracks respectively). Returns null when the media cannot
     * be resolved in the catalog.
     */
    async addItems(params: AddItemParams): Promise<AddItemsResult | null> {
        const {
            sql,
            playlistId,
            mediaType,
            title,
            seasonNumber,
            episodeNumber,
            seriesExternalIds,
            seriesName,
            overview,
            posterPath,
            username,
        } = params;

        // An older client may still send a Jellyfin item id: map it to the
        // internal id (lookup only, never a new row) and drop it.
        const externalIds = await mapLegacyJellyfinExternalIds(sql, params.externalIds);

        const policy = getPlaylistKindPolicy(params.playlistType);

        // Type gate first: a watchlist must never hold an episode, album or
        // track, whatever the caller asked for.
        if (!isMediaTypeAllowed(policy, mediaType)) {
            logger.info('Rejected item: media type not allowed for this playlist kind', {
                playlistId,
                mediaType,
                playlistType: params.playlistType,
            });
            return { type: 'rejected', reason: 'media_type_not_allowed' };
        }

        const preferred = getPreferredExternalId(externalIds, {
            includeUuids: true,
        });

        // ========================================
        // TV Series Expansion: Fetch all episodes
        // ========================================
        if (isSeries(mediaType) && policy.expandContainers) {
            const mediaId = await resolvePreferredToMediaId(sql, preferred, 'tv');
            if (!mediaId) {
                logger.warn('Could not resolve media_id for series', {
                    externalIds,
                    title,
                });
                return null;
            }

            const dbEpisodes = await getSeriesEpisodesForPlaylist(sql, mediaId);

            if (dbEpisodes.length === 0) {
                logger.warn('No DB episodes found for series', {
                    mediaId,
                    title,
                });
                return {
                    type: 'expanded',
                    expanded: false,
                    seriesName: title,
                    episodesAdded: 0,
                };
            }

            logger.info('Expanding TV series to episodes via DB hierarchy', {
                playlistId,
                mediaId,
                seriesName: title,
                episodeCount: dbEpisodes.length,
            });

            return withTx(sql, async (txRaw) => {
                // postgres.js types TransactionSql and Sql as distinct generics despite
                // being structurally compatible at runtime; cast via unknown to satisfy them.
                const tx = txRaw as unknown as postgres.Sql;
                // Serialize concurrent inserts to this playlist so the atomic
                // MAX(position)+1 in insertPlaylistItem cannot race.
                await tx`SELECT pg_advisory_xact_lock(${playlistId})`;
                let insertedCount = 0;
                let skippedCount = 0;
                const insertedItems: PlaylistEntry[] = [];

                for (const episode of dbEpisodes) {
                    const inserted = await insertPlaylistItem(tx, {
                        playlistId,
                        mediaId: String(episode.id),
                        seasonNumber: episode.season_number,
                        episodeNumber: episode.episode_number,
                        title: String(episode.title),
                        seriesName: title,
                        overview: episode.overview ?? null,
                        posterPath: episode.poster_path ?? posterPath ?? null,
                    });

                    if (inserted) {
                        insertedItems.push(
                            transformInsertedItemRow(
                                inserted,
                                { internal: String(episode.id) },
                                'episode',
                                params.surface,
                                externalIds,
                            ),
                        );
                        insertedCount++;
                    } else {
                        skippedCount++;
                    }
                }

                if (insertedCount > 0) await touchPlaylist(tx, playlistId);

                logger.info('TV series episodes added to playlist via DB hierarchy', {
                    playlistId,
                    seriesName: title,
                    insertedCount,
                    skippedCount,
                    username,
                });

                return {
                    type: 'expanded' as const,
                    expanded: true,
                    seriesName: title,
                    episodesAdded: insertedCount,
                    items: insertedItems,
                };
            });
        }

        // ========================================
        // Music Album Expansion: Fetch all tracks
        // ========================================
        if ((mediaType === 'album' || mediaType === 'track') && policy.expandContainers) {
            const internalId = getExternalIdFor(externalIds, 'internal');
            if (!internalId) {
                logger.warn('Music item missing internal UUID', {
                    externalIds,
                    mediaType,
                    title,
                });
                return null;
            }

            const tracks = await getAlbumTracks(sql, internalId);

            if (tracks.length > 0) {
                logger.info('Expanding music album to tracks', {
                    playlistId,
                    albumId: internalId,
                    albumTitle: title,
                    trackCount: tracks.length,
                });

                return withTx(sql, async (txRaw) => {
                    // postgres.js types TransactionSql and Sql as distinct generics despite
                    // being structurally compatible at runtime; cast via unknown to satisfy them.
                    const tx = txRaw as unknown as postgres.Sql;
                    // Serialize concurrent inserts to this playlist so the atomic
                    // MAX(position)+1 in insertPlaylistItem cannot race.
                    await tx`SELECT pg_advisory_xact_lock(${playlistId})`;
                    let insertedCount = 0;

                    for (const track of tracks) {
                        const inserted = await insertPlaylistItem(tx, {
                            playlistId,
                            mediaId: String(track.id),
                            seasonNumber: null,
                            episodeNumber: track.episode_number ?? null,
                            title: String(track.title),
                            seriesName: title || null,
                            overview: null,
                            posterPath: posterPath ?? null,
                        });

                        if (inserted) {
                            insertedCount++;
                        }
                    }

                    if (insertedCount > 0) await touchPlaylist(tx, playlistId);

                    return {
                        type: 'expanded' as const,
                        expanded: true,
                        seriesName: title,
                        episodesAdded: insertedCount,
                    };
                });
            }

            // Single audio track (no children) — insert directly by internal UUID
            if (mediaType === 'track') {
                logger.info('Adding single audio track to playlist', {
                    playlistId,
                    trackId: internalId,
                    title,
                });

                // Wrap in a transaction with an advisory lock on playlistId so
                // the atomic MAX(position)+1 in insertPlaylistItem cannot race
                // against a concurrent add to the same playlist.
                const inserted = await withTx(sql, async (txRaw) => {
                    const tx = txRaw as unknown as postgres.Sql;
                    await tx`SELECT pg_advisory_xact_lock(${playlistId})`;
                    const row = await insertPlaylistItem(tx, {
                        playlistId,
                        mediaId: internalId,
                        seasonNumber: null,
                        episodeNumber: null,
                        title,
                        seriesName: seriesName || null,
                        overview: overview ?? null,
                        posterPath: posterPath ?? null,
                    });
                    if (!row) return null;
                    await touchPlaylist(tx, playlistId);
                    return row;
                });

                if (!inserted) {
                    return null;
                }

                const item = transformInsertedItemRow(
                    inserted,
                    { ...externalIds, internal: internalId },
                    mediaType,
                    params.surface,
                    seriesExternalIds,
                );

                return { type: 'single', item };
            }
        }

        // ========================================
        // Single Item (Movie or Episode)
        // ========================================

        const singleItemMediaId = await resolvePreferredToMediaId(sql, preferred, mediaType);
        if (!singleItemMediaId) {
            logger.warn('Could not resolve media_id for item', {
                externalIds,
                mediaType,
                title,
            });
            return null;
        }

        // The kind-policy gate at the top of this method only checked the
        // CALLER-CLAIMED `mediaType`. `resolvePreferredToMediaId`'s
        // `internal`-UUID fast path (above) — and `resolveExternalIdsToMediaId`'s
        // equivalent in media-resolution.ts — return a caller-supplied UUID
        // VERBATIM, with no check that the row it names actually has the
        // claimed type. So `{externalIds:{internal:"<episode uuid>"},
        // mediaType:"movie"}` sails past the gate above and reaches here with
        // an id whose REAL type disagrees with what was claimed. Re-check
        // against the resolved row, but ONLY for a restrictive policy
        // (`allowedMediaTypes !== 'all'`) — an open policy can never reject
        // anything here, so this never adds a query to the ordinary-playlist
        // hot path. Series/album expansion above already runs under
        // OPEN_POLICY exclusively (a restrictive policy has
        // `expandContainers: false`), so it never reaches this check either.
        if (policy.allowedMediaTypes !== 'all') {
            // Not a content-visibility check — this only reads the TYPE of a
            // single already-resolved row the caller is trying to add to
            // their OWN playlist (ownership/edit-role is enforced by the
            // caller — see getPlaylistContext/canEdit in the def). No
            // library-group or age gate applies to which type a row is.
            const [actualRow] = await sql<{ media_type: string }[]>`
                SELECT media_type FROM media_items WHERE id = ${singleItemMediaId}::uuid
            `;
            if (!isMediaTypeAllowed(policy, actualRow?.media_type ?? '')) {
                logger.info(
                    'Rejected item: resolved media type not allowed for this playlist kind',
                    {
                        playlistId,
                        claimedMediaType: mediaType,
                        resolvedMediaType: actualRow?.media_type ?? null,
                        playlistType: params.playlistType,
                    },
                );
                return { type: 'rejected', reason: 'media_type_not_allowed' };
            }
        }

        // Episode adds that carry the episode's own internal UUID (e.g. picked
        // straight out of search results) arrive with no season/episode/series
        // name — that data never round-trips through external ids. Derive it
        // from the hierarchy instead. Without this the insert still SUCCEEDS,
        // writing NULL season/episode, and the row renders as an untyped item
        // outside all series/season grouping.
        //
        // Keyed on externalIds.internal directly rather than `preferred`:
        // provider preference can resolve to tmdb/imdb, and we need the UUID.
        //
        // A hit overrides the client-supplied values — the DB is the source of
        // truth, so a stale payload self-heals. A miss falls through unchanged,
        // preserving the SeriesEpisodePicker and SxxEyy paths, which supply
        // series external ids plus full season/episode themselves.
        let episodeSeasonNumber = seasonNumber;
        let episodeEpisodeNumber = episodeNumber;
        let episodeSeriesName = seriesName;
        let episodeSeriesExternalIds: PartialExternalIds | undefined;

        const episodeInternalId = isEpisode(mediaType)
            ? getExternalIdFor(externalIds, 'internal')
            : null;

        if (episodeInternalId) {
            const ctx = await resolveEpisodeContext(sql, episodeInternalId);
            if (ctx) {
                episodeSeasonNumber = ctx.seasonNumber;
                episodeEpisodeNumber = ctx.episodeNumber;
                episodeSeriesName = ctx.seriesName ?? seriesName;
                if (ctx.seriesMediaId) {
                    episodeSeriesExternalIds = { internal: ctx.seriesMediaId };
                }
            }
        }

        // Wrap in a transaction with an advisory lock on playlistId so the
        // atomic MAX(position)+1 in insertPlaylistItem cannot race against a
        // concurrent add to the same playlist.
        const row = await withTx(sql, async (txRaw) => {
            const tx = txRaw as unknown as postgres.Sql;
            await tx`SELECT pg_advisory_xact_lock(${playlistId})`;
            const inserted = await insertPlaylistItem(tx, {
                playlistId,
                mediaId: singleItemMediaId,
                // A non-expanding playlist stores exactly one row per media_id.
                // idx_playlist_items_unique_media includes COALESCE(season_number,-1),
                // so a stray seasonNumber would let the same movie occupy two
                // rows — which fans out the /j IsFavorite semi-joins.
                seasonNumber: policy.expandContainers ? (episodeSeasonNumber ?? null) : null,
                episodeNumber: policy.expandContainers ? (episodeEpisodeNumber ?? null) : null,
                title,
                seriesName: episodeSeriesName || null,
                overview: overview || null,
                posterPath: posterPath || null,
            });
            if (!inserted) return null;
            await touchPlaylist(tx, playlistId);
            return inserted;
        });

        if (!row) {
            return null;
        }

        logger.info('Item added to playlist', {
            playlistId,
            itemId: row.id,
            externalIds,
            mediaType,
            username,
        });

        // For a search-sourced episode the client sends the episode's own ids as
        // seriesExternalIds (it has nothing better), which would report a series
        // id that does not identify the series. Prefer the resolved series.
        const item = transformInsertedItemRow(
            row,
            { ...externalIds, internal: singleItemMediaId },
            mediaType,
            params.surface,
            episodeSeriesExternalIds ?? seriesExternalIds,
        );

        return { type: 'single', item };
    }

    /**
     * Remove an item from a playlist and reorder remaining items.
     * Returns false when the item is not found.
     */
    async removeItem(params: RemoveItemParams): Promise<boolean> {
        return (await this.removeEntry(params)) !== null;
    }

    /** Remove an entry and capture its summary before releasing the playlist lock. */
    async removeEntry(params: RemoveItemParams): Promise<PlaylistSummary | null> {
        const { sql, playlistId, itemId, username } = params;

        return withTx(sql, async (txRaw) => {
            // postgres.js types TransactionSql and Sql as distinct generics despite
            // being structurally compatible at runtime; cast via unknown to satisfy them.
            const tx = txRaw as unknown as postgres.Sql;
            // Serialize concurrent deletes/reorders on this playlist so the
            // position read + reorder cannot race against a sibling delete.
            await tx`SELECT pg_advisory_xact_lock(${playlistId})`;

            // Read position INSIDE the lock so two concurrent deletes don't
            // compute reorder offsets from stale positions.
            const deletedPosition = await getItemPosition(tx, itemId, playlistId);
            if (deletedPosition === null) {
                return null;
            }

            const deleted = await deletePlaylistItem(tx, itemId, playlistId);

            if (!deleted) {
                return null;
            }

            await reorderItemsAfterDelete(tx, playlistId, deletedPosition);
            await touchPlaylist(tx, playlistId);

            logger.info('Item removed from playlist', {
                playlistId,
                itemId,
                username,
            });

            return await getPlaylistSummary(tx, playlistId);
        });
    }
}

export const playlistItemManager = new PlaylistItemManager();
