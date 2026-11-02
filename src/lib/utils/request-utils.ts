// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Request Validation Utilities
 *
 * Centralized validation for "can this media be requested via Jellyseerr?"
 *
 * STRATEGY:
 * Both modal and external URL paths are provider-agnostic.
 * The server resolves any provider → TMDB via /api/request/redirect.
 *
 * This is the single source of truth for request validation.
 * All components should use canRequestMedia() instead of checking providers directly.
 */

import type { ExternalIds } from '$lib/types/api-common';
import * as m from '$lib/paraglide/messages';
import { hasAnyExternalId } from './external-ids';

/**
 * Reason codes for why a request cannot be made
 */
export type RequestFailureReason = 'no_external_ids' | 'requests_not_configured';

/**
 * Result of request validation
 */
export interface RequestValidation {
    /** Whether the media can be requested */
    canRequest: boolean;
    /** Reason code if canRequest is false */
    reason?: RequestFailureReason;
}

/**
 * Validate if media can be requested via Jellyseerr.
 *
 * Both paths (modal and external URL) are provider-agnostic — the server
 * resolves any provider to TMDB via /api/request/redirect.
 *
 * @param externalIds - Media external IDs
 * @param requestsEnabled - Whether request modal is enabled
 * @param requestUrl - External Jellyseerr URL (if modal disabled)
 * @returns Validation result with reason code if failed
 */
export function canRequestMedia(
    externalIds: ExternalIds | undefined,
    requestsEnabled: boolean,
    requestUrl: string,
): RequestValidation {
    // Must have a provider id (TMDB/IMDB/TVDB/...): the server resolves a
    // provider id to TMDB for Jellyseerr. The internal UUID alone is not a
    // TMDB entity, and an item that only has one is already in the library.
    if (!hasAnyExternalId(externalIds)) {
        return { canRequest: false, reason: 'no_external_ids' };
    }

    // Either modal or external URL must be configured
    if (requestsEnabled || requestUrl) {
        return { canRequest: true };
    }

    return {
        canRequest: false,
        reason: 'requests_not_configured',
    };
}

/**
 * Get user-friendly error message for request failure.
 *
 * @param reason - Failure reason code
 * @returns Human-readable error message
 */
export function getRequestFailureMessage(reason: RequestFailureReason): string {
    switch (reason) {
        case 'no_external_ids':
            return m.request_no_external_ids();
        case 'requests_not_configured':
            return m.request_not_configured();
        default:
            return m.request_unable();
    }
}
