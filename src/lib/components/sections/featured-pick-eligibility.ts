// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { isEpisode, isMovie, isSeries } from '$lib/shared/media-types';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';

/**
 * FeaturedPickSection is a video hero surface. The recommender query currently
 * supplies only movie/tv rows, but keep the component guarded if that widens.
 */
export function isFeaturedPickVideoItem(item: { mediaType?: string }): boolean {
    return isMovie(item.mediaType) || isSeries(item.mediaType) || isEpisode(item.mediaType);
}

export function firstFeaturedPickVideoItem(items: UniversalMediaItem[]): UniversalMediaItem | null {
    return items.find(isFeaturedPickVideoItem) ?? null;
}
