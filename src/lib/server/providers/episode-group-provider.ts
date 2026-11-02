// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Episode Group Provider Interface
 *
 * Provider-agnostic interface for fetching alternative episode orderings
 * (DVD order, regional order, absolute, etc.). TMDB is the primary
 * implementation; future providers (TVDB, AniDB, etc.) implement the
 * same interface and register via the provider map.
 */

// =============================================================================
// Types
// =============================================================================

export interface EpisodeGroupSummary {
    groupId: string;
    groupName: string;
    /** Maps to EpisodeOrderingType ('dvd', 'regional', 'absolute', 'other') */
    groupType: string;
    description?: string;
    episodeCount: number;
    groupCount: number;
}

export interface EpisodeGroupEpisode {
    /** Provider-specific episode ID (e.g. TMDB episode numeric ID) */
    id: number;
    seasonNumber: number;
    episodeNumber: number;
    /** Position within the group (0-based from provider, converted to 1-based by consumer) */
    order: number;
    name?: string;
    stillPath?: string;
}

export interface EpisodeGroupSeason {
    /** Display order of this group/season (0-based) */
    order: number;
    name?: string;
    episodes: EpisodeGroupEpisode[];
}

export interface EpisodeGroupDetails {
    groupId: string;
    groupName: string;
    groupType: string;
    description?: string;
    episodeCount: number;
    groupCount: number;
    seasons: EpisodeGroupSeason[];
}

// =============================================================================
// Provider Interface
// =============================================================================

export interface EpisodeGroupProvider {
    /** Unique provider identifier ('tmdb', 'tvdb', etc.) */
    readonly providerId: string;

    /**
     * List available episode groups for a series.
     * @param seriesExternalId - Provider-specific series ID (e.g. TMDB numeric ID as string)
     */
    getEpisodeGroups(seriesExternalId: string): Promise<EpisodeGroupSummary[]>;

    /**
     * Fetch full details for an episode group, including per-episode mappings.
     * @param groupId - Provider-specific group ID
     */
    getGroupDetails(groupId: string): Promise<EpisodeGroupDetails | null>;
}

// =============================================================================
// Provider Registry (simple map, not the full MetadataProvider registry)
// =============================================================================

const episodeGroupProviders = new Map<string, EpisodeGroupProvider>();

/**
 * Register an episode group provider.
 */
export function registerEpisodeGroupProvider(provider: EpisodeGroupProvider): void {
    episodeGroupProviders.set(provider.providerId, provider);
}

/**
 * Get an episode group provider by ID.
 */
export function getEpisodeGroupProvider(providerId: string): EpisodeGroupProvider | undefined {
    return episodeGroupProviders.get(providerId);
}

/**
 * Get all registered episode group provider IDs.
 */
export function getEpisodeGroupProviderIds(): string[] {
    return Array.from(episodeGroupProviders.keys());
}
