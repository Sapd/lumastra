// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TMDB API Response Types
 *
 * Re-exports all types from the TMDB client.
 * This file provides a clean import path for types only.
 */

export type {
    // Search & Media
    TMDBSearchResult,
    TMDBMovieDetails,
    TMDBImage,
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
} from './client.js';
