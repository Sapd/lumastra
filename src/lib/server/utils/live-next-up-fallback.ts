// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { NextSequentialEpisodeRow } from '$lib/server/database/queries/episode-search.queries.js';
import type { ContinueWatchingItem } from '$lib/server/utils/section-builder.js';
import { createExternalIds, getPreferredExternalId } from '$lib/utils/external-ids.js';
import { getCatalogPosterUrl } from '$lib/utils/image-utils.js';

export interface WatchingItemWithSort extends ContinueWatchingItem {
    sortDate: Date;
    itemType: 'continue' | 'nextup' | 'new-episode';
    preserveSortDate?: boolean;
}

export function seriesDedupKey(item: ContinueWatchingItem): string {
    return item.seriesId || getPreferredExternalId(item.externalIds)?.id || item.id;
}

export function createSequentialNextUpItem(
    nextEpisode: NextSequentialEpisodeRow,
    liveItem: ContinueWatchingItem,
    internalSeriesId: string,
    nowIso: string,
): WatchingItemWithSort {
    return {
        id: nextEpisode.id,
        title: nextEpisode.title,
        mediaType: 'episode',
        seriesName: liveItem.seriesName,
        seasonNumber: nextEpisode.season_number,
        episodeNumber: nextEpisode.episode_number,
        watchProgress: 0,
        // Carry the episode runtime (seconds) through so the synthetic next-up
        // card shows a duration like every other item, instead of dropping it.
        duration:
            typeof nextEpisode.runtime_seconds === 'number' &&
            Number.isFinite(nextEpisode.runtime_seconds) &&
            nextEpisode.runtime_seconds > 0
                ? nextEpisode.runtime_seconds
                : undefined,
        imageUrl: getCatalogPosterUrl(nextEpisode.id, { size: 'thumb' }),
        externalIds: createExternalIds({
            internal: nextEpisode.id,
        }),
        hasFiles: nextEpisode.has_files,
        seriesId: internalSeriesId,
        updatedAt: nowIso,
        lastEventSource: liveItem.lastEventSource,
        source: 'next-up',
        sortDate: new Date(nowIso),
        itemType: 'nextup',
        preserveSortDate: true,
    };
}

export function upsertSequentialNextUp(
    nextUp: WatchingItemWithSort[],
    candidate: WatchingItemWithSort,
): WatchingItemWithSort[] {
    const key = seriesDedupKey(candidate);
    return [
        candidate,
        ...nextUp.filter((item) => item.id !== candidate.id && seriesDedupKey(item) !== key),
    ];
}
