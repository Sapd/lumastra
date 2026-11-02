// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readSetting, type SettingSource } from '$lib/server/utils/live-setting.js';
import { config } from './config.js';
import { fetchWithTimeout, TIMEOUTS } from './utils/fetch-utils.js';
import { Logger } from './utils/logger';
import { DependencyUnavailableError } from './api/problem.js';
import { withHttpRetry } from './utils/http-retry.js';
import { getBreaker } from './utils/circuit-breaker.js';

const getErrorCode = (value: unknown): string | undefined => {
    if (!value || typeof value !== 'object') return undefined;

    const obj = value as Record<string, unknown>;
    if ('code' in obj && typeof obj.code === 'string') {
        return obj.code;
    }
    return undefined;
};

/**
 * Typed error thrown by `ArrClientBase.get`. Carries the HTTP status so
 * callers can distinguish a transient 5xx from a permanent 4xx without
 * parsing the error message. `status` is null for network-layer failures
 * (timeout, ECONNREFUSED, etc.).
 */
export class ArrApiError extends Error {
    readonly status: number | null;

    constructor(message: string, status: number | null) {
        super(message);
        this.name = 'ArrApiError';
        this.status = status;
    }
}

/**
 * Classify an `ArrApiError` for the retry loop.
 * Retryable: 429, 5xx, and network failures (null status).
 * Not retryable: other 4xx, AbortError.
 */
function classifyArrError(err: unknown): { retryable: boolean; retryAfterMs: number | null } {
    if (err instanceof ArrApiError) {
        const { status } = err;
        if (status === null) return { retryable: true, retryAfterMs: null };
        if (status === 429) return { retryable: true, retryAfterMs: null };
        if (status >= 500) return { retryable: true, retryAfterMs: null };
        return { retryable: false, retryAfterMs: null };
    }
    if (err instanceof Error && err.name === 'AbortError') {
        return { retryable: false, retryAfterMs: null };
    }
    // FetchTimeoutError and other network errors → transient
    return { retryable: true, retryAfterMs: null };
}

export interface SonarrCalendarEntry {
    id: number;
    seriesId?: number;
    title: string;
    overview?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    absoluteEpisodeNumber?: number;
    runtime?: number; // Runtime in minutes (from Sonarr API)
    hasFile: boolean;
    airDateUtc?: string;
    physicalRelease?: string;
    digitalRelease?: string;
    inCinemas?: string;
    series?: {
        id: number;
        title: string;
        network?: string;
        // Series-level external IDs (returned when Sonarr is called with
        // includeSeries=true). These uniquely identify the series and are
        // preferred over fuzzy name matching to disambiguate same-title
        // series (e.g. UK vs US "Ghosts").
        tvdbId?: number;
        tmdbId?: number;
        imdbId?: string;
    };
    episodeFile?: {
        quality: {
            quality: {
                name: string;
            };
        };
        mediaInfo: {
            audioLanguages?: string[];
            subtitles?: string[];
        };
    };
    // Movie fields (for Radarr)
    movieFile?: unknown;
    year?: number;
    genres?: string[];
    ratings?: {
        tmdb?: { value: number };
        imdb?: { value: number };
    };
    tmdbId?: number;
    tvdbId?: number;
}

export interface SearchResult {
    id?: number;
    title: string;
    overview?: string;
    year?: number;
    genres?: string[];
    ratings?: {
        tmdb?: { value: number };
        imdb?: { value: number };
    };
    tmdbId?: number;
    tvdbId?: number;
    movieFile?: unknown;
}

export interface RadarrMovie {
    id: number;
    title: string;
    titleSlug?: string;
    tmdbId: number;
    year?: number;
    status: 'tba' | 'announced' | 'inCinemas' | 'released' | 'deleted';
    monitored: boolean;
    hasFile: boolean;
    inCinemas?: string;
    physicalRelease?: string;
    digitalRelease?: string;
    minimumAvailability?: string;
}

export interface SonarrSeries {
    id: number;
    title: string;
    titleSlug?: string;
    tvdbId?: number;
    tmdbId?: number;
    year?: number;
    status: 'continuing' | 'ended' | 'upcoming' | 'deleted';
    monitored: boolean;
    seasonCount?: number;
    statistics?: {
        seasonCount: number;
        episodeFileCount: number;
        episodeCount: number;
        totalEpisodeCount: number;
        sizeOnDisk: number;
        percentOfEpisodes: number;
    };
    nextAiring?: string;
    previousAiring?: string;
    firstAired?: string;
}

export interface SonarrQueueRecord {
    id: number;
    seriesId: number;
    episodeId: number;
    series?: {
        id: number;
        title: string;
        tvdbId?: number;
    };
    episode?: {
        id: number;
        seasonNumber: number;
        episodeNumber: number;
    };
    quality: {
        quality: {
            id: number;
            name: string;
        };
    };
    size: number; // Total bytes
    sizeleft: number; // Remaining bytes
    timeleft?: string; // Time remaining (e.g., "00:05:30")
    estimatedCompletionTime?: string; // ISO timestamp
    status: string; // "downloading", "paused", "queued", etc.
    trackedDownloadStatus?: string;
    trackedDownloadState?: string; // "downloading", "importPending", etc.
    title: string; // Download filename
    downloadId?: string;
    protocol: string; // "usenet" or "torrent"
    downloadClient?: string;
    indexer?: string;
    outputPath?: string;
}

export interface SonarrQueueResponse {
    page: number;
    pageSize: number;
    sortKey: string;
    sortDirection: string;
    totalRecords: number;
    records: SonarrQueueRecord[];
}

export interface RadarrQueueRecord {
    id: number;
    movieId: number;
    movie?: {
        id: number;
        title: string;
        tmdbId?: number;
    };
    quality: {
        quality: {
            id: number;
            name: string;
        };
    };
    size: number; // Total bytes
    sizeleft: number; // Remaining bytes
    timeleft?: string; // Time remaining (e.g., "00:05:30")
    estimatedCompletionTime?: string; // ISO timestamp
    status: string; // "downloading", "paused", "queued", etc.
    trackedDownloadStatus?: string;
    trackedDownloadState?: string; // "downloading", "importPending", etc.
    title: string; // Download filename
    downloadId?: string;
    protocol: string; // "usenet" or "torrent"
    downloadClient?: string;
    indexer?: string;
    outputPath?: string;
}

export interface RadarrQueueResponse {
    page: number;
    pageSize: number;
    sortKey: string;
    sortDirection: string;
    totalRecords: number;
    records: RadarrQueueRecord[];
}

/**
 * Base class for Arr API clients (Sonarr/Radarr)
 * Uses plain fetch against the v3 REST API.
 */
abstract class ArrClientBase {
    private readonly baseUrlSource: SettingSource;
    private readonly apiKeySource: SettingSource;
    protected readonly serviceName: string;
    protected readonly logger: ReturnType<typeof Logger.for>;

    /**
     * URL and key are read on every use (the exported singletons pass
     * functions over the live config), so a saved connection applies without
     * a restart.
     */
    constructor(serviceName: string, baseUrl: SettingSource, apiKey: SettingSource) {
        this.serviceName = serviceName;
        this.logger = Logger.for(serviceName);
        this.baseUrlSource = baseUrl;
        this.apiKeySource = apiKey;

        if (!this.configured) {
            this.logger.warn(`${serviceName} not configured`);
        }
    }

    protected get baseUrl(): string {
        return readSetting(this.baseUrlSource).replace(/\/$/, '');
    }

    protected get apiKey(): string {
        return readSetting(this.apiKeySource);
    }

    protected get configured(): boolean {
        return !!(this.baseUrl && this.apiKey);
    }

    /**
     * True iff a base URL + API key were supplied for this Arr. Public so
     * callers (e.g. release-calendar-sync's outage guard) can distinguish a
     * genuinely-configured-but-unreachable provider (getCalendar throws → null)
     * from a not-configured one (getCalendar returns [] and does no work).
     */
    isConfigured(): boolean {
        return this.configured;
    }

    /**
     * Lightweight reachability + auth check via /api/v3/system/status.
     * Returns true iff the upstream Arr is configured, reachable, and accepts
     * the configured API key. Used by callers (e.g. orphan filter) that need
     * to distinguish "service down" from a genuine 404 on a per-record probe.
     */
    async ping(): Promise<boolean> {
        if (!this.isConfigured()) return false;
        try {
            const status = await this.get<{ version?: string }>('/api/v3/system/status');
            return !!status;
        } catch (error) {
            this.handleError(error, 'ping');
            return false;
        }
    }

    protected async get<T>(
        path: string,
        query?: Record<string, string | number | boolean>,
    ): Promise<T | undefined> {
        const url = new URL(`${this.baseUrl}${path}`);
        if (query) {
            for (const [key, value] of Object.entries(query)) {
                url.searchParams.set(key, String(value));
            }
        }
        const urlStr = url.toString();
        const breaker = getBreaker(this.serviceName.toLowerCase());
        return breaker.execute(
            () =>
                withHttpRetry(
                    async () => {
                        let response: Response;
                        try {
                            response = await fetchWithTimeout(
                                urlStr,
                                { headers: { 'X-Api-Key': this.apiKey } },
                                TIMEOUTS.DEFAULT,
                            );
                        } catch (err) {
                            // Network/timeout error — wrap so the classifier sees ArrApiError shape.
                            throw new ArrApiError(
                                err instanceof Error ? err.message : String(err),
                                null,
                            );
                        }
                        if (!response.ok) {
                            throw new ArrApiError(
                                `${this.serviceName} API ${path} returned ${response.status}`,
                                response.status,
                            );
                        }
                        return (await response.json()) as T;
                    },
                    { classify: classifyArrError },
                ),
            (err) => classifyArrError(err).retryable,
        );
    }

    protected handleError(error: unknown, operation: string): void {
        const err = error instanceof Error ? error : new Error(String(error));
        const causeCode = getErrorCode(err.cause);
        if (
            causeCode === 'ENOTFOUND' ||
            causeCode === 'ECONNREFUSED' ||
            causeCode === 'ETIMEDOUT'
        ) {
            this.logger.warn('Server not reachable');
        } else {
            this.logger.warn(`Failed to ${operation}`, {
                message: err.message,
            });
        }
    }

    async getCalendar(
        start: Date,
        end: Date,
        extraParams?: Record<string, boolean>,
    ): Promise<SonarrCalendarEntry[]> {
        if (!this.isConfigured()) return [];

        const query: Record<string, string | boolean> = {
            start: start.toISOString(),
            end: end.toISOString(),
            ...extraParams,
        };
        try {
            return (await this.get<SonarrCalendarEntry[]>('/api/v3/calendar', query)) || [];
        } catch (error) {
            this.handleError(error, 'get calendar');
            throw new DependencyUnavailableError(
                `${this.serviceName} calendar unavailable`,
                this.serviceName.toLowerCase(),
            );
        }
    }

    protected async searchEndpoint(
        endpoint: string,
        query: string,
        limit: number,
    ): Promise<SearchResult[]> {
        if (!this.isConfigured()) {
            this.logger.warn(`${this.serviceName} not configured`);
            return [];
        }
        try {
            const results = (await this.get<SearchResult[]>(endpoint, { term: query })) || [];
            return results.slice(0, limit);
        } catch (error) {
            this.handleError(error, `search ${this.serviceName}`);
            return [];
        }
    }
}

export class SonarrClient extends ArrClientBase {
    constructor(baseUrl: SettingSource, apiKey: SettingSource) {
        super('Sonarr', baseUrl, apiKey);
    }

    async getCalendar(start: Date, end: Date): Promise<SonarrCalendarEntry[]> {
        return super.getCalendar(start, end, {
            includeSeries: true,
            includeEpisodeFile: true,
        });
    }

    async search(query: string, limit = 20): Promise<SearchResult[]> {
        return this.searchEndpoint('/api/v3/series/lookup', query, limit);
    }

    /**
     * Get series by TVDB ID (from Sonarr's library)
     */
    async getSeriesByTvdbId(tvdbId: number): Promise<SonarrSeries | null> {
        if (!this.isConfigured()) return null;

        try {
            // Server-side filter. The unfiltered list is the whole library (6.5 MB
            // for 1,599 series on prod, 0.5-4 s) and this runs once per pending TV
            // request in the request popup; `?tvdbId=` returns ~3 KB in ~0.25 s.
            // The find() stays as a guard should a Sonarr build ignore the filter.
            const matches = await this.get<SonarrSeries[]>('/api/v3/series', { tvdbId });
            if (!Array.isArray(matches)) {
                // Unexpected shape: never report a live series as missing (the
                // orphan filter would hide its request) — fall back to the list.
                const all = await this.get<SonarrSeries[]>('/api/v3/series');
                return (Array.isArray(all) ? all : []).find((s) => s.tvdbId === tvdbId) || null;
            }
            return matches.find((s) => s.tvdbId === tvdbId) || null;
        } catch (error) {
            this.handleError(error, 'get series by TVDB ID');
            return null;
        }
    }

    /**
     * Get all series from Sonarr library
     */
    async getAllSeries(): Promise<SonarrSeries[]> {
        if (!this.isConfigured()) return [];

        try {
            return (await this.get<SonarrSeries[]>('/api/v3/series')) || [];
        } catch (error) {
            this.handleError(error, 'get all series');
            return [];
        }
    }

    /**
     * Get all episodes for a series by Sonarr series ID
     * Returns episodes with hasFile=true that are available to watch
     */
    async getEpisodesBySeriesId(seriesId: number): Promise<SonarrCalendarEntry[]> {
        if (!this.isConfigured()) return [];

        try {
            const episodes =
                (await this.get<SonarrCalendarEntry[]>('/api/v3/episode', {
                    seriesId,
                    includeImages: false,
                })) || [];
            // Only return episodes that have files
            return episodes.filter((ep) => ep.hasFile);
        } catch (error) {
            this.handleError(error, 'get episodes by series ID');
            return [];
        }
    }

    /**
     * Get Sonarr download queue
     * Returns active and pending downloads with progress information
     */
    async getQueue(
        options: {
            page?: number;
            pageSize?: number;
            includeSeries?: boolean;
            includeEpisode?: boolean;
        } = {},
    ): Promise<SonarrQueueResponse> {
        const emptyResponse: SonarrQueueResponse = {
            page: 1,
            pageSize: 0,
            sortKey: 'timeleft',
            sortDirection: 'ascending',
            totalRecords: 0,
            records: [],
        };

        if (!this.isConfigured()) return emptyResponse;

        try {
            return (
                (await this.get<SonarrQueueResponse>('/api/v3/queue', {
                    page: options.page || 1,
                    pageSize: options.pageSize || 50,
                    includeSeries: options.includeSeries ?? true,
                    includeEpisode: options.includeEpisode ?? true,
                })) || emptyResponse
            );
        } catch (error) {
            this.handleError(error, 'get queue');
            return emptyResponse;
        }
    }

    /**
     * Get the complete Sonarr download queue, paginating until totalRecords is
     * exhausted. A single page (pageSize 100) silently drops records beyond the
     * first page, which inflates/understates aggregate progress when many
     * episodes are queued. Caps total pages defensively to avoid an unbounded
     * loop if the upstream reports an inconsistent totalRecords.
     */
    async getAllQueueRecords(
        options: { includeSeries?: boolean; includeEpisode?: boolean } = {},
    ): Promise<SonarrQueueResponse> {
        const pageSize = 100;
        const maxPages = 20; // safety cap (2000 records)
        const first = await this.getQueue({
            page: 1,
            pageSize,
            includeSeries: options.includeSeries ?? true,
            includeEpisode: options.includeEpisode ?? true,
        });

        const records = [...first.records];
        const total = first.totalRecords || records.length;
        const totalPages = Math.min(maxPages, Math.ceil(total / pageSize));

        for (let page = 2; page <= totalPages && records.length < total; page++) {
            const next = await this.getQueue({
                page,
                pageSize,
                includeSeries: options.includeSeries ?? true,
                includeEpisode: options.includeEpisode ?? true,
            });
            if (next.records.length === 0) break;
            records.push(...next.records);
        }

        if (records.length < total) {
            this.logger.warn(
                'Queue truncated at safety cap; aggregate progress may be understated',
                {
                    fetched: records.length,
                    total,
                    maxPages,
                },
            );
        }

        return { ...first, page: 1, pageSize, records };
    }
}

export class RadarrClient extends ArrClientBase {
    constructor(baseUrl: SettingSource, apiKey: SettingSource) {
        super('Radarr', baseUrl, apiKey);
    }

    async search(query: string, limit = 20): Promise<SearchResult[]> {
        return this.searchEndpoint('/api/v3/movie/lookup', query, limit);
    }

    /**
     * Get movie by TMDB ID (from Radarr's library)
     */
    async getMovieByTmdbId(tmdbId: number): Promise<RadarrMovie | null> {
        if (!this.isConfigured()) return null;

        try {
            const movies = await this.get<RadarrMovie[]>('/api/v3/movie', {
                tmdbId,
            });
            return movies?.[0] || null;
        } catch (error) {
            this.handleError(error, 'get movie by TMDB ID');
            return null;
        }
    }

    /**
     * Get Radarr download queue
     * Returns active and pending downloads with progress information
     */
    async getQueue(
        options: {
            page?: number;
            pageSize?: number;
            includeMovie?: boolean;
        } = {},
    ): Promise<RadarrQueueResponse> {
        const emptyResponse: RadarrQueueResponse = {
            page: 1,
            pageSize: 0,
            sortKey: 'timeleft',
            sortDirection: 'ascending',
            totalRecords: 0,
            records: [],
        };

        if (!this.isConfigured()) return emptyResponse;

        try {
            return (
                (await this.get<RadarrQueueResponse>('/api/v3/queue', {
                    page: options.page || 1,
                    pageSize: options.pageSize || 50,
                    includeMovie: options.includeMovie ?? true,
                })) || emptyResponse
            );
        } catch (error) {
            this.handleError(error, 'get queue');
            return emptyResponse;
        }
    }

    /**
     * Get the complete Radarr download queue, paginating until totalRecords is
     * exhausted (see SonarrClient.getAllQueueRecords for rationale).
     */
    async getAllQueueRecords(
        options: { includeMovie?: boolean } = {},
    ): Promise<RadarrQueueResponse> {
        const pageSize = 100;
        const maxPages = 20; // safety cap (2000 records)
        const first = await this.getQueue({
            page: 1,
            pageSize,
            includeMovie: options.includeMovie ?? true,
        });

        const records = [...first.records];
        const total = first.totalRecords || records.length;
        const totalPages = Math.min(maxPages, Math.ceil(total / pageSize));

        for (let page = 2; page <= totalPages && records.length < total; page++) {
            const next = await this.getQueue({
                page,
                pageSize,
                includeMovie: options.includeMovie ?? true,
            });
            if (next.records.length === 0) break;
            records.push(...next.records);
        }

        if (records.length < total) {
            this.logger.warn(
                'Queue truncated at safety cap; aggregate progress may be understated',
                {
                    fetched: records.length,
                    total,
                    maxPages,
                },
            );
        }

        return { ...first, page: 1, pageSize, records };
    }
}

export const sonarrClient = new SonarrClient(
    () => config.SONARRURL,
    () => config.SONARRAPIKEY,
);
export const radarrClient = new RadarrClient(
    () => config.RADARRURL,
    () => config.RADARRAPIKEY,
);
