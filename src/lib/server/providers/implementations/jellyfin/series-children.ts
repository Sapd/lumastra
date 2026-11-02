// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin series-children helper.
 *
 * Returns a `SeriesChildrenResult` (seasons + episodes) for a Jellyfin series.
 * Extracted from the legacy `JellyfinMetadataPlugin.getSeriesChildren` so
 * callers can drive series-children sync against the new SDK provider
 * registry without routing through the deleted legacy plugin shell.
 *
 * Fan-out: fetches seasons and episodes in parallel, then groups episodes by
 * `seasonNumber`. If `getSeriesSeasons` returns empty (transient API failure)
 * but episodes succeeded, synthesises `SeasonMetadata` from the episode data
 * so the caller doesn't see "no children" when episodes are clearly present.
 */

import type {
    EpisodeMetadata,
    SeasonMetadata,
    SeriesChildrenResult,
} from '$lib/server/providers/types.js';

/** 1 RunTimeTick = 100 nanoseconds → minutes */
function ticksToMinutes(ticks: unknown): number | undefined {
    if (typeof ticks !== 'number' || !isFinite(ticks)) return undefined;
    return Math.round(ticks / 600_000_000);
}

export async function getSeriesChildren(seriesExternalId: string): Promise<SeriesChildrenResult> {
    const { jellyfinSeriesService } = await import('../../../jellyfin/series.service.js');

    const [rawSeasons, rawEpisodes] = await Promise.all([
        jellyfinSeriesService.getSeriesSeasons(seriesExternalId),
        jellyfinSeriesService.getAllSeriesEpisodes(seriesExternalId),
    ]);

    if (!Array.isArray(rawSeasons) || !Array.isArray(rawEpisodes)) {
        return { seasons: [] };
    }

    const episodesBySeason = new Map<number, EpisodeMetadata[]>();
    for (const ep of rawEpisodes) {
        const seasonNum = ep.seasonNumber ?? 1;
        const list = episodesBySeason.get(seasonNum) ?? [];
        list.push({
            seriesExternalId,
            season: seasonNum,
            episode: ep.episodeNumber ?? 1,
            title: ep.name,
            overview: ep.overview,
            runtime: ticksToMinutes(ep.runTimeTicks),
            airDate: ep.premiereDate,
            externalId: ep.id,
        });
        episodesBySeason.set(seasonNum, list);
    }

    let seasons: SeasonMetadata[];
    if (rawSeasons.length > 0) {
        seasons = rawSeasons.map((s) => ({
            seasonNumber: s.seasonNumber ?? 0,
            name: s.name ?? `Season ${s.seasonNumber}`,
            overview: s.overview,
            airDate: s.premiereDate,
            episodes: episodesBySeason.get(s.seasonNumber ?? 0) ?? [],
        }));
    } else {
        seasons = Array.from(episodesBySeason.entries()).map(([seasonNum, eps]) => ({
            seasonNumber: seasonNum,
            name: `Season ${seasonNum}`,
            episodes: eps,
        }));
    }

    return { seasons };
}
