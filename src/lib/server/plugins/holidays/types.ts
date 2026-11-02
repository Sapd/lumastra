// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Holiday Plugin Type Definitions
 *
 * This module defines all types used by the holiday recommendation plugin.
 * The plugin supports multiple content sources and is fully configurable.
 */

// ============================================================================
// Content Source Types
// ============================================================================

/**
 * Supported content source types for holiday recommendations
 */
export type ContentSourceType = 'tmdb' | 'mdblist' | 'custom' | 'library';

/**
 * TMDB-based content source configuration
 * Uses TMDB keyword IDs, collections, and genres for discovery
 */
export interface TmdbContentSource {
    type: 'tmdb';
    /** TMDB keyword IDs for content discovery (most accurate method) */
    keywordIds?: number[];
    /** Text keywords for fallback search */
    keywords?: string[];
    /** TMDB collection IDs (e.g., Home Alone Collection) */
    collectionIds?: number[];
    /** TMDB genre IDs to filter by */
    genreIds?: number[];
    /** Specific movie TMDB IDs to always include */
    featuredMovieIds?: number[];
    /** Specific TV show TMDB IDs to always include */
    featuredTvIds?: number[];
    /** Include new releases from current/last year */
    includeNewReleases?: boolean;
    /** Minimum vote count for TMDB results */
    minVoteCount?: number;
    /** Minimum vote average for TMDB results */
    minVoteAverage?: number;
}

/**
 * MDBList playlist-based content source configuration
 * Fetches content from curated MDBList playlists
 */
export interface MdblistContentSource {
    type: 'mdblist';
    /** MDBList playlist path (e.g., "linaspurinis/christmas-movies") */
    listPath: string;
    /** Maximum items to fetch from the list */
    limit?: number;
    /** Boost factor for items from this list (1.0 = normal) */
    boostFactor?: number;
}

/**
 * Custom content source with explicit TMDB IDs
 * For manually curated content lists
 */
export interface CustomContentSource {
    type: 'custom';
    /** List of specific TMDB movie IDs */
    movieIds?: number[];
    /** List of specific TMDB TV show IDs */
    tvIds?: number[];
    /** Boost factor for these items (1.0 = normal) */
    boostFactor?: number;
}

/** Union type for all content sources */
export type ContentSource = TmdbContentSource | MdblistContentSource | CustomContentSource;

// ============================================================================
// Holiday Configuration Types
// ============================================================================

/**
 * Pre-holiday variant configuration
 * Allows different messaging/emoji during the lead-up period
 */
export interface PreHolidayConfig {
    /** Display name (primary/default language) */
    name: string;
    /** Localized names by language code (e.g., { de: 'Adventszeit', fr: 'Avent' }) */
    localizedNames?: Record<string, string>;
    /** Emoji for this variant */
    emoji: string;
    /** Start month (1-12) */
    startMonth: number;
    /** Start day (1-31) */
    startDay: number;
    /** End month (1-12) */
    endMonth: number;
    /** End day (1-31) */
    endDay: number;
}

/**
 * Holiday validation configuration
 * Defines validation rules to filter out false positives
 */
export interface HolidayValidation {
    /** Require content to contain at least one of these terms (case-insensitive) */
    requiredTerms?: string[];
    /** Exclude content containing any of these terms */
    excludeTerms?: string[];
    /** Skip validation for featured/custom content */
    skipForFeatured?: boolean;
}

/**
 * Complete holiday configuration
 */
export interface HolidayConfig {
    /** Unique identifier (e.g., 'christmas', 'halloween') */
    id: string;
    /** Display name (primary/default language) */
    name: string;
    /** Localized names by language code (e.g., { de: 'Weihnachten', fr: 'Noël' }) */
    localizedNames?: Record<string, string>;
    /** Emoji displayed in the banner */
    emoji: string;

    // Date range
    /** Start month (1-12) */
    startMonth: number;
    /** Start day (1-31) */
    startDay: number;
    /** End month (1-12) */
    endMonth: number;
    /** End day (1-31) */
    endDay: number;

    /** Content sources for this holiday (processed in order, combined) */
    sources: ContentSource[];

    // Visual styling
    /** Background color (CSS color value) */
    backgroundColor: string;
    /** Text color (CSS color value) */
    textColor: string;
    /** Optional background image path */
    backgroundImage?: string;

    /** Optional pre-holiday variant (e.g., Advent for Christmas) */
    preHoliday?: PreHolidayConfig;

    /** Optional validation rules to filter false positives */
    validation?: HolidayValidation;

    /** Whether this holiday is enabled (default: true) */
    enabled?: boolean;

    /** Priority when multiple holidays overlap (higher = takes precedence) */
    priority?: number;
}

// ============================================================================
// Plugin Configuration Types
// ============================================================================

/**
 * Global plugin settings
 */
export interface HolidayPluginSettings {
    /** Enable/disable the entire holiday plugin */
    enabled: boolean;
    /** Default limit for recommendations */
    defaultLimit: number;
    /** Enable AI personalization (requires AI system) */
    enableAiPersonalization: boolean;
    /** Cache TTL in minutes for recommendations */
    cacheTtlMinutes: number;
    /**
     * Unused since availability became a per-request, access-scoped lookup
     * (2026-10-02). Kept so stored configs and the admin API shape stay valid.
     */
    jellyfinCacheTtlHours: number;
}

/**
 * Complete plugin configuration
 */
export interface HolidayPluginConfig {
    /** Global plugin settings */
    settings: HolidayPluginSettings;
    /** Array of holiday configurations */
    holidays: HolidayConfig[];
}

// ============================================================================
// Runtime Types (used during content discovery)
// ============================================================================

/**
 * Discovered content item (before enrichment)
 * INTERNAL: Uses TMDB ID as the discovery source
 */
export interface DiscoveredItem {
    /** TMDB ID (internal only - converted to externalIds in final output) */
    id: number;
    /** media_items.id when the row came from the caller's library (source 'library'). */
    internalId?: string;
    mediaType: 'movie' | 'tv';
    title: string;
    overview?: string;
    posterPath?: string;
    backdropPath?: string;
    releaseDate?: string;
    popularity?: number;
    voteAverage?: number;
    voteCount?: number;
    genreIds?: number[];
    /** Source that discovered this item */
    source: ContentSourceType;
    /** Boost factor from source configuration */
    boostFactor?: number;
    /** Whether this is featured content */
    isFeatured?: boolean;
    /** Whether this is a new release */
    isNewRelease?: boolean;
    /** Whether this is from a collection */
    isFromCollection?: boolean;
}

/**
 * Enriched recommendation item (after Jellyfin availability check)
 * MIGRATION: Uses externalIds for provider-agnostic format
 */
export interface HolidayRecommendation {
    /** Provider-agnostic external IDs */
    externalIds: {
        /** TMDB ID (always present) */
        tmdb?: string;
        /** Library media_items.id — set exactly when the item is available to the caller */
        internal?: string;
        /** Jellyfin ID (when the library item has one) */
        jellyfin?: string;
    };
    mediaType: 'movie' | 'tv';
    title: string;
    overview: string;
    genres: number[];
    rating: number;
    criticRating?: number;
    posterPath?: string;
    backdropPath?: string;
    releaseDate?: string;
    popularity?: number;
    aiSuggestion: boolean;
    aiScore?: number;
    holidayThemed: boolean;
    holidayId: string;
    holidayName: string;
    isAvailable: boolean;
    canRequest: boolean;
    availabilitySource: string;
    userRating?: number;
    isNewRelease?: boolean;
    isFeatured?: boolean;
}

/**
 * API response for holiday recommendations
 */
export interface HolidayApiResponse {
    active: boolean;
    holiday: HolidayConfig | null;
    items: HolidayRecommendation[];
    cached: boolean;
    message?: string;
}

// ============================================================================
// Content Source Interface (for implementing sources)
// ============================================================================

/**
 * Interface that all content sources must implement
 */
export interface ContentSourceAdapter {
    /** Source type identifier */
    readonly type: ContentSourceType;

    /**
     * Discover content from this source
     * @param config - The source configuration
     * @param holiday - The holiday being processed
     * @param limit - Maximum items to return
     * @returns Array of discovered items
     */
    discover(
        config: ContentSource,
        holiday: HolidayConfig,
        limit: number,
    ): Promise<DiscoveredItem[]>;

    /**
     * Check if this source is available (e.g., API configured)
     */
    isAvailable(): boolean;
}
