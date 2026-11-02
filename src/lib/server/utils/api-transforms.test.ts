// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit Tests for api-transforms utilities
 *
 * Focuses on normalizeGenres, which has historically been buggy
 * when SQL arrays contain NULL elements (from bare-integer JSONB genres).
 */

import { personImageSet } from '$lib/server/services/image-descriptor/resources.js';
import { describe, it, expect } from 'vitest';
import {
    normalizeGenres,
    toNodeDetailsExtra,
    transformToMediaDetail,
    type DbMediaRow,
} from './api-transforms.js';
import {
    MediaDetailSchema,
    MediaNodeBaseSchema,
    MediaNodeDetailsSchema,
} from '$lib/schemas/media-detail.js';

describe('detail subheading', () => {
    it('preserves the stored tagline through detail serialization', () => {
        const detail = transformToMediaDetail(
            {
                media_id: 'movie-id',
                media_type: 'movie',
                title: 'Awakening',
                tagline: '  Why are they here?  ',
            },
            {},
        );
        expect(MediaDetailSchema.parse(detail).tagline).toBe('Why are they here?');
    });

    it('omits blank taglines', () => {
        const detail = transformToMediaDetail(
            {
                media_id: 'movie-id',
                media_type: 'movie',
                title: 'Awakening',
                tagline: '   ',
            },
            {},
        );
        expect(MediaDetailSchema.parse(detail).tagline).toBeUndefined();
    });
});

/**
 * `transformToMediaDetail()` returns `null` for a row whose media_type has no arm
 * in `MediaDetailSchema`'s closed union (episode, season, track, album, channel,
 * home_video …). Every fixture in this file is a movie, series or audiobook, so a
 * `null` here means the fixture or the mapping table is wrong — fail loudly
 * instead of threading `!` through every assertion.
 */
function requireDetail<T>(detail: T | null): T {
    if (detail === null) {
        throw new Error('transformToMediaDetail returned null for a movie/series/audiobook row');
    }
    return detail;
}

describe('normalizeGenres', () => {
    // -------------------------------------------------------------------------
    // Null / empty inputs
    // -------------------------------------------------------------------------

    it('returns undefined for null input', () => {
        expect(normalizeGenres(null)).toBeUndefined();
    });

    it('returns undefined for undefined input', () => {
        expect(normalizeGenres(undefined)).toBeUndefined();
    });

    it('returns undefined for empty array', () => {
        expect(normalizeGenres([])).toBeUndefined();
    });

    // -------------------------------------------------------------------------
    // SQL NULL elements (regression: "null null null" bug)
    // -------------------------------------------------------------------------

    it('returns undefined when all elements are null (SQL array with NULL values)', () => {
        // postgres.js returns PostgreSQL NULL array elements as JS null
        expect(normalizeGenres([null as unknown as string])).toBeUndefined();
        expect(normalizeGenres([null, null] as unknown as string[])).toBeUndefined();
    });

    it('filters out null elements mixed with valid strings', () => {
        const result = normalizeGenres([
            null as unknown as string,
            'Crime',
            null as unknown as string,
            'Thriller',
        ]);
        expect(result).toEqual(['Crime', 'Thriller']);
    });

    // -------------------------------------------------------------------------
    // String array (already normalized genre names)
    // -------------------------------------------------------------------------

    it('passes through a plain string array unchanged', () => {
        const result = normalizeGenres(['Action', 'Drama']);
        expect(result).toEqual(['Action', 'Drama']);
    });

    // -------------------------------------------------------------------------
    // JSONB object array: [{"id": 80, "name": "Crime"}]
    // -------------------------------------------------------------------------

    it('extracts names from JSONB object genre array', () => {
        const genres = [
            { id: 80, name: 'Crime' },
            { id: 9648, name: 'Mystery' },
        ];
        const result = normalizeGenres(genres);
        expect(result).toEqual(['Crime', 'Mystery']);
    });

    it('skips JSONB objects with missing name field', () => {
        const genres = [{ id: 80, name: 'Crime' }, { id: 9648 }] as Array<{
            id?: number;
            name?: string;
        }>;
        const result = normalizeGenres(genres);
        expect(result).toEqual(['Crime']);
    });

    // -------------------------------------------------------------------------
    // Number array (integer genre IDs from DB)
    // -------------------------------------------------------------------------

    it('converts number IDs to strings', () => {
        const result = normalizeGenres([80, 9648]);
        expect(result).toEqual(['80', '9648']);
    });

    it('does not produce "null" or "NaN" strings from number IDs', () => {
        // Edge: ensure no stringified nulls slip through
        const result = normalizeGenres([80, 9648]);
        expect(result).not.toContain('null');
        expect(result).not.toContain('NaN');
        expect(result).not.toContain('undefined');
    });
});

describe('toNodeDetailsExtra', () => {
    it('strips MediaNodeBase identity fields, keeping only the rich augmentation', () => {
        const row: DbMediaRow = {
            media_id: 'movie-uuid',
            media_type: 'movie',
            title: 'Intertidal',
            overview: 'A team travels through a wormhole.',
            year: 2014,
            runtime_minutes: 169,
            genres: ['Sci-Fi', 'Drama'],
            imdb_rating: 8.7,
            is_available: true,
            can_request: false,
        };
        const detail = requireDetail(transformToMediaDetail(row, { tmdb: '157336' }));
        const extra = toNodeDetailsExtra(detail);

        // Identity fields MediaNodeBaseSchema already carries must be gone.
        expect(extra).not.toHaveProperty('id');
        expect(extra).not.toHaveProperty('ids');
        expect(extra).not.toHaveProperty('title');
        expect(extra).not.toHaveProperty('overview');
        expect(extra).not.toHaveProperty('images');
        expect(extra).not.toHaveProperty('isAvailable');
        expect(extra).not.toHaveProperty('canRequest');
        expect(extra).not.toHaveProperty('type');

        // The rich augmentation survives.
        expect(extra.genres).toEqual(['Sci-Fi', 'Drama']);
        expect(extra.rating).toBeGreaterThan(0);

        // Regression: `year` lives on MediaNodeBaseSchema (the parent node),
        // not on MediaNodeDetailsSchema. transformToMediaDetail() sets `year`
        // on MovieDetail — a prior version of toNodeDetailsExtra() forgot to
        // strip it, leaking a duplicate, undeclared `details.year` onto the
        // wire that a strict client decoder rejects outright (live tvOS
        // failure: "Additional properties are disabled, but found 1 unknown
        // keys ... year"). Zod silently drops unknown keys on a bare
        // `.parse()`, so this must be asserted directly — parsing success
        // alone does not prove the field is actually absent.
        expect(extra).not.toHaveProperty('year');
    });

    it('never leaks any MediaNodeBaseSchema field into details (guards the whole class of bug, not just year)', () => {
        const row: DbMediaRow = {
            media_id: 'movie-uuid',
            media_type: 'movie',
            title: 'Intertidal',
            overview: 'A team travels through a wormhole.',
            year: 2014,
            runtime_minutes: 169,
            is_available: true,
            can_request: false,
        };
        const detail = requireDetail(transformToMediaDetail(row, {}));
        const extra = toNodeDetailsExtra(detail);

        // Dynamically walk MediaNodeBaseSchema's own field list rather than a
        // hand-picked subset — a future field added to the base node schema
        // is caught automatically instead of requiring someone to remember
        // to add a matching assertion here.
        for (const key of Object.keys(MediaNodeBaseSchema.shape)) {
            expect(extra).not.toHaveProperty(key);
        }
    });

    it('the result validates against MediaNodeDetailsSchema.strict() (rejects ANY undeclared key)', () => {
        const row: DbMediaRow = {
            media_id: 'movie-uuid',
            media_type: 'movie',
            title: 'Intertidal',
            overview: 'A team travels through a wormhole.',
            year: 2014,
            runtime_minutes: 169,
            genres: ['Sci-Fi'],
            imdb_rating: 8.7,
            is_available: true,
            can_request: false,
        };
        const detail = requireDetail(transformToMediaDetail(row, { tmdb: '157336' }));
        const extra = toNodeDetailsExtra(detail);

        // .strict() rejects unknown keys instead of silently stripping them —
        // this is what actually reproduces a strict generated-client decoder
        // (Swift, etc.) rejecting the whole response over one stray field.
        const result = MediaNodeDetailsSchema.strict().safeParse(extra);
        expect(result.success, JSON.stringify(!result.success && result.error.issues)).toBe(true);
    });

    it('keeps series-only fields (firstAirDate/status/seasonCount) for a series row', () => {
        const row: DbMediaRow = {
            media_id: 'series-uuid',
            media_type: 'tv',
            title: 'Starhaven',
            first_air_date: '2022-02-18',
            status: 'Continuing',
            season_count: 2,
            is_available: true,
            can_request: false,
        };
        const detail = requireDetail(transformToMediaDetail(row, {}));
        const extra = toNodeDetailsExtra(detail);

        expect(extra.firstAirDate).toBe('2022-02-18');
        expect(extra.status).toBe('Continuing');
        expect(extra.seasonCount).toBe(2);
        // Movie-only field must not leak onto a series row.
        expect(extra).not.toHaveProperty('runtime');
    });

    it('maps the best-version quality projection + best audio into details.quality', () => {
        const row: DbMediaRow = {
            media_id: 'movie-uuid',
            media_type: 'movie',
            title: 'Dawn: Part Two',
            is_available: true,
            can_request: false,
            resolution_tier: '4K',
            hdr_tier: 'dolby_vision',
            hdr_type: 'dolby_vision',
            best_audio: {
                codec: 'truehd',
                channels: 8,
                channel_layout: '7.1',
                profile: 'Dolby TrueHD + Dolby Atmos',
            },
        };
        const detail = requireDetail(transformToMediaDetail(row, { tmdb: '693134' }));
        const extra = toNodeDetailsExtra(detail);

        expect(extra.quality).toEqual({
            resolution: '2160p',
            is4k: true,
            videoRange: 'DolbyVision',
            audioCodec: 'TrueHD Atmos',
        });
        // Still decodes strictly — quality is a declared key, not a stray one.
        expect(MediaNodeDetailsSchema.strict().safeParse(extra).success).toBe(true);
    });

    it('omits details.quality when the item has no probed version', () => {
        const row: DbMediaRow = {
            media_id: 'catalog-only-uuid',
            media_type: 'movie',
            title: 'Unreleased Thing',
            is_available: false,
            can_request: true,
        };
        const detail = requireDetail(transformToMediaDetail(row, {}));
        const extra = toNodeDetailsExtra(detail);
        expect(extra.quality).toBeUndefined();
    });
});

describe('transformToMediaDetail — actors (structured cast)', () => {
    it('maps structured cast to name + character + proxied profileUrl + tmdbId', () => {
        const row: DbMediaRow = {
            media_id: 'movie-uuid',
            media_type: 'movie',
            title: 'The Lantern',
            is_available: true,
            can_request: false,
            cast_structured: [
                {
                    name: 'Keiran Vale',
                    character: 'Neo',
                    person_id: '6384',
                    profile_path: '/profile.jpg',
                },
                {
                    name: 'Laurence Fenwick',
                    character: 'Morpheus',
                    person_id: '2975',
                    profile_path: '/profile.jpg',
                },
            ],
        };
        const detail = requireDetail(transformToMediaDetail(row, { tmdb: '603' }));

        expect(detail.actors).toEqual([
            {
                name: 'Keiran Vale',
                character: 'Neo',
                images: personImageSet('internal', '6384', '/profile.jpg'),
                tmdbId: '6384',
            },
            {
                name: 'Laurence Fenwick',
                character: 'Morpheus',
                images: personImageSet('internal', '2975', '/profile.jpg'),
                tmdbId: '2975',
            },
        ]);
    });

    it('points profileUrl at the v1 person-image route when served on /api/v1', () => {
        const row: DbMediaRow = {
            media_id: 'movie-uuid',
            media_type: 'movie',
            title: 'Jasper',
            is_available: true,
            can_request: false,
            cast_structured: [
                {
                    name: 'Jules Fenwick',
                    character: 'Arthur Fleck',
                    person_id: '73421',
                    profile_path: '/profile.jpg',
                },
            ],
        };
        const detail = requireDetail(
            transformToMediaDetail(row, { tmdb: '475557' }, undefined, 'v1'),
        );
        // The legacy /api/image/person/{id} is cookie-only with no v1 twin: a
        // Bearer client got 401/404 for every headshot (iOS, 2026-09-24).
        expect(detail.actors?.[0].images).toEqual(personImageSet('v1', '73421', '/profile.jpg'));
    });

    it('omits profileUrl/tmdbId for a structured actor with no person id, keeps character', () => {
        const row: DbMediaRow = {
            media_id: 'movie-uuid',
            media_type: 'movie',
            title: 'Obscure Film',
            is_available: true,
            can_request: false,
            cast_structured: [{ name: 'Jane Doe', character: 'Herself' }],
        };
        const detail = requireDetail(transformToMediaDetail(row, {}));

        expect(detail.actors).toEqual([{ name: 'Jane Doe', character: 'Herself', images: {} }]);
    });

    it('falls back to the flat name array when no structured cast is present', () => {
        const row: DbMediaRow = {
            media_id: 'movie-uuid',
            media_type: 'movie',
            title: 'Legacy Item',
            is_available: true,
            can_request: false,
            actors: ['Alice', 'Bob'],
        };
        const detail = requireDetail(transformToMediaDetail(row, {}));

        // Pre-cast-ingest rows have names only — no character/profileUrl invented.
        expect(detail.actors).toEqual([{ name: 'Alice' }, { name: 'Bob' }]);
    });

    it('falls back to flat names when structured cast yields no valid entries', () => {
        const row: DbMediaRow = {
            media_id: 'movie-uuid',
            media_type: 'movie',
            title: 'Malformed Cast',
            is_available: true,
            can_request: false,
            // Structured array present but every entry is nameless/malformed.
            cast_structured: [{ character: 'Ghost' }, {}] as DbMediaRow['cast_structured'],
            actors: ['Real Name'],
        };
        const detail = requireDetail(transformToMediaDetail(row, {}));

        // Must not return [] — falls through to the flat names instead of
        // dropping the cast entirely.
        expect(detail.actors).toEqual([{ name: 'Real Name' }]);
    });

    it('omits profileUrl and tmdbId for a non-numeric person id (proxy resolves numeric ids only)', () => {
        const row: DbMediaRow = {
            media_id: 'movie-uuid',
            media_type: 'movie',
            title: 'Non-numeric Person',
            is_available: true,
            can_request: false,
            cast_structured: [{ name: 'Jane Doe', character: 'Lead', person_id: 'nm12345' }],
        };
        const detail = requireDetail(transformToMediaDetail(row, {}));

        // A non-numeric id would 404 the person-image route — emit neither the
        // proxied URL nor a tmdbId that isn't actually a numeric TMDB id.
        expect(detail.actors).toEqual([{ name: 'Jane Doe', character: 'Lead', images: {} }]);
    });

    it('prefers structured cast over the flat name array when both exist', () => {
        const row: DbMediaRow = {
            media_id: 'movie-uuid',
            media_type: 'movie',
            title: 'Both Present',
            is_available: true,
            can_request: false,
            actors: ['Stale Name'],
            cast_structured: [
                {
                    name: 'Fresh Name',
                    character: 'Lead',
                    person_id: '42',
                    profile_path: '/profile.jpg',
                },
            ],
        };
        const detail = requireDetail(transformToMediaDetail(row, {}));

        expect(detail.actors).toEqual([
            {
                name: 'Fresh Name',
                character: 'Lead',
                images: personImageSet('internal', '42', '/profile.jpg'),
                tmdbId: '42',
            },
        ]);
    });
});

// ============================================================================
// transformToMediaDetail — audiobook arm
// ============================================================================
//
// Regression guard for the THIRD `mediaType` collapse. `transformToMediaDetail`
// is the producer behind `GET /api/media-details?key=…`, which is what the
// home Continue-Watching card click fetches (item-handlers.ts → EXTERNAL
// branch, because an AudiobookShelf book has neither a jellyfin id nor a
// seriesId). It used to end in an unconditional `type: 'movie'` arm, so an
// audiobook row came back off the wire labelled a movie and the modal opened
// as "Watch Movie" with a `slug=movie-…` URL.
//
// NOTE for future edits: the `apiMediaType` local in that function comes from
// this module's own `normalizeMediaType()`, whose `default:` arm returns
// 'movie'. Any audiobook branch keyed off `apiMediaType` is DEAD CODE. The
// classification must read the RAW `row.media_type`.
describe('transformToMediaDetail — audiobook rows', () => {
    const audiobookRow: DbMediaRow = {
        media_id: '4993e963-4220-4f1e-adc0-fb475034149a',
        media_type: 'audiobook',
        title: 'Milo Farrow und der Stein der Weisen - Gesprochen von Felix Vale',
        overview: 'Ein Junge erfährt, dass er ein Zauberer ist.',
        year: 1999,
        is_available: true,
        can_request: false,
    };

    it('carries type "audiobook" instead of collapsing onto the movie arm', () => {
        const detail = requireDetail(
            transformToMediaDetail(audiobookRow, {
                internal: '4993e963-4220-4f1e-adc0-fb475034149a',
            }),
        );

        expect(detail.type).toBe('audiobook');
    });

    it('the result still validates against the wire contract (MediaDetailSchema union)', () => {
        // This is the exact step `defs/media/details.ts` performs before
        // json() — a type the discriminated union does not carry would throw
        // here rather than reach the client.
        const detail = requireDetail(
            transformToMediaDetail(audiobookRow, {
                internal: '4993e963-4220-4f1e-adc0-fb475034149a',
            }),
        );
        const parsed = MediaDetailSchema.parse(detail);

        expect(parsed.type).toBe('audiobook');
        expect(parsed.title).toBe(audiobookRow.title);
    });

    it('returns null for a row MediaDetailSchema cannot describe', () => {
        // The union is movie | series | audiobook. An episode, season, track,
        // channel or home_video row has no arm — it used to be serialized as
        // `type: 'movie'`, so a client rendered "Watch Movie" for one episode.
        // The route turns this null into a 404 (defs/media/details.ts).
        for (const mediaType of [
            'episode',
            'season',
            'track',
            'album',
            'artist',
            'tvchannel',
            'home_video',
            'training',
            'sonarr',
        ]) {
            expect(
                transformToMediaDetail({ ...audiobookRow, media_type: mediaType }, {}),
                `media_type '${mediaType}' must not produce a detail`,
            ).toBeNull();
        }
    });

    it('still returns "movie" for a movie row and "series" for a tv row', () => {
        expect(
            requireDetail(transformToMediaDetail({ ...audiobookRow, media_type: 'movie' }, {}))
                .type,
        ).toBe('movie');
        expect(
            requireDetail(transformToMediaDetail({ ...audiobookRow, media_type: 'tv' }, {})).type,
        ).toBe('series');
    });
});

describe('details.rating stays inside its declared 0-10 contract', () => {
    /**
     * Regression for the prod RESPONSE CONFORMANCE log on
     * GET /api/v1/media/{id}: `details.rating` came back too_big.
     *
     * Rows below are real production data (provider_metadata, 2026-08-20).
     * The assertion runs the emitted `details` block through the SAME schema
     * mount() checks, so it fails on the contract rather than on a hand-copied
     * number.
     */
    function detailsFor(row: DbMediaRow) {
        return toNodeDetailsExtra(requireDetail(transformToMediaDetail(row, {})));
    }

    it('does not double-scale letterboxd when no earlier source qualifies', () => {
        // Ratings taken from edebf2c3-a868-4dfb-a43d-cc58956549cc ("Demon
        // Slayer: Infinity Castle", the item in the prod log), with the TMDB
        // score withheld so the fallback chain is the one under test:
        // letterboxd 8 was being emitted as 16.
        const extra = detailsFor({
            media_id: 'edebf2c3-a868-4dfb-a43d-cc58956549cc',
            media_type: 'movie',
            title: 'Lantern Keeper: The Endless Harbor',
            imdb_rating: undefined,
            tmdb_rating: undefined,
            letterboxd_rating: 8,
            trakt_score: 83,
            mdblist_score: 83,
            rt_rating: 98,
            is_available: true,
            can_request: false,
        });

        expect(extra.rating).toBe(8);
        expect(extra.ratingSource).toBe('letterboxd');
        expect(MediaNodeDetailsSchema.safeParse(extra).success).toBe(true);
    });

    it('keeps the logged prod row in contract once TMDB vote_average is supplied', () => {
        // The same row as prod actually stores it: vote_average 8.649 over 1676
        // votes, which clears MIN_DISPLAY_VOTE_COUNT, so pickDisplayRating wins
        // and letterboxd is never reached. Guards the two fixes together.
        const extra = detailsFor({
            media_id: 'edebf2c3-a868-4dfb-a43d-cc58956549cc',
            media_type: 'movie',
            title: 'Lantern Keeper: The Endless Harbor',
            imdb_rating: undefined,
            vote_average: 8.649,
            vote_count: 1676,
            letterboxd_rating: 8,
            trakt_score: 83,
            mdblist_score: 83,
            rt_rating: 98,
            is_available: true,
            can_request: false,
        });

        expect(extra.rating).toBe(8.649);
        expect(extra.ratingSource).toBe('tmdb');
        expect(MediaNodeDetailsSchema.safeParse(extra).success).toBe(true);
    });

    it('drops the mdblist "-1 = no score" sentinel rather than emitting -0.1', () => {
        const extra = detailsFor({
            media_id: 'no-score-uuid',
            media_type: 'movie',
            title: 'Unscored Title',
            mdblist_score: -1,
            is_available: true,
            can_request: false,
        });

        expect(extra.rating).toBeUndefined();
        expect(MediaNodeDetailsSchema.safeParse(extra).success).toBe(true);
    });

    it('clamps a provider value that overshoots its own scale', () => {
        const extra = detailsFor({
            media_id: 'overshoot-uuid',
            media_type: 'movie',
            title: 'Overshooting Title',
            letterboxd_rating: 10.2,
            is_available: true,
            can_request: false,
        });

        expect(extra.rating).toBe(10);
        expect(MediaNodeDetailsSchema.safeParse(extra).success).toBe(true);
    });
});
