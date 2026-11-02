// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Map music query rows to client-ready `RecommendedMusic` cards.
 *
 * Poster: the catalog image proxy walks the parent chain (track → album →
 * artist), so passing the item's own UUID resolves album art automatically —
 * no need to figure out which ancestor actually holds the cover.
 *
 * @module server/proprietary/assistant-tools/music-card-builder
 */

import type { MusicSearchResult } from '../../database/queries/search.queries.js';
import type { RecentTrackRow } from '../../database/queries/music.queries.js';
import type { TextSoundSearchRow } from '../../database/queries/text-sound-search.queries.js';
import type { RecommendedMusic } from '../../../schemas/assistant-types.js';

function posterUrl(id: string): string {
    return `/api/image/catalog/${id}/poster?size=thumb`;
}

/** Map a full-text music search hit (track/album/artist) to a card. */
export function musicCardFromSearchResult(r: MusicSearchResult): RecommendedMusic {
    const mediaType: RecommendedMusic['mediaType'] =
        // eslint-disable-next-line callback-safety/no-inline-media-type-default -- search rows are normalized to the three music card kinds.
        r.media_type === 'album' ? 'album' : r.media_type === 'artist' ? 'artist' : 'track';
    return {
        id: r.id,
        title: r.title,
        mediaType,
        artistName: r.artist_name ?? undefined,
        artistId: r.artist_id ?? undefined,
        albumTitle: r.album_title ?? undefined,
        albumId: r.album_id ?? undefined,
        posterUrl: posterUrl(r.image_source_id ?? r.id),
    };
}

/** Map a played/recommended TRACK row (top-music / quick-picks) to a card. */
export function musicCardFromTrackRow(t: RecentTrackRow, bucket?: string): RecommendedMusic {
    return {
        id: t.id,
        title: t.title,
        mediaType: 'track',
        artistName: t.artist_title ?? undefined,
        artistId: t.artist_id ?? undefined,
        albumTitle: t.album_title ?? undefined,
        albumId: t.album_id ?? undefined,
        posterUrl: posterUrl(t.id),
        bucket,
    };
}

/**
 * Map a CLAP text-to-sound search hit (`find_music_by_vibe`) to a card. The
 * row shape differs from {@link MusicSearchResult} / {@link RecentTrackRow}
 * (`media_id` instead of `id`, no `artist_id` — only a display artist string)
 * so it gets its own mapper rather than being forced through the others.
 */
export function musicCardFromVibeResult(r: TextSoundSearchRow): RecommendedMusic {
    return {
        id: r.media_id,
        title: r.title,
        mediaType: 'track',
        artistName: r.artist_title ?? undefined,
        albumTitle: r.album_title ?? undefined,
        albumId: r.album_id ?? undefined,
        posterUrl: posterUrl(r.media_id),
        bucket: 'sonic-vibe-match',
    };
}
