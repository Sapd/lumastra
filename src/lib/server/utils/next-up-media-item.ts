// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { NextUpRow } from '$lib/server/database/queries/watch-state.queries.js';
import { createExternalIds } from '$lib/utils/external-ids.js';
import { getCatalogPosterUrl } from '$lib/utils/image-utils';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';

/**
 * Transform a NextUpRow (local DB) into the MediaItem shape the API and
 * the homepage hero expect, for response parity. Shared by the
 * recommendations route, the cache warmer, and the SSR hero resolver.
 */
export function nextUpRowToMediaItem(row: NextUpRow): Record<string, unknown> {
    return {
        id: row.media_id,
        title: row.title,
        externalIds: createExternalIds({
            [getPrimaryExternalIdProvider()]: row.series_tmdb_id || null,
            internal: row.media_id,
        }),
        overview: row.overview ?? undefined,
        mediaType: 'episode',
        seriesName: row.series_name ?? undefined,
        seasonNumber: row.season_number,
        episodeNumber: row.episode_number,
        duration: row.runtime_seconds ?? undefined,
        imageUrl: getCatalogPosterUrl(row.media_id, { size: 'thumb' }),
        watchProgress: 0,
        // Internal series UUID. `seriesInternalId` carries the same value for
        // the translation overlay, which keys on it.
        seriesId: row.series_id ?? undefined,
        seriesInternalId: row.series_id ?? undefined,
        imageBackdropId: row.series_id || row.media_id,
        remoteTrailers: row.trailer_url ? [row.trailer_url] : undefined,
    };
}
