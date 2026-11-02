// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readSetting, type SettingSource } from '$lib/server/utils/live-setting.js';
import { config } from './config.js';
import { fetchWithTimeout, TIMEOUTS } from './utils/fetch-utils.js';
import { isSeries } from './utils/media-types';
import { Logger } from './utils/logger';

const logger = Logger.for('Seerr');

const getErrorCode = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;

    const obj = value as Record<string, unknown>;
    if ('code' in obj && typeof obj.code === 'string') {
        return obj.code;
    }
    return undefined;
};

interface JellyseerrSearchResult {
    id: number; // This IS the TMDB ID
    title?: string; // For movies
    name?: string; // For TV shows
    originalTitle?: string;
    originalName?: string;
    overview?: string;
    releaseDate?: string;
    firstAirDate?: string;
    posterPath?: string;
    backdropPath?: string;
    mediaType: 'movie' | 'tv';
    status?: number; // MediaStatus: 1=UNKNOWN, 2=PENDING, 3=PROCESSING, 4=PARTIALLY_AVAILABLE, 5=AVAILABLE
    tvdbId?: number; // TVDB ID for TV shows (at root level)
    externalIds?: {
        // External IDs object (nested structure)
        tvdbId?: number;
        imdbId?: string;
    };
    genre_ids?: number[];
}

// TV show details with season request info
interface JellyseerrTvDetails {
    seasons?: Array<{
        seasonNumber: number;
        name: string;
        episodeCount: number;
        airDate?: string;
        overview?: string;
        posterPath?: string;
    }>;
    id: number;
    name: string;
    mediaInfo?: {
        id: number;
        status: number;
        requests?: Array<{
            id: number;
            status: number;
            seasons: Array<{
                id: number;
                seasonNumber: number;
                status: number;
            }>;
        }>;
        seasons?: Array<{
            id: number;
            seasonNumber: number;
            status: number;
        }>;
    };
}

export interface SeasonRequestStatus {
    seasonNumber: number;
    isRequested: boolean;
    isAvailable: boolean;
    requestStatus?: 'pending' | 'approved' | 'declined' | 'processing';
    status?: number; // Jellyseerr API status code (1-5)
}

interface JellyseerrSearchResponse {
    page: number;
    totalPages: number;
    totalResults: number;
    results: JellyseerrSearchResult[];
}

// Request status enum matching Jellyseerr
export enum RequestStatus {
    PENDING_APPROVAL = 1,
    APPROVED = 2,
    DECLINED = 3,
}

// Media status enum matching Jellyseerr
export enum MediaStatus {
    UNKNOWN = 1,
    PENDING = 2,
    PROCESSING = 3,
    PARTIALLY_AVAILABLE = 4,
    AVAILABLE = 5,
}

export interface JellyseerrRequest {
    seasons?: Array<{ seasonNumber: number }>;
    id: number;
    status: RequestStatus | number; // RequestStatus enum or 5 for completed
    createdAt: string;
    updatedAt: string;
    type: 'movie' | 'tv';
    is4k: boolean;
    media: {
        id: number;
        tmdbId: number;
        tvdbId?: number;
        status: MediaStatus;
        status4k?: MediaStatus;
        createdAt: string;
        updatedAt: string;
        mediaType: 'movie' | 'tv';
        // Additional media info fields
        externalServiceId?: number;
        externalServiceSlug?: string;
        ratingKey?: string;
        jellyfinMediaId?: string;
        jellyfinMediaId4k?: string;
    };
    requestedBy: {
        id: number;
        email: string;
        username?: string;
        displayName: string;
        jellyfinUserId?: string;
    };
    modifiedBy?: {
        id: number;
        displayName: string;
    };
    // Populated media details (when available)
    mediaInfo?: {
        title?: string;
        name?: string;
        posterPath?: string;
        backdropPath?: string;
        overview?: string;
        releaseDate?: string;
        firstAirDate?: string;
    };
}

interface JellyseerrPageInfo {
    pages: number;
    pageSize: number;
    results: number;
    page: number;
}

interface JellyseerrRequestsResponse {
    pageInfo: JellyseerrPageInfo;
    results: JellyseerrRequest[];
}

export interface JellyseerrUser {
    id: number;
    email: string;
    username?: string;
    displayName: string;
    jellyfinUserId?: string;
    jellyfinUsername?: string;
}

export interface JellyseerrQuota {
    movie: {
        days: number;
        limit: number;
        used: number;
        remaining: number;
        restricted: boolean;
    };
    tv: {
        days: number;
        limit: number;
        used: number;
        remaining: number;
        restricted: boolean;
    };
}

export interface JellyseerrCreateRequestResponse {
    id: number;
    status: RequestStatus;
    type: 'movie' | 'tv';
    media: {
        id: number;
        tmdbId: number;
        status: MediaStatus;
        mediaType: 'movie' | 'tv';
    };
    requestedBy: {
        id: number;
        displayName: string;
    };
}

/** How long a successful `/user` listing is reused. A new Seerr account or link shows up within this. */
const USERS_CACHE_TTL_MS = 60_000;

/** How long a DNS failure short-circuits requests before the next one asks Seerr again. */
const UNREACHABLE_RETRY_MS = 60_000;

class JellyseerrClient {
    private readonly baseUrlSource: SettingSource;
    private readonly apiKeySource: SettingSource;
    private failedFor: string | null = null;
    private failedAt = 0;

    /**
     * `/user?take=100` backs every username → Jellyseerr-user lookup, and the
     * home page alone makes three of them per load (request badge twice, the
     * fulfilled-requests row once) — each a full upstream round-trip. Only a
     * successful response is cached; a failure is never remembered, so the
     * next call retries. Keyed by connection so a settings change bypasses it.
     */
    private usersCache: { key: string; at: number; users: JellyseerrUser[] } | null = null;
    private usersInFlight: { key: string; promise: Promise<JellyseerrUser[]> } | null = null;

    /** URL/key are read on every use, so a saved connection applies live. */
    constructor(baseUrl: SettingSource, apiKey: SettingSource) {
        this.baseUrlSource = baseUrl;
        this.apiKeySource = apiKey;
    }

    private get baseUrl(): string {
        return readSetting(this.baseUrlSource).replace(/\/$/, '');
    }

    private get apiKey(): string {
        return readSetting(this.apiKeySource);
    }

    private get configured(): boolean {
        return !!(this.baseUrl && this.apiKey);
    }

    /**
     * The "server not reachable" latch belongs to the URL and key it was
     * raised for — fixing either in settings clears it without a restart.
     *
     * It also lapses after UNREACHABLE_RETRY_MS. It used to hold until a
     * restart: one DNS blip made every later request answer "not reachable"
     * without asking Seerr again, and because the latch is per process, prod's
     * two web replicas disagreed — the tvOS app, pinned to one replica, got
     * `503` from `/api/v1/requests` all day while the other replica served
     * it fine.
     */
    private get connectionFailed(): boolean {
        return (
            this.failedFor !== null &&
            this.failedFor === `${this.baseUrl}|${this.apiKey}` &&
            Date.now() - this.failedAt < UNREACHABLE_RETRY_MS
        );
    }

    private set connectionFailed(failed: boolean) {
        this.failedFor = failed ? `${this.baseUrl}|${this.apiKey}` : null;
        this.failedAt = failed ? Date.now() : 0;
    }

    isConfigured(): boolean {
        return this.configured && !this.connectionFailed;
    }

    private async makeRequest<T>(
        endpoint: string,
        options?: { method?: string; body?: unknown },
    ): Promise<T> {
        if (!this.configured) {
            throw new Error('Jellyseerr not configured');
        }

        const url = `${this.baseUrl}/api/v1${endpoint}`;

        const response = await fetchWithTimeout(
            url,
            {
                method: options?.method || 'GET',
                headers: {
                    'X-Api-Key': this.apiKey,
                    'Content-Type': 'application/json',
                },
                body: options?.body ? JSON.stringify(options.body) : undefined,
            },
            TIMEOUTS.DEFAULT,
        );
        // Any answer at all means the host resolves again: end the outage so
        // the next one is reported.
        if (this.failedFor !== null) this.connectionFailed = false;

        if (!response.ok) {
            // Capture the upstream body for server-side diagnostics only — it can
            // contain internal infra detail and must never reach the client. The
            // thrown message stays generic (status + statusText); callers that
            // surface errors to users map this to a user-facing string.
            const errorBody = await response.text().catch(() => '');
            logger.warn('Seerr API non-OK response', {
                endpoint,
                status: response.status,
                statusText: response.statusText,
                body: errorBody.slice(0, 500),
            });
            throw new Error(`Jellyseerr API error: ${response.status} ${response.statusText}`);
        }

        const data: unknown = await response.json();
        return data as T;
    }

    private handleError(context: string, error: unknown): void {
        const err = error instanceof Error ? error : new Error(String(error));
        if (getErrorCode(err.cause) === 'ENOTFOUND') {
            // Warn once per outage, not once per lapsed retry window.
            const alreadyReported = this.failedFor === `${this.baseUrl}|${this.apiKey}`;
            this.connectionFailed = true;
            if (!alreadyReported) {
                logger.warn('Server not reachable', { url: this.baseUrl });
            }
        } else if (!err.message.includes('not configured')) {
            logger.warn(context, { message: err.message });
        }
    }

    async search(query: string, limit: number = 20): Promise<JellyseerrSearchResult[]> {
        if (!this.isConfigured()) return [];
        try {
            const encodedQuery = encodeURIComponent(query);
            const response = await this.makeRequest<JellyseerrSearchResponse>(
                `/search?query=${encodedQuery}&page=1`,
            );

            return response.results.slice(0, limit);
        } catch (error) {
            this.handleError('search', error);
            return [];
        }
    }

    /**
     * Get all users from Jellyseerr
     */
    async getUsers(): Promise<JellyseerrUser[]> {
        if (!this.isConfigured()) return [];
        const key = `${this.baseUrl}|${this.apiKey}`;
        if (this.usersCache?.key === key && Date.now() - this.usersCache.at < USERS_CACHE_TTL_MS) {
            return this.usersCache.users;
        }
        if (this.usersInFlight?.key === key) return this.usersInFlight.promise;

        const promise = (async () => {
            try {
                const response = await this.makeRequest<{
                    pageInfo: JellyseerrPageInfo;
                    results: JellyseerrUser[];
                }>(`/user?take=100`);
                const users = response.results || [];
                this.usersCache = { key, at: Date.now(), users };
                return users;
            } catch (error) {
                this.handleError('getUsers', error);
                return [];
            } finally {
                if (this.usersInFlight?.key === key) this.usersInFlight = null;
            }
        })();
        this.usersInFlight = { key, promise };
        return promise;
    }

    /**
     * Find Jellyseerr user by Lumastra username
     */
    async getUserByUsername(username: string): Promise<JellyseerrUser | null> {
        if (!this.isConfigured()) return null;
        try {
            const users = await this.getUsers();
            const target = username.toLowerCase();
            // Prefer the stable, unique linkage field: jellyfinUsername. This is
            // the field set when a Jellyseerr account is bound to a Jellyfin
            // user, so it uniquely identifies the account and avoids the
            // collision risk of matching on the human-editable displayName.
            let user = users.find((u) => u.jellyfinUsername?.toLowerCase() === target);
            // Resilience fallback: some deployments don't populate
            // jellyfinUsername (e.g. local Jellyseerr accounts). Fall back to
            // username/displayName, but log when this resolves so an operator
            // can spot a potential collision.
            if (!user) {
                user = users.find(
                    (u) =>
                        u.username?.toLowerCase() === target ||
                        u.displayName?.toLowerCase() === target,
                );
                if (user) {
                    logger.debug(
                        'Jellyseerr user matched via non-canonical field (username/displayName) — collision risk if names are not unique',
                        {
                            event: 'jellyseerr_user_fuzzy_match',
                            attempted_username: username,
                            matched_user_id: user.id,
                        },
                    );
                }
            }
            if (!user) {
                logger.info(
                    'Jellyseerr user lookup returned no match — per-user features will no-op for this user',
                    {
                        event: 'jellyseerr_user_not_found',
                        attempted_username: username,
                    },
                );
            }
            return user || null;
        } catch (error) {
            this.handleError('getUserByUsername', error);
            return null;
        }
    }

    /**
     * Resolve a username to a Jellyseerr user, distinguishing the three states
     * a caller needs to react to differently:
     *
     *  - `linked`        — user found; `user` is populated.
     *  - `not_linked`    — service is reachable but this username has no
     *                      matching Jellyseerr account (a benign, expected
     *                      state — surface as a non-error "not linked" hint).
     *  - `unavailable`   — Jellyseerr isn't configured or the lookup failed
     *                      (fail-soft for genuine upstream errors).
     *
     * This lets the pending/quota endpoints return a distinct, non-leaky signal
     * for "no Jellyseerr link" instead of an ambiguous empty 200.
     */
    async resolveUserLink(
        username: string,
    ): Promise<
        | { state: 'linked'; user: JellyseerrUser }
        | { state: 'not_linked' }
        | { state: 'unavailable' }
    > {
        if (!this.isConfigured()) return { state: 'unavailable' };
        try {
            const users = await this.getUsers();
            const target = username.toLowerCase();
            let user = users.find((u) => u.jellyfinUsername?.toLowerCase() === target);
            if (!user) {
                user = users.find(
                    (u) =>
                        u.username?.toLowerCase() === target ||
                        u.displayName?.toLowerCase() === target,
                );
            }
            if (user) return { state: 'linked', user };
            return { state: 'not_linked' };
        } catch (error) {
            this.handleError('resolveUserLink', error);
            return { state: 'unavailable' };
        }
    }

    /**
     * Get all requests, optionally filtered by user
     */
    async getRequests(
        options: {
            requestedBy?: number; // Jellyseerr user ID
            status?: 'approved' | 'pending' | 'declined' | 'all';
            take?: number;
            skip?: number;
        } = {},
    ): Promise<JellyseerrRequest[]> {
        if (!this.isConfigured()) return [];
        try {
            const params = new URLSearchParams();
            params.set('take', String(options.take || 50));
            if (options.skip) params.set('skip', String(options.skip));
            if (options.requestedBy) params.set('requestedBy', String(options.requestedBy));
            if (options.status && options.status !== 'all') {
                // Map status string to filter parameter
                params.set('filter', options.status);
            }

            const response = await this.makeRequest<JellyseerrRequestsResponse>(
                `/request?${params.toString()}`,
            );
            return response.results || [];
        } catch (error) {
            this.handleError('getRequests', error);
            return [];
        }
    }

    /**
     * Get requests for a user that are now available or partially available.
     * Returns requests where the media status is AVAILABLE (5) or PARTIALLY_AVAILABLE (4).
     */
    async getFulfilledRequestsForUser(username: string): Promise<JellyseerrRequest[]> {
        if (!this.isConfigured()) return [];
        try {
            const user = await this.getUserByUsername(username);
            if (!user) {
                // This is expected when user doesn't exist in Jellyseerr - not an error
                return [];
            }

            // Get all requests for this user
            const allRequests = await this.getRequests({
                requestedBy: user.id,
                status: 'approved',
                take: 100,
            });

            // Filter to requests where media is now available or partially available
            // PARTIALLY_AVAILABLE (4) = at least some episodes are ready
            // AVAILABLE (5) = all content is ready
            // For 4K requests, check status4k instead of status
            const fulfilledRequests = allRequests.filter((req) => {
                const relevantStatus = req.is4k ? req.media.status4k : req.media.status;
                return (
                    relevantStatus === MediaStatus.AVAILABLE ||
                    relevantStatus === MediaStatus.PARTIALLY_AVAILABLE
                );
            });

            return fulfilledRequests;
        } catch (error) {
            this.handleError('getFulfilledRequestsForUser', error);
            return [];
        }
    }

    /**
     * Get media details for a TMDB ID (movie or TV)
     */
    async getMediaByTmdbId(
        tmdbId: number,
        mediaType: 'movie' | 'tv',
    ): Promise<JellyseerrSearchResult | null> {
        if (!this.isConfigured()) return null;
        try {
            const response = await this.makeRequest<JellyseerrSearchResult>(
                `/${mediaType}/${tmdbId}`,
            );
            return response;
        } catch (error) {
            this.handleError(`getMediaByTmdbId ${mediaType}/${tmdbId}`, error);
            return null;
        }
    }

    /**
     * Get user's request quota (how many requests they can make)
     */
    async getUserQuota(userId: number): Promise<JellyseerrQuota | null> {
        if (!this.isConfigured()) return null;
        try {
            const response = await this.makeRequest<{
                movie: {
                    days: number;
                    limit: number;
                    used: number;
                    restricted: boolean;
                };
                tv: {
                    days: number;
                    limit: number;
                    used: number;
                    restricted: boolean;
                };
            }>(`/user/${userId}/quota`);

            // Calculate remaining (limit=0 means unlimited)
            return {
                movie: {
                    ...response.movie,
                    remaining:
                        response.movie.limit === 0
                            ? Infinity
                            : Math.max(0, response.movie.limit - response.movie.used),
                },
                tv: {
                    ...response.tv,
                    remaining:
                        response.tv.limit === 0
                            ? Infinity
                            : Math.max(0, response.tv.limit - response.tv.used),
                },
            };
        } catch (error) {
            this.handleError(`getUserQuota ${userId}`, error);
            return null;
        }
    }

    /**
     * Create a media request on behalf of a user
     */
    async createRequest(
        tmdbId: number,
        mediaType: 'movie' | 'tv',
        userId: number,
        seasons?: number[],
    ): Promise<{ success: boolean; requestId?: number; error?: string }> {
        if (!this.isConfigured()) {
            return { success: false, error: 'Jellyseerr not configured' };
        }

        try {
            const body: Record<string, unknown> = {
                mediaType,
                mediaId: tmdbId,
                userId,
            };

            // For TV shows, include seasons array if specified
            if (isSeries(mediaType) && seasons && seasons.length > 0) {
                body.seasons = seasons;
            }

            const response = await this.makeRequest<JellyseerrCreateRequestResponse>('/request', {
                method: 'POST',
                body,
            });

            return {
                success: true,
                requestId: response.id,
            };
        } catch (error) {
            // Detail is logged server-side via handleError; never surface the raw
            // upstream message (may contain infra detail) to the caller. Return a
            // generic, user-safe error string instead.
            this.handleError(`createRequest ${mediaType}/${tmdbId}`, error);
            return {
                success: false,
                error: 'Failed to create request',
            };
        }
    }

    /**
     * Get a user's pending/processing requests (not yet available)
     */
    async getUserPendingRequests(userId: number): Promise<JellyseerrRequest[]> {
        if (!this.isConfigured()) return [];
        try {
            // Get all requests for the user
            const allRequests = await this.getRequests({
                requestedBy: userId,
                take: 50,
            });

            // Filter to only pending/processing (not available yet)
            // Request status 5 means completed/available
            // For 4K requests, check status4k instead of status
            return allRequests.filter((req) => {
                // If the request itself is completed (status 5), it's done
                if (req.status === 5) return false;

                // Check the appropriate media status based on 4K or regular
                const relevantStatus = req.is4k ? req.media.status4k : req.media.status;
                return relevantStatus !== MediaStatus.AVAILABLE;
            });
        } catch (error) {
            this.handleError(`getUserPendingRequests ${userId}`, error);
            return [];
        }
    }

    /**
     * Get a user's pending requests by username.
     * Convenience method that combines user lookup and request fetching.
     */
    async getPendingRequestsForUser(username: string): Promise<JellyseerrRequest[]> {
        if (!this.isConfigured()) return [];
        try {
            const user = await this.getUserByUsername(username);
            if (!user) return [];
            return this.getUserPendingRequests(user.id);
        } catch (error) {
            this.handleError('getPendingRequestsForUser', error);
            return [];
        }
    }

    /**
     * Get a single request by Jellyseerr request ID.
     *
     * Returns `null` when:
     *  - Jellyseerr is not configured / reachable.
     *  - The request does not exist (404 from upstream).
     */
    async getRequestById(requestId: number): Promise<JellyseerrRequest | null> {
        if (!this.isConfigured()) return null;
        try {
            const response = await this.makeRequest<JellyseerrRequest>(`/request/${requestId}`);
            return response;
        } catch (error) {
            // 404 from Jellyseerr is a non-error (request simply doesn't exist)
            const err = error instanceof Error ? error : new Error(String(error));
            if (err.message.includes('404')) return null;
            this.handleError(`getRequestById ${requestId}`, error);
            return null;
        }
    }

    /**
     * Get user quota by username.
     * Convenience method that combines user lookup and quota fetching.
     */
    async getQuotaForUser(username: string): Promise<JellyseerrQuota | null> {
        if (!this.isConfigured()) return null;
        try {
            const user = await this.getUserByUsername(username);
            if (!user) return null;
            return this.getUserQuota(user.id);
        } catch (error) {
            this.handleError('getQuotaForUser', error);
            return null;
        }
    }

    /**
     * Get season request status for a TV show
     * Returns info about which seasons are requested/available
     *
     * Season status codes from Jellyseerr:
     * 1 = UNKNOWN (not requested)
     * 2 = PENDING (requested, waiting)
     * 3 = PROCESSING (approved, being downloaded)
     * 4 = PARTIALLY_AVAILABLE (some episodes)
     * 5 = AVAILABLE (fully available)
     */
    async getRequestSeasons(tmdbId: number) {
        if (!this.isConfigured()) return null;
        try {
            const details = await this.makeRequest<JellyseerrTvDetails>(`/tv/${tmdbId}`);
            return (details.seasons ?? []).map((season) => {
                const status = details.mediaInfo?.seasons?.find(
                    (item) => item.seasonNumber === season.seasonNumber,
                )?.status;
                return {
                    seasonNumber: season.seasonNumber,
                    name: season.name,
                    episodeCount: season.episodeCount,
                    airDate: season.airDate ?? null,
                    overview: season.overview ?? null,
                    posterPath: season.posterPath ?? null,
                    isAvailable: status === MediaStatus.AVAILABLE,
                    isPending: status === MediaStatus.PENDING || status === MediaStatus.PROCESSING,
                };
            });
        } catch (error) {
            this.handleError('getRequestSeasons', error);
            return null;
        }
    }

    async getSeasonRequestStatus(tmdbId: number): Promise<SeasonRequestStatus[]> {
        if (!this.isConfigured()) return [];
        try {
            const response = await this.makeRequest<JellyseerrTvDetails>(`/tv/${tmdbId}`);

            const mediaInfo = response.mediaInfo;

            if (!mediaInfo) return [];

            // Build a map of season statuses from mediaInfo.seasons
            const seasonMap = new Map<number, SeasonRequestStatus>();

            // First, process seasons from mediaInfo.seasons (aggregate status)
            if (mediaInfo.seasons) {
                for (const season of mediaInfo.seasons) {
                    const status = season.status;

                    // Determine availability and request status based on season status
                    const isAvailable = status === MediaStatus.AVAILABLE;
                    // Status >= 2 means it's been requested (PENDING, PROCESSING, PARTIALLY_AVAILABLE, or AVAILABLE)
                    const isRequested = status >= MediaStatus.PENDING;

                    // Map status to request status string
                    let requestStatus:
                        'pending' | 'approved' | 'declined' | 'processing' | undefined;
                    if (status === MediaStatus.PENDING) {
                        requestStatus = 'pending';
                    } else if (status === MediaStatus.PROCESSING) {
                        requestStatus = 'processing';
                    } else if (status === MediaStatus.PARTIALLY_AVAILABLE) {
                        requestStatus = 'processing'; // Still being downloaded
                    } else if (status === MediaStatus.AVAILABLE) {
                        requestStatus = 'approved'; // Completed
                    }

                    seasonMap.set(season.seasonNumber, {
                        seasonNumber: season.seasonNumber,
                        isAvailable,
                        isRequested,
                        requestStatus,
                        status, // Include the numeric status code
                    });
                }
            }

            // Then, check mediaInfo.requests for pending requests that may not yet
            // be reflected in mediaInfo.seasons (race condition fix)
            // This handles the case where a request was JUST created
            if (mediaInfo.requests) {
                for (const request of mediaInfo.requests) {
                    // Request status: 1=PENDING, 2=APPROVED, 3=DECLINED
                    const requestIsPending = request.status === 1;
                    const requestIsApproved = request.status === 2;

                    if (request.seasons) {
                        for (const reqSeason of request.seasons) {
                            const existingStatus = seasonMap.get(reqSeason.seasonNumber);

                            // If the season shows as UNKNOWN (status=1) but we have a pending/approved request,
                            // update it to reflect the actual request state
                            if (!existingStatus || existingStatus.status === MediaStatus.UNKNOWN) {
                                // Request season status can be different from the request status
                                // Season status: 1=UNKNOWN, 2=PENDING, 3=PROCESSING, etc.
                                const seasonStatus = reqSeason.status;

                                // Determine the effective status:
                                // - If the season has a status >= 2, use it
                                // - Otherwise, if the request is pending/approved, treat the season as pending
                                let effectiveStatus = seasonStatus;
                                let isRequested = seasonStatus >= MediaStatus.PENDING;
                                let requestStatus:
                                    'pending' | 'approved' | 'declined' | 'processing' | undefined;

                                if (seasonStatus >= MediaStatus.PENDING) {
                                    // Season has a valid status
                                    if (seasonStatus === MediaStatus.PENDING) {
                                        requestStatus = 'pending';
                                    } else if (seasonStatus === MediaStatus.PROCESSING) {
                                        requestStatus = 'processing';
                                    } else if (seasonStatus === MediaStatus.PARTIALLY_AVAILABLE) {
                                        requestStatus = 'processing';
                                    } else if (seasonStatus === MediaStatus.AVAILABLE) {
                                        requestStatus = 'approved';
                                    }
                                } else if (requestIsPending || requestIsApproved) {
                                    // Season shows UNKNOWN but request exists - treat as pending
                                    effectiveStatus = MediaStatus.PENDING;
                                    isRequested = true;
                                    requestStatus = 'pending';
                                }

                                seasonMap.set(reqSeason.seasonNumber, {
                                    seasonNumber: reqSeason.seasonNumber,
                                    isAvailable: effectiveStatus === MediaStatus.AVAILABLE,
                                    isRequested,
                                    requestStatus,
                                    status: effectiveStatus,
                                });
                            }
                        }
                    }
                }
            }

            return Array.from(seasonMap.values()).sort((a, b) => a.seasonNumber - b.seasonNumber);
        } catch (error) {
            this.handleError(`getSeasonRequestStatus ${tmdbId}`, error);
            return [];
        }
    }

    /**
     * Create a request by username.
     * Convenience method that combines user lookup and request creation.
     */
    async createRequestForUser(
        tmdbId: number,
        mediaType: 'movie' | 'tv',
        username: string,
        seasons?: number[],
    ): Promise<{ success: boolean; requestId?: number; error?: string }> {
        if (!this.isConfigured()) {
            return { success: false, error: 'Jellyseerr not configured' };
        }

        try {
            const user = await this.getUserByUsername(username);
            if (!user) {
                return {
                    success: false,
                    error: 'User not found in Jellyseerr',
                };
            }
            return this.createRequest(tmdbId, mediaType, user.id, seasons);
        } catch (error) {
            // Generic, user-safe error — detail is logged via handleError.
            this.handleError('createRequestForUser', error);
            return { success: false, error: 'Failed to create request' };
        }
    }
}

export const jellyseerrClient = new JellyseerrClient(
    () => config.SEERRURL,
    () => config.SEERRAPIKEY,
);

export type { JellyseerrSearchResult };
