// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Status Resolvers
 *
 * Determines the current status of media requests by checking multiple sources:
 * Jellyfin → Sonarr/Radarr Queue → Sonarr/Radarr monitoring → Jellyseerr
 */

import { MediaStatus, type SeasonRequestStatus } from '$lib/server/jellyseerr.js';
import {
    radarrClient,
    type RadarrMovie,
    type SonarrQueueResponse,
    type RadarrQueueResponse,
} from '$lib/server/sonarr.js';
import * as m from '$lib/paraglide/messages.js';
import type { RequestStatusResult, StatusType, DownloadProgress, ArrStatus } from './types.js';
import type { ExternalIds } from '$lib/types/api-common.js';
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import type { AgeRatingFilterParams } from '$lib/server/database/queries/builders/age-rating.builder.js';
import { checkLocalAvailability, checkSeasonAvailability, checkIfWatched } from './database.js';
import {
    getSeasonProgressFromSonarr,
    getTvProgressFromSonarr,
    getMovieProgressFromRadarr,
} from './progress.js';
import { formatReleaseDate, isDateInFuture } from './utils.js';
import {
    mapSeasonRequestStatus,
    getStatusMessage,
    getStatusFromDownloadState,
} from './status-mapping.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('RequestStatusResolvers');

// ============================================================================
// Re-Request State Machine
// ============================================================================

// ============================================================================
// Season Status Resolver
// ============================================================================

/**
 * Determine status for a specific TV season
 *
 * Priority: active Sonarr downloads → complete local season → Jellyseerr
 */
export async function determineSeasonStatus(
    externalIds: ExternalIds,
    seasonNumber: number,
    tvdbId: number | undefined,
    sonarrQueue: SonarrQueueResponse,
    jellyseerrSeasonStatuses: SeasonRequestStatus[] | null,
    requestAge: number = 0,
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    } = { deniedGroupIds: null, ageRating: null },
    watchedUserId?: string,
): Promise<RequestStatusResult> {
    const primaryId = getExternalIdFor(externalIds, getPrimaryExternalIdProvider()) ?? '';

    const seasonJellyseerrStatus = jellyseerrSeasonStatuses?.find(
        (s) => s.seasonNumber === seasonNumber,
    );

    logger.debug('Determining season status', {
        primaryId,
        seasonNumber,
        tvdbId,
        requestAge,
        jellyseerrSeasonCount: jellyseerrSeasonStatuses?.length ?? 0,
        seasonJellyseerrStatus: seasonJellyseerrStatus
            ? {
                  status: seasonJellyseerrStatus.status,
                  isRequested: seasonJellyseerrStatus.isRequested,
                  isAvailable: seasonJellyseerrStatus.isAvailable,
                  requestStatus: seasonJellyseerrStatus.requestStatus,
              }
            : null,
    });

    // 1. Check Sonarr queue for downloads (most reliable with TVDB ID)
    if (tvdbId) {
        const sonarrProgress = getSeasonProgressFromSonarr(tvdbId, seasonNumber, sonarrQueue);
        if (sonarrProgress) {
            const { status, statusMessage } = getStatusFromDownloadState(sonarrProgress.state);
            return {
                externalIds,
                mediaType: 'tv',
                seasonNumber,
                status,
                statusMessage,
                download: sonarrProgress,
            };
        }
    }

    // 2. Require a complete local season, not merely one playable episode.
    // A season whose aired episodes are all present counts as fulfilled even
    // when later episodes have not been released yet (nothing left to fetch).
    const jellyfinSeason = await checkSeasonAvailability(primaryId, seasonNumber, access);
    if (
        jellyfinSeason?.isCaughtUp ||
        (jellyfinSeason?.isAvailable &&
            seasonJellyseerrStatus?.status !== MediaStatus.PARTIALLY_AVAILABLE)
    ) {
        // Populate `watched` so the widget's allWatched auto-remove can fire for
        // season results (mirroring the movie / full-show available paths).
        const watched = watchedUserId
            ? await checkIfWatched(watchedUserId, externalIds, 'tv')
            : undefined;
        return {
            externalIds,
            mediaType: 'tv',
            seasonNumber,
            status: 'available',
            statusMessage: m.req_available(),
            watched,
        };
    }

    // 3. Check Jellyseerr for request status (using pre-fetched statuses)
    if (seasonJellyseerrStatus) {
        // 3a. Jellyseerr says available but has_files is not set yet → synching
        // (The local episode files are not all visible yet.)
        if (seasonJellyseerrStatus.isAvailable) {
            return {
                externalIds,
                mediaType: 'tv',
                seasonNumber,
                status: 'synching',
                statusMessage: m.req_processing(),
            };
        }
        // 3b. Has explicit request status string.
        // PARTIALLY_AVAILABLE (4) is reported with requestStatus 'processing'
        // (indistinguishable from PROCESSING at the string level), which would
        // hide partial availability. Skip the string mapping for status 4
        // so the numeric branch can report that remaining episodes are monitored.
        if (
            seasonJellyseerrStatus.status !== MediaStatus.PARTIALLY_AVAILABLE &&
            seasonJellyseerrStatus.isRequested &&
            seasonJellyseerrStatus.requestStatus
        ) {
            const mappedStatus =
                mapSeasonRequestStatus(seasonJellyseerrStatus.requestStatus) || 'pending';
            return {
                externalIds,
                mediaType: 'tv',
                seasonNumber,
                status: mappedStatus,
                statusMessage: getStatusMessage(mappedStatus),
            };
        }
        // 3c. Fall back to numeric status code
        if (seasonJellyseerrStatus.status !== undefined) {
            // AVAILABLE (5) but has_files not set yet → synching
            if (seasonJellyseerrStatus.status === 5)
                return {
                    externalIds,
                    mediaType: 'tv',
                    seasonNumber,
                    status: 'synching',
                    statusMessage: m.req_processing(),
                };
            // PARTIALLY_AVAILABLE (4), with no active queue → waiting for remaining episodes
            if (seasonJellyseerrStatus.status === 4)
                return {
                    externalIds,
                    mediaType: 'tv',
                    seasonNumber,
                    status: 'monitored',
                    statusMessage: m.request_status_monitored_searching(),
                };
            // PROCESSING (3) → downloading/searching
            if (seasonJellyseerrStatus.status === 3) {
                if (requestAge < 10 * 60 * 1000) {
                    return {
                        externalIds,
                        mediaType: 'tv',
                        seasonNumber,
                        status: 'searching',
                        statusMessage: m.req_searching(),
                    };
                }
                return {
                    externalIds,
                    mediaType: 'tv',
                    seasonNumber,
                    status: 'searching',
                    statusMessage: m.request_status_searching(),
                };
            }
            // PENDING (2)
            if (seasonJellyseerrStatus.status === 2)
                return {
                    externalIds,
                    mediaType: 'tv',
                    seasonNumber,
                    status: 'pending',
                    statusMessage: m.request_sending(),
                };
        }
    }

    // 4. Default: Not available/not requested
    logger.debug('Season status fell through to unavailable', {
        primaryId,
        seasonNumber,
        hadJellyseerrData: !!seasonJellyseerrStatus,
        jellyseerrStatus: seasonJellyseerrStatus?.status,
        jellyseerrIsRequested: seasonJellyseerrStatus?.isRequested,
        jellyseerrRequestStatus: seasonJellyseerrStatus?.requestStatus,
    });
    return {
        externalIds,
        mediaType: 'tv',
        seasonNumber,
        status: 'unavailable',
        statusMessage: m.req_unavailable(),
    };
}

// ============================================================================
// Movie Status Resolver
// ============================================================================

/**
 * Determine status for a movie
 *
 * Priority: Jellyfin → Radarr Queue → Radarr Monitoring → Jellyseerr
 */
export async function determineMovieStatus(
    externalIds: ExternalIds,
    radarrQueue: RadarrQueueResponse,
    requestAge: number,
    jellyseerrStatus: MediaStatus | undefined,
    access: {
        deniedGroupIds: string[] | null;
        ageRating: AgeRatingFilterParams | null;
    },
): Promise<RequestStatusResult> {
    // Radarr APIs require TMDB integer IDs specifically
    const tmdbIdStr = getExternalIdFor(externalIds, 'tmdb');
    const tmdbId = tmdbIdStr ? parseInt(tmdbIdStr, 10) : null;

    // Lazy-load Radarr movie data (only fetched once if needed)
    let radarrMovie: RadarrMovie | null | undefined;
    async function getRadarrMovie(): Promise<RadarrMovie | null> {
        if (radarrMovie === undefined) {
            radarrMovie = tmdbId ? await radarrClient.getMovieByTmdbId(tmdbId) : null;
        }
        return radarrMovie;
    }

    // 1. Check if movie is available in Jellyfin (highest priority)
    const localAvailability = await checkLocalAvailability(externalIds, 'movie', access);
    if (localAvailability?.isAvailable) {
        return {
            externalIds,
            mediaType: 'movie',
            status: 'available',
            statusMessage: m.req_available(),
        };
    }

    // 2. Check Radarr queue for downloads
    const radarrProgress = tmdbId ? getMovieProgressFromRadarr(tmdbId, radarrQueue) : null;
    if (radarrProgress) {
        const { status, statusMessage } = getStatusFromDownloadState(radarrProgress.state);
        return {
            externalIds,
            mediaType: 'movie',
            status,
            statusMessage,
            download: radarrProgress,
        };
    }

    // 3. Check Radarr monitoring status
    const radarrMovieForMonitoring = await getRadarrMovie();
    if (radarrMovieForMonitoring) {
        if (radarrMovieForMonitoring.hasFile) {
            return {
                externalIds,
                mediaType: 'movie',
                status: 'synching',
                statusMessage: m.req_processing(),
            };
        }
        if (radarrMovieForMonitoring.monitored) {
            const nextRelease =
                radarrMovieForMonitoring.digitalRelease ||
                radarrMovieForMonitoring.physicalRelease ||
                radarrMovieForMonitoring.inCinemas;

            if (nextRelease && isDateInFuture(nextRelease)) {
                const formattedDate = formatReleaseDate(nextRelease);
                return {
                    externalIds,
                    mediaType: 'movie',
                    status: 'monitored',
                    statusMessage: formattedDate
                        ? m.request_status_available_from({
                              date: formattedDate,
                          })
                        : m.request_status_waiting_release(),
                };
            }
            if (
                radarrMovieForMonitoring.status === 'tba' ||
                radarrMovieForMonitoring.status === 'announced'
            ) {
                return {
                    externalIds,
                    mediaType: 'movie',
                    status: 'monitored',
                    statusMessage: m.request_status_waiting_release_date(),
                };
            }
            if (radarrMovieForMonitoring.status === 'inCinemas') {
                return {
                    externalIds,
                    mediaType: 'movie',
                    status: 'monitored',
                    statusMessage: m.request_status_in_cinema(),
                };
            }
            if (radarrMovieForMonitoring.status === 'released') {
                // Not in the Radarr queue (step 2) and no file yet: after an
                // hour, the title is simply waiting on the admin's service.
                const oneHour = 60 * 60 * 1000;
                if (requestAge > oneHour) {
                    return {
                        externalIds,
                        mediaType: 'movie',
                        status: 'monitored',
                        statusMessage: m.request_status_monitored_searching(),
                    };
                }
                return {
                    externalIds,
                    mediaType: 'movie',
                    status: 'searching',
                    statusMessage: m.req_searching(),
                };
            }
        }
    }

    // 4. Check Jellyseerr for request status
    // 4a. Jellyseerr says AVAILABLE but has_files not set yet → synching
    // (We reached this point because step 1 didn't find it via has_files)
    if (jellyseerrStatus === MediaStatus.AVAILABLE) {
        return {
            externalIds,
            mediaType: 'movie',
            status: 'synching',
            statusMessage: m.req_processing(),
        };
    }

    // 4b. Handle PROCESSING (the admin's service is working on it)
    if (jellyseerrStatus === MediaStatus.PROCESSING) {
        const radarrMovieData = await getRadarrMovie();
        if (radarrMovieData?.hasFile) {
            return {
                externalIds,
                mediaType: 'movie',
                status: 'synching',
                statusMessage: m.req_processing(),
            };
        }
        // No file yet — check request age for context
        const tenMinutes = 10 * 60 * 1000;
        const oneHour = 60 * 60 * 1000;
        if (requestAge < tenMinutes) {
            return {
                externalIds,
                mediaType: 'movie',
                status: 'searching',
                statusMessage: m.req_searching(),
            };
        }
        if (requestAge < oneHour) {
            return {
                externalIds,
                mediaType: 'movie',
                status: 'searching',
                statusMessage: m.request_status_searching(),
            };
        }
        // Old request, still processing — likely stuck
        if (radarrMovieData?.monitored) {
            return {
                externalIds,
                mediaType: 'movie',
                status: 'monitored',
                statusMessage: m.request_status_monitored_searching(),
            };
        }
        return {
            externalIds,
            mediaType: 'movie',
            status: 'unavailable',
            statusMessage: m.request_status_no_release_found(),
        };
    }

    if (jellyseerrStatus === MediaStatus.PENDING) {
        return {
            externalIds,
            mediaType: 'movie',
            status: 'pending',
            statusMessage: m.request_sending(),
        };
    }

    // 5. Default
    return {
        externalIds,
        mediaType: 'movie',
        status: 'unavailable',
        statusMessage: m.req_unavailable(),
    };
}

// ============================================================================
// TV Aggregate Status Resolver
// ============================================================================

/**
 * Result from TV aggregate status determination
 */
export interface AggregateStatusResult {
    status: StatusType;
    download?: DownloadProgress;
    statusMessage?: string;
}

/**
 * Determine status for TV aggregate (non-season-specific queries)
 *
 * Uses TVDB ID matching against the Sonarr queue, then Sonarr monitoring
 * state, then Jellyseerr.
 */
export function determineTvAggregateStatus(
    jellyseerrStatus: MediaStatus | undefined,
    sonarrQueue: SonarrQueueResponse,
    tvdbId: number | undefined,
    requestAge: number,
    arrStatus?: ArrStatus,
): AggregateStatusResult {
    // Jellyseerr AVAILABLE is not a trusted availability source;
    // has_files (from file scanner) is the canonical signal.
    // Fall through to synching path when Jellyseerr reports AVAILABLE.

    // 1. Check Sonarr queue first (most reliable - uses TVDB ID)
    if (tvdbId) {
        const sonarrProgress = getTvProgressFromSonarr(tvdbId, sonarrQueue);
        if (sonarrProgress) {
            const { status, statusMessage } = getStatusFromDownloadState(sonarrProgress.state);
            return { status, statusMessage, download: sonarrProgress };
        }
    }

    if (arrStatus?.hasFile) return { status: 'synching', statusMessage: m.req_processing() };

    if (arrStatus?.isMonitored) {
        if (arrStatus.nextRelease && isDateInFuture(arrStatus.nextRelease)) {
            const formattedDate = formatReleaseDate(arrStatus.nextRelease);
            return {
                status: 'monitored',
                statusMessage: formattedDate
                    ? m.request_status_available_from({ date: formattedDate })
                    : m.request_status_waiting_release(),
            };
        }
        if (arrStatus.releaseStatus === 'tba' || arrStatus.releaseStatus === 'announced') {
            return {
                status: 'monitored',
                statusMessage: m.request_status_waiting_release_date(),
            };
        }
        if (arrStatus.releaseStatus === 'inCinemas')
            return {
                status: 'monitored',
                statusMessage: m.request_status_in_cinema(),
            };
        if (arrStatus.releaseStatus === 'upcoming')
            return {
                status: 'monitored',
                statusMessage: m.request_status_series_starting(),
            };
        if (['released', 'continuing', 'ended'].includes(arrStatus.releaseStatus || '')) {
            const oneHour = 60 * 60 * 1000;
            if (requestAge > oneHour) {
                return {
                    status: 'monitored',
                    statusMessage: m.request_status_monitored_searching(),
                };
            }
        }
    }

    // Jellyseerr AVAILABLE but has_files not propagated yet → synching (transient)
    if (jellyseerrStatus === MediaStatus.AVAILABLE)
        return { status: 'synching', statusMessage: m.req_processing() };

    if (jellyseerrStatus === MediaStatus.PROCESSING) {
        const tenMinutes = 10 * 60 * 1000,
            oneHour = 60 * 60 * 1000;
        if (requestAge > oneHour) {
            if (arrStatus?.isMonitored)
                return {
                    status: 'monitored',
                    statusMessage: m.request_status_monitored_searching(),
                };
            return {
                status: 'unavailable',
                statusMessage: m.request_status_no_release_found(),
            };
        }
        if (requestAge > tenMinutes)
            return {
                status: 'searching',
                statusMessage: m.request_status_searching(),
            };
        return {
            status: 'searching',
            statusMessage: m.request_status_processing(),
        };
    }

    if (jellyseerrStatus === MediaStatus.PENDING) {
        const twoHours = 2 * 60 * 60 * 1000;
        if (requestAge > twoHours)
            return {
                status: 'unavailable',
                statusMessage: m.request_status_processing_failed(),
            };
        return {
            status: 'pending',
            statusMessage: m.request_status_processing(),
        };
    }

    return { status: 'pending' };
}
