// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Playlist / Station Serializers
// Stations are exposed as virtual read-only playlists.

import type { StationSummary } from '$lib/server/services/music/stations.service.js';
import type { SubsonicPlaylist, SubsonicPlaylistWithSongs, SubsonicSong } from '../types.js';

/**
 * Encode a station id as a playlist ID.
 * Uses the "station:" prefix to avoid collisions with UUID-format media IDs.
 */
function stationId(id: string): string {
    return `station:${id}`;
}

/**
 * Convert a StationSummary to a SubsonicPlaylist (without songs).
 * The playlist is read-only; public is set to false so clients don't try
 * to delete or modify it.
 */
export function serializeStation(station: StationSummary, owner: string): SubsonicPlaylist {
    return {
        id: stationId(station.id),
        name: station.label,
        comment: station.tagline,
        owner,
        public: false,
        songCount: station.playedTrackCount,
        duration: 0, // duration unknown until songs are loaded
        created: '1970-01-01T00:00:00.000Z',
    };
}

/**
 * Convert a StationSummary + resolved songs to a SubsonicPlaylistWithSongs.
 * Duration is computed from the song list.
 */
export function serializeStationWithSongs(
    station: StationSummary,
    songs: SubsonicSong[],
    owner: string,
): SubsonicPlaylistWithSongs {
    const duration = songs.reduce((sum, s) => sum + (s.duration ?? 0), 0);

    return {
        id: stationId(station.id),
        name: station.label,
        comment: station.tagline,
        owner,
        public: false,
        songCount: songs.length,
        duration,
        created: '1970-01-01T00:00:00.000Z',
        entry: songs,
    };
}
