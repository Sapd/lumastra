// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MDBList Content Source Adapter
 *
 * Fetches holiday-themed content from curated MDBList playlists.
 * MDBList provides community-curated lists that can be used for holiday content.
 */

import type {
    ContentSourceAdapter,
    ContentSource,
    MdblistContentSource,
    HolidayConfig,
    DiscoveredItem,
} from '../types';
import { mdblistApi } from '$lib/server/services/mdblist-api';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('MdblistSource');

export class MdblistContentSourceAdapter implements ContentSourceAdapter {
    readonly type = 'mdblist' as const;

    isAvailable(): boolean {
        // MDBList public lists don't require an API key
        return true;
    }

    async discover(
        config: ContentSource,
        holiday: HolidayConfig,
        limit: number,
    ): Promise<DiscoveredItem[]> {
        if (config.type !== 'mdblist') {
            return [];
        }

        const mdblistConfig: MdblistContentSource = config;
        const results: DiscoveredItem[] = [];

        try {
            logger.debug('Fetching MDBList playlist', {
                listPath: mdblistConfig.listPath,
                limit: mdblistConfig.limit || limit,
            });

            const listItems = await mdblistApi.getList(
                mdblistConfig.listPath,
                mdblistConfig.limit || limit,
            );

            if (!listItems || listItems.length === 0) {
                logger.warn('MDBList playlist returned no items', {
                    listPath: mdblistConfig.listPath,
                });
                return [];
            }

            // Transform MDBList items to DiscoveredItems
            for (const item of listItems) {
                // MDBList uses 'id' as TMDB ID and 'mediatype' for type
                const id = item.id || item.tmdb_id;
                if (!id) {
                    continue;
                }

                // eslint-disable-next-line callback-safety/no-bare-media-type-comparison -- MDBList's mediatype field uses the external 'show' alias.
                const mediaType = item.mediatype === 'show' ? 'tv' : 'movie';

                // Safely coerce score_average to number (API may return string or undefined)
                const scoreAverage = Number(item.score_average);
                const safeScore = Number.isFinite(scoreAverage) ? scoreAverage : undefined;

                results.push({
                    id,
                    mediaType,
                    title: item.title || 'Unknown',
                    overview: undefined, // MDBList list items don't include overview
                    posterPath: undefined, // Will be enriched later from TMDB
                    backdropPath: undefined,
                    releaseDate: item.release_year ? `${item.release_year}-01-01` : undefined,
                    popularity: undefined, // MDBList uses rank instead
                    voteAverage: safeScore,
                    voteCount: undefined,
                    genreIds: undefined,
                    source: 'mdblist',
                    boostFactor: mdblistConfig.boostFactor || 1.0,
                    isFeatured: false,
                    isNewRelease: false,
                    isFromCollection: false,
                });
            }

            logger.debug('MDBList source discovered', {
                count: results.length,
                listPath: mdblistConfig.listPath,
                holidayId: holiday.id,
            });
        } catch (error) {
            logger.error('MDBList discovery failed', error as Error, {
                listPath: mdblistConfig.listPath,
            });
        }

        return results;
    }
}

// Export singleton instance
export const mdblistSource = new MdblistContentSourceAdapter();
