// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { fileName, mediaTypeLabel } from './fix-matches-format.js';

describe('mediaTypeLabel', () => {
    it('uses one label per kind, never the internal "tv"', () => {
        expect(mediaTypeLabel('tv')).toBe('Series');
        expect(mediaTypeLabel('series')).toBe('Series');
        expect(mediaTypeLabel('movie')).toBe('Movie');
        expect(mediaTypeLabel('season')).toBe('Season');
        expect(mediaTypeLabel('episode')).toBe('Episode');
    });

    it('capitalises unknown kinds', () => {
        expect(mediaTypeLabel('home_video')).toBe('Home video');
    });
});

describe('fileName', () => {
    it('returns the last path segment', () => {
        expect(fileName('/data/movies/HDR Test/clip.mp4')).toBe('clip.mp4');
        expect(fileName('C:\\media\\a.mkv')).toBe('a.mkv');
        expect(fileName('plain.mkv')).toBe('plain.mkv');
    });
});
