// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { artistEnrichmentDisplay, discogsCatalogueUrl, discogsCredits } from './music-provenance';
import { toArtist, toAlbum } from '$lib/server/services/music/track-projection';

describe('music provenance', () => {
    it.each([null, 0, -1, 1.5, '42evil', '0', '01', Number.MAX_SAFE_INTEGER + 1])(
        'rejects invalid catalogue id %s',
        (id) => {
            expect(discogsCatalogueUrl('artist', id)).toBeNull();
        },
    );
    it('constructs canonical item links', () => {
        expect(discogsCatalogueUrl('release', 42)).toBe('https://www.discogs.com/release/42');
    });
    it('filters historical, overridden and unsafe source values and groups links', () => {
        const source = { provider: 'discogs', url: 'https://www.discogs.com/artist/42' };
        const meta = {
            artist_enrichment: {
                provenance: {
                    poster: { ...source, value: 'photo' },
                    biography: { ...source, value: 'bio' },
                    genre: { ...source, value: 'rock', url: 'javascript:alert(1)' },
                },
            },
        };
        expect(discogsCredits({}, 'artist_enrichment', { poster: 'photo' })).toEqual([]);
        expect(
            discogsCredits(meta, 'artist_enrichment', {
                poster: 'photo',
                biography: 'bio',
                genre: 'rock',
            }),
        ).toEqual([source.url]);
        expect(
            discogsCredits(meta, 'artist_enrichment', { poster: 'uploaded', biography: 'edited' }),
        ).toEqual([]);
    });
    it('keeps curated values ahead of namespace values', () => {
        const meta = {
            genre: ['Jazz'],
            artist_enrichment: { biography: 'plugin bio', genre: 'Rock' },
        };
        expect(artistEnrichmentDisplay(meta, 'curated bio')).toEqual({
            biography: 'curated bio',
            genres: ['Jazz'],
            creditedGenre: null,
            creditedBiography: null,
        });
    });
    it('projects biography without exposing namespace provenance at the API boundary', () => {
        const data = {
            id: 'id',
            title: 'Artist',
            overview: null,
            custom_poster_url: null,
            custom_backdrop_url: null,
            custom_metadata: {
                artist_enrichment: {
                    biography: 'bio',
                    provenance: {
                        biography: {
                            provider: 'discogs',
                            url: 'https://www.discogs.com/artist/42',
                            value: 'bio',
                        },
                    },
                },
            },
            album_count: 1,
            track_count: 1,
            created_at: '2026-10-09',
        };
        const parsed = toArtist(data, {});
        expect(parsed.biography).toBe('bio');
        expect(parsed.discogsAttribution?.biography).toBe('https://www.discogs.com/artist/42');
        expect(toArtist({ ...data, overview: 'Edited bio' }, {}).discogsAttribution).toBeUndefined();
        expect(parsed).not.toHaveProperty('custom_metadata');
    });
});

it.each([null, '', '  \t\n', 42, {}])(
    'credits the selected fallback for malformed curated values %s',
    (value) => {
        expect(
            artistEnrichmentDisplay(
                {
                    biography: value,
                    genre: value,
                    artist_enrichment: { biography: 'bio', genre: 'Rock' },
                },
                null,
            ),
        ).toEqual({
            biography: 'bio',
            creditedBiography: 'bio',
            genres: ['Rock'],
            creditedGenre: 'Rock',
        });
    },
);
it('does not credit real curated overrides, even when text equals plugin text', () => {
    expect(
        artistEnrichmentDisplay(
            {
                biography: 'bio',
                genre: 'Rock',
                artist_enrichment: { biography: 'bio', genre: 'Rock' },
            },
            null,
        ),
    ).toEqual({ biography: 'bio', creditedBiography: null, genres: ['Rock'], creditedGenre: null });
});
it.each([null, 42, 'old namespace', []])(
    'parses historical malformed optional enrichment %s',
    (namespace) => {
        const parsed = toArtist(
            {
                id: 'id',
                title: 'Artist',
                overview: null,
                custom_poster_url: null,
                custom_backdrop_url: null,
                custom_metadata: {
                    artist_enrichment: namespace,
                    album_enrichment: namespace,
                    biography: 42,
                    country_code: null,
                    genres: null,
                },
                album_count: 0,
                track_count: 0,
                created_at: '2026-10-09',
            },
            {},
        );
        expect(parsed.title).toBe('Artist');
        expect(parsed).not.toHaveProperty('custom_metadata');
    },
);
it('keeps valid fields and provenance when sibling enrichment values are malformed', () => {
    const parsed = toArtist(
        {
            id: 'id',
            title: 'Artist',
            overview: null,
            custom_poster_url: null,
            custom_backdrop_url: null,
            custom_metadata: {
                artist_enrichment: {
                    biography: 42,
                    genre: 'Rock',
                    country_code: null,
                    provenance: {
                        genre: {
                            provider: 'discogs',
                            value: 'Rock',
                            url: 'https://www.discogs.com/artist/42',
                        },
                    },
                },
            },
            album_count: 0,
            track_count: 0,
            created_at: '2026-10-09',
        },
        {},
    );
    expect(parsed.genres).toEqual(['Rock']);
    expect(parsed.biography).toBeNull();
    expect(parsed).not.toHaveProperty('custom_metadata');
});

it('ignores malformed provenance entries while preserving valid sibling credits', () => {
    const parsed = {
        id: 'id',
        title: 'Artist',
        overview: null,
        custom_poster_url: null,
        custom_backdrop_url: null,
        custom_metadata: {
            artist_enrichment: {
                provenance: {
                    poster: 42,
                    biography: {
                        provider: 'discogs',
                        url: 'https://www.discogs.com/artist/42',
                        value: 'bio',
                    },
                },
            },
        },
        album_count: 0,
        track_count: 0,
        created_at: '2026-10-09',
    };
    expect(
        discogsCredits(parsed.custom_metadata, 'artist_enrichment', {
            biography: 'bio',
            poster: 'photo',
        }),
    ).toEqual(['https://www.discogs.com/artist/42']);
});

it('projects matching album artwork and inherited artist links without stale credits', () => {
    const source = { provider: 'discogs', value: '/image', url: 'https://www.discogs.com/release/42' };
    const row = { id: 'album', title: 'Album', custom_poster_url: '/image',
        custom_metadata: { album_enrichment: { provenance: { poster: source } } } };
    expect(toAlbum(row, {}).discogsAttribution?.poster).toBe(source.url);
    expect(toAlbum({ ...row, custom_poster_url: '/uploaded' }, {}).discogsAttribution).toBeUndefined();
    expect(toAlbum({ ...row, custom_poster_url: null,
        inherited_poster_credit_url: 'https://www.discogs.com/artist/42' }, {
            primary: { href: '/artist-image', source: 'artist', revision: '1' },
        }).discogsAttribution?.poster)
        .toBe('https://www.discogs.com/artist/42');
    expect(toAlbum({ ...row, custom_poster_url: null,
        inherited_poster_credit_url: 'javascript:bad' }, {}).discogsAttribution).toBeUndefined();
});

it('does not credit an artist fallback when the album displays its own provider cover', () => {
    expect(toAlbum({ id: 'album', title: 'Album', inherited_poster_credit_url: 'https://www.discogs.com/artist/42' }, {
        primary: { href: '/album-cover', source: 'provider', revision: '1' },
    }).discogsAttribution).toBeUndefined();
});
