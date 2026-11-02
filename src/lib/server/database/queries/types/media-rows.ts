// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared Row Type Interfaces
 *
 * Composable interfaces for database query result rows used across all query modules.
 * These eliminate duplicate type definitions and provide a single source of truth
 * for the shape of raw database rows returned by SQL queries.
 *
 * Usage pattern:
 *   import type { StandardMediaRow } from './types/media-rows.js';
 *
 * @module queries/types/media-rows
 */

// =============================================================================
// Core Fields
// =============================================================================

/**
 * Minimum fields present on every media item row.
 */
export interface BaseMediaRow {
    /** Internal UUID of the media item */
    media_id: string;
    /** Display title */
    title: string;
    /** Lowercase media type */
    media_type: 'movie' | 'tv';
}

/**
 * BaseMediaRow plus the resolved primary external ID (TMDB or aggregated).
 */
export interface BaseMediaWithExtIdRow extends BaseMediaRow {
    /** Primary external provider ID (e.g. TMDB ID as string) */
    primary_ext_id: string;
}

// =============================================================================
// Availability
// =============================================================================

/**
 * Availability fields derived from local file presence (media_file_items)
 */
export interface AvailabilityFields {
    /** Whether the item is available for playback */
    is_available: boolean;
    /** Whether the item can be requested via Jellyseerr */
    can_request: boolean;
}

// =============================================================================
// Metadata Ratings
// =============================================================================

/**
 * Core metadata rating fields from TMDB and RT.
 */
export interface MetadataRatings {
    /** IMDB weighted average (0–10), or null */
    imdb_rating: number | null;
    /** Rotten Tomatoes critics score (0–100), or null */
    rt_rating: number | null;
    /** TMDB weighted average (0–10), or null */
    tmdb_rating: number | null;
    /** TMDB popularity score, or null */
    popularity: number | null;
}

/**
 * Extended ratings from additional providers; extends MetadataRatings.
 */
export interface ExtendedRatings extends MetadataRatings {
    /** Rotten Tomatoes audience score (0–100), or null */
    rt_audience_score: number | null;
    /** Letterboxd average rating (0–5), or null */
    letterboxd_rating: number | null;
    /** Number of Letterboxd ratings, or null */
    letterboxd_votes: number | null;
    /** Metacritic score (0–100), or null */
    metacritic_score: number | null;
    /** Trakt.tv score (0–100), or null */
    trakt_score: number | null;
    /** MDBList aggregated score, or null */
    mdblist_score: number | null;
    /** MyAnimeList score (0–10), or null — only present for anime */
    mal_score?: number | null;
}

// =============================================================================
// Content Metadata
// =============================================================================

/**
 * Descriptive content metadata fields.
 */
export interface MetadataContent {
    /** Plot summary, or null */
    overview: string | null;
    /** Runtime in minutes, or null */
    runtime_minutes: number | null;
    /** Original release date (ISO string or Date), or null */
    release_date: string | Date | null;
    /** MPAA / content certification (e.g. "PG-13"), or null */
    certification: string | null;
    /** YouTube trailer URL, or null */
    trailer_url?: string | null;
}

// =============================================================================
// JSONB Array Fields
// =============================================================================

/**
 * Fields stored as JSONB arrays in the database.
 * All fields are optional since not every query selects every array.
 */
export interface MetadataArrays {
    /** Genre IDs array, or null */
    genres: number[] | null;
    /** Keyword tags, or null */
    keywords?: string[] | null;
    /** MDBList-sourced keyword tags, or null */
    mdblist_keywords?: string[] | null;
    /** Top billed actor names, or null */
    actors?: string[] | null;
    /** Director names, or null */
    directors?: string[] | null;
    /** Network/broadcaster names (TV), or null */
    networks?: string[] | null;
    /** Production company names, or null */
    production_companies?: string[] | null;
    /** Streaming service names, or null */
    streaming_services?: string[] | null;
}

// =============================================================================
// TV-Specific Fields
// =============================================================================

/**
 * Fields that are only meaningful for TV series rows.
 */
export interface TvMetadataFields {
    /** ISO date string of first episode air date, or null */
    first_air_date: string | null;
    /** ISO date string of most recent episode air date, or null */
    last_air_date: string | null;
    /** Series status (e.g. "Returning Series", "Ended"), or null */
    status: string | null;
    /** Total season count, or null */
    season_count: number | null;
    /** Total episode count, or null */
    episode_count: number | null;
}

// =============================================================================
// AI / Embedding Fields
// =============================================================================

/**
 * AI similarity score attached to recommendation query results.
 */
export interface SimilarityFields {
    /** Cosine similarity score (0–1), or null if not ranked */
    ai_similarity: number | null;
}

/**
 * Flags indicating which embedding sources are present for a media item.
 */
export interface EmbeddingPresenceFields {
    /** Whether a Jellyfin-sourced embedding exists */
    has_jellyfin: boolean;
    /** Whether a Jellyseerr-sourced embedding exists */
    has_jellyseerr: boolean;
}

// =============================================================================
// Composed Types
// =============================================================================

/**
 * Standard full media row returned by most browse and listing queries.
 * Combines identity, availability, descriptive metadata, ratings, and arrays.
 */
export type StandardMediaRow = BaseMediaWithExtIdRow &
    AvailabilityFields &
    MetadataContent &
    MetadataRatings &
    MetadataArrays;

/**
 * Media row for recommendation and similarity queries.
 * Extends StandardMediaRow with extended ratings, AI similarity, and an
 * optional explicit relevance score.
 */
export type RecommendationMediaRow = StandardMediaRow &
    ExtendedRatings &
    SimilarityFields & {
        /** Optional explicit relevance score from the ranking query */
        relevance_score?: number | null;
    };
