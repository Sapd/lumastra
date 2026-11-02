// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { musicSearchRowToTrack, type MusicSearchRow } from './music-track-mapper.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';

const IMAGES: ImageSet = {};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<MusicSearchRow> = {}): MusicSearchRow {
    return {
        custom_poster_url: '/cover.jpg',
        media_id: 'aaaaaaaa-0000-0000-0000-000000000001',
        title: 'Test Track',
        custom_metadata: {},
        runtime_seconds: 210,
        artist_title: 'Test Artist',
        album_id: 'aaaaaaaa-0000-0000-0000-000000000002',
        album_title: 'Test Album',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('musicSearchRowToTrack', () => {
    it('maps a basic row with no essentia data', () => {
        const row = makeRow();
        const track = musicSearchRowToTrack(row, IMAGES);

        expect(track.id).toBe(row.media_id);
        expect(track.title).toBe('Test Track');
        expect(track.type).toBe('track');
        expect(track.artists[0]?.title).toBe('Test Artist');
        expect(track.album?.title).toBe('Test Album');
        expect(track.durationMs).toBe(210000);
        expect(track.album?.id).toBe('aaaaaaaa-0000-0000-0000-000000000002');
        expect(track.audioFeatures).toBeUndefined();
    });

    it('populates audioFeatures when essentia data is present', () => {
        const row = makeRow({
            custom_metadata: {
                essentia: {
                    bpm: 128,
                    key: 'C major',
                    energy: 0.85,
                    danceability: 0.72,
                    loudness_lufs: -9.5,
                    outro_start_ms: 195000,
                    mood_tags: ['energetic', 'upbeat'],
                },
            },
        });
        const track = musicSearchRowToTrack(row, IMAGES);

        expect(track.audioFeatures).toBeDefined();
        expect(track.audioFeatures?.bpm).toBe(128);
        expect(track.audioFeatures?.key).toBe('C major');
        expect(track.audioFeatures?.energy).toBe(0.85);
        expect(track.audioFeatures?.danceability).toBe(0.72);
        expect(track.audioFeatures?.loudnessLufs).toBe(-9.5);
        expect(track.audioFeatures?.outroStartMs).toBe(195000);
        expect(track.audioFeatures?.moodTags).toEqual(['energetic', 'upbeat']);
    });

    it('leaves audioFeatures undefined when essentia object has none of the trigger fields', () => {
        const row = makeRow({
            custom_metadata: {
                essentia: {
                    some_other_field: 'value',
                },
            },
        });
        const track = musicSearchRowToTrack(row, IMAGES);
        expect(track.audioFeatures).toBeUndefined();
    });

    it('returns audioFeatures when only one trigger field is present (bpm)', () => {
        const row = makeRow({
            custom_metadata: {
                essentia: { bpm: 100 },
            },
        });
        const track = musicSearchRowToTrack(row, IMAGES);
        expect(track.audioFeatures).toBeDefined();
        expect(track.audioFeatures?.bpm).toBe(100);
        expect(track.audioFeatures?.key).toBeUndefined();
    });

    it('uses metadata.artist fallback when artist_title is null', () => {
        const row = makeRow({
            artist_title: null,
            custom_metadata: { artist: 'Metadata Artist' },
        });
        expect(musicSearchRowToTrack(row, IMAGES).artists[0]?.title).toBe('Metadata Artist');
    });

    it('uses metadata.album_artist fallback when artist_title and metadata.artist are both absent', () => {
        const row = makeRow({
            artist_title: null,
            custom_metadata: { album_artist: 'Album Artist' },
        });
        expect(musicSearchRowToTrack(row, IMAGES).artists[0]?.title).toBe('Album Artist');
    });

    it('falls back to "Unknown Artist" when all artist sources are absent', () => {
        const row = makeRow({ artist_title: null, custom_metadata: {} });
        expect(musicSearchRowToTrack(row, IMAGES).artists[0]?.title).toBe('Unknown Artist');
    });

    it('uses metadata.album fallback when album_title is null', () => {
        const row = makeRow({
            album_title: null,
            custom_metadata: { album: 'Meta Album' },
        });
        expect(musicSearchRowToTrack(row, IMAGES).album?.title).toBe('Meta Album');
    });

    it('does not include a coverArtUrl field (image resolution is caller responsibility)', () => {
        const row = makeRow();
        const track = musicSearchRowToTrack(row, IMAGES);
        expect((track as Record<string, unknown>).coverArtUrl).toBeUndefined();
        expect(track.images).toBe(IMAGES);
        expect(track.images.primary).toBeUndefined();
    });

    it('sets duration to undefined when runtime_seconds is null', () => {
        const row = makeRow({ runtime_seconds: null });
        expect(musicSearchRowToTrack(row, IMAGES).durationMs).toBeNull();
    });

    it('omits an album reference when album_id is null', () => {
        const row = makeRow({ album_id: null });
        expect(musicSearchRowToTrack(row, IMAGES).album?.id).toBeUndefined();
    });

    it('filters non-string values from mood_tags array', () => {
        const row = makeRow({
            custom_metadata: {
                essentia: {
                    mood_tags: ['happy', 42, null, 'sad', true],
                },
            },
        });
        const track = musicSearchRowToTrack(row, IMAGES);
        expect(track.audioFeatures?.moodTags).toEqual(['happy', 'sad']);
    });

    it('ignores essentia if it is an array (not an object)', () => {
        const row = makeRow({
            custom_metadata: {
                essentia: ['not', 'an', 'object'],
            },
        });
        const track = musicSearchRowToTrack(row, IMAGES);
        expect(track.audioFeatures).toBeUndefined();
    });
});
