// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Availability Determination Service
 *
 * Centralizes availability and request status logic from multiple sources
 * (Jellyfin availability + Jellyseerr request status)
 */

import type { MediaItem } from '../types.js';
import type { BaseItemDto, MediaStream } from '@jellyfin/sdk/lib/generated-client/models';
import type { SonarrSeries } from '../sonarr.js';
import { GenreService } from './genre.service.js';
import type { ExternalIds } from '$lib/types/api-common.js';
import { mediaCompositeKey } from '$lib/utils/media-id-helpers.js';
import { hasAnyExternalId } from '$lib/utils/external-ids.js';
import { getFriendlyResolution } from '$lib/utils/media-display.js';
import { providerResolutionService } from './provider-resolution.service.js';
import { isMovie, isSeries } from '../utils/media-types';
import { toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';
import { getDb } from '../database/connection.js';

/** Extended Jellyfin item with provider IDs and media sources */
export interface JellyfinAvailabilityItem extends BaseItemDto {
    ProviderIds?: Record<string, string>;
    MediaSources?: Array<{
        MediaStreams?: MediaStream[];
    }>;
}

/** Radarr movie item for availability checking */
interface RadarrAvailabilityItem {
    id: number;
    tmdbId: number;
    hasFile: boolean;
    monitored: boolean;
    movieFile?: {
        quality?: {
            quality?: {
                name?: string;
            };
        };
        size?: number;
    };
}

/** Jellyseerr item for request status */
interface JellyseerrAvailabilityItem {
    id: number;
    status: number; // 1: Available, 2: Pending, 3: Processing, 4: Partial
}

export interface AvailabilityInfo {
    is_available: boolean;
    can_request: boolean;
    availability_source: 'jellyfin' | 'radarr' | 'sonarr' | 'none';
    request_status?: 'available' | 'pending' | 'processing' | 'partial' | 'unknown';
    jellyfin_id?: string;
    internal_id?: string;
    jellyseerr_id?: number;
    tmdb_id?: number;
    additional_info?: {
        file_quality?: string;
        file_size?: number;
        added_date?: string;
        monitored?: boolean;
        has_file?: boolean;
    };
}

export interface RequestabilityRules {
    allowMovieRequests: boolean;
    allowTvRequests: boolean;
    requireApproval: boolean;
    maxPendingRequests?: number;
    allowedQualities?: string[];
    blockedGenres?: number[];
}

/**
 * Availability Determination Service
 * Consolidates availability logic from multiple endpoints
 */
export class AvailabilityService {
    /**
     * Determine comprehensive availability status for a media item
     *
     * IMPORTANT: Uses externalIds parameter to avoid TMDB ID collisions.
     * Resolves to tmdbId internally only for matching against Jellyfin/Radarr data.
     */
    static async determineAvailability(
        externalIds: ExternalIds,
        mediaType: 'movie' | 'tv',
        additionalSources?: {
            jellyfinItems?: JellyfinAvailabilityItem[];
            jellyseerrItem?: JellyseerrAvailabilityItem;
            radarrItem?: RadarrAvailabilityItem;
            sonarrItem?: SonarrSeries;
        },
    ): Promise<AvailabilityInfo> {
        // Resolve externalIds to tmdbId for internal matching (required for Jellyfin/Radarr lookups)
        const resolution = await providerResolutionService.resolveToTmdb(externalIds, mediaType);
        if (!resolution.success) {
            return {
                is_available: false,
                can_request: false,
                availability_source: 'none',
            };
        }

        const tmdbId = resolution.tmdbId;
        const result: AvailabilityInfo = {
            is_available: false,
            can_request: false,
            availability_source: 'none',
            tmdb_id: tmdbId,
        };

        const { jellyfinItems, jellyseerrItem, radarrItem, sonarrItem } = additionalSources || {};

        // Check Jellyfin availability (primary source)
        // CRITICAL: Pass mediaType to avoid TMDB ID collisions (same ID can be movie AND TV)
        if (jellyfinItems && jellyfinItems.length > 0) {
            const matchingItem = AvailabilityService.findJellyfinMatch(
                jellyfinItems,
                tmdbId,
                mediaType,
            );
            if (matchingItem) {
                result.is_available = true;
                result.availability_source = 'jellyfin';
                result.jellyfin_id = matchingItem.Id;

                // Resolve internal UUID for provider-agnostic image URLs
                try {
                    const sql = getDb();
                    if (sql && matchingItem.Id) {
                        const [row] = await sql<{ id: string }[]>`
                            SELECT mi.id FROM media_items mi
                            JOIN external_ids ei ON ei.media_id = mi.id
                            WHERE ei.provider = 'jellyfin' AND ei.external_id = ${matchingItem.Id}
                            LIMIT 1
                        `;
                        if (row) result.internal_id = row.id;
                    }
                } catch {
                    /* non-critical — fallback to jellyfin_id for images */
                }

                result.additional_info = {
                    added_date: matchingItem.DateCreated ?? undefined,
                    file_quality: AvailabilityService.extractJellyfinQuality(matchingItem),
                };

                // If available in Jellyfin, usually can't request
                result.can_request = false;
                return result;
            }
        }

        // Check Radarr availability (for movies)
        if (isMovie(mediaType) && radarrItem) {
            if (radarrItem.hasFile && radarrItem.movieFile) {
                result.is_available = true;
                result.availability_source = 'radarr';
                result.additional_info = {
                    has_file: radarrItem.hasFile,
                    file_quality: radarrItem.movieFile?.quality?.quality?.name,
                    file_size: radarrItem.movieFile?.size,
                    monitored: radarrItem.monitored,
                };
                result.can_request = false;
                return result;
            } else if (radarrItem.monitored) {
                // Movie is monitored but not available yet
                result.request_status = 'processing';
                result.can_request = false;
            }
        }

        // Check Sonarr availability (for TV shows)
        if (isSeries(mediaType) && sonarrItem) {
            const hasEpisodes = (sonarrItem.statistics?.episodeFileCount ?? 0) > 0;
            const totalEpisodes = sonarrItem.statistics?.totalEpisodeCount || 0;
            const availableEpisodes = sonarrItem.statistics?.episodeFileCount || 0;

            if (hasEpisodes) {
                result.is_available = availableEpisodes >= totalEpisodes * 0.8; // 80% available
                result.availability_source = 'sonarr';
                result.additional_info = {
                    has_file: hasEpisodes,
                    monitored: sonarrItem.monitored,
                };

                if (availableEpisodes < totalEpisodes) {
                    result.request_status = 'partial';
                } else {
                    result.can_request = false;
                    return result;
                }
            } else if (sonarrItem.monitored) {
                result.request_status = 'processing';
                result.can_request = false;
            }
        }

        // Check Jellyseerr request status
        if (jellyseerrItem) {
            result.jellyseerr_id = jellyseerrItem.id;

            switch (jellyseerrItem.status) {
                case 1: // Available
                    result.is_available = true;
                    result.can_request = false;
                    result.request_status = 'available';
                    break;
                case 2: // Pending
                    result.can_request = false;
                    result.request_status = 'pending';
                    break;
                case 3: // Processing
                    result.can_request = false;
                    result.request_status = 'processing';
                    break;
                case 4: // Partially Available
                    result.is_available = true;
                    result.can_request = true; // Can request missing parts
                    result.request_status = 'partial';
                    break;
                default:
                    result.can_request = true;
                    result.request_status = 'unknown';
            }
        } else {
            // Item not in Jellyseerr, can potentially be requested
            result.can_request = true;
        }

        return result;
    }

    /**
     * Find matching Jellyfin item by TMDB ID AND media type
     *
     * CRITICAL: Must match BOTH tmdb_id AND media_type to avoid TMDB ID collisions.
     * The same TMDB ID can refer to both a movie AND a TV show (e.g., ID 1429).
     */
    private static findJellyfinMatch(
        jellyfinItems: JellyfinAvailabilityItem[],
        tmdbId: number,
        mediaType: 'movie' | 'tv',
    ): JellyfinAvailabilityItem | null {
        return (
            jellyfinItems.find((item) => {
                const providerIds = item.ProviderIds || {};
                const itemTmdbId = Number.parseInt(providerIds.Tmdb || providerIds.tmdb || '0');
                // Map Jellyfin's "Series" type to our "tv" type. A null (a
                // Jellyfin container type, an Audio item, a channel …) can never
                // match the caller's 'movie' | 'tv', so it correctly excludes the
                // item — no substitute needed, and inventing one would have made
                // an audiobook match a movie's TMDB id.
                const itemMediaType = toTmdbType(item.Type);
                // Must match BOTH tmdb_id AND media_type to avoid collisions
                return itemTmdbId === tmdbId && itemMediaType === mediaType;
            }) || null
        );
    }

    /**
     * Extract quality information from Jellyfin item
     */
    private static extractJellyfinQuality(
        jellyfinItem: JellyfinAvailabilityItem,
    ): string | undefined {
        if (!jellyfinItem.MediaSources || jellyfinItem.MediaSources.length === 0) {
            return undefined;
        }

        const source = jellyfinItem.MediaSources[0];
        const videoStream = source.MediaStreams?.find((s: MediaStream) => s.Type === 'Video');

        if (videoStream) {
            const label = getFriendlyResolution(videoStream.Width ?? 0, videoStream.Height ?? 0);
            if (label) return label;
        }

        return undefined;
    }

    /**
     * Check if item can be requested based on rules
     */
    static canRequest(item: MediaItem | AvailabilityInfo, rules: RequestabilityRules): boolean {
        // Basic availability check
        if ('is_available' in item && item.is_available) {
            return false; // Already available
        }

        if ('request_status' in item && item.request_status === 'pending') {
            return false; // Already requested
        }

        // Media type rules
        const mediaType = 'mediaType' in item ? item.mediaType : 'movie'; // Default assumption

        if (isMovie(mediaType) && !rules.allowMovieRequests) {
            return false;
        }

        if (isSeries(mediaType) && !rules.allowTvRequests) {
            return false;
        }

        // Genre restrictions
        if (
            rules.blockedGenres &&
            rules.blockedGenres.length > 0 &&
            'genres' in item &&
            item.genres
        ) {
            const itemGenres = Array.isArray(item.genres) ? item.genres : [item.genres];
            const hasBlockedGenre = itemGenres.some(
                (genre: string | { id: number; name?: string }) => {
                    if (typeof genre === 'string') {
                        // Convert genre name to ID for checking
                        const genreId = GenreService.getGenreId(genre);
                        return genreId && rules.blockedGenres!.includes(genreId);
                    } else if (typeof genre === 'object' && genre && genre.id) {
                        return rules.blockedGenres!.includes(genre.id);
                    }
                    return false;
                },
            );

            if (hasBlockedGenre) return false;
        }

        return true;
    }

    /**
     * Batch check availability for multiple items
     * Returns Map with composite keys to avoid TMDB ID collisions
     *
     * IMPORTANT: Uses externalIds to avoid TMDB ID collisions at integration boundary.
     */
    static async batchCheckAvailability(
        items: Array<{ externalIds: ExternalIds; mediaType: 'movie' | 'tv' }>,
        sources?: {
            jellyfinItems?: JellyfinAvailabilityItem[];
            jellyseerrItems?: JellyseerrAvailabilityItem[];
            radarrItems?: RadarrAvailabilityItem[];
            sonarrItems?: SonarrSeries[];
        },
    ): Promise<Map<string, AvailabilityInfo>> {
        const results = new Map<string, AvailabilityInfo>();

        // Create lookup maps for efficient searching
        // All maps use composite keys (tmdbId:mediaType) to avoid TMDB ID collisions
        const jellyfinMap = AvailabilityService.createTmdbLookupMap(sources?.jellyfinItems || []);
        // Jellyseerr items need to be separated by media type - assume mixed input
        // Create separate maps for movie and tv lookups
        const jellyseerrMovieMap = AvailabilityService.createIdLookupMap(
            sources?.jellyseerrItems || [],
            'movie',
        );
        const jellyseerrTvMap = AvailabilityService.createIdLookupMap(
            sources?.jellyseerrItems || [],
            'tv',
        );
        const radarrMap = AvailabilityService.createTmdbLookupMap(sources?.radarrItems || []);
        const sonarrMap = AvailabilityService.createTvdbLookupMap(sources?.sonarrItems || []);

        for (const { externalIds, mediaType } of items) {
            // Resolve to tmdbId for lookups (required for Jellyfin/Radarr matching)
            const resolution = await providerResolutionService.resolveToTmdb(
                externalIds,
                mediaType,
            );
            if (!resolution.success) {
                const key = mediaCompositeKey(externalIds, mediaType);
                if (key) {
                    results.set(key, {
                        is_available: false,
                        can_request: false,
                        availability_source: 'none',
                    });
                }
                continue;
            }
            const tmdbId = resolution.tmdbId;

            // Use composite key for lookups to avoid TMDB ID collisions
            const compositeKey = `${tmdbId}:${mediaType}`;
            const jellyfinItem = jellyfinMap.get(compositeKey);
            const jellyseerrItem = isMovie(mediaType)
                ? jellyseerrMovieMap.get(compositeKey)
                : jellyseerrTvMap.get(compositeKey);
            const availability = await AvailabilityService.determineAvailability(
                externalIds,
                mediaType,
                {
                    jellyfinItems: jellyfinItem ? [jellyfinItem] : [],
                    jellyseerrItem: jellyseerrItem,
                    radarrItem: isMovie(mediaType) ? radarrMap.get(compositeKey) : undefined,
                    sonarrItem: isSeries(mediaType) ? sonarrMap.get(tmdbId) : undefined, // Sonarr uses TVDB, not TMDB
                },
            );

            // Use composite key to avoid TMDB ID collisions (same ID can be movie AND tv)
            const key = mediaCompositeKey(externalIds, mediaType);
            if (key) {
                results.set(key, availability);
            }
        }

        return results;
    }

    /**
     * Create TMDB ID lookup map for Jellyfin items
     * Uses composite key (tmdbId:mediaType) to avoid TMDB ID collisions
     */
    private static createTmdbLookupMap<T extends JellyfinAvailabilityItem | RadarrAvailabilityItem>(
        items: T[],
    ): Map<string, T> {
        const map = new Map<string, T>();

        items.forEach((item) => {
            // Check for Jellyfin ProviderIds structure
            const jellyfinItem = item as JellyfinAvailabilityItem;
            const radarrItem = item as RadarrAvailabilityItem;
            const providerIds = jellyfinItem.ProviderIds || {};
            const tmdbId = Number.parseInt(
                providerIds.Tmdb || providerIds.tmdb || String(radarrItem.tmdbId) || '0',
            );
            if (tmdbId > 0) {
                // Determine media type from item.
                // Jellyfin items have a Type field, Radarr items are always movies.
                //
                // Skip on null rather than interpolating it: the key is built by
                // template literal, so a null would have been stringified into the
                // map as the literal `"123:null"` — a key no lookup ever produces,
                // silently making the item permanently invisible instead of
                // visibly absent. (Before this refactor the same code path put a
                // non-TMDB item under `123:movie`, where it could shadow a real
                // movie with that id.)
                const mediaType = toTmdbType(jellyfinItem.Type);
                if (mediaType !== null) {
                    const compositeKey = `${tmdbId}:${mediaType}`;
                    map.set(compositeKey, item);
                }
            }
        });

        return map;
    }

    /**
     * Create ID lookup map (for items where ID is TMDB ID)
     * Uses composite key (tmdbId:mediaType) to avoid TMDB ID collisions
     */
    private static createIdLookupMap(
        items: JellyseerrAvailabilityItem[],
        mediaType: 'movie' | 'tv',
    ): Map<string, JellyseerrAvailabilityItem> {
        const map = new Map<string, JellyseerrAvailabilityItem>();

        items.forEach((item) => {
            if (item.id) {
                // Note: Jellyseerr items are requested separately for movies/tv
                // so we use the passed mediaType parameter
                const compositeKey = `${item.id}:${mediaType}`;
                map.set(compositeKey, item);
            }
        });

        return map;
    }

    /**
     * Create TVDB ID lookup map (for Sonarr items)
     */
    private static createTvdbLookupMap(items: SonarrSeries[]): Map<number, SonarrSeries> {
        const map = new Map<number, SonarrSeries>();

        items.forEach((item) => {
            const tvdbId = item.tvdbId;
            if (tvdbId) {
                map.set(tvdbId, item);
            }
        });

        return map;
    }

    /**
     * Enrich media items with availability information
     */
    static async enrichWithAvailability(
        items: MediaItem[],
        sources?: {
            jellyfinItems?: JellyfinAvailabilityItem[];
            jellyseerrItems?: JellyseerrAvailabilityItem[];
            radarrItems?: RadarrAvailabilityItem[];
            sonarrItems?: SonarrSeries[];
        },
    ): Promise<Array<MediaItem & { availability: AvailabilityInfo }>> {
        // Prepare batch check data - filter items with any resolvable external ID
        const batchItems = items
            .filter((item) => hasAnyExternalId(item.externalIds))
            .map((item) => ({
                externalIds: item.externalIds!,
                mediaType: isMovie(item.mediaType) ? ('movie' as const) : ('tv' as const),
            }));

        // Get availability info
        const availabilityMap = await AvailabilityService.batchCheckAvailability(
            batchItems,
            sources,
        );

        // Enrich items with availability using composite key
        return items.map((item) => {
            // Availability (Jellyseerr/Radarr/Sonarr) is a movie/TV-only concept.
            // MediaItem.mediaType (server/types.ts) also carries audiobook/artist/
            // album/track/book/... members that TMDB does not catalog and no
            // availability source can look up — fall into the same "no key" branch
            // used below instead of fabricating a composite key from a null type.
            const mediaType = toTmdbType(item.mediaType);
            const key = mediaType ? mediaCompositeKey(item.externalIds, mediaType) : null;
            const availability = key
                ? availabilityMap.get(key)
                : {
                      is_available: false,
                      can_request: false,
                      availability_source: 'none' as const,
                  };

            return {
                ...item,
                availability: availability || {
                    is_available: false,
                    can_request: false,
                    availability_source: 'none' as const,
                },
            };
        });
    }

    /**
     * Get availability statistics for a collection
     */
    static getAvailabilityStats(items: Array<{ availability?: AvailabilityInfo }>): {
        total: number;
        available: number;
        requestable: number;
        pending: number;
        processing: number;
        bySource: {
            jellyfin: number;
            radarr: number;
            sonarr: number;
            none: number;
        };
    } {
        const stats = {
            total: items.length,
            available: 0,
            requestable: 0,
            pending: 0,
            processing: 0,
            bySource: {
                jellyfin: 0,
                radarr: 0,
                sonarr: 0,
                none: 0,
            },
        };

        items.forEach((item) => {
            if (!item.availability) return;

            const { availability } = item;

            if (availability.is_available) stats.available++;
            if (availability.can_request) stats.requestable++;
            if (availability.request_status === 'pending') stats.pending++;
            if (availability.request_status === 'processing') stats.processing++;

            stats.bySource[availability.availability_source]++;
        });

        return stats;
    }

    /**
     * Filter items by availability status
     */
    static filterByAvailability<T extends { availability?: AvailabilityInfo }>(
        items: T[],
        filter: 'available' | 'unavailable' | 'requestable' | 'pending' | 'processing',
    ): T[] {
        return items.filter((item) => {
            if (!item.availability) return filter === 'unavailable';

            const { availability } = item;

            switch (filter) {
                case 'available':
                    return availability.is_available;
                case 'unavailable':
                    return !availability.is_available;
                case 'requestable':
                    return availability.can_request;
                case 'pending':
                    return availability.request_status === 'pending';
                case 'processing':
                    return availability.request_status === 'processing';
                default:
                    return true;
            }
        });
    }

    /**
     * Get request recommendations based on availability and user preferences
     */
    static getRequestRecommendations(
        items: Array<MediaItem & { availability?: AvailabilityInfo }>,
        userPreferences?: {
            preferredGenres?: number[];
            excludedGenres?: number[];
            minRating?: number;
            maxYear?: number;
            minYear?: number;
        },
        limit = 10,
    ): Array<MediaItem & { availability: AvailabilityInfo }> {
        let filtered = items.filter(
            (item) => item.availability?.can_request && !item.availability.is_available,
        ) as Array<MediaItem & { availability: AvailabilityInfo }>;

        // Apply user preferences
        if (userPreferences) {
            const { minRating, maxYear, minYear } = userPreferences;

            if (minRating) {
                filtered = filtered.filter((item) => (item.rating || 0) >= minRating);
            }

            if (minYear || maxYear) {
                filtered = filtered.filter((item) => {
                    const year = item.year;
                    if (!year) return true;
                    if (minYear && year < minYear) return false;
                    if (maxYear && year > maxYear) return false;
                    return true;
                });
            }
        }

        // Sort by rating and popularity
        filtered.sort((a, b) => {
            const ratingA = a.rating || 0;
            const ratingB = b.rating || 0;

            if (ratingA !== ratingB) {
                return ratingB - ratingA;
            }

            // Secondary sort by year (newer first)
            const yearA = a.year || 0;
            const yearB = b.year || 0;
            return yearB - yearA;
        });

        return filtered.slice(0, limit);
    }
}

// Export singleton instance for convenience
export const availabilityService = AvailabilityService;
