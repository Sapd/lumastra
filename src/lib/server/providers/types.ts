// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Domain types for metadata provider responses.
 *
 * Shape of what the `providers/*` subtree returns from search / detail /
 * childList calls, and what SDK `ProviderDefinition` methods produce.
 */

/**
 * A candidate result from a metadata search.
 * Multiple candidates may match a title — caller picks the best.
 */
export interface MetadataCandidate {
    /** Provider-specific ID for this item. */
    externalId: string;
    /** Which provider this candidate came from. */
    provider: string;
    /** Canonical title. */
    title: string;
    /** Release year, if known. */
    year?: number;
    /** Media type as returned by this provider. */
    mediaType: 'movie' | 'tv' | 'episode' | 'season' | 'anime';
    /**
     * Match confidence 0–1.
     * 1.0 = exact ID match, 0.5 = title+year match, lower = fuzzy.
     */
    confidence: number;
    /** Short plot summary, if available from search results. */
    overview?: string;
    /** Poster image URL (direct, not proxied), if available from search results. */
    posterUrl?: string;
    /**
     * Cross-provider external IDs sourced from the search result.
     * Map of provider name → external ID (e.g. { tmdb: "550", imdb: "tt0137523" }).
     * Populated when the provider returns ProviderIds in its search response.
     */
    externalIds?: Record<string, string>;
    /**
     * National certification string from the provider (Jellyfin `OfficialRating`,
     * e.g. "FSK 12", "PG-13"), when the search result carries one. Mapped to an age
     * with `certificationToAge`.
     */
    certification?: string;
}

/**
 * Full metadata for a single movie or series.
 */
export interface MediaMetadata {
    /** Canonical title. */
    title: string;
    /** Original language title, if different. */
    originalTitle?: string;
    /** English title extracted from TMDB translations (for international search). */
    englishTitle?: string;
    /** Plot summary. */
    overview?: string;
    /** Tagline. */
    tagline?: string;
    /** Release year. */
    year?: number;
    /** Genre names. */
    genres?: string[];
    /** Runtime in minutes. */
    runtime?: number;
    /** ISO 8601 release date (YYYY-MM-DD). */
    releaseDate?: string;
    /** Status string (e.g. "Released", "Ended", "Continuing"). */
    status?: string;
    /** National certification (Jellyfin `OfficialRating`, e.g. "FSK 12"). */
    certification?: string;
    /** Primary spoken language code (e.g. "en"). */
    language?: string;
    /** Production country codes. */
    countries?: string[];
    cast?: Array<{
        name: string;
        character?: string;
        order?: number;
    }>;
    crew?: Array<{
        name: string;
        job: string;
        department?: string;
    }>;
    /** Keywords / tags. */
    keywords?: string[];
    /** Map of provider name → external ID for cross-referencing. */
    externalIds?: Record<string, string>;
    /** Poster image URL (direct, not proxied). */
    posterUrl?: string;
    /** Backdrop image URL (direct, not proxied). */
    backdropUrl?: string;
}

/**
 * Metadata for a single episode.
 */
export interface EpisodeMetadata {
    /** Provider-specific series ID this episode belongs to. */
    seriesExternalId: string;
    /** Season number (1-based). */
    season: number;
    /** Episode number within the season (1-based). */
    episode: number;
    /** Episode title. */
    title?: string;
    /** Episode plot summary. */
    overview?: string;
    /** ISO 8601 air date. */
    airDate?: string;
    /** Runtime in minutes. */
    runtime?: number;
    /** Provider-specific episode ID. */
    externalId: string;
    /** Still image URL (direct, not proxied). */
    stillUrl?: string;
}

/**
 * Metadata for a single season of a TV series.
 */
export interface SeasonMetadata {
    /** Season number (1-based). */
    seasonNumber: number;
    /** Season name (e.g. "Season 1"). */
    name: string;
    /** Season plot summary. */
    overview?: string;
    /** ISO 8601 premiere date. */
    airDate?: string;
    /**
     * Absolute poster URL for this season, if the provider supplies a
     * season-specific poster (TMDB returns one per entry in `seasons[]`).
     * Used to populate the season row's `custom_poster_url` so the image
     * proxy can serve a per-season poster even without a Jellyfin image_tag.
     */
    posterUrl?: string;
    /** Episodes belonging to this season. */
    episodes: EpisodeMetadata[];
}

/**
 * Result type for grouped series children (seasons → episodes).
 */
export interface SeriesChildrenResult {
    /** Seasons with their episodes grouped. */
    seasons: SeasonMetadata[];
    /** True when only a subset of the provider's seasons was requested/fetched. */
    partial?: boolean;
    /** Seasons the provider failed to deliver: not written, not full coverage. */
    incompleteSeasons?: number[];
}
