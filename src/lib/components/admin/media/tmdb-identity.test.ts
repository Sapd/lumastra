// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { tmdbIdentityUrl } from './tmdb-identity.js';
it('constructs only complete typed identities, including specials season zero', () => {
    expect(tmdbIdentityUrl('tv', 123)).toBe('https://www.themoviedb.org/tv/123');
    expect(tmdbIdentityUrl('movie', '123')).toBe('https://www.themoviedb.org/movie/123');
    expect(tmdbIdentityUrl('series', 123)).toBe('https://www.themoviedb.org/tv/123');
    expect(tmdbIdentityUrl('season', 999, { seriesTmdbId: 123, seasonNumber: 0 })).toBe(
        'https://www.themoviedb.org/tv/123/season/0',
    );
    expect(
        tmdbIdentityUrl('episode', 999, { seriesTmdbId: 123, seasonNumber: 1, episodeNumber: 2 }),
    ).toBe('https://www.themoviedb.org/tv/123/season/1/episode/2');
    for (const type of ['track', 'artist', 'album', 'unknown'])
        expect(tmdbIdentityUrl(type, 123)).toBeNull();
    expect(tmdbIdentityUrl('episode', 123, { seriesTmdbId: 123, seasonNumber: 1 })).toBeNull();
    expect(tmdbIdentityUrl('season', 123, { seasonNumber: 1 })).toBeNull();
    expect(
        tmdbIdentityUrl('episode', 123, { seriesTmdbId: 123, seasonNumber: 1, episodeNumber: 0 }),
    ).toBeNull();
});
