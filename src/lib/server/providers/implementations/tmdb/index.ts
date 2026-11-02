// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TMDB Provider Module
 *
 * Consolidated TMDB provider implementation — the canonical home for everything
 * TMDB-specific that isn't a `defineProvider` declaration (those live in
 * `src/lib/server/tasks/builtin/native/providers/tmdb.ts`).
 *
 * - TMDBApiService and related: typed HTTP client with 15+ specialized methods
 * - searchResultToCandidate / detailToMetadata: per-provider normalization used
 *   by providers/normalize.ts dispatcher
 * - getTrendingMovies / getTrendingTVShows / getCrossReferences: pre-shaped
 *   trending + cross-reference helpers (not part of the SDK contract)
 *
 * Usage:
 *   import { tmdbApi } from '$lib/server/providers/implementations/tmdb';
 *   import type { TMDBMovieDetails } from '$lib/server/providers/implementations/tmdb';
 */

// Re-export all types from types.ts (which re-exports from client.ts)
export type {
    // Search & Media
    TMDBSearchResult,
    TMDBMovieDetails,
    // Video
    TMDBVideoResult,
    TMDBVideoResponse,
    // Credits
    TMDBCastMember,
    TMDBCrewMember,
    TMDBCredits,
    // Categorization
    TMDBGenre,
    TMDBKeyword,
    TMDBKeywordsResponse,
    TMDBGenreListResponse,
    // Network & Production
    TMDBNetwork,
    TMDBProductionCountry,
    TMDBProductionCompany,
    TMDBSpokenLanguage,
    // External IDs
    TMDBExternalIds,
    // TV Season & Episode
    TMDBSeason,
    TMDBSeasonResponse,
    TMDBEpisode,
    TMDBSeasonEpisodesResponse,
    // Collections
    TMDBCollectionDetails,
    // Episode Groups (alternative orderings)
    TMDBEpisodeGroupType,
    TMDBEpisodeGroupSummary,
    TMDBEpisodeGroupsResponse,
    TMDBEpisodeGroupEpisode,
    TMDBEpisodeGroupGroup,
    TMDBEpisodeGroupDetails,
} from './types.js';

// Additional types only surfaced from the client (not in the types barrel)
export type { TMDBImage, TMDBTranslation, TMDBTranslationsResponse } from './client.js';

// Re-export the API service for direct access (for specialized endpoints)
export { TMDBApiService, tmdbApi, createTMDBApi, TmdbApiError } from './client.js';

// Per-provider normalization (used by providers/normalize.ts dispatcher)
export { searchResultToCandidate, detailToMetadata } from './normalize.js';

// Pre-shaped trending + cross-reference helpers
export { getTrendingMovies, getTrendingTVShows, getCrossReferences } from './trending.js';
export type { TmdbTrendingItem } from './trending.js';
