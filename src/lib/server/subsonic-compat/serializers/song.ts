// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Song Serializers
// Handles the five different DB row shapes that represent a track.

import type {
    TrackRow,
    TrackDetailRow,
    GenreTrackRow,
    RecentTrackRow,
    SimilarTrackRow,
} from '$lib/server/database/queries/music.queries.js';
import type { SubsonicSong } from '../types.js';
import { AUDIO_MIME_TYPES } from '../constants.js';
import { computeLufsGain } from '$lib/utils/lufs-gain.js';

// ---------------------------------------------------------------------------
// Union input type
// ---------------------------------------------------------------------------

export type AnySongRow =
    RecentTrackRow | SimilarTrackRow | GenreTrackRow | TrackDetailRow | TrackRow;

// ---------------------------------------------------------------------------
// Field accessors — each row shape exposes fields under slightly different keys
// ---------------------------------------------------------------------------

function getAlbumId(row: AnySongRow, fallback?: string): string | undefined {
    if ('album_id' in row && row.album_id != null) return row.album_id;
    if ('parent_id' in row && row.parent_id != null) return row.parent_id;
    return fallback;
}

function getAlbumTitle(row: AnySongRow): string | undefined {
    if ('album_title' in row && row.album_title != null) return row.album_title;
    return undefined;
}

function getArtistId(row: AnySongRow, fallback?: string): string | undefined {
    if ('artist_id' in row && row.artist_id != null) return row.artist_id;
    // TrackRow has track_artist_id
    if ('track_artist_id' in row && row.track_artist_id != null) return row.track_artist_id;
    return fallback;
}

function getArtistTitle(row: AnySongRow): string | undefined {
    if ('artist_title' in row && row.artist_title != null) return row.artist_title;
    // TrackRow has track_artist_title
    if ('track_artist_title' in row && row.track_artist_title != null)
        return row.track_artist_title;
    return undefined;
}

function getYear(row: AnySongRow): number | undefined {
    if ('album_year' in row && row.album_year != null) return row.album_year;
    if ('year' in row && row.year != null) return row.year;
    return undefined;
}

function getCreatedAt(row: AnySongRow): string | undefined {
    if ('created_at' in row) return row.created_at;
    return undefined;
}

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
// BPM extraction from essentia analysis block
// ---------------------------------------------------------------------------

function extractBpm(meta: Record<string, unknown>): number | undefined {
    const essentia = meta.essentia;
    if (essentia === null || essentia === undefined || typeof essentia !== 'object') {
        return undefined;
    }
    const essentiaRecord = essentia as Record<string, unknown>;
    const bpm = essentiaRecord.bpm;
    if (typeof bpm === 'number' && isFinite(bpm)) return Math.round(bpm);
    if (typeof bpm === 'string') {
        const parsed = parseFloat(bpm);
        if (isFinite(parsed)) return Math.round(parsed);
    }
    return undefined;
}

/**
 * Convert the stored integrated LUFS measurement into the OpenSubsonic
 * ReplayGain representation.  Use the same capped gain as web playback so a
 * Symfonium session and the dashboard never normalize a track by different
 * amounts.  Peak data is not currently measured, so it is intentionally
 * omitted rather than guessed.
 */
function extractReplayGain(meta: Record<string, unknown>): SubsonicSong['replayGain'] {
    const essentia = meta.essentia;
    if (essentia === null || essentia === undefined || typeof essentia !== 'object') {
        return undefined;
    }
    const loudness = (essentia as Record<string, unknown>).loudness_lufs;
    const loudnessLufs =
        typeof loudness === 'number'
            ? loudness
            : typeof loudness === 'string'
              ? Number.parseFloat(loudness)
              : Number.NaN;
    if (!Number.isFinite(loudnessLufs)) return undefined;

    // ReplayGain uses dB whereas computeLufsGain returns a linear multiplier.
    // The conversion also preserves computeLufsGain's safe -12 dB / +6 dB cap.
    const gainDb = Math.round(20 * Math.log10(computeLufsGain(loudnessLufs)) * 10) / 10;
    return { trackGain: gainDb, fallbackGain: gainDb };
}

// ---------------------------------------------------------------------------
// Disc number extraction
// ---------------------------------------------------------------------------

function extractDiscNumber(meta: Record<string, unknown>): number | undefined {
    const disc = meta.disc_number;
    if (typeof disc === 'number' && isFinite(disc)) return disc;
    if (typeof disc === 'string') {
        const parsed = parseInt(disc, 10);
        if (!isNaN(parsed)) return parsed;
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// coverArt resolution
// Always use the track's own UUID: the image proxy's getLocalArtwork walks the
// parent chain (track → album → artist) so album art is found automatically,
// and getImageMetadata's recursive CTE also bubbles up to find custom_poster_url
// or TMDB metadata from ancestor items.  Using the album UUID instead would miss
// artwork stored at the track level (typical for embedded music file covers).
// ---------------------------------------------------------------------------

function resolveCoverArt(row: AnySongRow, _albumId?: string): string | undefined {
    return row.id;
}

function getFilePath(row: AnySongRow): string | null {
    if ('file_path' in row && typeof row.file_path === 'string') return row.file_path;
    return null;
}

function getSuffixAndContentType(filePath: string | null): {
    suffix?: string;
    contentType?: string;
} {
    if (!filePath) return {};
    const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
    const contentType = AUDIO_MIME_TYPES[ext];
    if (!contentType) return {};
    return { suffix: ext.slice(1), contentType };
}

// ---------------------------------------------------------------------------
// Main serialiser
// ---------------------------------------------------------------------------

/**
 * Convert any track DB row shape to a SubsonicSong wire object.
 *
 * @param row     - Track row from any music query (RecentTrack, Similar,
 *                  GenreTrack, TrackDetail, or plain Track).
 * @param albumId - Override album ID for rows that lack it (e.g. bare TrackRow
 *                  returned from getAlbumWithTracks where parent_id is set).
 * @param artistId - Override artist ID for rows that lack a top-level artist.
 */
export function serializeSong(
    row: AnySongRow,
    albumId?: string,
    artistId?: string,
    albumTitle?: string,
    playCount?: number,
): SubsonicSong {
    const meta = row.custom_metadata;
    const resolvedAlbumId = getAlbumId(row, albumId);
    const resolvedArtistId = getArtistId(row, artistId);

    const filePath = getFilePath(row);
    const { suffix, contentType } = getSuffixAndContentType(filePath);

    const song: SubsonicSong = {
        id: row.id,
        title: row.title,
        isDir: false,
        type: 'music',
        isVideo: false,
        duration: Math.round(row.runtime_seconds ?? 0),
    };

    if (suffix !== undefined) song.suffix = suffix;
    if (contentType !== undefined) song.contentType = contentType;

    if (resolvedAlbumId !== undefined) song.parent = resolvedAlbumId;

    const resolvedAlbumTitle = getAlbumTitle(row) ?? albumTitle;
    if (resolvedAlbumTitle !== undefined) song.album = resolvedAlbumTitle;
    if (resolvedAlbumId !== undefined) song.albumId = resolvedAlbumId;

    const artistTitle = getArtistTitle(row);
    if (artistTitle !== undefined) song.artist = artistTitle;
    if (resolvedArtistId !== undefined) song.artistId = resolvedArtistId;

    const sortOrder = 'sort_order' in row ? row.sort_order : undefined;
    if (sortOrder != null) song.track = sortOrder;

    const discNumber = extractDiscNumber(meta);
    if (discNumber !== undefined) song.discNumber = discNumber;

    const year = getYear(row);
    if (year !== undefined) song.year = year;

    const genre = extractGenre(meta);
    if (genre !== undefined) song.genre = genre;

    const coverArt = resolveCoverArt(row, resolvedAlbumId);
    if (coverArt !== undefined) song.coverArt = coverArt;

    const bpm = extractBpm(meta);
    if (bpm !== undefined) song.bpm = bpm;

    const replayGain = extractReplayGain(meta);
    if (replayGain !== undefined) song.replayGain = replayGain;

    const createdAt = getCreatedAt(row);
    if (createdAt !== undefined) song.created = createdAt;

    if (playCount !== undefined && playCount > 0) song.playCount = playCount;

    return song;
}
