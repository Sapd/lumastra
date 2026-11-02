// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * API Response types for Media-related endpoints.
 *
 * Types are re-exported from Zod schemas in '$lib/schemas/api-media-responses'.
 * This file exists for backward compatibility and convenience.
 *
 * Convention:
 * - All property names use camelCase
 * - TMDB-specific types use snake_case for API compatibility
 * - Use externalIds for provider-agnostic ID handling
 */

// =============================================================================
// Re-export all types from Zod schemas
// =============================================================================

export type {
    MediaRatings,
    MediaDetails,
    // Provider-neutral detail schema types
    Genre,
    CastMember,
    CrewMember,
    MediaDetailVideo,
    ProductionCountry,
    Network,
    MediaDetailData,
    // @deprecated — use the provider-neutral types above
    TmdbGenre,
    TmdbCastMember,
    TmdbCrewMember,
    TmdbVideo,
    TmdbProductionCountry,
    TmdbNetwork,
    TmdbMediaData,
    SimilarMediaItem,
    SocialActivityItem,
    TrendingItem,
    RecommendationItem,
} from '$lib/schemas/api-media-responses';
