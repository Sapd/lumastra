// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { generateImageUrl } from './provider-image-url';

describe('generateImageUrl', () => {
    it('generates Jellyfin image URLs via catalog proxy', () => {
        expect(generateImageUrl('jellyfin', 'abc123', 'poster')).toBe(
            '/api/media/abc123/images/poster',
        );
        expect(generateImageUrl('jellyfin', 'abc123', 'backdrop')).toBe(
            '/api/media/abc123/images/backdrop',
        );
    });

    it('generates TMDB image URLs with default movie media type', () => {
        expect(generateImageUrl('tmdb', 12345, 'poster')).toBe(
            '/api/image/tmdb:12345:movie/poster',
        );
    });

    it('generates TMDB image URLs with tv media type', () => {
        expect(generateImageUrl('tmdb', 12345, 'poster', 'tv')).toBe(
            '/api/image/tmdb:12345:tv/poster',
        );
    });

    it('generates Audiobookshelf image URLs', () => {
        expect(generateImageUrl('audiobookshelf', 'book123')).toBe('/api/image/audiobook/book123');
    });

    it('generates Radarr image URLs', () => {
        expect(generateImageUrl('radarr', 456, 'poster')).toBe('/api/image/radarr/456/poster');
    });

    it('defaults to poster type', () => {
        expect(generateImageUrl('jellyfin', 'abc')).toBe('/api/media/abc/images/poster');
    });
});
