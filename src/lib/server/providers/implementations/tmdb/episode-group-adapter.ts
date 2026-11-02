// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TMDB Episode Group Provider Adapter
 *
 * Wraps the existing TMDBApiService episode group methods behind the
 * provider-agnostic EpisodeGroupProvider interface.
 */

import type {
    EpisodeGroupProvider,
    EpisodeGroupSummary,
    EpisodeGroupDetails,
} from '../../episode-group-provider.js';
import { tmdbApi, TMDBApiService } from './client.js';

export class TmdbEpisodeGroupProvider implements EpisodeGroupProvider {
    readonly providerId = 'tmdb' as const;

    async getEpisodeGroups(seriesExternalId: string): Promise<EpisodeGroupSummary[]> {
        const tmdbId = parseInt(seriesExternalId, 10);
        if (isNaN(tmdbId)) return [];

        if (!tmdbApi.isAvailable()) return [];

        const groups = await tmdbApi.getEpisodeGroups(tmdbId);
        return groups.map((g) => ({
            groupId: g.id,
            groupName: g.name,
            groupType: TMDBApiService.mapEpisodeGroupType(g.type),
            description: g.description,
            episodeCount: g.episode_count,
            groupCount: g.group_count,
        }));
    }

    async getGroupDetails(groupId: string): Promise<EpisodeGroupDetails | null> {
        const details = await tmdbApi.getEpisodeGroupDetails(groupId);
        if (!details) return null;

        return {
            groupId: details.id,
            groupName: details.name,
            groupType: TMDBApiService.mapEpisodeGroupType(details.type),
            description: details.description,
            episodeCount: details.episode_count,
            groupCount: details.group_count,
            seasons: details.groups.map((g) => ({
                order: g.order,
                name: g.name,
                episodes: g.episodes.map((ep) => ({
                    id: ep.id,
                    seasonNumber: ep.season_number,
                    episodeNumber: ep.episode_number,
                    order: ep.order,
                    name: ep.name,
                    stillPath: ep.still_path,
                })),
            })),
        };
    }
}
