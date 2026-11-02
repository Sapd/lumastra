// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin Image Fallback Strategy Pattern
 *
 * Handles complex fallback chains for different Jellyfin item types.
 * Each strategy defines which alternative items/types to try when the primary image fails.
 */

import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('JellyfinFallbackStrategy');

/**
 * Represents a fallback attempt
 */
export interface FallbackAttempt {
    itemId: string;
    imageType: string;
    description: string;
}

/**
 * Jellyfin item info from API
 */
export interface JellyfinItemInfo {
    Type: string;
    SeriesId?: string;
    ParentId?: string;
    AlbumId?: string;
}

/**
 * Strategy for determining fallback chains
 */
export interface FallbackStrategy {
    /**
     * Get ordered list of fallback attempts for this item type
     * @param itemId - Original item ID
     * @param jellyfinType - Requested image type (Primary, Backdrop, etc.)
     * @param itemInfo - Item metadata from Jellyfin API
     * @returns Array of fallback attempts to try in order
     */
    getFallbackChain(
        itemId: string,
        jellyfinType: string,
        itemInfo: JellyfinItemInfo,
    ): FallbackAttempt[];
}

/**
 * Episode fallback: Episode → Series
 */
class EpisodeFallbackStrategy implements FallbackStrategy {
    getFallbackChain(
        itemId: string,
        jellyfinType: string,
        itemInfo: JellyfinItemInfo,
    ): FallbackAttempt[] {
        const seriesId = itemInfo.SeriesId || itemInfo.ParentId;
        if (!seriesId) return [];

        logger.debug('Episode fallback: trying series image', {
            itemId,
            seriesId,
        });

        if (jellyfinType === 'Thumb') {
            return [
                {
                    itemId,
                    imageType: 'Primary',
                    description: 'Episode Primary for thumbnail',
                },
                {
                    itemId: seriesId,
                    imageType: 'Thumb',
                    description: 'Series Thumb for episode',
                },
                {
                    itemId: seriesId,
                    imageType: 'Backdrop',
                    description: 'Series Backdrop for episode',
                },
                {
                    itemId: seriesId,
                    imageType: 'Primary',
                    description: 'Series Primary for episode',
                },
            ];
        }

        return [
            {
                itemId: seriesId,
                imageType: jellyfinType,
                description: `Series ${jellyfinType} for episode`,
            },
        ];
    }
}

/**
 * Audio track fallback: Audio → Album Primary → Album Backdrop → Track Primary
 */
class AudioFallbackStrategy implements FallbackStrategy {
    getFallbackChain(
        itemId: string,
        jellyfinType: string,
        itemInfo: JellyfinItemInfo,
    ): FallbackAttempt[] {
        const albumId = itemInfo.AlbumId || itemInfo.ParentId;
        if (!albumId) return [];

        logger.debug('Audio fallback: trying album images', {
            itemId,
            albumId,
        });

        return [
            {
                itemId: albumId,
                imageType: 'Primary',
                description: 'Album Primary for audio track',
            },
            {
                itemId: albumId,
                imageType: 'Backdrop',
                description: 'Album Backdrop for audio track',
            },
            {
                itemId: itemId,
                imageType: 'Primary',
                description: 'Track Primary as last resort',
            },
        ];
    }
}

/**
 * Music album fallback: MusicAlbum → Backdrop
 */
class MusicAlbumFallbackStrategy implements FallbackStrategy {
    getFallbackChain(
        itemId: string,
        _jellyfinType: string,
        _itemInfo: JellyfinItemInfo,
    ): FallbackAttempt[] {
        logger.debug('MusicAlbum fallback: trying backdrop', { itemId });

        return [
            {
                itemId: itemId,
                imageType: 'Backdrop',
                description: 'Backdrop for music album',
            },
        ];
    }
}

/**
 * Season fallback: Season → Series
 */
class SeasonFallbackStrategy implements FallbackStrategy {
    getFallbackChain(
        itemId: string,
        jellyfinType: string,
        itemInfo: JellyfinItemInfo,
    ): FallbackAttempt[] {
        const seriesId = itemInfo.ParentId;
        if (!seriesId) return [];

        logger.debug('Season fallback: trying series image', {
            itemId,
            seriesId,
        });

        return [
            {
                itemId: seriesId,
                imageType: jellyfinType,
                description: `Series ${jellyfinType} for season`,
            },
        ];
    }
}

/**
 * Generic fallback: Backdrop → Primary
 */
class GenericFallbackStrategy implements FallbackStrategy {
    getFallbackChain(
        itemId: string,
        jellyfinType: string,
        _itemInfo: JellyfinItemInfo,
    ): FallbackAttempt[] {
        // Only apply Backdrop → Primary fallback
        if (jellyfinType !== 'Backdrop') return [];

        logger.debug('Generic fallback: trying Primary instead of Backdrop', {
            itemId,
        });

        return [
            {
                itemId: itemId,
                imageType: 'Primary',
                description: 'Primary as fallback for Backdrop',
            },
        ];
    }
}

/**
 * Registry of fallback strategies by item type
 */
const FALLBACK_STRATEGIES: Record<string, FallbackStrategy> = {
    Episode: new EpisodeFallbackStrategy(),
    Audio: new AudioFallbackStrategy(),
    MusicAlbum: new MusicAlbumFallbackStrategy(),
    Season: new SeasonFallbackStrategy(),
};

/**
 * Get fallback chain for a given item
 * @param itemId - Original item ID
 * @param itemType - Jellyfin item type (Episode, Audio, etc.)
 * @param jellyfinType - Image type (Primary, Backdrop, etc.)
 * @param itemInfo - Item metadata
 * @returns Array of fallback attempts plus generic fallback
 */
export function getFallbackChain(
    itemId: string,
    itemType: string,
    jellyfinType: string,
    itemInfo: JellyfinItemInfo,
): FallbackAttempt[] {
    const typeStrategy = FALLBACK_STRATEGIES[itemType];
    const genericStrategy = new GenericFallbackStrategy();

    const typeSpecificFallbacks = typeStrategy
        ? typeStrategy.getFallbackChain(itemId, jellyfinType, itemInfo)
        : [];

    const genericFallbacks = genericStrategy.getFallbackChain(itemId, jellyfinType, itemInfo);

    // Combine type-specific and generic fallbacks
    return [...typeSpecificFallbacks, ...genericFallbacks];
}
