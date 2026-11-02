// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import { BASE_SCHEMA_SQL } from '$lib/server/database/base-schema-sql';
import { publicMediaTypeSchema } from '$lib/schemas/common';
import { UniversalMediaTypeSchema } from '$lib/schemas/api-responses';
import { ApiMediaTypeSchema } from '$lib/schemas/api-common-responses';

import {
    INTERNAL_MEDIA_TYPES,
    apiTypeOf,
    assertNever,
    detailTypeOf,
    isInternalMediaType,
    isProviderMatchable,
    movieOrSeriesOf,
    providerTypeOf,
    publicTypeOf,
    toApiMediaType,
    toDetailMediaType,
    toInternalMediaType,
    toMovieOrSeries,
    toProviderMediaType,
    toPublicMediaType,
    toTmdbMediaType,
    toUniversalMediaType,
    tmdbTypeOf,
    universalTypeOf,
    type MediaTypeInternal,
} from './media-type-domain';

/**
 * The types that are NOT representable in each target vocabulary.
 *
 * These lists are written out longhand on purpose. The whole failure mode this
 * module exists to prevent is "unknown silently became a movie", so the test
 * asserts `null` — never a substitute — for every single one of them. If a type
 * is added to a vocabulary later, the corresponding line here must be deleted
 * deliberately, which is a reviewable diff.
 */
const STORAGE_ONLY = ['anfragen', 'sonarr', 'radarr'] as const;
const NON_ENTERTAINMENT = ['home_video', 'training', 'educational', 'personal', 'product'] as const;
const TEXT_KINDS = ['book', 'manga', 'comic', 'podcast'] as const;
const LIVE_KINDS = ['tvchannel', 'radio'] as const;

describe('INTERNAL_MEDIA_TYPES', () => {
    it('matches the media_items_media_type_check CHECK constraint exactly', () => {
        // The DB constraint is the single source of truth for this union. Parse
        // it out of the committed base schema rather than restating it, so a
        // migration that widens the constraint without widening the union (or
        // the reverse) fails here instead of silently collapsing rows onto
        // 'movie' somewhere downstream.
        const marker = 'media_items_media_type_check';
        const start = BASE_SCHEMA_SQL.indexOf(marker);
        expect(start, `${marker} not found in base schema`).toBeGreaterThan(-1);

        const clause = BASE_SCHEMA_SQL.slice(start, start + 2000);
        const arrayStart = clause.indexOf('ARRAY[');
        const arrayEnd = clause.indexOf(']', arrayStart);
        expect(arrayStart).toBeGreaterThan(-1);
        expect(arrayEnd).toBeGreaterThan(arrayStart);

        const constraintTypes = [
            ...clause.slice(arrayStart, arrayEnd).matchAll(/'([a-z_]+)'::text/g),
        ].map((m) => m[1]);

        expect(constraintTypes.length).toBeGreaterThan(0);
        expect([...constraintTypes].sort()).toEqual([...INTERNAL_MEDIA_TYPES].sort());
    });

    it('has no duplicate members', () => {
        expect(new Set(INTERNAL_MEDIA_TYPES).size).toBe(INTERNAL_MEDIA_TYPES.length);
    });

    it('is entirely lowercase (media_items.media_type stores lowercase)', () => {
        for (const t of INTERNAL_MEDIA_TYPES) {
            expect(t).toBe(t.toLowerCase());
        }
    });
});

describe('toInternalMediaType', () => {
    it('round-trips every canonical type', () => {
        for (const t of INTERNAL_MEDIA_TYPES) {
            expect(toInternalMediaType(t)).toBe(t);
        }
    });

    it('accepts every case convention', () => {
        expect(toInternalMediaType('Movie')).toBe('movie');
        expect(toInternalMediaType('MOVIE')).toBe('movie');
        expect(toInternalMediaType('Series')).toBe('tv');
        expect(toInternalMediaType('SERIES')).toBe('tv');
        expect(toInternalMediaType('Episode')).toBe('episode');
        expect(toInternalMediaType('AUDIOBOOK')).toBe('audiobook');
        expect(toInternalMediaType('  tv  ')).toBe('tv');
    });

    it('folds the documented aliases', () => {
        expect(toInternalMediaType('film')).toBe('movie');
        expect(toInternalMediaType('show')).toBe('tv');
        expect(toInternalMediaType('tvshows')).toBe('tv');
        expect(toInternalMediaType('anime')).toBe('tv');
        expect(toInternalMediaType('song')).toBe('track');
        expect(toInternalMediaType('MusicAlbum')).toBe('album');
        expect(toInternalMediaType('MusicArtist')).toBe('artist');
        expect(toInternalMediaType('livetv')).toBe('tvchannel');
        expect(toInternalMediaType('request')).toBe('anfragen');
    });

    it('keeps Jellyfin Audio on the canonical audio member', () => {
        // 'audio' is itself a CHECK member, so it wins over any alias. Every
        // mapping table treats it exactly like 'track'.
        expect(toInternalMediaType('Audio')).toBe('audio');
        expect(publicTypeOf('audio')).toBe(publicTypeOf('track'));
        expect(universalTypeOf('audio')).toBe(universalTypeOf('track'));
        expect(providerTypeOf('audio')).toBe(providerTypeOf('track'));
    });

    it('does NOT accept aliases none of the old normalizers accepted', () => {
        // The alias table is exactly the union of what the four deleted
        // `normalizeMediaType` copies plus the old `toTmdbType` accepted.
        // Widening it widens what EVERY boundary swallows — `media-key-parser`
        // runs this on user-supplied route params.
        expect(toInternalMediaType('tvshow')).toBeNull();
        expect(toInternalMediaType('shows')).toBeNull();
        expect(toInternalMediaType('homevideo')).toBeNull();
        expect(toInternalMediaType('movies')).toBeNull();
    });

    it('returns null — never movie — for unknown, empty and nullish input', () => {
        expect(toInternalMediaType('nonsense')).toBeNull();
        expect(toInternalMediaType('')).toBeNull();
        expect(toInternalMediaType('   ')).toBeNull();
        expect(toInternalMediaType(null)).toBeNull();
        expect(toInternalMediaType(undefined)).toBeNull();
        // The whole point: "I don't know" is not spelled 'movie'.
        expect(toInternalMediaType('some_future_type')).not.toBe('movie');
    });
});

describe('isInternalMediaType', () => {
    it('accepts canonical lowercase only', () => {
        expect(isInternalMediaType('movie')).toBe(true);
        expect(isInternalMediaType('audiobook')).toBe(true);
        expect(isInternalMediaType('Movie')).toBe(false);
        expect(isInternalMediaType('series')).toBe(false);
        expect(isInternalMediaType('nope')).toBe(false);
    });
});

describe('every mapping is total over MediaTypeInternal', () => {
    // A missing key would be a compile error, but an accidental `undefined`
    // value would not be — assert the runtime shape too.
    const accessors = {
        publicTypeOf,
        universalTypeOf,
        movieOrSeriesOf,
        detailTypeOf,
        apiTypeOf,
        tmdbTypeOf,
        providerTypeOf,
    } as const;

    for (const [name, fn] of Object.entries(accessors)) {
        it(`${name} returns a value or explicit null for all ${INTERNAL_MEDIA_TYPES.length} types`, () => {
            for (const t of INTERNAL_MEDIA_TYPES) {
                const result = fn(t);
                expect(result, `${name}('${t}') must not be undefined`).not.toBeUndefined();
                if (result !== null) expect(typeof result).toBe('string');
            }
        });
    }

    it('isProviderMatchable is a boolean for all types', () => {
        for (const t of INTERNAL_MEDIA_TYPES) {
            expect(typeof isProviderMatchable(t)).toBe('boolean');
        }
    });
});

describe('publicTypeOf', () => {
    it('promotes tv → series and never emits the stored token', () => {
        expect(publicTypeOf('tv')).toBe('series');
        for (const t of INTERNAL_MEDIA_TYPES) {
            expect(publicTypeOf(t)).not.toBe('tv');
        }
    });

    it('carries audiobooks verbatim', () => {
        expect(publicTypeOf('audiobook')).toBe('audiobook');
    });

    it('returns null for storage-only rows', () => {
        for (const t of STORAGE_ONLY) expect(publicTypeOf(t)).toBeNull();
    });

    it('returns null for non-entertainment library types', () => {
        for (const t of NON_ENTERTAINMENT) expect(publicTypeOf(t)).toBeNull();
    });

    it('returns null for text kinds and live kinds', () => {
        for (const t of TEXT_KINDS) expect(publicTypeOf(t)).toBeNull();
        for (const t of LIVE_KINDS) expect(publicTypeOf(t)).toBeNull();
    });

    it('returns null for the music library-root marker and for extras', () => {
        expect(publicTypeOf('music')).toBeNull();
        expect(publicTypeOf('extra')).toBeNull();
    });

    it('only ever emits values publicMediaTypeSchema accepts', () => {
        for (const t of INTERNAL_MEDIA_TYPES) {
            const p = publicTypeOf(t);
            if (p !== null) expect(publicMediaTypeSchema.parse(p)).toBe(p);
        }
    });
});

describe('universalTypeOf', () => {
    it('has no representation for a season', () => {
        // UniversalMediaType genuinely lacks a 'season' member; substituting
        // 'series' would relabel one season as the whole show.
        expect(universalTypeOf('season')).toBeNull();
    });

    it('renders audiobooks as audiobooks, not movies', () => {
        expect(universalTypeOf('audiobook')).toBe('audiobook');
    });

    it('returns null for non-entertainment library types', () => {
        for (const t of NON_ENTERTAINMENT) expect(universalTypeOf(t)).toBeNull();
    });

    it('only ever emits values UniversalMediaTypeSchema accepts', () => {
        for (const t of INTERNAL_MEDIA_TYPES) {
            const u = universalTypeOf(t);
            if (u !== null) expect(UniversalMediaTypeSchema.parse(u)).toBe(u);
        }
    });
});

describe('movieOrSeriesOf (replaces the toPublicMovieOrSeries clamp)', () => {
    it('maps only the two catalog video kinds', () => {
        expect(movieOrSeriesOf('movie')).toBe('movie');
        expect(movieOrSeriesOf('tv')).toBe('series');
    });

    it('returns null for an audiobook — the original production bug', () => {
        // toPublicMovieOrSeries('audiobook') returned 'movie', which is how an
        // audiobook rendered as a movie card and offered "Watch Movie".
        expect(movieOrSeriesOf('audiobook')).toBeNull();
        expect(toMovieOrSeries('audiobook')).toBeNull();
    });

    it('returns null for episodes and seasons rather than mislabelling them', () => {
        expect(movieOrSeriesOf('episode')).toBeNull();
        expect(movieOrSeriesOf('season')).toBeNull();
    });

    it('returns null for every music, live, text, non-entertainment and storage type', () => {
        for (const t of [
            'artist',
            'album',
            'track',
            'audio',
            'music',
            ...LIVE_KINDS,
            ...TEXT_KINDS,
            ...NON_ENTERTAINMENT,
            ...STORAGE_ONLY,
            'extra',
        ] satisfies MediaTypeInternal[]) {
            expect(movieOrSeriesOf(t), `movieOrSeriesOf('${t}')`).toBeNull();
        }
    });
});

describe('detailTypeOf', () => {
    it('gives an audiobook its own detail discriminator', () => {
        expect(detailTypeOf('audiobook')).toBe('audiobook');
        expect(toDetailMediaType('AUDIOBOOK')).toBe('audiobook');
    });

    it('maps the two video kinds and nothing else', () => {
        expect(detailTypeOf('movie')).toBe('movie');
        expect(detailTypeOf('tv')).toBe('series');
        expect(detailTypeOf('episode')).toBeNull();
        expect(detailTypeOf('track')).toBeNull();
        expect(detailTypeOf('tvchannel')).toBeNull();
    });
});

describe('apiTypeOf', () => {
    it('covers the four ApiMediaType members', () => {
        expect(apiTypeOf('movie')).toBe('movie');
        expect(apiTypeOf('tv')).toBe('series');
        expect(apiTypeOf('episode')).toBe('episode');
        expect(apiTypeOf('season')).toBe('season');
    });

    it('returns null for audiobooks and music — ApiMediaType has no member', () => {
        expect(apiTypeOf('audiobook')).toBeNull();
        expect(toApiMediaType('audiobook')).toBeNull();
        expect(apiTypeOf('track')).toBeNull();
        expect(apiTypeOf('album')).toBeNull();
        expect(apiTypeOf('artist')).toBeNull();
    });

    it('only ever emits values ApiMediaTypeSchema accepts', () => {
        for (const t of INTERNAL_MEDIA_TYPES) {
            const a = apiTypeOf(t);
            if (a !== null) expect(ApiMediaTypeSchema.parse(a)).toBe(a);
        }
    });
});

describe('tmdbTypeOf', () => {
    it('folds episode and season onto the parent tv entity', () => {
        expect(tmdbTypeOf('episode')).toBe('tv');
        expect(tmdbTypeOf('season')).toBe('tv');
    });

    it('returns null for everything TMDB does not catalog', () => {
        expect(tmdbTypeOf('audiobook')).toBeNull();
        expect(tmdbTypeOf('track')).toBeNull();
        expect(tmdbTypeOf('album')).toBeNull();
        expect(tmdbTypeOf('artist')).toBeNull();
        expect(tmdbTypeOf('tvchannel')).toBeNull();
        for (const t of NON_ENTERTAINMENT) expect(tmdbTypeOf(t)).toBeNull();
        for (const t of STORAGE_ONLY) expect(tmdbTypeOf(t)).toBeNull();
    });

    it('never answers movie for a non-TMDB type', () => {
        // toTmdbType('audiobook') used to return 'movie', producing a request
        // for /3/movie/{audiobook id}.
        expect(toTmdbMediaType('audiobook')).not.toBe('movie');
        expect(toTmdbMediaType('nonsense')).not.toBe('movie');
    });
});

describe('providerTypeOf', () => {
    it('covers exactly the external-ID composite-key vocabulary', () => {
        const matchable = INTERNAL_MEDIA_TYPES.filter((t) => providerTypeOf(t) !== null);
        expect(new Set(matchable.map((t) => providerTypeOf(t)))).toEqual(
            new Set(['movie', 'tv', 'episode', 'season', 'artist', 'album', 'track', 'audiobook']),
        );
    });

    it('returns null for non-entertainment types (never provider-matched)', () => {
        for (const t of NON_ENTERTAINMENT) {
            expect(providerTypeOf(t)).toBeNull();
            expect(isProviderMatchable(t)).toBe(false);
        }
    });
});

describe('string-in wrappers', () => {
    const projections = [
        ['public', toPublicMediaType, publicTypeOf],
        ['universal', toUniversalMediaType, universalTypeOf],
        ['movie-or-series', toMovieOrSeries, movieOrSeriesOf],
        ['detail', toDetailMediaType, detailTypeOf],
        ['api', toApiMediaType, apiTypeOf],
        ['tmdb', toTmdbMediaType, tmdbTypeOf],
        ['provider', toProviderMediaType, providerTypeOf],
    ] as const;

    it('keeps every raw-input wrapper identical to its typed table accessor', () => {
        for (const [name, wrapper, accessor] of projections) {
            for (const type of INTERNAL_MEDIA_TYPES) {
                expect(wrapper(type), `${name} wrapper diverged for '${type}'`).toBe(
                    accessor(type),
                );
            }
        }
    });

    it('parse then map in one step', () => {
        expect(toPublicMediaType('Series')).toBe('series');
        expect(toPublicMediaType('show')).toBe('series');
        expect(toUniversalMediaType('TV')).toBe('series');
        expect(toMovieOrSeries('Movie')).toBe('movie');
        expect(toProviderMediaType('MusicArtist')).toBe('artist');
        expect(toTmdbMediaType('Episode')).toBe('tv');
    });

    it('return null for unparseable input rather than substituting', () => {
        for (const fn of [
            toPublicMediaType,
            toUniversalMediaType,
            toMovieOrSeries,
            toDetailMediaType,
            toApiMediaType,
            toTmdbMediaType,
            toProviderMediaType,
        ]) {
            expect(fn('who_knows')).toBeNull();
            expect(fn(undefined)).toBeNull();
            expect(fn(null)).toBeNull();
            expect(fn('')).toBeNull();
        }
    });
});

describe('assertNever', () => {
    it('throws with the offending value and context', () => {
        // Reaching this at runtime means a value escaped the type system.
        const escaped = 'ghost' as never;
        expect(() => assertNever(escaped, 'mediaType')).toThrowError(
            /mediaType: unhandled value "ghost"/,
        );
    });
});
