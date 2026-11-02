// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Types for the request status service
 */

export interface RequestStatusQuery {
    /** Provider-agnostic external IDs */
    externalIds: ExternalIds;
    mediaType: 'movie' | 'tv';
    seasons?: number[]; // Optional: For TV shows, query specific seasons
}

// Import ExternalIds for type
import type { ExternalIds } from '$lib/types/api-common.js';
import type { RequestStatusValue } from '$lib/shared/request-status.js';

/**
 * Internal download-progress shape.
 *
 * `state` is SERVER-INTERNAL ONLY — it is used by the progress extractors and
 * resolvers to compute the outer `status` (via getStatusFromDownloadState) and
 * MUST NOT be serialized to the client. The public response schema
 * (RequestStatusResultSchema in api-content-responses.ts) intentionally omits
 * `state`; building the response strips it.
 */
export interface DownloadProgress {
    percentage: number;
    timeLeft?: string;
    size?: string;
    sizeLeft?: string;
    /** INTERNAL ONLY — never sent to the client. See doc comment above. */
    state?: 'queued' | 'paused' | 'downloading' | 'importing';
}

/**
 * Internal status type. Structurally identical to the shared
 * `RequestStatusValue` (single source of truth in $lib/shared/request-status).
 */
export type StatusType = RequestStatusValue;

export interface RequestStatusResult {
    /** Provider-agnostic external IDs (echoed from request) */
    externalIds: ExternalIds;
    mediaType: 'movie' | 'tv';
    seasonNumber?: number; // Present when querying specific seasons
    status: StatusType;
    statusMessage?: string;
    download?: DownloadProgress;
    watched?: boolean; // True if user has watched this content
}

// Check availability in our local database (synced every 5 minutes)
export interface LocalAvailability {
    /**
     * `media_items.id` — the internal UUID.
     *
     * This is the whole point of the lookup for a request-status caller: the
     * moment a request is fulfilled the item exists in the catalog and gets a
     * UUID, and that UUID is what a UUID-first client needs to switch a
     * "Requested" button to "Play". Previously the row was fetched, the UUID
     * discarded, and only the boolean survived.
     */
    internalId: string;
    isAvailable: boolean;
}

// Information about the arr status (Radarr/Sonarr)
export interface ArrStatus {
    isMonitored: boolean;
    hasFile: boolean;
    releaseStatus?:
        | 'tba'
        | 'announced'
        | 'inCinemas'
        | 'released'
        | 'deleted'
        | 'continuing'
        | 'ended'
        | 'upcoming';
    nextRelease?: string; // ISO date of next release (digital/physical for movies, next airing for TV)
}
