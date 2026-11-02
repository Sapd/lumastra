// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Poster-URL resolution for playlist cover-collage tiles.
 *
 * Extracted from the playlists route so the branch order — the part that has
 * actually produced grey tiles in production — is unit testable without Svelte.
 *
 * ORDER MATTERS. When the item carries an internal UUID we resolve through the
 * CATALOG route and never through the raw `custom_*_url` the row carries:
 *
 * - `/api/image/catalog/{uuid}/poster` is a strict SUPERSET of
 *   `/api/image/custom/{uuid}/poster`. It reads the same local `media_artwork`
 *   rows (walking `parent_id` up to 3 levels, so a track inherits its album's
 *   cover), accepts a wider set of servable paths (media store OR library
 *   roots, vs. the custom route's narrower list), and then falls through to the
 *   provider chain (TMDB &c.) and finally the placeholder.
 * - `posterUrl` is a DENORMALIZED pointer (`media_items.custom_poster_url`)
 *   stamped when local artwork is stored. It can dangle: the paired
 *   `media_artwork` row can disappear via a path that bypasses the
 *   delete helpers that maintain the invariant (e.g. a bulk SQL purge), and
 *   the column is then left pointing at artwork that no longer exists. The
 *   custom route 404s and the tile paints grey — permanently, because trusting
 *   the dangling pointer PREEMPTS the catalog fallback that would have served
 *   the item's provider art.
 *
 * Preferring the catalog route whenever we have a UUID costs nothing when the
 * local row is present (identical bytes) and is the difference between a cover
 * and a grey tile when the pointer has gone stale.
 */

import { imageFromIds, getCatalogPosterUrl } from '$lib/utils/image-utils';
import { getExternalIdFor } from '$lib/utils/external-ids';
import { isEpisode } from '$lib/shared/media-types';
import type { ExternalIds } from '$lib/types/api-common';

export interface CoverItemLike {
    externalIds: ExternalIds;
    mediaType: string;
    seriesExternalIds?: ExternalIds | null;
    posterUrl?: string;
}

/**
 * Resolve the image URL for one cover-collage tile (provider-agnostic).
 *
 * Returns '' when nothing can be resolved, so the caller renders its own
 * empty-tile treatment rather than a broken image.
 */
export function getCoverItemPosterUrl(item: CoverItemLike): string {
    // Any item with an internal UUID resolves through the catalog route: it
    // serves local artwork (parent-walking track -> album -> artist), then
    // provider art, then the placeholder. This deliberately takes precedence
    // over `posterUrl` — see the module comment on dangling pointers.
    const internalId = getExternalIdFor(item.externalIds, 'internal');
    if (internalId) {
        return getCatalogPosterUrl(internalId, { size: 'thumb' });
    }

    // No internal UUID below this point — resolve from external ids alone.

    // Direct poster URL (custom posters) for rows we cannot address by UUID.
    if (item.posterUrl) {
        return item.posterUrl;
    }

    // For episodes, use series external IDs if available.
    if (isEpisode(item.mediaType) && item.seriesExternalIds) {
        return imageFromIds(item.seriesExternalIds, 'poster', 'tv', { size: 'thumb' }) || '';
    }

    // For movies/TV, use the item's external IDs.
    // The episode -> 'tv' collapse is deliberate and lossy: an episode has no
    // poster of its own, so the composite key must address the series. Every
    // other token passes through verbatim into `tmdb:{id}:{type}`, which the
    // server parses across all five — the two-token type is the label, not
    // the constraint.
    // eslint-disable-next-line callback-safety/no-narrowing-media-type-cast
    const mediaType = (isEpisode(item.mediaType) ? 'tv' : item.mediaType) as 'movie' | 'tv';
    return imageFromIds(item.externalIds, 'poster', mediaType, { size: 'thumb' }) || '';
}
