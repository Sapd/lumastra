// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Request Status Service
 *
 * Provides utilities for checking the status of media requests across
 * multiple services (library, Seerr, Sonarr, Radarr).
 */

// Types
export type {
    RequestStatusQuery,
    DownloadProgress,
    StatusType,
    RequestStatusResult,
    LocalAvailability,
    ArrStatus,
} from './types.js';

// Database queries
export { checkLocalAvailability, checkIfWatched, checkSeasonAvailability } from './database.js';

// Queue progress extraction
export {
    getSeasonProgressFromSonarr,
    getTvProgressFromSonarr,
    getMovieProgressFromRadarr,
} from './progress.js';

// Utilities
export { formatReleaseDate, isDateInFuture, validateRequestQuery } from './utils.js';

// Dismissals
export {
    getDismissalsForUser,
    upsertDismissal,
    deleteDismissal,
    type DismissedRequest,
    type UpsertDismissalResult,
} from './dismissals.js';

// Status Mapping
export {
    getSimpleStatusLabel,
    mapSeasonRequestStatus,
    mapJellyseerrStatusCode,
    isMediaAvailable,
    isMediaPartiallyAvailable,
    isMediaProcessing,
    isMediaPending,
    getHighestPriorityStatus,
    isPreRelease,
    isInCinemas,
    isReleased,
    getStatusMessage,
    getStatusFromDownloadState,
    STATUS_PRIORITY,
    type SimpleStatusLabel,
    type ReleaseStatus,
    type DownloadState,
} from './status-mapping.js';

// Status Resolvers
export {
    determineSeasonStatus,
    determineMovieStatus,
    determineTvAggregateStatus,
    type AggregateStatusResult,
} from './resolvers.js';
