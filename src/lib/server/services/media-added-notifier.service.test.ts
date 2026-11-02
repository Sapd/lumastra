// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { mediaTypeCategory } from './media-added-notifier.service.js';

describe('mediaTypeCategory', () => {
    it('maps DB media types to the four notifiable categories', () => {
        expect(mediaTypeCategory('MOVIE')).toBe('movie');
        expect(mediaTypeCategory('Series')).toBe('series');
        expect(mediaTypeCategory('episode')).toBe('episode');
        expect(mediaTypeCategory('ALBUM')).toBe('album');
    });
    it('suppresses container / over-granular types', () => {
        expect(mediaTypeCategory('SEASON')).toBeNull();
        expect(mediaTypeCategory('ARTIST')).toBeNull();
        expect(mediaTypeCategory('TRACK')).toBeNull();
    });
});
