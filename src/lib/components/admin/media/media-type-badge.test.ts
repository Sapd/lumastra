// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, it, expect } from 'vitest';
import { getLocale, overwriteGetLocale } from '$lib/paraglide/runtime.js';
const originalGetLocale = getLocale;
import { mediaTypeLabel } from '../library/library-labels';
afterEach(() => overwriteGetLocale(originalGetLocale));
import { getMediaTypeBadge, getMediaTypeLabel } from './media-type-badge';

describe('getMediaTypeBadge', () => {
    it('returns correct label and class for known types', () => {
        const tv = getMediaTypeBadge('tv');
        expect(tv.label).toBe('Series');
        expect(tv.class).toContain('blue');

        const movie = getMediaTypeBadge('movie');
        expect(movie.label).toBe('Movie');
        expect(movie.class).toContain('purple');

        const episode = getMediaTypeBadge('episode');
        expect(episode.label).toBe('Episode');
        expect(episode.class).toContain('green');

        const season = getMediaTypeBadge('season');
        expect(season.label).toBe('Season');
        expect(season.class).toContain('amber');
    });

    it('returns gray class for unknown types', () => {
        const unknown = getMediaTypeBadge('podcast');
        expect(unknown.class).toContain('gray');
    });

    it('handles extended media types via getMediaTypeDisplay', () => {
        // These types are handled by getMediaTypeDisplay but not by the local switch
        expect(getMediaTypeBadge('audiobook').label).toBe('Audiobook');
        expect(getMediaTypeBadge('manga').label).toBe('Manga');
    });
});

describe('getMediaTypeLabel', () => {
    it('returns display label for known types', () => {
        expect(getMediaTypeLabel('tv')).toBe('Series');
        expect(getMediaTypeLabel('movie')).toBe('Movie');
        expect(getMediaTypeLabel('episode')).toBe('Episode');
        expect(getMediaTypeLabel('season')).toBe('Season');
    });

    it('delegates to getMediaTypeDisplay for extended types', () => {
        expect(getMediaTypeLabel('audiobook')).toBe('Audiobook');
        expect(getMediaTypeLabel('book')).toBe('Book');
    });
});

it('localizes admin badges and source-card types in German', () => {
    overwriteGetLocale(() => 'de');
    expect(getMediaTypeLabel('tv')).toBe('Serie');
    expect(getMediaTypeLabel('movie')).toBe('Film');
    expect(getMediaTypeLabel('season')).toBe('Staffel');
    expect(mediaTypeLabel('tv')).toBe('Serien');
    expect(mediaTypeLabel('music')).toBe('Musik');
    expect(mediaTypeLabel('audiobook')).toBe('Hörbuch');
});
