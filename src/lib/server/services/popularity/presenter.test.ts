// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
    attributionForSource,
    buildArtistPopularitySummary,
    buildTrackPopularitySummary,
    lastfmCatalogueUrl,
} from './presenter';

describe('Last.fm catalogue attribution', () => {
    it.each([
        'https://www.last.fm/music/Milo+Fenwick',
        'https://www.last.fm/music/AC%2FDC',
        'https://www.last.fm/music/...And+You+Will+Know+Us+by+the+Trail+of+Dead',
        'https://www.last.fm/music/AC%2FDC/_/Live%2FStudio...version',
        'https://www.last.fm/music/Milo+Fenwick/_/So+What',
    ])('accepts catalogue URL %s', (url) => {
        expect(lastfmCatalogueUrl(url)).toBe(url);
    });
    it.each([
        'http://www.last.fm/music/artist',
        'https://www.last.fm.evil/music/artist',
        'https://evil@www.last.fm/music/artist',
        'https://www.last.fm:8080/music/artist',
        'javascript:alert(1)',
        'https://www.last.fm/user/artist',
        'https://www.last.fm/music/artist/+images',
        'https://www.last.fm/music/artist?next=evil',
        'https://www.last.fm/music/a%5Cb',
        'https://www.last.fm/music/a%2F..%2Fb',
        'https://www.last.fm/music/a/_/%2e%2e',
        'https://www.last.fm/music/a/_/%00',
    ])('rejects unsafe/non-catalogue URL %s', (url) => {
        expect(lastfmCatalogueUrl(url)).toBeNull();
    });
    it('does not mutate shared attribution and leaves local unlinked', () => {
        expect(attributionForSource('lastfm', 'https://www.last.fm/music/Artist').url).toBe(
            'https://www.last.fm/music/Artist',
        );
        expect(attributionForSource('lastfm').url).toBe('https://www.last.fm/');
        expect(attributionForSource('local', 'https://www.last.fm/music/Artist').url).toBe('');
    });
    it('uses readout provider URLs for artist and track summaries', () => {
        const url = 'https://www.last.fm/music/Artist';
        expect(
            buildArtistPopularitySummary(
                {
                    listeners: 4,
                    playcount: 10,
                    score: 50,
                    providerUrl: url,
                    fetchedAt: new Date(),
                    rawMetadata: null,
                },
                'lastfm',
            ).attribution.url,
        ).toBe(url);
        expect(
            buildTrackPopularitySummary(
                {
                    listeners: 4,
                    playcount: 10,
                    score: 50,
                    trackId: 'track',
                    rank: 2,
                    providerUrl: url + '/_/Song',
                },
                'lastfm',
            ).attribution.url,
        ).toBe(url + '/_/Song');
    });
});
