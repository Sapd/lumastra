// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Episode Ordering Service
 *
 * Provides support for alternative episode orderings (absolute, DVD, regional).
 * Uses internal UUIDs from media_items table for storage.
 *
 * NOTE: This service is currently TMDB-backed for fetching ordering data.
 * The storage layer is provider-agnostic, but ordering discovery and sync
 * use TMDB's episode groups API directly. Future providers (TVDB, etc.)
 * would require extending the sync methods.
 */

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import type { TMDBEpisodeGroupSummary } from '../providers/implementations/tmdb/index.js';
import { tmdbApi, TMDBApiService } from '../providers/implementations/tmdb/index.js';
import {
    getEpisodeGroupProvider,
    registerEpisodeGroupProvider,
} from '../providers/episode-group-provider.js';
import { TmdbEpisodeGroupProvider } from '../providers/implementations/tmdb/episode-group-adapter.js';
import { Logger } from '../utils/logger.js';
import {
    getSeriesOrdering as getSeriesOrderingQuery,
    upsertSeriesOrdering,
    deleteSeriesOrdering,
    getEpisodeOrderings,
    findEpisodeByAbsoluteNumber as findEpisodeByAbsoluteNumberQuery,
    getAbsoluteNumber as getAbsoluteNumberQuery,
    hasOrderingsCache as hasOrderingsCacheQuery,
    deleteEpisodeOrderings,
    batchInsertEpisodeOrderings,
    resolveMediaIdFromTmdbId,
    resolveTmdbIdFromMediaId,
    linkEpisodeMediaIds,
    unlinkEpisodeMediaIds,
    type EpisodeOrderingInsert,
} from '../database/queries/episode-orderings.queries.js';

const logger = Logger.for('EpisodeOrderingService');

// =============================================================================
// Types
// =============================================================================

export type EpisodeOrderingType = 'standard' | 'dvd' | 'absolute' | 'regional' | 'other';

export type OrderingSource = 'manual' | 'auto';

/**
 * Result of applying an ordering to episodes (display-layer linking)
 */
export interface ApplyResult {
    applied: number;
    skipped: number;
    combined: number;
}

/**
 * Series ordering preference stored in database
 */
export interface SeriesOrdering {
    id: number;
    mediaId: string; // UUID from media_items
    orderingType: EpisodeOrderingType;
    orderingSource: OrderingSource;
    orderingProvider: string | null; // e.g., 'tmdb'
    orderingGroupId: string | null; // Provider-specific group ID
    createdAt: Date;
    updatedAt: Date;
}

/**
 * Episode with alternative ordering applied
 */
export interface OrderedEpisode {
    // Episode identification
    mediaId?: string; // UUID from media_items (if in catalog)
    providerEpisodeId: string; // Provider-specific ID

    // Original numbering (standard ordering)
    originalSeasonNumber: number;
    originalEpisodeNumber: number;

    // Display numbering (based on selected ordering)
    displaySeasonNumber: number | null; // null for absolute-only ordering
    displayEpisodeNumber: number;

    // Absolute number (if applicable)
    absoluteNumber?: number;

    // Ordering metadata
    orderingType: EpisodeOrderingType;
}

/**
 * Available ordering option for a series
 */
export interface AvailableOrdering {
    type: EpisodeOrderingType;
    provider: string;
    groupId: string;
    name: string;
    description?: string;
    episodeCount: number;
    groupCount: number;
    /** The provider's own group type code (TMDB: 1 original air date … 7 TV), for display. */
    providerType?: number;
}

/**
 * Series identifier - can use mediaId (UUID) or external IDs
 */
export interface SeriesIdentifier {
    mediaId?: string; // Internal UUID (preferred)
    tmdbId?: number; // For TMDB API calls
}

// =============================================================================
// Service
// =============================================================================

export class EpisodeOrderingService {
    constructor(private sql: postgres.Sql) {}

    // =========================================================================
    // Series Ordering Preference
    // =========================================================================

    /**
     * Get the episode ordering preference for a series
     */
    async getSeriesOrdering(seriesId: SeriesIdentifier): Promise<SeriesOrdering | null> {
        // Resolve to mediaId
        const mediaId = await this.resolveMediaId(seriesId);
        if (!mediaId) {
            return null;
        }

        const row = await getSeriesOrderingQuery(this.sql, mediaId);

        if (!row) {
            return null;
        }

        return {
            id: row.id,
            mediaId: row.media_id,
            orderingType: row.ordering_type,
            orderingSource: row.ordering_source,
            orderingProvider: row.ordering_provider,
            orderingGroupId: row.ordering_group_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    /**
     * Set the episode ordering preference for a series
     */
    async setSeriesOrdering(
        seriesId: SeriesIdentifier,
        orderingType: EpisodeOrderingType,
        options: {
            source?: OrderingSource;
            provider?: string;
            groupId?: string;
        } = {},
    ): Promise<SeriesOrdering> {
        const mediaId = await this.resolveMediaId(seriesId);
        if (!mediaId) {
            throw new Error('Could not resolve series to media_id');
        }

        const { source = 'manual', provider = null, groupId = null } = options;

        const row = await upsertSeriesOrdering(this.sql, {
            mediaId,
            orderingType,
            orderingSource: source,
            orderingProvider: provider,
            orderingGroupId: groupId,
        });

        logger.info('Series ordering updated', {
            mediaId,
            orderingType,
            provider,
            source,
        });

        return {
            id: row.id,
            mediaId: row.media_id,
            orderingType: row.ordering_type,
            orderingSource: row.ordering_source,
            orderingProvider: row.ordering_provider,
            orderingGroupId: row.ordering_group_id,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    /**
     * Reset series ordering to standard (default).
     * Clears episode_media_id links and deletes the preference.
     * No media_items mutation — display reverts to standard automatically.
     */
    async resetSeriesOrdering(seriesId: SeriesIdentifier): Promise<void> {
        const mediaId = await this.resolveMediaId(seriesId);
        if (!mediaId) {
            return;
        }

        // Clear episode_media_id links so display reverts to standard
        await unlinkEpisodeMediaIds(this.sql, mediaId);

        // Delete the preference
        await deleteSeriesOrdering(this.sql, mediaId);

        logger.info('Series ordering reset to standard', { mediaId });
    }

    // =========================================================================
    // Available Orderings Discovery
    // =========================================================================

    /**
     * Get available episode orderings for a series
     * Currently fetches from TMDB, but designed to support multiple providers
     */
    async getAvailableOrderings(seriesId: SeriesIdentifier): Promise<AvailableOrdering[]> {
        // Check if TMDB API is available before making calls
        if (!tmdbApi.isAvailable()) {
            logger.debug('TMDB API not available, skipping getAvailableOrderings');
            return [];
        }

        // Get TMDB ID for API call
        const tmdbId = await this.resolveTmdbId(seriesId);
        if (!tmdbId) {
            return [];
        }

        const groups = await tmdbApi.getEpisodeGroups(tmdbId);

        return groups.map((g: TMDBEpisodeGroupSummary) => ({
            type: TMDBApiService.mapEpisodeGroupType(g.type),
            provider: 'tmdb',
            groupId: g.id,
            name: g.name,
            description: g.description,
            episodeCount: g.episode_count,
            groupCount: g.group_count,
            providerType: g.type,
        }));
    }

    /**
     * Check if a series has alternative orderings available
     */
    async hasAlternativeOrderings(seriesId: SeriesIdentifier): Promise<boolean> {
        const orderings = await this.getAvailableOrderings(seriesId);
        return orderings.length > 0;
    }

    // =========================================================================
    // Episode Ordering Cache
    // =========================================================================

    /**
     * Sync episode orderings from a provider
     */
    async syncOrderings(
        seriesId: SeriesIdentifier,
        orderingType: EpisodeOrderingType,
        provider: string,
        groupId: string,
        options: { force?: boolean } = {},
    ): Promise<number> {
        const mediaId = await this.resolveMediaId(seriesId);
        if (!mediaId) {
            throw new Error('Could not resolve series to media_id');
        }

        const existing = await getSeriesOrderingQuery(this.sql, mediaId);
        if (
            !options.force &&
            existing &&
            existing.ordering_source === 'manual' &&
            existing.ordering_group_id &&
            existing.ordering_group_id !== groupId
        ) {
            throw new Error(
                `Refusing to overwrite manual ordering for ${mediaId} (group ${existing.ordering_group_id}); pass force to override`,
            );
        }

        // Look up the episode group provider
        const groupProvider = getEpisodeGroupProvider(provider);
        if (!groupProvider) {
            logger.warn('Unsupported ordering provider', { provider });
            return 0;
        }

        // Fetch episode group details from provider
        const groupDetails = await groupProvider.getGroupDetails(groupId);
        if (!groupDetails) {
            logger.warn('Episode group not found', { groupId });
            return 0;
        }

        let absoluteCounter = 0;
        const insertData: EpisodeOrderingInsert[] = [];

        // Sort seasons by order to ensure correct absolute numbering
        const sortedSeasons = [...groupDetails.seasons].sort((a, b) => a.order - b.order);

        // Process each season (group equivalent in the ordering).
        // Use the sorted array index (not season.order) so season numbers are
        // always consecutive (1, 2, 3…) even when provider order values
        // have gaps (e.g. 0, 2, 5 → season 1, 2, 3 rather than 1, 3, 6).
        for (let seasonIdx = 0; seasonIdx < sortedSeasons.length; seasonIdx++) {
            const season = sortedSeasons[seasonIdx];
            const groupSeasonNumber = seasonIdx + 1;

            // Sort episodes by order within each season
            const sortedEpisodes = [...season.episodes].sort((a, b) => a.order - b.order);

            for (const episode of sortedEpisodes) {
                absoluteCounter++;

                insertData.push({
                    series_media_id: mediaId,
                    provider,
                    provider_episode_id: String(episode.id),
                    ordering_type: orderingType,
                    ordering_group_id: groupId,
                    original_season_number: episode.seasonNumber,
                    original_episode_number: episode.episodeNumber,
                    order_season_number: orderingType === 'absolute' ? null : groupSeasonNumber,
                    order_episode_number: episode.order + 1,
                    absolute_number: orderingType === 'absolute' ? absoluteCounter : null,
                });
            }
        }

        // Wrap delete+insert in a transaction so a failed chunked insert
        // does not leave the table in a partially-updated state.
        if (insertData.length > 0) {
            await withTx(this.sql, async (txRaw) => {
                const tx = txRaw as unknown as postgres.Sql;
                await deleteEpisodeOrderings(tx, {
                    mediaId,
                    orderingType,
                    provider,
                    groupId,
                });
                await batchInsertEpisodeOrderings(tx, insertData);
            });

            logger.info('Episode orderings synced', {
                mediaId,
                orderingType,
                provider,
                episodeCount: insertData.length,
            });
        }

        return insertData.length;
    }

    // =========================================================================
    // Episode Ordering Queries
    // =========================================================================

    /**
     * Get ordered episodes for a series using the configured ordering
     */
    async getOrderedEpisodes(
        seriesId: SeriesIdentifier,
        episodes: Array<{
            mediaId?: string;
            providerEpisodeId?: string;
            seasonNumber: number;
            episodeNumber: number;
        }>,
    ): Promise<OrderedEpisode[]> {
        const ordering = await this.getSeriesOrdering(seriesId);

        // If no alternative ordering configured, use standard
        if (!ordering || ordering.orderingType === 'standard') {
            return episodes.map((ep) => ({
                mediaId: ep.mediaId,
                providerEpisodeId: ep.providerEpisodeId || '',
                originalSeasonNumber: ep.seasonNumber,
                originalEpisodeNumber: ep.episodeNumber,
                displaySeasonNumber: ep.seasonNumber,
                displayEpisodeNumber: ep.episodeNumber,
                orderingType: 'standard' as const,
            }));
        }

        // Query cached orderings - filter by provider and group to avoid mixing
        const orderingRows = await getEpisodeOrderings(this.sql, {
            mediaId: ordering.mediaId,
            orderingType: ordering.orderingType,
            orderingProvider: ordering.orderingProvider,
            orderingGroupId: ordering.orderingGroupId,
        });

        // Build map of original S/E to ordered data
        const orderingMap = new Map<
            string,
            {
                providerEpisodeId: string;
                orderSeasonNumber: number | null;
                orderEpisodeNumber: number;
                absoluteNumber: number | null;
            }
        >();

        for (const row of orderingRows) {
            const key = `${row.original_season_number}:${row.original_episode_number}`;
            orderingMap.set(key, {
                providerEpisodeId: row.provider_episode_id,
                orderSeasonNumber: row.order_season_number,
                orderEpisodeNumber: row.order_episode_number,
                absoluteNumber: row.absolute_number,
            });
        }

        return episodes.map((ep) => {
            const key = `${ep.seasonNumber}:${ep.episodeNumber}`;
            const ordered = orderingMap.get(key);

            if (ordered) {
                return {
                    mediaId: ep.mediaId,
                    providerEpisodeId: ordered.providerEpisodeId,
                    originalSeasonNumber: ep.seasonNumber,
                    originalEpisodeNumber: ep.episodeNumber,
                    displaySeasonNumber: ordered.orderSeasonNumber,
                    displayEpisodeNumber: ordered.orderEpisodeNumber,
                    absoluteNumber: ordered.absoluteNumber || undefined,
                    orderingType: ordering.orderingType,
                };
            }

            // Fallback to standard numbering but preserve configured orderingType
            // This indicates the episode wasn't found in the ordering cache
            // (may be a special/extra episode not in the ordering group)
            return {
                mediaId: ep.mediaId,
                providerEpisodeId: ep.providerEpisodeId || '',
                originalSeasonNumber: ep.seasonNumber,
                originalEpisodeNumber: ep.episodeNumber,
                displaySeasonNumber: ep.seasonNumber,
                displayEpisodeNumber: ep.episodeNumber,
                orderingType: ordering.orderingType, // Keep configured type, not 'standard'
            };
        });
    }

    /**
     * Look up episode by absolute number
     * Uses the series' configured ordering preference to determine which cache to query
     */
    async findEpisodeByAbsoluteNumber(
        seriesId: SeriesIdentifier,
        absoluteNumber: number,
    ): Promise<{
        providerEpisodeId: string;
        originalSeasonNumber: number;
        originalEpisodeNumber: number;
    } | null> {
        // Get ordering preference to determine which cache to query
        const ordering = await this.getSeriesOrdering(seriesId);
        if (!ordering) {
            return null;
        }

        const row = await findEpisodeByAbsoluteNumberQuery(this.sql, {
            mediaId: ordering.mediaId,
            absoluteNumber,
            orderingProvider: ordering.orderingProvider,
            orderingGroupId: ordering.orderingGroupId,
        });

        if (!row) {
            return null;
        }

        return {
            providerEpisodeId: row.provider_episode_id,
            originalSeasonNumber: row.original_season_number,
            originalEpisodeNumber: row.original_episode_number,
        };
    }

    /**
     * Get absolute number for an episode
     * Uses the series' configured ordering preference to determine which cache to query
     */
    async getAbsoluteNumber(
        seriesId: SeriesIdentifier,
        seasonNumber: number,
        episodeNumber: number,
    ): Promise<number | null> {
        // Get ordering preference to determine which cache to query
        const ordering = await this.getSeriesOrdering(seriesId);
        if (!ordering) {
            return null;
        }

        return getAbsoluteNumberQuery(this.sql, {
            mediaId: ordering.mediaId,
            seasonNumber,
            episodeNumber,
            orderingProvider: ordering.orderingProvider,
            orderingGroupId: ordering.orderingGroupId,
        });
    }

    // =========================================================================
    // Apply Ordering (Display-Layer)
    // =========================================================================

    /**
     * Apply an episode ordering by linking episode_orderings to local media_items.
     * Does NOT mutate media_items — only populates episode_media_id via three-tier matching.
     * Queries use LEFT JOIN + COALESCE to display ordered numbers at read time.
     */
    async applyOrderingToEpisodes(
        seriesId: SeriesIdentifier,
        fallbackOrderingType: EpisodeOrderingType,
        provider: string,
        groupId: string,
    ): Promise<ApplyResult> {
        const mediaId = await this.resolveMediaId(seriesId);
        if (!mediaId) {
            throw new Error('Could not resolve series to media_id');
        }

        // Prefer stored preference; fall back to caller-provided type
        const ordering = await this.getSeriesOrdering(seriesId);
        const orderingType = ordering?.orderingType ?? fallbackOrderingType;

        const result = await withTx(this.sql, async (txRaw) => {
            const tx = txRaw as unknown as postgres.Sql;
            // Clear any previous links first
            await unlinkEpisodeMediaIds(tx, mediaId, orderingType, provider, groupId);
            // Run three-tier matching (provider ID → S/E number → unmatched)
            return await linkEpisodeMediaIds(tx, mediaId, orderingType, provider, groupId);
        });

        logger.info('Episode ordering applied (display-layer)', {
            mediaId,
            orderingType,
            provider,
            linked: result.linked,
            unlinked: result.unlinked,
        });

        return {
            applied: result.linked,
            skipped: result.unlinked,
            combined: result.combined,
        };
    }

    // =========================================================================
    // Sync Helpers
    // =========================================================================

    /**
     * Sync all orderings for a series (all available types)
     */
    async syncAllOrderings(
        seriesId: SeriesIdentifier,
    ): Promise<{ type: EpisodeOrderingType; provider: string; count: number }[]> {
        const available = await this.getAvailableOrderings(seriesId);
        const results: {
            type: EpisodeOrderingType;
            provider: string;
            count: number;
        }[] = [];

        for (const ordering of available) {
            const count = await this.syncOrderings(
                seriesId,
                ordering.type,
                ordering.provider,
                ordering.groupId,
                { force: true },
            );
            results.push({
                type: ordering.type,
                provider: ordering.provider,
                count,
            });
        }

        return results;
    }

    /**
     * Check if orderings are cached for a series
     */
    async hasOrderingsCache(
        seriesId: SeriesIdentifier,
        orderingType?: EpisodeOrderingType,
    ): Promise<boolean> {
        const mediaId = await this.resolveMediaId(seriesId);
        if (!mediaId) {
            return false;
        }

        return hasOrderingsCacheQuery(this.sql, mediaId, orderingType);
    }

    /**
     * Clear orderings cache for a series
     * @param seriesId - Series identifier
     * @param options - Optional filters: orderingType, provider, groupId
     *                  If none provided, clears all orderings for the series
     */
    async clearOrderingsCache(
        seriesId: SeriesIdentifier,
        options: {
            orderingType?: EpisodeOrderingType;
            provider?: string;
            groupId?: string;
        } = {},
    ): Promise<void> {
        const mediaId = await this.resolveMediaId(seriesId);
        if (!mediaId) {
            return;
        }

        const { orderingType, provider, groupId } = options;

        await deleteEpisodeOrderings(this.sql, {
            mediaId,
            orderingType,
            provider,
            groupId,
        });

        logger.info('Orderings cache cleared', {
            mediaId,
            orderingType,
            provider,
            groupId,
        });
    }

    // =========================================================================
    // ID Resolution Helpers
    // =========================================================================

    /**
     * Resolve a series identifier to internal media_id (UUID)
     */
    private async resolveMediaId(seriesId: SeriesIdentifier): Promise<string | null> {
        // If mediaId provided, use it directly
        if (seriesId.mediaId) {
            return seriesId.mediaId;
        }

        // Try to resolve from TMDB ID (must be TV series, not movie)
        if (seriesId.tmdbId) {
            const mediaId = await resolveMediaIdFromTmdbId(this.sql, seriesId.tmdbId);
            if (mediaId) {
                return mediaId;
            }
        }

        return null;
    }

    /**
     * Resolve a series identifier to TMDB ID (for API calls)
     */
    private async resolveTmdbId(seriesId: SeriesIdentifier): Promise<number | null> {
        // If tmdbId provided, use it directly
        if (seriesId.tmdbId) {
            return seriesId.tmdbId;
        }

        // Try to resolve from mediaId
        if (seriesId.mediaId) {
            return resolveTmdbIdFromMediaId(this.sql, seriesId.mediaId);
        }

        return null;
    }
}

// =============================================================================
// Factory
// =============================================================================

let serviceInstance: EpisodeOrderingService | null = null;
let providersRegistered = false;

/**
 * Ensure built-in episode group providers are registered.
 * Lazy: runs once, on first service construction OR first direct registry
 * consumer. Exported because season-structure reconciliation reads the
 * registry via getEpisodeGroupProvider() without constructing the service —
 * in a fresh process the registry would otherwise be silently empty.
 */
export function ensureEpisodeGroupProvidersRegistered(): void {
    if (providersRegistered) return;
    providersRegistered = true;
    registerEpisodeGroupProvider(new TmdbEpisodeGroupProvider());
}

/**
 * Get or create the episode ordering service instance
 */
export function getEpisodeOrderingService(sql: postgres.Sql): EpisodeOrderingService {
    if (!serviceInstance) {
        ensureEpisodeGroupProvidersRegistered();
        serviceInstance = new EpisodeOrderingService(sql);
    }
    return serviceInstance;
}
