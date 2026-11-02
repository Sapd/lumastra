// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Status Mapping Service
 *
 * Shared status label mappings for media requests.
 * Consolidates status resolution logic used across multiple endpoints.
 */

import { MediaStatus, RequestStatus } from '$lib/server/jellyseerr.js';
import * as m from '$lib/paraglide/messages.js';
import type { StatusType } from './types.js';
import { STATUS_RANK, getFurthestAlongStatus, getStatusLabel } from '$lib/shared/request-status.js';

/**
 * Simple status label for listing pending requests
 * Maps Jellyseerr request/media status to human-readable labels
 */
export type SimpleStatusLabel =
    | 'available'
    | 'partially_available'
    | 'processing'
    | 'pending'
    | 'awaiting_approval'
    | 'declined'
    | 'unknown';

/**
 * Get simple status label from Jellyseerr statuses
 * Used by pending requests endpoint for quick status display
 */
export function getSimpleStatusLabel(
    requestStatus: RequestStatus | number,
    mediaStatus: MediaStatus,
): SimpleStatusLabel {
    // Request status 5 means completed/available
    if (requestStatus === 5) return 'available';
    if (mediaStatus === MediaStatus.AVAILABLE) return 'available';
    if (mediaStatus === MediaStatus.PARTIALLY_AVAILABLE) return 'partially_available';
    if (mediaStatus === MediaStatus.PROCESSING) return 'processing';
    if (mediaStatus === MediaStatus.PENDING) return 'pending';
    if (requestStatus === RequestStatus.PENDING_APPROVAL) return 'awaiting_approval';
    if (requestStatus === RequestStatus.DECLINED) return 'declined';
    return 'unknown';
}

/**
 * Map Jellyseerr season request status to internal StatusType
 */
export function mapSeasonRequestStatus(requestStatus: string | undefined): StatusType | null {
    if (!requestStatus) return null;

    const statusMap: Record<string, StatusType> = {
        pending: 'pending',
        processing: 'searching',
        approved: 'synching',
        declined: 'unavailable',
    };

    return statusMap[requestStatus] || null;
}

/**
 * Map Jellyseerr numeric status to internal StatusType
 * Used for season status codes
 */
export function mapJellyseerrStatusCode(statusCode: number): StatusType | null {
    if (statusCode === 5) return 'available';
    if (statusCode >= 3) return 'downloading';
    if (statusCode === 2) return 'pending';
    return null;
}

/**
 * Check if a MediaStatus indicates availability
 */
export function isMediaAvailable(status: MediaStatus | undefined): boolean {
    return status === MediaStatus.AVAILABLE;
}

/**
 * Check if a MediaStatus indicates partial availability
 */
export function isMediaPartiallyAvailable(status: MediaStatus | undefined): boolean {
    return status === MediaStatus.PARTIALLY_AVAILABLE;
}

/**
 * Check if a MediaStatus indicates processing/downloading
 */
export function isMediaProcessing(status: MediaStatus | undefined): boolean {
    return status === MediaStatus.PROCESSING;
}

/**
 * Check if a MediaStatus indicates pending
 */
export function isMediaPending(status: MediaStatus | undefined): boolean {
    return status === MediaStatus.PENDING;
}

/**
 * Status priority for determining aggregate status (higher = furthest along).
 *
 * Re-exported from the canonical `STATUS_RANK` in `$lib/shared/request-status`
 * so server and client share ONE ordering. `StatusType` is structurally
 * identical to the shared `RequestStatusValue`.
 */
export const STATUS_PRIORITY: Record<StatusType, number> = STATUS_RANK;

/**
 * Get the furthest-along status from multiple statuses (best-first aggregation).
 * Thin wrapper over the shared canonical helper.
 */
export function getHighestPriorityStatus(statuses: StatusType[]): StatusType {
    return getFurthestAlongStatus(statuses);
}

/**
 * Release status strings from Radarr/Sonarr
 */
export type ReleaseStatus =
    'tba' | 'announced' | 'inCinemas' | 'released' | 'upcoming' | 'continuing' | 'ended';

/**
 * Check if a release status indicates the content is not yet available
 */
export function isPreRelease(releaseStatus: ReleaseStatus | string | undefined): boolean {
    return releaseStatus === 'tba' || releaseStatus === 'announced';
}

/**
 * Check if content is currently in cinemas
 */
export function isInCinemas(releaseStatus: ReleaseStatus | string | undefined): boolean {
    return releaseStatus === 'inCinemas';
}

/**
 * Check if content is released (available for download)
 */
export function isReleased(releaseStatus: ReleaseStatus | string | undefined): boolean {
    return (
        releaseStatus === 'released' || releaseStatus === 'continuing' || releaseStatus === 'ended'
    );
}

/**
 * Type-safe status message getter
 * Returns localized message for a given status type.
 *
 * Delegates to the shared canonical `getStatusLabel` so server and client
 * resolve the SAME status→label table.
 */
export function getStatusMessage(status: StatusType): string {
    return getStatusLabel(status);
}

/**
 * Download state type from queue progress
 */
export type DownloadState = 'queued' | 'paused' | 'downloading' | 'importing';

/**
 * Convert download state to status type and message
 * Consolidates the repeated pattern of mapping queue state to status
 */
export function getStatusFromDownloadState(state: DownloadState | undefined): {
    status: StatusType;
    statusMessage: string;
} {
    if (state === 'paused') {
        return { status: 'paused', statusMessage: m.req_paused() };
    }
    if (state === 'queued') {
        return { status: 'queued', statusMessage: m.req_queued() };
    }
    if (state === 'importing') {
        return {
            status: 'importing',
            statusMessage: m.request_status_importing(),
        };
    }
    return { status: 'downloading', statusMessage: m.req_downloading() };
}
