// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Music-specific embedding text formatter.
 * Generates text optimized for embedding similarity search of music tracks.
 */

import { isVariousArtistsName } from '../utils/music-scanner-utils.js';

export interface MusicTrackMetadata {
    title: string;
    artist: string;
    albumArtist?: string;
    album?: string;
    genre?: string[];
    year?: number;
    bpm?: number;
    key?: string;
    energy?: number;
    danceability?: number;
    moodTags?: string[];
    relatedArtists?: string[];
    /**
     * Provider-sourced artist tags (e.g. Last.fm community tags like 'indie',
     * 'dream pop', 'shoegaze'). Distinct from `genre` which is typically
     * authored on the release, and from `moodTags` which describe emotion.
     */
    artistTags?: string[];
}

/**
 * Create embedding text for a music track.
 *
 * The text is structured to capture musical similarity:
 * - Genre and subgenre are highest-weight signals
 * - Mood tags for emotional similarity
 * - Artist for "more like this" recommendations
 * - Decade bucket for era similarity
 * - Energy/danceability buckets for activity-based matching
 * - BPM range bucket for DJ transitions
 * - Key for harmonic compatibility
 */
export function createMusicEmbeddingText(track: MusicTrackMetadata): string {
    const parts: string[] = [];

    // Genre (highest weight — repeat for emphasis)
    if (track.genre?.length) {
        parts.push(`Genre: ${track.genre.join(', ')}`);
        parts.push(`Style: ${track.genre.join(', ')}`);
    }

    // Mood tags
    if (track.moodTags?.length) {
        parts.push(`Mood: ${track.moodTags.join(', ')}`);
    }

    // Artist — skip the "Various Artists" marker so compilation tracks don't
    // cluster together on a literal token instead of musical similarity. When
    // the per-track artist tag IS "Various Artists" (no real artist available)
    // the artist line is dropped entirely; the vector then falls back to
    // genre/mood/era/tempo signals, which is what we want.
    const trackArtistIsVA = isVariousArtistsName(track.artist);
    if (!trackArtistIsVA) {
        parts.push(`Artist: ${track.artist}`);
    }
    if (
        track.albumArtist &&
        track.albumArtist !== track.artist &&
        !isVariousArtistsName(track.albumArtist)
    ) {
        parts.push(`Album Artist: ${track.albumArtist}`);
    }

    // Album
    if (track.album) {
        parts.push(`Album: ${track.album}`);
    }

    // Title deliberately excluded — track names like "Moonlight" and "Full Moon"
    // create false similarity clusters based on words rather than musical style.

    // Decade bucket
    if (track.year) {
        const decade = getDecadeBucket(track.year);
        parts.push(`Era: ${decade}`);
    }

    // Energy level bucket
    if (track.energy !== undefined) {
        parts.push(`Energy: ${getEnergyBucket(track.energy)}`);
    }

    // Danceability bucket
    if (track.danceability !== undefined) {
        parts.push(`Danceability: ${getDanceabilityBucket(track.danceability)}`);
    }

    // BPM range bucket
    if (track.bpm) {
        parts.push(`Tempo: ${getBpmBucket(track.bpm)}`);
    }

    // Key
    if (track.key) {
        parts.push(`Key: ${track.key}`);
    }

    // Related artists
    if (track.relatedArtists?.length) {
        parts.push(`Similar to: ${track.relatedArtists.slice(0, 5).join(', ')}`);
    }

    // Provider artist tags (Last.fm style — top 8 is a sensible cap:
    // more than that is noise and dilutes the vector)
    if (track.artistTags?.length) {
        parts.push(`Tags: ${track.artistTags.slice(0, 8).join(', ')}`);
    }

    return parts.join('. ') + '.';
}

function getDecadeBucket(year: number): string {
    if (year < 1960) return 'Pre-1960s classics';
    if (year < 1970) return '1960s';
    if (year < 1980) return '1970s';
    if (year < 1990) return '1980s';
    if (year < 2000) return '1990s';
    if (year < 2010) return '2000s';
    if (year < 2020) return '2010s';
    return '2020s';
}

function getEnergyBucket(energy: number): string {
    if (energy < 0.3) return 'low energy, calm, ambient';
    if (energy < 0.6) return 'medium energy, moderate';
    return 'high energy, intense, powerful';
}

function getDanceabilityBucket(danceability: number): string {
    if (danceability < 0.3) return 'not danceable, contemplative';
    if (danceability < 0.6) return 'moderately danceable, rhythmic';
    return 'highly danceable, groovy, club';
}

function getBpmBucket(bpm: number): string {
    if (bpm < 80) return 'slow tempo, ballad pace';
    if (bpm < 110) return 'medium tempo, walking pace';
    if (bpm < 140) return 'uptempo, energetic pace';
    return 'fast tempo, high energy';
}
