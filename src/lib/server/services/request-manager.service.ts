// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RequestManager — the ONE implementation of "create a media request".
 *
 * This logic used to live inline in the `POST /api/v1/requests` handler:
 * permission gate → rate limit → TMDB resolution → Jellyseerr user link →
 * quota pre-check → create → clear dismissal. A second caller (the assistant's
 * `create_request` tool) needed the same sequence, and a second copy of a
 * permission-plus-quota check is exactly the drift the `hasRequestPermission`
 * P0 comment in that def already documents. So the sequence moved here and the
 * def became a mapping from {@link CreateRequestOutcome} to problem+json.
 *
 * The service returns a discriminated outcome rather than a Response: HTTP
 * status codes are the route's vocabulary, not the assistant's.
 *
 * Quota is EXTERNAL — Jellyseerr's own per-user rolling window. There is no
 * Lumastra-side quota table. Note the deliberate hole preserved from the
 * original: when the caller has no Jellyseerr account (`not_linked`) the quota
 * check is skipped entirely and the create proceeds, failing later inside
 * `createRequestForUser` with "User not found in Jellyseerr".
 *
 * @module server/services/request-manager.service
 */

import type { UserContext } from '$lib/server/types.js';
import type { ExternalIds } from '$lib/types/api-common.js';
import { jellyseerrClient, RequestStatus } from '$lib/server/jellyseerr.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { providerResolutionService } from '$lib/server/services/provider-resolution.service.js';
import { deleteDismissal } from '$lib/server/services/request-status/index.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('RequestManager');

/** POST /requests has always been 20 creates per 60 s, keyed per caller. */
const CREATE_RATE_LIMIT = 20;
const CREATE_RATE_WINDOW = 60;

/**
 * Rate-limit key for a create.
 *
 * `scope` is the caller's client IP for the HTTP route. Surfaces with no
 * request of their own (the assistant tool) pass a fixed scope string, which
 * keeps them bounded per username without pretending to know an IP.
 */
export function createRequestRateLimitKey(scope: string, username: string): string {
    return `${scope}:${username}:requests-create`;
}

export type CreateRequestOutcome =
    | { kind: 'created'; requestId: number; requestedAt: string }
    /** Caller lacks `hasRequestPermission` (sourced from REQUEST_GROUPS). */
    | { kind: 'not_permitted' }
    | { kind: 'rate_limited'; resetAt: number }
    /** External IDs could not be turned into a TMDB id. */
    | {
          kind: 'unresolvable';
          reason: 'unsupported_provider' | 'not_found' | 'api_error' | 'other';
          error?: string;
      }
    /** Jellyseerr is unreachable. */
    | { kind: 'dependency_unavailable' }
    | {
          kind: 'quota_exceeded';
          /** PUBLIC vocabulary: 'series', never 'tv'. */
          bucket: 'movie' | 'series';
          limit: number;
          used: number;
          /** Length of the rolling quota window, in days. */
          days: number;
      }
    /** Jellyseerr accepted the call but refused or returned nothing usable. */
    | { kind: 'create_failed'; error: string };

export interface CreateRequestParams {
    /** Caller principal — carries `hasRequestPermission`. */
    user: UserContext | undefined;
    /**
     * Username Jellyseerr is asked to attribute the request to. The HTTP route
     * resolves this through `getEffectiveUser` (dev-user override); other
     * callers pass the real username.
     */
    effectiveUsername: string;
    /** Rate-limit scope — client IP for HTTP, a fixed surface name otherwise. */
    rateLimitScope: string;
    externalIds: ExternalIds;
    mediaType: 'movie' | 'tv';
    seasons?: number[];
}

class RequestManager {
    /** Whether request management is configured at all. */
    isConfigured(): boolean {
        return jellyseerrClient.isConfigured();
    }

    /**
     * Whether this caller may submit requests. Both halves matter: an
     * unconfigured Jellyseerr makes the permission moot, and the permission is
     * server-side truth (it was UI-gated only until the P0 fix).
     */
    canRequest(user: UserContext | undefined): boolean {
        return this.isConfigured() && user?.hasRequestPermission === true;
    }

    /**
     * Whether this TMDB id already has a request on file for this caller.
     *
     * Jellyseerr rejects duplicates itself, but it does so as a generic error
     * that a caller can only report as an unexplained failure. Reading first
     * lets the caller say "already requested" and name the status. Scoped to
     * the caller's own requests — that is the case worth reporting, and it is
     * one page rather than a full-instance scan.
     */
    async findExistingRequest(
        username: string,
        tmdbId: number,
        mediaType: 'movie' | 'tv',
    ): Promise<{ requestId: number; status: string } | null> {
        const link = await jellyseerrClient.resolveUserLink(username);
        if (link.state !== 'linked') return null;

        const mine = await jellyseerrClient.getRequests({
            requestedBy: link.user.id,
            status: 'all',
            take: 100,
        });
        const match = mine.find((r) => r.media?.tmdbId === tmdbId && r.type === mediaType);
        if (!match) return null;
        return { requestId: match.id, status: describeRequestStatus(match.status) };
    }

    /**
     * Read the caller's remaining quota for one bucket, or null when it is
     * unknown (not linked, unlimited, or Jellyseerr did not answer).
     */
    async getRemainingQuota(
        username: string,
        mediaType: 'movie' | 'tv',
    ): Promise<{ limit: number; used: number; remaining: number; days: number } | null> {
        const link = await jellyseerrClient.resolveUserLink(username);
        if (link.state !== 'linked') return null;
        const quota = await jellyseerrClient.getUserQuota(link.user.id);
        if (!quota) return null;
        const bucket = mediaType === 'movie' ? quota.movie : quota.tv;
        if (bucket.limit === 0) return null; // unlimited
        return {
            limit: bucket.limit,
            used: bucket.used,
            remaining: bucket.remaining ?? Math.max(0, bucket.limit - bucket.used),
            days: bucket.days,
        };
    }

    /**
     * Permission → rate limit → TMDB resolve → quota pre-check → create →
     * clear dismissal. Every caller must go through this; skipping it skips
     * the permission gate AND the rate limit.
     */
    async createRequest(params: CreateRequestParams): Promise<CreateRequestOutcome> {
        const { user, effectiveUsername, rateLimitScope, externalIds, mediaType, seasons } = params;

        if (!user?.hasRequestPermission) return { kind: 'not_permitted' };

        const rl = await checkRateLimit(
            createRequestRateLimitKey(rateLimitScope, user.username),
            CREATE_RATE_LIMIT,
            CREATE_RATE_WINDOW,
        );
        if (!rl.allowed) return { kind: 'rate_limited', resetAt: rl.resetAt };

        const resolution = await providerResolutionService.resolveToTmdb(externalIds, mediaType);
        if (!resolution.success) {
            const reason =
                resolution.reason === 'unsupported_provider' ||
                resolution.reason === 'not_found' ||
                resolution.reason === 'api_error'
                    ? resolution.reason
                    : 'other';
            return { kind: 'unresolvable', reason, error: resolution.error };
        }

        // Pre-check quota. `not_linked` deliberately falls through unchecked —
        // preserved from the inline original; the create then fails with
        // "User not found in Jellyseerr".
        const link = await jellyseerrClient.resolveUserLink(effectiveUsername);
        if (link.state === 'unavailable') return { kind: 'dependency_unavailable' };
        if (link.state === 'linked') {
            const quota = await jellyseerrClient.getUserQuota(link.user.id);
            if (quota) {
                const bucket = mediaType === 'movie' ? quota.movie : quota.tv;
                const isExhausted =
                    bucket.limit > 0 &&
                    bucket.remaining !== undefined &&
                    bucket.remaining !== null &&
                    bucket.remaining <= 0;
                if (isExhausted) {
                    return {
                        kind: 'quota_exceeded',
                        bucket: mediaType === 'movie' ? 'movie' : 'series',
                        limit: bucket.limit,
                        used: bucket.used,
                        days: bucket.days,
                    };
                }
            }
        }

        const result = await jellyseerrClient.createRequestForUser(
            resolution.tmdbId,
            mediaType,
            effectiveUsername,
            seasons,
        );
        if (!result.success) {
            return { kind: 'create_failed', error: result.error ?? 'Failed to create request' };
        }

        // Clear any prior dismissal so the notification re-surfaces on next
        // check. Best-effort ON PURPOSE: the request is already submitted by
        // this point, and letting a failure here escape turned a request that
        // DID happen into a thrown error the caller reports as "nothing was
        // requested" — after which the user retries and files a duplicate. A
        // stale dismissal only costs one suppressed notification.
        try {
            await deleteDismissal(effectiveUsername, externalIds, mediaType);
        } catch (err) {
            logger.warn('Request created, but clearing its prior dismissal failed', {
                effectiveUsername,
                mediaType,
                error: err instanceof Error ? err.message : String(err),
            });
        }

        if (!result.requestId) {
            return { kind: 'create_failed', error: 'Jellyseerr did not return a request ID' };
        }

        logger.info('Media request created', {
            username: effectiveUsername,
            mediaType,
            requestId: result.requestId,
        });

        return {
            kind: 'created',
            requestId: result.requestId,
            requestedAt: new Date().toISOString(),
        };
    }
}

/**
 * Jellyseerr request status code → a word a person (or a model) can repeat.
 * `RequestStatus` covers 1-3; a completed request reports 5, which the enum
 * does not name.
 */
function describeRequestStatus(status: RequestStatus | number): string {
    switch (status) {
        case RequestStatus.PENDING_APPROVAL:
            return 'pending';
        case RequestStatus.APPROVED:
            return 'approved';
        case RequestStatus.DECLINED:
            return 'declined';
        case 5:
            return 'completed';
        default:
            return 'unknown';
    }
}

export const requestManager = new RequestManager();
