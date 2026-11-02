// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    createMusicEmbeddingText,
    type MusicTrackMetadata,
} from './music-embedding-text-formatter.js';

// Minimal valid track for use as a base in tests
const baseTrack: MusicTrackMetadata = {
    title: 'Breathe',
    artist: 'Pink Harbor',
};

describe('music-embedding-text-formatter', () => {
    // -------------------------------------------------------------------------
    // createMusicEmbeddingText — complete track
    // -------------------------------------------------------------------------
    describe('createMusicEmbeddingText — complete track', () => {
        it('includes a real artist', () => {
            const text = createMusicEmbeddingText(baseTrack);
            expect(text).toContain('Artist: Pink Harbor');
        });

        it('returns a string ending with a period', () => {
            const text = createMusicEmbeddingText(baseTrack);
            expect(text.endsWith('.')).toBe(true);
        });

        it('formats a complete track with all fields', () => {
            const track: MusicTrackMetadata = {
                title: 'Comfortably Numb',
                artist: 'Pink Harbor',
                albumArtist: 'Pink Harbor',
                album: 'The Wall',
                genre: ['Progressive Rock', 'Lanternlight Rock'],
                year: 1979,
                bpm: 63,
                key: 'Bm',
                energy: 0.45,
                danceability: 0.25,
                moodTags: ['melancholic', 'introspective'],
                relatedArtists: ['Roger Waters', 'David Gilmour'],
            };
            const text = createMusicEmbeddingText(track);

            expect(text).toContain('Genre: Progressive Rock, Lanternlight Rock');
            expect(text).toContain('Style: Progressive Rock, Lanternlight Rock');
            expect(text).toContain('Mood: melancholic, introspective');
            expect(text).toContain('Artist: Pink Harbor');
            expect(text).toContain('Album: The Wall');
            expect(text).toContain('Era: 1970s');
            expect(text).toContain('Key: Bm');
            expect(text).toContain('Similar to: Roger Waters, David Gilmour');
        });

        it('does not repeat albumArtist when it matches artist', () => {
            const track: MusicTrackMetadata = {
                title: 'Money',
                artist: 'Pink Harbor',
                albumArtist: 'Pink Harbor',
            };
            const text = createMusicEmbeddingText(track);
            // albumArtist section should not appear when equal to artist
            expect(text).not.toContain('Album Artist:');
        });

        it('includes albumArtist when it differs from artist', () => {
            const track: MusicTrackMetadata = {
                title: 'Yesterday',
                artist: 'Paul McCartney',
                albumArtist: 'The Lanterns',
            };
            const text = createMusicEmbeddingText(track);
            expect(text).toContain('Album Artist: The Lanterns');
        });

        it('keeps the real track artist on a "Various Artists" album', () => {
            const track: MusicTrackMetadata = {
                title: 'Heroes',
                artist: 'David Linden',
                albumArtist: 'Various Artists',
            };
            const text = createMusicEmbeddingText(track);
            // Track-level artist survives; the VA marker must not poison the vector.
            expect(text).toContain('Artist: David Linden');
            expect(text).not.toContain('Various Artists');
            expect(text).not.toContain('Album Artist:');
        });

        it('drops the artist line entirely when the track artist is itself VA', () => {
            const track: MusicTrackMetadata = {
                title: 'Mystery Cut',
                artist: 'Various Artists',
            };
            const text = createMusicEmbeddingText(track);
            expect(text).not.toContain('Various Artists');
            expect(text).not.toContain('Artist:');
        });

        it('treats "VA" alias the same as "Various Artists"', () => {
            const track: MusicTrackMetadata = {
                title: 'Some Track',
                artist: 'Real Artist',
                albumArtist: 'VA',
            };
            const text = createMusicEmbeddingText(track);
            expect(text).toContain('Artist: Real Artist');
            expect(text).not.toContain('Album Artist:');
        });
    });

    // -------------------------------------------------------------------------
    // createMusicEmbeddingText — missing optional fields
    // -------------------------------------------------------------------------
    describe('createMusicEmbeddingText — missing optional fields', () => {
        it('omits Genre/Style when genre is undefined', () => {
            const text = createMusicEmbeddingText(baseTrack);
            expect(text).not.toContain('Genre:');
            expect(text).not.toContain('Style:');
        });

        it('omits Genre/Style when genre array is empty', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, genre: [] });
            expect(text).not.toContain('Genre:');
        });

        it('omits Mood when moodTags is undefined', () => {
            const text = createMusicEmbeddingText(baseTrack);
            expect(text).not.toContain('Mood:');
        });

        it('omits Mood when moodTags array is empty', () => {
            const text = createMusicEmbeddingText({
                ...baseTrack,
                moodTags: [],
            });
            expect(text).not.toContain('Mood:');
        });

        it('omits Album when album is undefined', () => {
            const text = createMusicEmbeddingText(baseTrack);
            expect(text).not.toContain('Album:');
        });

        it('omits Era when year is undefined', () => {
            const text = createMusicEmbeddingText(baseTrack);
            expect(text).not.toContain('Era:');
        });

        it('omits Energy when energy is undefined', () => {
            const text = createMusicEmbeddingText(baseTrack);
            expect(text).not.toContain('Energy:');
        });

        it('omits Danceability when danceability is undefined', () => {
            const text = createMusicEmbeddingText(baseTrack);
            expect(text).not.toContain('Danceability:');
        });

        it('omits Tempo when bpm is undefined', () => {
            const text = createMusicEmbeddingText(baseTrack);
            expect(text).not.toContain('Tempo:');
        });

        it('omits Key when key is undefined', () => {
            const text = createMusicEmbeddingText(baseTrack);
            expect(text).not.toContain('Key:');
        });

        it('omits Similar to when relatedArtists is undefined', () => {
            const text = createMusicEmbeddingText(baseTrack);
            expect(text).not.toContain('Similar to:');
        });

        it('omits Similar to when relatedArtists is empty', () => {
            const text = createMusicEmbeddingText({
                ...baseTrack,
                relatedArtists: [],
            });
            expect(text).not.toContain('Similar to:');
        });
    });

    // -------------------------------------------------------------------------
    // BPM bucket labels — boundary conditions
    // -------------------------------------------------------------------------
    describe('BPM bucket labels', () => {
        it('bpm=79 → slow tempo', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, bpm: 79 });
            expect(text).toContain('slow tempo, ballad pace');
        });

        it('bpm=80 → medium tempo (lower boundary)', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, bpm: 80 });
            expect(text).toContain('medium tempo, walking pace');
        });

        it('bpm=90 → medium tempo', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, bpm: 90 });
            expect(text).toContain('medium tempo, walking pace');
        });

        it('bpm=109 → medium tempo (upper boundary)', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, bpm: 109 });
            expect(text).toContain('medium tempo, walking pace');
        });

        it('bpm=110 → uptempo (lower boundary)', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, bpm: 110 });
            expect(text).toContain('uptempo, energetic pace');
        });

        it('bpm=128 → uptempo', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, bpm: 128 });
            expect(text).toContain('uptempo, energetic pace');
        });

        it('bpm=139 → uptempo (upper boundary)', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, bpm: 139 });
            expect(text).toContain('uptempo, energetic pace');
        });

        it('bpm=140 → fast tempo (lower boundary)', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, bpm: 140 });
            expect(text).toContain('fast tempo, high energy');
        });

        it('bpm=180 → fast tempo', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, bpm: 180 });
            expect(text).toContain('fast tempo, high energy');
        });
    });

    // -------------------------------------------------------------------------
    // Decade bucket labels — boundary conditions
    // -------------------------------------------------------------------------
    describe('decade bucket labels', () => {
        it('year=1959 → Pre-1960s classics', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, year: 1959 });
            expect(text).toContain('Pre-1960s classics');
        });

        it('year=1960 → 1960s (lower boundary)', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, year: 1960 });
            expect(text).toContain('Era: 1960s');
        });

        it('year=1969 → 1960s (upper boundary)', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, year: 1969 });
            expect(text).toContain('Era: 1960s');
        });

        it('year=1970 → 1970s', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, year: 1970 });
            expect(text).toContain('Era: 1970s');
        });

        it('year=1989 → 1980s', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, year: 1989 });
            expect(text).toContain('Era: 1980s');
        });

        it('year=1995 → 1990s', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, year: 1995 });
            expect(text).toContain('Era: 1990s');
        });

        it('year=2005 → 2000s', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, year: 2005 });
            expect(text).toContain('Era: 2000s');
        });

        it('year=2015 → 2010s', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, year: 2015 });
            expect(text).toContain('Era: 2010s');
        });

        it('year=2020 → 2020s (lower boundary)', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, year: 2020 });
            expect(text).toContain('Era: 2020s');
        });

        it('year=2025 → 2020s', () => {
            const text = createMusicEmbeddingText({ ...baseTrack, year: 2025 });
            expect(text).toContain('Era: 2020s');
        });
    });

    // -------------------------------------------------------------------------
    // Energy bucket labels — boundary conditions
    // -------------------------------------------------------------------------
    describe('energy bucket labels', () => {
        it('energy=0.0 → low energy', () => {
            const text = createMusicEmbeddingText({
                ...baseTrack,
                energy: 0.0,
            });
            expect(text).toContain('low energy, calm, ambient');
        });

        it('energy=0.29 → low energy (upper boundary)', () => {
            const text = createMusicEmbeddingText({
                ...baseTrack,
                energy: 0.29,
            });
            expect(text).toContain('low energy, calm, ambient');
        });

        it('energy=0.3 → medium energy (lower boundary)', () => {
            const text = createMusicEmbeddingText({
                ...baseTrack,
                energy: 0.3,
            });
            expect(text).toContain('medium energy, moderate');
        });

        it('energy=0.59 → medium energy (upper boundary)', () => {
            const text = createMusicEmbeddingText({
                ...baseTrack,
                energy: 0.59,
            });
            expect(text).toContain('medium energy, moderate');
        });

        it('energy=0.6 → high energy (lower boundary)', () => {
            const text = createMusicEmbeddingText({
                ...baseTrack,
                energy: 0.6,
            });
            expect(text).toContain('high energy, intense, powerful');
        });

        it('energy=1.0 → high energy', () => {
            const text = createMusicEmbeddingText({
                ...baseTrack,
                energy: 1.0,
            });
            expect(text).toContain('high energy, intense, powerful');
        });
    });

    // -------------------------------------------------------------------------
    // Danceability bucket labels — boundary conditions
    // -------------------------------------------------------------------------
    describe('danceability bucket labels', () => {
        it('danceability=0.0 → not danceable', () => {
            const text = createMusicEmbeddingText({
                ...baseTrack,
                danceability: 0.0,
            });
            expect(text).toContain('not danceable, contemplative');
        });

        it('danceability=0.29 → not danceable (upper boundary)', () => {
            const text = createMusicEmbeddingText({
                ...baseTrack,
                danceability: 0.29,
            });
            expect(text).toContain('not danceable, contemplative');
        });

        it('danceability=0.3 → moderately danceable (lower boundary)', () => {
            const text = createMusicEmbeddingText({
                ...baseTrack,
                danceability: 0.3,
            });
            expect(text).toContain('moderately danceable, rhythmic');
        });

        it('danceability=0.59 → moderately danceable (upper boundary)', () => {
            const text = createMusicEmbeddingText({
                ...baseTrack,
                danceability: 0.59,
            });
            expect(text).toContain('moderately danceable, rhythmic');
        });

        it('danceability=0.6 → highly danceable (lower boundary)', () => {
            const text = createMusicEmbeddingText({
                ...baseTrack,
                danceability: 0.6,
            });
            expect(text).toContain('highly danceable, groovy, club');
        });

        it('danceability=1.0 → highly danceable', () => {
            const text = createMusicEmbeddingText({
                ...baseTrack,
                danceability: 1.0,
            });
            expect(text).toContain('highly danceable, groovy, club');
        });
    });

    // -------------------------------------------------------------------------
    // relatedArtists — capped at 5
    // -------------------------------------------------------------------------
    describe('relatedArtists', () => {
        it('includes up to 5 related artists', () => {
            const related = ['A', 'B', 'C', 'D', 'E'];
            const text = createMusicEmbeddingText({
                ...baseTrack,
                relatedArtists: related,
            });
            expect(text).toContain('Similar to: A, B, C, D, E');
        });

        it('truncates related artists list to 5 when more are provided', () => {
            const related = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta', 'Eta'];
            const text = createMusicEmbeddingText({
                ...baseTrack,
                relatedArtists: related,
            });
            expect(text).toContain('Similar to: Alpha, Beta, Gamma, Delta, Epsilon');
            // Zeta and Eta are beyond the 5-item cap
            expect(text).not.toContain('Zeta');
            expect(text).not.toContain('Eta');
        });

        it('includes a single related artist without trailing comma', () => {
            const text = createMusicEmbeddingText({
                ...baseTrack,
                relatedArtists: ['Roger Waters'],
            });
            expect(text).toContain('Similar to: Roger Waters');
        });
    });

    // -------------------------------------------------------------------------
    // Genre — appears twice (Genre + Style)
    // -------------------------------------------------------------------------
    describe('genre duplication', () => {
        it('emits genre content under both Genre and Style labels', () => {
            const text = createMusicEmbeddingText({
                ...baseTrack,
                genre: ['Jazz', 'Fusion'],
            });
            expect(text).toContain('Genre: Jazz, Fusion');
            expect(text).toContain('Style: Jazz, Fusion');
        });
    });
});
