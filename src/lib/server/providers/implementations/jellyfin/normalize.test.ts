// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for jellyfin/normalize.ts.
 *
 * Covers: searchResultToCandidate — basic mapping, externalIds population from
 * ProviderIds, and the absent-ProviderIds omit path.
 */

import { describe, it, expect } from 'vitest';
import { searchResultToCandidate, detailToMetadata } from './normalize.js';

// ---------------------------------------------------------------------------
// searchResultToCandidate
// ---------------------------------------------------------------------------

describe('searchResultToCandidate', () => {
    it('returns null when Id is missing', () => {
        expect(searchResultToCandidate({ Name: 'Test' }, 'movie')).toBeNull();
    });

    it('maps basic fields for a movie item', () => {
        const raw = {
            Id: 'jf-uuid-123',
            Name: 'Intertidal',
            ProductionYear: 2014,
        };
        const candidate = searchResultToCandidate(raw, 'movie');
        expect(candidate).not.toBeNull();
        expect(candidate!.externalId).toBe('jf-uuid-123');
        expect(candidate!.provider).toBe('jellyfin');
        expect(candidate!.title).toBe('Intertidal');
        expect(candidate!.year).toBe(2014);
        expect(candidate!.mediaType).toBe('movie');
        expect(candidate!.confidence).toBe(0.7);
    });

    it('maps mediaType to tv when type param is tv', () => {
        const raw = { Id: 'jf-series-1', Name: 'Drifting Clouds' };
        const candidate = searchResultToCandidate(raw, 'tv');
        expect(candidate!.mediaType).toBe('tv');
    });

    it('populates externalIds from ProviderIds with lowercased keys', () => {
        const raw = {
            Id: 'jf-uuid-456',
            Name: 'Daydream',
            ProductionYear: 2010,
            ProviderIds: {
                Tmdb: '27205',
                Imdb: 'tt1375666',
                Tvdb: '99999',
            },
        };
        const candidate = searchResultToCandidate(raw, 'movie');
        expect(candidate).not.toBeNull();
        expect(candidate!.externalIds).toEqual({
            tmdb: '27205',
            imdb: 'tt1375666',
            tvdb: '99999',
        });
    });

    it('omits externalIds when ProviderIds is absent', () => {
        const raw = { Id: 'jf-uuid-789', Name: 'No Providers' };
        const candidate = searchResultToCandidate(raw, 'movie');
        expect(candidate).not.toBeNull();
        expect(candidate!.externalIds).toBeUndefined();
    });

    it('omits externalIds when ProviderIds is an empty object', () => {
        const raw = { Id: 'jf-uuid-000', Name: 'Empty Providers', ProviderIds: {} };
        const candidate = searchResultToCandidate(raw, 'movie');
        expect(candidate!.externalIds).toBeUndefined();
    });

    it('skips ProviderIds entries with non-string or empty values', () => {
        const raw = {
            Id: 'jf-uuid-abc',
            Name: 'Mixed Providers',
            ProviderIds: {
                Tmdb: '12345',
                Imdb: '',
                Tvdb: null as unknown as string,
            },
        };
        const candidate = searchResultToCandidate(raw, 'movie');
        expect(candidate!.externalIds).toEqual({ tmdb: '12345' });
    });
});

// ---------------------------------------------------------------------------
// detailToMetadata — basic smoke test (detailed coverage in other tests)
// ---------------------------------------------------------------------------

describe('detailToMetadata', () => {
    it('returns null when Name is missing', () => {
        expect(detailToMetadata({ Id: 'x' }, 'movie')).toBeNull();
    });

    it('maps ProviderIds to externalIds unchanged (no lowercasing in detail)', () => {
        const raw = {
            Name: 'Quiet Orbit',
            ProviderIds: { Tmdb: '550', Imdb: 'tt0137523' },
        };
        const metadata = detailToMetadata(raw, 'movie');
        expect(metadata).not.toBeNull();
        // detailToMetadata forwards ProviderIds as-is (no key transformation)
        expect(metadata!.externalIds).toEqual({ Tmdb: '550', Imdb: 'tt0137523' });
    });
});

// ---------------------------------------------------------------------------
// OfficialRating -> certification (national age rating)
// ---------------------------------------------------------------------------

describe('Jellyfin OfficialRating', () => {
    it('is carried on the search candidate and the detail metadata', () => {
        const raw = { Id: 'jf-1', Name: 'Intertidal', OfficialRating: 'FSK-12' };
        expect(searchResultToCandidate(raw, 'movie')?.certification).toBe('FSK-12');
        expect(detailToMetadata(raw, 'movie')?.certification).toBe('FSK-12');
    });

    it('is omitted when Jellyfin has none', () => {
        const raw = { Id: 'jf-1', Name: 'Intertidal' };
        expect(searchResultToCandidate(raw, 'movie')).not.toHaveProperty('certification');
        expect(detailToMetadata(raw, 'movie')?.certification).toBeUndefined();
    });
});
