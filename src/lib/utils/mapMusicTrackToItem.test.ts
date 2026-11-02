// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { musicTrackFromCard } from '$lib/utils/music-track';

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { MusicTrack } from '$lib/schemas/music';

const SENTINEL_IMAGE = '/api/image/catalog/MOCK/thumb';

vi.mock('$lib/utils/image-utils', () => ({
    getCatalogPosterUrl: vi.fn((_id: string, _opts?: { size?: string }) => SENTINEL_IMAGE),
}));

// Import after mock is registered
const { mapMusicTrackToItem, buildMusicCardItem } = await import('./mapMusicTrackToItem.js');
const { getCatalogPosterUrl } = await import('$lib/utils/image-utils');

const mockCatalogPosterUrl = getCatalogPosterUrl as ReturnType<typeof vi.fn>;

const baseTrack: MusicTrack = musicTrackFromCard({
    id: 'abc-123',
    title: 'Test Song',
    artists: [{ id: null, title: 'Test Artist' }],
    type: 'track',
});

describe('mapMusicTrackToItem', () => {
    it('keeps title remixer identities separate from the performer subtitle and target', () => {
        const item = mapMusicTrackToItem({
            ...baseTrack,
            artists: [{ id: 'performer', title: 'Northlight' }],
            remixerArtists: [{ id: 'remixer', title: 'Ekoglow' }],
        });
        expect(item.subtitle).toBe('Northlight');
        expect(item.clickData?.artistId).toBe('performer');
        expect(item.artists).toEqual([{ id: 'performer', title: 'Northlight' }]);
        expect(item.remixerArtists).toEqual([{ id: 'remixer', title: 'Ekoglow' }]);
    });

    beforeEach(() => {
        mockCatalogPosterUrl.mockClear();
    });

    it('keeps playable UUID and separate search presentation key', () => {
        const item = mapMusicTrackToItem(baseTrack);
        expect(item.id).toBe('abc-123');
        expect(item.itemKey).toBe('search-abc-123');
    });

    it('leaves externalIds empty', () => {
        const item = mapMusicTrackToItem(baseTrack);
        expect(item.externalIds).toEqual({});
    });

    it('sets mediaType to track', () => {
        const item = mapMusicTrackToItem(baseTrack);
        expect(item.mediaType).toBe('track');
    });

    it('sets title from track', () => {
        const item = mapMusicTrackToItem(baseTrack);
        expect(item.title).toBe('Test Song');
    });

    it('sets subtitle and overview to artist', () => {
        const item = mapMusicTrackToItem(baseTrack);
        expect(item.subtitle).toBe('Test Artist');
        expect(item.overview).toBe('Test Artist');
    });

    it('calls getCatalogPosterUrl with the track id and thumb size', () => {
        mapMusicTrackToItem(baseTrack);
        expect(mockCatalogPosterUrl).toHaveBeenCalledOnce();
        expect(mockCatalogPosterUrl).toHaveBeenCalledWith('abc-123', { size: 'thumb' });
    });

    it('sets image to getCatalogPosterUrl return value', () => {
        const item = mapMusicTrackToItem(baseTrack);
        expect(item.image).toBe(SENTINEL_IMAGE);
    });

    it('sets aspectRatio square, isAvailable true, canRequest false', () => {
        const item = mapMusicTrackToItem(baseTrack);
        expect(item.aspectRatio).toBe('square');
        expect(item.isAvailable).toBe(true);
        expect(item.canRequest).toBe(false);
    });

    it('works with an optional similarityScore field', () => {
        const withScore = { ...baseTrack, similarityScore: 0.87 };
        const item = mapMusicTrackToItem(withScore);
        expect(item.id).toBe('abc-123');
        expect(item.itemKey).toBe('search-abc-123');
    });
});

describe('buildMusicCardItem', () => {
    beforeEach(() => {
        mockCatalogPosterUrl.mockClear();
    });

    it('track input — delegates like mapMusicTrackToItem', () => {
        const item = buildMusicCardItem({
            id: 'abc-123',
            mediaType: 'track',
            title: 'Test Song',
            subtitle: 'Test Artist',
            overview: 'Test Artist',
        });
        expect(item.id).toBe('abc-123');
        expect(item.itemKey).toBe('search-abc-123');
        expect(item.externalIds).toEqual({});
        expect(item.mediaType).toBe('track');
        expect(item.title).toBe('Test Song');
        expect(item.subtitle).toBe('Test Artist');
        expect(item.overview).toBe('Test Artist');
        expect(item.image).toBe(SENTINEL_IMAGE);
        expect(mockCatalogPosterUrl).toHaveBeenCalledWith('abc-123', { size: 'thumb' });
        expect(item.aspectRatio).toBe('square');
        expect(item.isAvailable).toBe(true);
        expect(item.canRequest).toBe(false);
    });

    it('FTS artist input uses the entity UUID for artwork', () => {
        const item = buildMusicCardItem({
            id: 'raw-id',
            mediaType: 'artist',
            title: 'Some Artist',
            subtitle: '2024',
            year: 2024,
            externalIds: { internal: 'uuid-artist', tmdb: 'tmdb-99' },
        });
        expect(item.itemKey).toBe('search-raw-id');
        expect(item.externalIds).toEqual({});
        expect(item.externalIds.tmdb).toBeUndefined();
        expect(item.mediaType).toBe('artist');
        expect(item.subtitle).toBe('2024');
        expect(item.year).toBe(2024);
        // Artwork follows the entity UUID.
        expect(mockCatalogPosterUrl).toHaveBeenCalledWith('raw-id', { size: 'thumb' });
    });

    it('FTS album input keeps provider IDs out of music identity', () => {
        const item = buildMusicCardItem({
            id: 'album-42',
            mediaType: 'album',
            title: 'Great Album',
            subtitle: 'Overview text',
            overview: 'Best Artist',
            externalIds: { tmdb: '42' },
        });
        expect(item.itemKey).toBe('search-album-42');
        expect(item.externalIds).toEqual({});
        expect(item.externalIds.tmdb).toBeUndefined();
        expect(item.mediaType).toBe('album');
        expect(item.overview).toBe('Best Artist');
        expect(mockCatalogPosterUrl).toHaveBeenCalledWith('album-42', { size: 'thumb' });
    });

    it('FTS track input preserves distinct subtitle and overview', () => {
        const item = buildMusicCardItem({
            id: 'track-7',
            mediaType: 'track',
            title: 'Song Name',
            subtitle: 'Album Overview',
            overview: 'Artist Name',
            externalIds: { internal: 'uuid-track-7' },
        });
        expect(item.subtitle).toBe('Album Overview');
        expect(item.overview).toBe('Artist Name');
        expect(item.externalIds).toEqual({});
        expect(mockCatalogPosterUrl).toHaveBeenCalledWith('track-7', { size: 'thumb' });
    });

    it('subtitle defaults to empty string when undefined', () => {
        const item = buildMusicCardItem({ id: 'x', mediaType: 'track', title: 'T' });
        expect(item.subtitle).toBe('');
    });

    it('year is undefined when not provided', () => {
        const item = buildMusicCardItem({ id: 'x', mediaType: 'track', title: 'T' });
        expect(item.year).toBeUndefined();
    });
});
