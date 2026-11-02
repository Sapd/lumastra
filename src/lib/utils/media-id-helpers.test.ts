// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    buildMediaKey,
    createRenderableMediaKeys,
    createExternalIds,
    getBestMediaKey,
    getLocalPreviewId,
    getPlayableId,
    getTmdbIdFromExternalIds,
    hasValidExternalId,
    mediaCompositeKey,
    mergeExternalIds,
} from './media-id-helpers';

describe('media-id-helpers', () => {
    it('buildMediaKey ignores a Jellyfin id (it is not an API id)', () => {
        const key = buildMediaKey(
            {
                imdb: 'tt0137523',
                tmdb: '550',
                jellyfin: 'jf1',
            },
            'movie',
        );
        expect(key).toBe('tmdb:550:movie');
    });

    it('buildMediaKey uses tmdb composite key when no internal ID', () => {
        const key = buildMediaKey(
            {
                imdb: 'tt0137523',
                tmdb: '550',
                tvdb: '123',
            },
            'movie',
        );
        expect(key).toBe('tmdb:550:movie');
    });

    it('buildMediaKey falls back to imdb when tmdb is missing', () => {
        const key = buildMediaKey({ imdb: 'tt0137523' }, 'movie');
        expect(key).toBe('imdb:tt0137523:movie');
    });

    it('mediaCompositeKey uses fallback when no external ids', () => {
        const key = mediaCompositeKey(undefined, 'movie', 'fallback-id');
        expect(key).toBe('fallback:fallback-id:movie');
    });

    it('mediaCompositeKey treats an empty provider id as missing', () => {
        // Catalog rows without a TMDB id arrive as { tmdb: '' } from the
        // onboarding-movies endpoint (COALESCE -> '').
        expect(mediaCompositeKey({ tmdb: '' }, 'movie')).toBe('');
        expect(mediaCompositeKey({ tmdb: '' }, 'movie', 'A Title')).toBe('fallback:A Title:movie');
    });

    it('mediaCompositeKey with title fallback keeps id-less items unique (each-key regression)', () => {
        // Regression for the rating mode crash: multiple library candidates with
        // no external id collapsed to '' as {#each} keys -> each_key_duplicate ->
        // the rating stack never rendered. The title fallback must keep them apart.
        const a = mediaCompositeKey({ tmdb: '' }, 'movie', 'Milo Farrow und ein Stein');
        const b = mediaCompositeKey({ tmdb: '' }, 'movie', 'Milo Farrow und der Plastik Pokal');
        expect(a).not.toBe(b);
        expect(new Set([a, b]).size).toBe(2);
    });

    it('getTmdbIdFromExternalIds parses numeric strings', () => {
        expect(getTmdbIdFromExternalIds({ tmdb: '123' })).toBe(123);
        expect(getTmdbIdFromExternalIds({ tmdb: 'abc' })).toBeUndefined();
    });

    it('createExternalIds normalizes numbers to strings', () => {
        const ids = createExternalIds({ tmdb: 550, tvdb: 42, trakt: 9 });
        expect(ids).toEqual({ tmdb: '550', tvdb: '42', trakt: '9' });
    });

    it('mergeExternalIds prefers override values', () => {
        const merged = mergeExternalIds({ tmdb: '1', imdb: 'tt1' }, { tmdb: '2' });
        expect(merged).toEqual({ tmdb: '2', imdb: 'tt1' });
    });
});

describe('getPlayableId', () => {
    it('never returns a Jellyfin id', () => {
        expect(
            getPlayableId({ externalIds: { jellyfin: 'jf-123' } } as Parameters<
                typeof getPlayableId
            >[0]),
        ).toBeUndefined();
    });

    it('returns externalIds.internal', () => {
        expect(getPlayableId({ externalIds: { internal: 'uuid-456' } })).toBe('uuid-456');
    });

    it('returns undefined when neither exists', () => {
        expect(getPlayableId({})).toBeUndefined();
    });

    it('returns undefined for empty externalIds', () => {
        expect(getPlayableId({ externalIds: {} })).toBeUndefined();
    });

    it('uses externalIds.internal even when a Jellyfin id is present', () => {
        expect(
            getPlayableId({
                externalIds: { jellyfin: 'jf-123', internal: 'uuid-456' },
            } as Parameters<typeof getPlayableId>[0]),
        ).toBe('uuid-456');
    });

    it('returns the raw item id when it is already a UUID', () => {
        expect(
            getPlayableId({
                id: '123e4567-e89b-12d3-a456-426614174000',
            }),
        ).toBe('123e4567-e89b-12d3-a456-426614174000');
    });
});

describe('getLocalPreviewId', () => {
    it('returns externalIds.internal when present', () => {
        expect(
            getLocalPreviewId({
                id: 'not-a-uuid',
                externalIds: {
                    internal: '123e4567-e89b-12d3-a456-426614174000',
                },
            }),
        ).toBe('123e4567-e89b-12d3-a456-426614174000');
    });

    it('falls back to the raw item id when it is already a UUID', () => {
        expect(
            getLocalPreviewId({
                id: '123e4567-e89b-12d3-a456-426614174000',
            }),
        ).toBe('123e4567-e89b-12d3-a456-426614174000');
    });

    it('does not fall back to non-UUID item ids', () => {
        expect(
            getLocalPreviewId({
                id: 'not-a-uuid',
                externalIds: {},
            }),
        ).toBeUndefined();
    });
});

describe('createRenderableMediaKeys', () => {
    it('keeps canonical keys for unique items', () => {
        expect(
            createRenderableMediaKeys([
                {
                    id: 'movie-1',
                    mediaType: 'movie',
                    externalIds: { tmdb: '550' },
                },
                {
                    id: 'show-1',
                    mediaType: 'tv',
                    externalIds: { tmdb: '1399' },
                },
            ]),
        ).toEqual(['tmdb:550:movie', 'tmdb:1399:tv']);
    });

    it('adds duplicate suffixes when the same item appears multiple times', () => {
        expect(
            createRenderableMediaKeys([
                {
                    id: 'movie-1',
                    mediaType: 'movie',
                    externalIds: { tmdb: '550' },
                },
                {
                    id: 'movie-1-copy',
                    mediaType: 'movie',
                    externalIds: { tmdb: '550' },
                },
                {
                    id: 'movie-1-copy-2',
                    mediaType: 'movie',
                    externalIds: { tmdb: '550' },
                },
            ]),
        ).toEqual(['tmdb:550:movie', 'tmdb:550:movie::dup-1', 'tmdb:550:movie::dup-2']);
    });
});

describe('hasValidExternalId', () => {
    it('accepts an internal-only item (standalone library, no TMDB, no Jellyfin)', () => {
        expect(hasValidExternalId({ internal: '123e4567-e89b-12d3-a456-426614174000' })).toBe(true);
    });

    it('accepts a provider id', () => {
        expect(hasValidExternalId({ tmdb: '550' })).toBe(true);
    });

    it('rejects a Jellyfin id alone and empty ids', () => {
        expect(hasValidExternalId({ jellyfin: 'jf-1' })).toBe(false);
        expect(hasValidExternalId({})).toBe(false);
        expect(hasValidExternalId(undefined)).toBe(false);
    });
});

describe('getBestMediaKey', () => {
    it('uses externalIds.internal when item.id is not a UUID', () => {
        expect(
            getBestMediaKey({
                id: 'search-1',
                externalIds: { internal: 'uuid-9', jellyfin: 'jf-9' },
                mediaType: 'movie',
            }),
        ).toBe('uuid-9');
    });
});

it('uses carousel item keys when the same music entity occurs twice', () => {
    expect(createRenderableMediaKeys([
        { id: 'track', itemKey: 'qp:rotation:track', mediaType: 'track', externalIds: {} },
        { id: 'track', itemKey: 'qp:unplayed:track', mediaType: 'track', externalIds: {} },
    ])).toEqual(['qp:rotation:track', 'qp:unplayed:track']);
});
