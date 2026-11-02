// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Album Serializers

import type { MusicAlbumRow, TrackRow } from '$lib/server/database/queries/music.queries.js';
import type { SubsonicAlbum, SubsonicAlbumWithSongs } from '../types.js';
import { serializeSong } from './song.js';

// ---------------------------------------------------------------------------
// Genre extraction — handles both scalar and array values in custom_metadata
// ---------------------------------------------------------------------------

function extractGenre(meta: Record<string, unknown>): string | undefined {
    const rawGenre = meta.genre;
    if (Array.isArray(rawGenre)) return rawGenre[0] as string | undefined;
    if (typeof rawGenre === 'string') return rawGenre;
    return undefined;
}

// ---------------------------------------------------------------------------
// Public serialisers
// ---------------------------------------------------------------------------

/**
 * Convert one album DB row to a SubsonicAlbum wire object.
 * coverArt uses the album UUID directly when a custom poster is present —
 * getCoverArt resolves it to the actual image.
 */
export function serializeAlbum(row: MusicAlbumRow): SubsonicAlbum {
    const album: SubsonicAlbum = {
        id: row.id,
        name: row.title,
        songCount: row.track_count,
        duration: Math.round(row.total_duration ?? 0),
        created: row.created_at,
    };

    if (row.artist_id != null) album.artistId = row.artist_id;
    if (row.artist_title != null) album.artist = row.artist_title;
    if (row.year != null) album.year = row.year;
    if (row.custom_poster_url) album.coverArt = row.id;

    const genre = extractGenre(row.custom_metadata);
    if (genre !== undefined) album.genre = genre;

    return album;
}

/**
 * Convert an album row + its track rows to a SubsonicAlbumWithSongs.
 * Each track is serialised with the album's ID so coverArt falls back
 * to the album poster when the track has no dedicated poster.
 */
export function serializeAlbumWithSongs(
    album: MusicAlbumRow,
    tracks: TrackRow[],
    playCounts?: Map<string, number>,
): SubsonicAlbumWithSongs {
    const base = serializeAlbum(album);

    const songs = tracks.map((track) =>
        serializeSong(
            track,
            album.id,
            album.artist_id ?? undefined,
            album.title,
            playCounts?.get(track.id),
        ),
    );

    return {
        ...base,
        song: songs,
    };
}
