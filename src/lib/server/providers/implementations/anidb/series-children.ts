// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * AniDB series-children helper.
 *
 * AniDB's data model is anime-shaped (a single linear episode list per aid),
 * not the season/episode hierarchy TMDB or Jellyfin use. Returns a single
 * synthetic "Season 1" wrapping the episode list — mirrors the legacy
 * `getSeriesChildrenFromProvider` fallback that grouped a flat
 * `getEpisodeList` result by season number.
 *
 * Delegates to the native AniDB provider's `childList()` method via the
 * invoke helper. Returns `{ seasons: [] }` when AniDB isn't configured
 * (childList returns []) — caller treats that the same as "no data".
 */

import type {
    EpisodeMetadata,
    SeasonMetadata,
    SeriesChildrenResult,
} from '$lib/server/providers/types.js';
import { invokeProviderChildList } from '$lib/server/tasks/plugin-context.js';

export async function getSeriesChildren(seriesExternalId: string): Promise<SeriesChildrenResult> {
    const episodes = await invokeProviderChildList<EpisodeMetadata>(
        'anidb-metadata-provider',
        seriesExternalId,
    );
    if (episodes.length === 0) return { seasons: [] };

    // Group by season number — AniDB usually only carries season 1 but the
    // shape mirrors the legacy plugin's getEpisodeList fallback exactly so
    // a multi-season anime (rare) doesn't get flattened into one bucket.
    const bySeason = new Map<number, EpisodeMetadata[]>();
    for (const ep of episodes) {
        const seasonNum = ep.season ?? 1;
        const list = bySeason.get(seasonNum) ?? [];
        list.push(ep);
        bySeason.set(seasonNum, list);
    }

    const seasons: SeasonMetadata[] = Array.from(bySeason.entries())
        .sort(([a], [b]) => a - b)
        .map(([seasonNumber, eps]) => ({
            seasonNumber,
            name: `Season ${seasonNumber}`,
            episodes: eps,
        }));

    return { seasons };
}
