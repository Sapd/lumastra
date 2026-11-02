// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Shared Embedding Generation Utilities
// Consolidates common logic between Jellyfin, TMDB, and other embedding generators

import type { Database } from '../database/connection';
import { generateTextEmbedding } from './openai';
import { DataNormalizationService } from '../services/data-normalization.service.js';
import type { CastMember, CrewMember, JellyfinPerson } from '../services/cast-crew.service.js';
import { formatEmbeddingText, type EmbeddingTextInput } from './embedding-text-formatter';
import type { TaskPhase } from '../../utils/task-phases';
import {
    isRecord,
    toString,
    toNumber,
    parseInteger as toNumberFromUnknown,
    toStringArray,
    toNumberArray,
} from '../../utils/data-extraction';
import { isMovie } from '../utils/media-types';
import { toTmdbMediaType } from '$lib/shared/media-type-domain';
import { tmdbAuthorizedRequest } from '$lib/server/providers/implementations/tmdb/auth.js';
import {
    EmbeddingOperationsService,
    DiscoveryCatalogDisabledError,
} from '../services/embedding-operations.service.js';
import { EMBEDDING_SOURCE, type EmbeddingSource } from '../utils/embedding-source';
import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { trackExternalCall } from '$lib/server/utils/external-request-counter.js';

export interface MediaItem {
    // Common fields
    id: string | number;
    tmdb_id?: number;
    imdb_id?: string; // IMDB identifier
    title: string;
    original_title?: string; // Original/English title for search
    name?: string; // TV series use 'name' instead of 'title'
    overview?: string;
    media_type: 'movie' | 'tv';

    // Local-only content (no real TMDB ID)
    is_local_only?: boolean; // True if using a virtual TMDB ID

    // Date fields
    release_date?: string;
    first_air_date?: string;
    premiere_date?: string;

    // Ratings
    vote_average?: number;
    vote_count?: number;
    popularity?: number;
    community_rating?: number;
    critic_rating?: number;
    imdb_rating?: number;
    rt_rating?: number;

    // Content details
    runtime?: number;
    runtime_ticks?: number;
    budget?: number;
    revenue?: number;

    // Metadata
    genres?: string[] | number[];
    genre_ids?: number[];
    official_rating?: string; // Parental rating

    // Cast & crew - Enhanced
    directors?: string[];
    actors?: string[];
    producers?: string[];
    writers?: string[];
    cast?: CastMember[];
    crew?: CrewMember[];
    people?: JellyfinPerson[];

    // Network/Studio info - Enhanced
    networks?: string[];
    production_companies?: string[];
    keywords?: string[];
    spoken_languages?: string[];
    production_countries?: string[];

    // Availability
    is_available?: boolean;
    can_request?: boolean;
    jellyseerr_id?: number;

    // MDBList enrichment data
    mdblist_score?: number;
    mdblist_keywords?: string[];
    letterboxd_rating?: number;
    letterboxd_votes?: number;
    metacritic_score?: number;
    rt_audience_score?: number;
    trakt_score?: number;
    mal_score?: number;
    mal_votes?: number;
    streaming_services?: string[];
    anime_genres?: string[];

    // Source-specific data
    source: 'library' | 'tmdb' | 'discovery';
    original_data?: unknown; // Store the original API response
}

export interface EmbeddingResult {
    success: boolean;
    /** Primary identifier — UUID from media_items table */
    media_id?: string;
    /** TMDB ID when available; absent for local-only content */
    tmdb_id?: number;
    title: string;
    media_type: 'movie' | 'tv';
    action: 'created' | 'updated' | 'skipped' | 'error';
    reason?: string;
    error?: string;
}

export interface GenerationProgress {
    phase: TaskPhase;
    totalItems: number;
    processedItems: number;
    currentItem?: string;
    currentSubStatus?: string;
    estimatedTimeRemaining?: string;
    errors: string[];
    recentLogs: string[];
    startTime: Date;
    lastCheckpoint?: Date;

    // Statistics
    created: number;
    updated: number;
    skipped: number;
    errorCount: number;

    // Progress percentage
    progressPercentage: number;

    // Custom stats (optional, task-specific)
    episodesSynced?: number;
    moviesSynced?: number;
}

/**
 * Base class for generators with progress tracking
 * Shared by JellyfinMetadataSyncGenerator, TMDBMetadataSyncGenerator, etc.
 */
export abstract class BaseProgressGenerator {
    protected currentProgress: GenerationProgress | null = null;
    protected aborted = false;
    protected isRunning = false;

    protected initProgress(startMessage: string): void {
        this.currentProgress = {
            phase: 'fetching',
            totalItems: 0,
            processedItems: 0,
            currentSubStatus: 'Initializing...',
            errors: [],
            recentLogs: [startMessage],
            startTime: new Date(),
            created: 0,
            updated: 0,
            skipped: 0,
            errorCount: 0,
            progressPercentage: 0,
        };
    }

    getProgress(): GenerationProgress {
        if (!this.currentProgress) {
            return {
                phase: 'initializing',
                totalItems: 0,
                processedItems: 0,
                currentSubStatus: 'Initializing...',
                errors: [],
                recentLogs: [],
                startTime: new Date(),
                created: 0,
                updated: 0,
                skipped: 0,
                errorCount: 0,
                progressPercentage: 0,
            };
        }
        return this.currentProgress;
    }

    async abort(abortMessage = 'Aborted by user'): Promise<void> {
        this.aborted = true;
        if (this.currentProgress) {
            this.currentProgress.phase = 'aborted';
            this.currentProgress.errors.push(abortMessage);
        }
    }

    isAborted(): boolean {
        return this.aborted;
    }

    protected setRunning(running: boolean): void {
        this.isRunning = running;
    }

    protected isCurrentlyRunning(): boolean {
        return this.isRunning;
    }

    protected handleSyncError(error: Error): void {
        if (this.currentProgress) {
            this.currentProgress.phase = 'error';
            this.currentProgress.errors.push(error.message);
        }
    }
}

export class ProgressTracker {
    private progress: GenerationProgress;
    private logBuffer: string[] = [];
    private maxLogs = 20;

    constructor(totalItems: number = 0) {
        this.progress = {
            phase: 'fetching',
            totalItems,
            processedItems: 0,
            errors: [],
            recentLogs: [],
            startTime: new Date(),
            created: 0,
            updated: 0,
            skipped: 0,
            errorCount: 0,
            progressPercentage: 0,
        };
    }

    updatePhase(phase: GenerationProgress['phase'], status?: string) {
        this.progress.phase = phase;
        this.progress.lastCheckpoint = new Date();
        if (status) {
            this.progress.currentSubStatus = status;
            this.addLog(`Phase: ${phase} - ${status}`);
        } else {
            this.addLog(`Phase: ${phase}`);
        }
    }

    updateTotalItems(total: number) {
        this.progress.totalItems = total;
        this.updateProgress();
    }

    updateCurrentItem(title: string, mediaType: 'movie' | 'tv' = 'movie') {
        const emoji = isMovie(mediaType) ? '🎬' : '📺';
        this.progress.currentItem = `${emoji} ${title}`;
    }

    incrementProgress(result: EmbeddingResult) {
        this.progress.processedItems++;

        switch (result.action) {
            case 'created':
                this.progress.created++;
                break;
            case 'updated':
                this.progress.updated++;
                break;
            case 'skipped':
                this.progress.skipped++;
                break;
            case 'error':
                this.progress.errorCount++;
                break;
        }

        this.updateProgress();
        this.updateTimeEstimate();

        if (result.action === 'error' && result.error) {
            this.addError(result.error);
        }
    }

    addLog(message: string) {
        const timestamp = new Date().toLocaleTimeString();
        const logMessage = `[${timestamp}] ${message}`;
        this.logBuffer.push(logMessage);

        // Keep only recent logs
        if (this.logBuffer.length > this.maxLogs) {
            this.logBuffer = this.logBuffer.slice(-this.maxLogs);
        }

        this.progress.recentLogs = [...this.logBuffer];
    }

    addError(error: string) {
        this.progress.errors.push(error);
        this.addLog(`❌ Error: ${error}`);
    }

    private updateProgress() {
        if (this.progress.totalItems > 0) {
            this.progress.progressPercentage = Math.round(
                (this.progress.processedItems / this.progress.totalItems) * 100,
            );
        }
    }

    private updateTimeEstimate() {
        if (this.progress.processedItems === 0) return;

        const elapsed = Date.now() - this.progress.startTime.getTime();
        const avgTimePerItem = elapsed / this.progress.processedItems;
        const remaining = this.progress.totalItems - this.progress.processedItems;
        const estimatedMs = remaining * avgTimePerItem;

        if (estimatedMs > 60000) {
            const minutes = Math.round(estimatedMs / 60000);
            this.progress.estimatedTimeRemaining = `~${minutes}m`;
        } else {
            const seconds = Math.round(estimatedMs / 1000);
            this.progress.estimatedTimeRemaining = `~${seconds}s`;
        }
    }

    getProgress(): GenerationProgress {
        return { ...this.progress };
    }

    markComplete() {
        this.progress.phase = 'completed';
        this.progress.progressPercentage = 100;
        this.addLog(
            `✅ Completed! ${this.progress.created} created, ${this.progress.updated} updated, ${this.progress.skipped} skipped, ${this.progress.errorCount} errors`,
        );
    }

    markError(error: string) {
        this.progress.phase = 'error';
        this.addError(error);
    }
}

// Genre mapping for consistency across sources
export const GENRE_MAP: Record<number, string> = {
    12: 'Adventure',
    28: 'Action',
    16: 'Animation',
    35: 'Comedy',
    80: 'Crime',
    99: 'Documentary',
    18: 'Drama',
    10751: 'Family',
    14: 'Fantasy',
    36: 'History',
    27: 'Horror',
    10402: 'Music',
    9648: 'Mystery',
    10749: 'Romance',
    878: 'Science Fiction',
    53: 'Thriller',
    10752: 'War',
    37: 'Western',
    // TV-specific genres
    10759: 'Action & Adventure',
    10762: 'Kids',
    10763: 'News',
    10764: 'Reality',
    10765: 'Sci-Fi & Fantasy',
    10766: 'Soap',
    10767: 'Talk',
    10768: 'War & Politics',
};

export const REVERSE_GENRE_MAP: Record<string, number> = Object.fromEntries(
    Object.entries(GENRE_MAP).map(([id, name]) => [name, parseInt(id)]),
);

/**
 * Fetch original_title from TMDB API for a given media item
 * This is used to enable search by English title for localized content
 */
async function fetchTmdbOriginalTitle(
    tmdbId: number,
    mediaType: 'movie' | 'tv',
): Promise<string | null> {
    const apiKey = process.env.TMDB_API_KEY;
    if (!apiKey) return null;

    try {
        const endpoint = toTmdbMediaType(mediaType);
        const request = tmdbAuthorizedRequest(
            `https://api.themoviedb.org/3/${endpoint}/${tmdbId}`,
            apiKey,
            { 'Content-Type': 'application/json' },
        );
        // C22 fix-plan finding scope: fixed, non-admin-configurable public
        // host (api.themoviedb.org) — see docs/dev/eslint-exceptions.md.
        const response = await trackExternalCall(request.url, () =>
            fetchWithTimeout(request.url, { headers: request.headers }),
        );

        if (!response.ok) return null;

        const data: unknown = await response.json();
        if (!isRecord(data)) return null;
        // Movies use original_title, TV shows use original_name
        return toString(data.original_title) || toString(data.original_name) || null;
    } catch {
        return null;
    }
}

/** Input type for normalizeMediaItem - accepts various API response formats */
type MediaItemInput = Record<string, unknown>;

/**
 * Normalize a media item from any source to our standard format
 */
export function normalizeMediaItem(
    item: MediaItemInput,
    source: 'library' | 'tmdb' | 'discovery',
): MediaItem {
    const normalized: MediaItem = {
        id:
            toString(item.id) ??
            toNumberFromUnknown(item.id) ??
            toString(item.Id) ??
            toNumberFromUnknown(item.Id) ??
            'unknown',
        source,
        media_type: 'movie', // default
        title: '',
        original_data: item,
    };

    // Determine media type and extract common fields
    if (source === 'library') {
        const providerIds = isRecord(item.ProviderIds) ? item.ProviderIds : undefined;
        // `isMovie(normalizeMediaType(x)) ? 'movie' : 'tv'` used to sit here —
        // a comparator applied to an already-narrowed value, and a binary clamp
        // on top of it: an audiobook, album or channel row came out as 'tv'.
        //
        // The `?? 'movie'` is a genuine last resort, not a classification: the
        // recommender's `media_type` is `'movie' | 'tv'` by construction and the
        // embedding pipeline is only ever fed movie/series rows (see the note on
        // `MediaType` in providers/provider-types.ts — audiobooks never enter the
        // recommender). A row that reaches here with no TMDB namespace is a
        // caller bug upstream, not something to model.
        // eslint-disable-next-line callback-safety/no-inline-media-type-default -- the embedding pipeline is movie/series-only.
        normalized.media_type = toTmdbMediaType(toString(item.Type)) ?? 'movie';
        normalized.title = DataNormalizationService.safeString(toString(item.Name) || '');

        // Extract TMDB ID when available. Items without a real TMDB ID are
        // marked as local-only and identified by their UUID.
        // Use explicit null/undefined check (not truthy) since TMDB ID 0 is theoretically possible
        const realTmdbId = DataNormalizationService.extractTmdbId(providerIds);
        if (realTmdbId !== null && realTmdbId !== undefined) {
            normalized.tmdb_id = realTmdbId;
            normalized.is_local_only = false;
        } else {
            normalized.is_local_only = true;
        }

        normalized.imdb_id = providerIds ? toString(providerIds.Imdb) : undefined;
        normalized.overview = DataNormalizationService.normalizeOverview(toString(item.Overview));
        normalized.release_date = toString(item.PremiereDate);
        normalized.community_rating = toNumber(item.CommunityRating);
        normalized.critic_rating = toNumber(item.CriticRating);
        normalized.official_rating = toString(item.OfficialRating);
        normalized.runtime_ticks = toNumber(item.RunTimeTicks);
        normalized.genres = toStringArray(item.Genres);
        normalized.people = Array.isArray(item.People)
            ? (item.People as JellyfinPerson[])
            : undefined;
        normalized.is_available = true;

        // Extract runtime in minutes if available
        if (toNumber(item.RunTimeTicks)) {
            normalized.runtime = Math.round((toNumber(item.RunTimeTicks) || 0) / 600000000);
        }
    } else {
        // TMDB/Jellyseerr - Enhanced extraction
        const mediaTypeValue = toString(item.media_type) || toString(item.mediaType);
        // TMDB search results sometimes omit `media_type` entirely, so the
        // first_air_date heuristic below stays as the documented fallback for
        // THAT case (absent field), which is different from "present but not a
        // TMDB namespace" — the latter now takes the same branch rather than
        // being asked twice via isSeries/isMovie.
        normalized.media_type =
            toTmdbMediaType(mediaTypeValue) ?? (toString(item.first_air_date) ? 'tv' : 'movie');
        normalized.title = DataNormalizationService.safeString(
            toString(item.title) || toString(item.name) || '',
        );
        // Original title for searching in original language (e.g., "Submission" for German "Unterwerfung")
        normalized.original_title =
            toString(item.original_title) ||
            toString(item.original_name) ||
            toString(item.originalTitle);
        normalized.tmdb_id = toNumberFromUnknown(item.id);
        normalized.imdb_id = toString(item.imdb_id);
        normalized.overview = DataNormalizationService.normalizeOverview(toString(item.overview));
        normalized.release_date = toString(item.release_date) || toString(item.first_air_date);
        normalized.vote_average = toNumber(item.vote_average);
        normalized.vote_count = toNumber(item.vote_count);
        normalized.popularity = toNumber(item.popularity);
        normalized.genre_ids = toNumberArray(item.genre_ids);
        normalized.runtime = toNumber(item.runtime);
        normalized.budget = toNumber(item.budget);
        normalized.revenue = toNumber(item.revenue);

        // Enhanced TMDB fields
        const keywordsContainer = isRecord(item.keywords) ? item.keywords : undefined;
        normalized.keywords = (
            keywordsContainer && Array.isArray(keywordsContainer.keywords)
                ? keywordsContainer.keywords
                : []
        )
            .map((k) => (isRecord(k) ? toString(k.name) : undefined))
            .filter((name): name is string => Boolean(name));
        normalized.networks = (Array.isArray(item.networks) ? item.networks : [])
            .map((n) => (isRecord(n) ? toString(n.name) : undefined))
            .filter((name): name is string => Boolean(name));
        normalized.production_companies = (
            Array.isArray(item.production_companies) ? item.production_companies : []
        )
            .map((c) => (isRecord(c) ? toString(c.name) : undefined))
            .filter((name): name is string => Boolean(name));
        normalized.spoken_languages = (
            Array.isArray(item.spoken_languages) ? item.spoken_languages : []
        )
            .map((l) => (isRecord(l) ? toString(l.iso_639_1) : undefined))
            .filter((code): code is string => Boolean(code));
        normalized.production_countries = (
            Array.isArray(item.production_countries) ? item.production_countries : []
        )
            .map((c) => (isRecord(c) ? toString(c.iso_3166_1) : undefined))
            .filter((code): code is string => Boolean(code));
        const credits = isRecord(item.credits) ? item.credits : undefined;
        normalized.cast = (
            Array.isArray(credits?.cast) ? credits?.cast : Array.isArray(item.cast) ? item.cast : []
        ) as CastMember[];
        normalized.crew = (
            Array.isArray(credits?.crew) ? credits?.crew : Array.isArray(item.crew) ? item.crew : []
        ) as CrewMember[];

        // For discovery (Jellyseerr) specifically
        if (source === 'discovery') {
            normalized.jellyseerr_id =
                toNumberFromUnknown(item.jellyseerr_id) ?? toNumberFromUnknown(item.id);
            normalized.can_request = true; // Jellyseerr items can be requested
        }
    }

    return normalized;
}

/**
 * Extract and format cast/crew information from different sources
 */
export function extractCastInfo(item: MediaItem): {
    directors: string[];
    actors: string[];
    producers: string[];
    writers: string[];
} {
    let directors: string[] = [];
    let actors: string[] = [];
    let producers: string[] = [];
    let writers: string[] = [];

    if (item.source === 'library' && item.people) {
        // Library (Jellyfin) People array format
        directors = item.people
            .filter((p: JellyfinPerson) => p.Type === 'Director')
            .map((p: JellyfinPerson) => p.Name || '')
            .filter(Boolean)
            .slice(0, 3); // Limit to top 3 directors

        actors = item.people
            .filter((p: JellyfinPerson) => p.Type === 'Actor')
            .map((p: JellyfinPerson) => p.Name || '')
            .filter(Boolean)
            .slice(0, 8); // Limit to top 8 actors

        producers = item.people
            .filter((p: JellyfinPerson) => p.Type === 'Producer')
            .map((p: JellyfinPerson) => p.Name || '')
            .filter(Boolean)
            .slice(0, 3); // Limit to top 3 producers

        writers = item.people
            .filter((p: JellyfinPerson) => p.Type === 'Writer' || p.Type === 'Screenplay')
            .map((p: JellyfinPerson) => p.Name || '')
            .filter(Boolean)
            .slice(0, 3); // Limit to top 3 writers
    } else if (item.crew || item.cast) {
        // TMDB/Jellyseerr format with cast and crew arrays
        if (item.crew) {
            directors = item.crew
                .filter((c: CrewMember) => c.job === 'Director')
                .map((c: CrewMember) => c.name)
                .slice(0, 3);

            producers = item.crew
                .filter((c: CrewMember) => c.job === 'Producer' || c.job === 'Executive Producer')
                .map((c: CrewMember) => c.name)
                .slice(0, 3);

            writers = item.crew
                .filter(
                    (c: CrewMember) =>
                        c.job === 'Writer' || c.job === 'Screenplay' || c.job === 'Story',
                )
                .map((c: CrewMember) => c.name)
                .slice(0, 3);
        }

        if (item.cast) {
            actors = item.cast.map((c: CastMember) => c.name).slice(0, 8);
        }
    } else {
        // Use pre-extracted arrays
        directors = item.directors || [];
        actors = item.actors || [];
        producers = item.producers || [];
        writers = item.writers || [];
    }

    return { directors, actors, producers, writers };
}

/**
 * Generate genre text from either genre names or IDs
 */
export function getGenreText(item: MediaItem): string {
    if (item.genres && Array.isArray(item.genres)) {
        // Already genre names (Jellyfin)
        return item.genres.join(', ');
    } else if (item.genre_ids && Array.isArray(item.genre_ids)) {
        // Genre IDs (TMDB)
        const genreNames = item.genre_ids.map((id) => GENRE_MAP[id]).filter(Boolean);
        return genreNames.join(', ');
    }
    return '';
}

/**
 * Generate genre IDs for database storage
 */
export function getGenreIds(item: MediaItem): number[] {
    if (item.genre_ids && Array.isArray(item.genre_ids)) {
        return item.genre_ids;
    } else if (item.genres && Array.isArray(item.genres)) {
        return item.genres
            .map((genre) => REVERSE_GENRE_MAP[genre] || 18) // Default to Drama
            .filter(Boolean);
    }
    return [];
}

/**
 * Create the embedding text for any media item.
 *
 * Uses the unified formatter for clean, natural language output.
 * Converts MediaItem to EmbeddingTextInput format.
 */
export function createEmbeddingText(item: MediaItem): string {
    const { directors, actors, producers, writers } = extractCastInfo(item);

    // Parse year from release date
    const year = DataNormalizationService.normalizeYear(item.release_date);

    // Calculate runtime in minutes
    let runtimeMinutes: number | null = null;
    if (item.runtime) {
        runtimeMinutes = item.runtime;
    } else if (item.runtime_ticks) {
        runtimeMinutes = Math.round(item.runtime_ticks / 600000000);
    }

    // Get genre names
    const genres = getGenreText(item).split(', ').filter(Boolean);

    // Combine keywords from all sources
    const allKeywords: string[] = [];
    if (item.keywords?.length) allKeywords.push(...item.keywords.slice(0, 10));
    if (item.mdblist_keywords?.length) {
        item.mdblist_keywords.slice(0, 15).forEach((k) => {
            if (!allKeywords.includes(k)) allKeywords.push(k);
        });
    }

    // Check if anime
    const isAnime = Boolean(
        item.anime_genres?.length || (item.mal_score && item.mal_votes && item.mal_votes > 1000),
    );

    // Build the input for the unified formatter
    const input: EmbeddingTextInput = {
        title: DataNormalizationService.safeString(item.title),
        year: year || null,
        overview: DataNormalizationService.normalizeOverview(item.overview),
        genres,
        keywords: allKeywords.slice(0, 20),
        runtimeMinutes,

        // Ratings - prioritize the most reliable sources
        imdbRating: item.community_rating || item.imdb_rating,
        tmdbRating: item.vote_average,
        letterboxdRating: item.letterboxd_rating,
        rtCriticsScore: item.critic_rating || item.rt_rating,
        rtAudienceScore: item.rt_audience_score,
        traktScore: item.trakt_score,
        metacriticScore: item.metacritic_score,
        malScore: item.mal_score,
        mdblistScore: item.mdblist_score,

        // Cast & Crew
        directors,
        actors,
        producers,
        writers,

        // Production
        networks: item.networks,
        studios: item.production_companies,
        countries: item.production_countries,
        languages: item.spoken_languages,

        // Classification
        certification: item.official_rating,
        mediaType: item.media_type,

        // Anime
        isAnime,
        animeGenres: item.anime_genres,
    };

    return formatEmbeddingText(input, {
        includeRatings: true,
        maxActors: 6,
        maxKeywords: 15,
    });
}

/**
 * Process a single media item and generate its embedding.
 * Items are eligible as long as they have enough metadata to generate meaningful text.
 * A TMDB ID is not required — local-only items are identified by their Jellyfin ID and UUID.
 */
export async function processMediaItem(
    item: MediaItem,
    db: Database,
    embeddingSource: EmbeddingSource = EMBEDDING_SOURCE.LIBRARY,
    options: { force?: boolean; requireMdblistTags?: boolean } = {},
): Promise<EmbeddingResult> {
    const result: EmbeddingResult = {
        success: false,
        tmdb_id: item.tmdb_id,
        title: item.title,
        media_type: item.media_type,
        action: 'error',
    };

    try {
        // Items must have at least a title to generate meaningful embeddings
        if (!item.title) {
            result.action = 'skipped';
            result.reason = 'no_title';
            return result;
        }

        // Look up existing embedding — prefer UUID path for local-only items
        let existing;
        if (item.tmdb_id) {
            existing = await db.getMediaEmbedding(item.tmdb_id, item.media_type);
        }

        // Populate media_id from resolved UUID when available
        if (existing?.internal_id) {
            result.media_id = existing.internal_id;
        }

        const hasRequiredEmbedding =
            embeddingSource === EMBEDDING_SOURCE.LIBRARY
                ? existing?.library_embedding
                : existing?.discovery_embedding;

        // Skip if already has embedding (unless force mode)
        if (hasRequiredEmbedding && !options.force) {
            result.action = 'skipped';
            result.reason = `${embeddingSource}_embedding_exists`;
            result.success = true;
            return result;
        }

        // Enrich item with MDBList data from existing record if available
        if (existing) {
            item.mdblist_score = existing.mdblist_score ?? undefined;
            item.mdblist_keywords = existing.mdblist_keywords ?? undefined;
            item.letterboxd_rating = existing.letterboxd_rating ?? undefined;
            item.letterboxd_votes = existing.letterboxd_votes ?? undefined;
            item.metacritic_score = existing.metacritic_score ?? undefined;
            item.rt_rating = existing.rt_rating ?? undefined;
            item.rt_audience_score = existing.rt_audience_score ?? undefined;
            item.trakt_score = existing.trakt_score ?? undefined;
            item.mal_score = existing.mal_score ?? undefined;
            item.mal_votes = existing.mal_votes ?? undefined;
            item.streaming_services = existing.streaming_services ?? undefined;
            item.anime_genres = existing.anime_genres ?? undefined;
            // Also enrich with existing cast/crew if not present
            if (!item.actors?.length && existing.actors) item.actors = existing.actors;
            if (!item.directors?.length && existing.directors) item.directors = existing.directors;
            if (!item.producers?.length && existing.producers) item.producers = existing.producers;
            if (!item.writers?.length && existing.writers) item.writers = existing.writers;
            if (!item.imdb_id && existing.imdb_id) item.imdb_id = existing.imdb_id;
            if (!item.keywords?.length && existing.keywords) item.keywords = existing.keywords;
            // Enrich with original title if available
            if (!item.original_title && existing.original_title)
                item.original_title = existing.original_title;
        }

        // Fetch original_title from TMDB if not present (needed for search by English title)
        // Skip for local-only items — they don't exist in TMDB
        if (!item.original_title && item.tmdb_id && !item.is_local_only) {
            try {
                const tmdbOriginalTitle = await fetchTmdbOriginalTitle(
                    item.tmdb_id,
                    item.media_type,
                );
                if (tmdbOriginalTitle) {
                    item.original_title = tmdbOriginalTitle;
                }
            } catch {
                // Ignore errors - original_title is optional, search will still work with regular title
            }
        }

        // Check if MDBList tags are required but missing
        // Skip this check for local-only items - they won't have MDBList data
        if (options.requireMdblistTags && !item.is_local_only) {
            const hasMdblistTags = item.mdblist_keywords && item.mdblist_keywords.length > 0;
            if (!hasMdblistTags) {
                result.action = 'skipped';
                result.reason = 'no_mdblist_tags';
                result.success = true;
                return result;
            }
        }

        // Generate embedding text
        const embeddingText = createEmbeddingText(item);

        // Embed the rich pre-formatted text DIRECTLY. (Previously this passed
        // embeddingText as the `overview` field to generateMediaEmbedding, which
        // rebuilt its own [title, overview, genres, year] string — double-wrapping
        // the rich text as a plot synopsis and discarding the formatting.)
        const embedding = await generateTextEmbedding(embeddingText);

        if (!embedding) {
            result.error = 'Failed to generate embedding';
            return result;
        }

        // Extract enhanced cast and crew information
        const { directors, actors, producers, writers } = extractCastInfo(item);

        // Save to database with all the new fields.
        // Pass item.media_type as an explicit boundary parameter (mediaType) so the
        // composite-key requirement is visible at the call site rather than buried
        // inside the input object (IDENT-M3).
        const embeddingService = new EmbeddingOperationsService(db.getSql());
        const saved = await embeddingService.upsertMediaEmbedding(
            {
                tmdb_id: item.tmdb_id ?? null,
                imdb_id: item.imdb_id,
                title: item.title,
                original_title: item.original_title,
                overview: item.overview || '',
                genres: getGenreIds(item),
                release_date: item.release_date,
                vote_average: item.vote_average || item.community_rating || 0,
                vote_count: item.vote_count || 0,
                popularity: item.popularity || 0,
                runtime_minutes: item.runtime,
                budget: item.budget,
                revenue: item.revenue,

                // Cast and crew
                actors: actors.length ? actors : undefined,
                directors: directors.length ? directors : undefined,
                producers: producers.length ? producers : undefined,
                writers: writers.length ? writers : undefined,

                // Production details
                keywords: item.keywords,
                networks: item.networks,
                production_companies: item.production_companies,
                spoken_languages: item.spoken_languages,
                production_countries: item.production_countries,
                certification: item.official_rating,

                // Ratings
                imdb_rating: item.community_rating || item.imdb_rating,
                rt_rating: item.critic_rating || item.rt_rating,

                // Availability
                is_available: item.is_available,
                can_request: item.can_request,
                jellyseerr_id: item.jellyseerr_id,

                // Local-only flag
                is_local_only: item.is_local_only,

                embedding: embedding,
            },
            item.media_type,
            embeddingSource,
        );

        result.media_id = saved.internal_id;
        result.success = true;
        result.action = existing ? 'updated' : 'created';
        return result;
    } catch (error) {
        if (error instanceof DiscoveryCatalogDisabledError) {
            result.action = 'skipped';
            result.reason = 'discovery_catalog_disabled';
            result.success = true;
            return result;
        }
        // best-effort: per-item failure is captured in result.error (aggregated by the batch caller), not swallowed.
        result.error = (error as Error).message;
        return result;
    }
}

/**
 * Process multiple media items in batches with advanced progress tracking
 */
export async function processMediaBatchWithProgress(
    items: MediaItem[],
    db: Database,
    embeddingSource: EmbeddingSource = EMBEDDING_SOURCE.LIBRARY,
    options: {
        batchSize?: number;
        progressTracker?: ProgressTracker;
        onProgress?: (progress: GenerationProgress) => void;
        force?: boolean;
        requireMdblistTags?: boolean;
        shouldAbort?: () => boolean;
    } = {},
): Promise<{
    total: number;
    created: number;
    updated: number;
    skipped: number;
    errors: number;
    results: EmbeddingResult[];
    progress: GenerationProgress;
}> {
    const {
        batchSize = 3,
        onProgress,
        force = false,
        requireMdblistTags = true,
        shouldAbort,
    } = options;
    const tracker = options.progressTracker || new ProgressTracker(items.length);

    tracker.updatePhase(
        'generating',
        `Processing ${items.length} ${embeddingSource} items${force ? ' (force mode)' : ''}${requireMdblistTags ? '' : ' (skip MDBList check)'}`,
    );
    tracker.updateTotalItems(items.length);

    const allResults: EmbeddingResult[] = [];

    for (let i = 0; i < items.length; i += batchSize) {
        // Check for abort before each batch
        if (shouldAbort?.()) {
            tracker.updatePhase('aborted', 'Generation aborted by user');
            tracker.addLog('Generation aborted by user');
            break;
        }

        const batch = items.slice(i, i + batchSize);

        const batchPromises = batch.map(async (item) => {
            tracker.updateCurrentItem(item.title, item.media_type);
            const result = await processMediaItem(item, db, embeddingSource, {
                force,
                requireMdblistTags,
            });
            tracker.incrementProgress(result);

            if (onProgress) onProgress(tracker.getProgress());

            return result;
        });

        const batchResults = await Promise.allSettled(batchPromises);
        const processedResults = batchResults.map((r) => {
            if (r.status === 'fulfilled') {
                return r.value;
            }
            const errorMessage = r.reason instanceof Error ? r.reason.message : 'Unknown error';
            return {
                success: false,
                action: 'error' as const,
                error: errorMessage,
                title: 'Unknown',
                media_type: 'movie' as const,
            };
        });

        allResults.push(...processedResults);

        // Progress logging every few batches
        if (i % (batchSize * 3) === 0 || i + batchSize >= items.length) {
            const progress = tracker.getProgress();
            tracker.addLog(
                `Processed ${progress.processedItems}/${progress.totalItems} (${progress.progressPercentage}%)`,
            );
        }

        // Rate limiting between batches
        if (i + batchSize < items.length) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }

    tracker.markComplete();
    const finalProgress = tracker.getProgress();

    return {
        total: items.length,
        created: finalProgress.created,
        updated: finalProgress.updated,
        skipped: finalProgress.skipped,
        errors: finalProgress.errorCount,
        results: allResults,
        progress: finalProgress,
    };
}
