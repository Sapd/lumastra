// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages';
import { isSeries, isSeason } from '$lib/shared/media-types';

export interface SeriesCountSummary {
    seasonCount?: number;
    episodeCount?: number;
    availableEpisodeCount?: number;
    watchedEpisodeCount?: number;
    unwatchedEpisodeCount?: number;
}

export function formatSeriesCounts(
    counts: SeriesCountSummary,
    type: string | undefined,
    compact = false,
): string {
    if (!isSeries(type) && !isSeason(type)) return '';
    const parts: string[] = [];
    if (
        (!compact || counts.episodeCount === undefined) &&
        isSeries(type) &&
        counts.seasonCount !== undefined &&
        counts.seasonCount > 0
    ) {
        parts.push(m.series_seasons_count({ count: counts.seasonCount }));
    }
    if (counts.episodeCount !== undefined)
        parts.push(m.series_episodes_count({ count: counts.episodeCount }));
    return parts.join(' · ');
}

export function formatSeriesProgress(counts: SeriesCountSummary, type: string | undefined): string {
    if (!isSeries(type) && !isSeason(type)) return '';
    const parts: string[] = [];
    if (counts.availableEpisodeCount !== undefined)
        parts.push(m.series_available_count({ count: counts.availableEpisodeCount }));
    if (counts.watchedEpisodeCount !== undefined)
        parts.push(m.series_watched_count({ count: counts.watchedEpisodeCount }));
    if (counts.unwatchedEpisodeCount !== undefined)
        parts.push(m.series_unwatched_count({ count: counts.unwatchedEpisodeCount }));
    return parts.join(' · ');
}

export function seriesCountBadge(
    counts: SeriesCountSummary,
    type: string | undefined,
): { text: string; label: string; complete: boolean } | undefined {
    if (
        (!isSeries(type) && !isSeason(type)) ||
        !counts.availableEpisodeCount ||
        counts.unwatchedEpisodeCount === undefined
    )
        return undefined;
    if (counts.unwatchedEpisodeCount > 0)
        return {
            text: String(counts.unwatchedEpisodeCount),
            label: m.series_unwatched_count({ count: counts.unwatchedEpisodeCount }),
            complete: false,
        };
    return { text: '✓', label: m.series_all_watched(), complete: true };
}
