// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { MusicTrack } from '$lib/schemas/music';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';
import { getCatalogPosterUrl } from '$lib/utils/image-utils';
import type { ExternalIds } from '$lib/types/api-common';

/**
 * Common input shape for building a music UniversalMediaItem card.
 * Covers both FTS search results (artist/album/track, with externalIds) and
 * semantic-search track results (track-only, no externalIds beyond internal).
 */
export interface MusicCardItemInput {
    id: string;
    mediaType: 'artist' | 'album' | 'track';
    title: string;
    subtitle?: string;
    overview?: string;
    year?: number;
    externalIds?: ExternalIds;
    /**
     * Structured entity ids (artistId/albumId). UniversalMediaCard uses these
     * for the clickable artist subtitle, the "Go to artist/album" context
     * entries, and to open a track's parent album without a detail fetch.
     */
    clickData?: { artistId?: string; albumId?: string };
    /** Structured track artists (tag order) for title/credit linkification. */
    artists?: { id?: string | null; title: string }[];
    remixerArtists?: { id?: string | null; title: string }[];
}

/**
 * Builds the shared UniversalMediaItem shell for music cards.
 *
 * Shared invariants:
 *   - id: entity UUID; itemKey: `search-${i.id}`
 *   - externalIds is empty; music identity is id
 *   - image always via getCatalogPosterUrl (catalog route, parent-walks track→album→artist)
 *   - aspectRatio: 'square', isAvailable: true, canRequest: false
 */
export function buildMusicCardItem(i: MusicCardItemInput): UniversalMediaItem {
    const internal = i.id;
    return {
        id: i.id,
        itemKey: `search-${i.id}`,
        externalIds: {},
        mediaType: i.mediaType,
        title: i.title,
        subtitle: i.subtitle ?? '',
        overview: i.overview,
        year: i.year,
        ...(i.artists && {
            artists: i.artists.map((a) => ({ ...a, id: a.id ?? undefined })),
        }),
        ...(i.remixerArtists && {
            remixerArtists: i.remixerArtists.map((a) => ({ ...a, id: a.id ?? undefined })),
        }),
        image: getCatalogPosterUrl(internal, { size: 'thumb' }),
        aspectRatio: 'square',
        isAvailable: true,
        canRequest: false,
        ...(i.clickData &&
            (i.clickData.artistId || i.clickData.albumId) && {
                clickData: {
                    ...(i.clickData.artistId && { artistId: i.clickData.artistId }),
                    ...(i.clickData.albumId && { albumId: i.clickData.albumId }),
                },
            }),
    };
}

/**
 * Maps a MusicTrack (as returned by /api/music/text-search or /api/music/lyrics-search)
 * to a UniversalMediaItem for rendering in semantic search sections.
 *
 * Image resolution goes through the catalog route (getCatalogPosterUrl) which
 * parent-walks track→album→artist, matching the FTS search card behaviour exactly.
 */
export function mapMusicTrackToItem(
    t: MusicTrack & { similarityScore?: number },
): UniversalMediaItem {
    return buildMusicCardItem({
        id: t.id,
        mediaType: 'track',
        title: t.title,
        subtitle: t.artists.map((a) => a.title).join(', '),
        overview: t.artists.map((a) => a.title).join(', '),
        clickData: { artistId: t.artists[0]?.id ?? undefined, albumId: t.album?.id },
        artists: t.artists,
        remixerArtists: t.remixerArtists,
    });
}
