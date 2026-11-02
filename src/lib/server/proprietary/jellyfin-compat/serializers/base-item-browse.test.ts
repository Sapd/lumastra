// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, it, expect } from 'vitest';
import { mapJellyfinTypes } from '$lib/server/database/queries/jellyfin-browse.queries';

describe('mapJellyfinTypes', () => {
    it('maps single type Movie to movie', () => {
        expect(mapJellyfinTypes('Movie')).toEqual(['movie']);
    });

    it('maps multiple types comma-separated', () => {
        expect(mapJellyfinTypes('Movie,Series')).toEqual(['movie', 'tv']);
    });

    it('lowercases unknown types', () => {
        expect(mapJellyfinTypes('Foo')).toEqual(['foo']);
    });

    it('maps mixed known and audio types', () => {
        expect(mapJellyfinTypes('Movie,Episode,Audio')).toEqual(['movie', 'episode', 'track']);
    });

    it('maps Series to tv', () => {
        expect(mapJellyfinTypes('Series')).toEqual(['tv']);
    });

    it('maps Episode to episode', () => {
        expect(mapJellyfinTypes('Episode')).toEqual(['episode']);
    });

    it('maps Season to season', () => {
        expect(mapJellyfinTypes('Season')).toEqual(['season']);
    });

    it('maps MusicAlbum to album', () => {
        expect(mapJellyfinTypes('MusicAlbum')).toEqual(['album']);
    });

    it('maps MusicArtist to artist', () => {
        expect(mapJellyfinTypes('MusicArtist')).toEqual(['artist']);
    });

    it('trims whitespace around types', () => {
        expect(mapJellyfinTypes('Movie, Series')).toEqual(['movie', 'tv']);
    });
});
