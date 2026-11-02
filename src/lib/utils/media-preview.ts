// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { pickVariantUrl } from '$lib/utils/image-utils.js';
import type { MediaPreview } from '$lib/schemas/api-media-preview';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';
import { url } from '$lib/paths';
import { FALLBACK_IMAGE } from '$lib/constants/images';

/** The UI uses percentages; API playback progress is a fraction, never a ranking score. */
export function mediaPreviewToUniversal(item: MediaPreview): UniversalMediaItem {
    const image =
        item.type === 'episode'
            ? (item.images.thumb ?? item.images.poster)
            : (item.images.poster ?? item.images.primary ?? item.images.thumb);
    return {
        id: item.id,
        externalIds: { ...item.ids, internal: item.catalogId ?? undefined },
        mediaType: item.type === 'season' ? 'series' : item.type,
        title: item.title,
        subtitle: item.subtitle,
        year: item.year,
        overview: item.overview,
        image: image ? url(pickVariantUrl(image, 'card')) : FALLBACK_IMAGE,
        backdrop: item.images.backdrop
            ? url(pickVariantUrl(item.images.backdrop, 'hd'))
            : undefined,
        logo: item.images.logo ? url(item.images.logo.href) : undefined,
        rating: item.rating,
        genres: item.genres,
        durationMs: item.durationMs,
        progress: item.progress?.fraction != null ? item.progress.fraction * 100 : undefined,
        isPlayed: item.progress?.finished,
        isAvailable: item.availability?.isAvailable ?? false,
        hasFiles: item.availability?.hasFile ?? item.availability?.isAvailable ?? false,
        canRequest: item.availability?.canRequest ?? false,
        seriesId: item.context?.series?.id,
        seriesName: item.context?.series?.title,
        seasonNumber: item.context?.seasonNumber,
        episodeNumber: item.context?.episodeNumber,
        ...(item.type === 'audiobook' ? { aspectRatio: 'square' as const } : {}),
        reason: item.reason?.label,
        similarityScore: item.score,
    };
}
