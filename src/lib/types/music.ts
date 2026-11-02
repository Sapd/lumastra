// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Public music types shared by API and web consumers. */
export type {
    Artist as MusicArtistRow,
    Album as MusicAlbumRow,
    Track as TrackRow,
    ArtistSummary as MusicArtistSummary,
    AlbumSummary as MusicAlbumSummary,
} from '$lib/schemas/api-music-dto';

export type { AutoplaySeed, PlaybackContext } from '$lib/schemas/autoplay-seed';
