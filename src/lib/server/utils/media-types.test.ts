// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for media type utilities
 *
 * Tests case-insensitive comparisons, Jellyfin conversions, constants, and edge cases.
 */

/**
 * The removed converters are covered by `$lib/shared/media-type-domain.test.ts`,
 * which owns the vocabulary and every mapping:
 *
 * | removed from this file  | replacement / where it is tested now              |
 * | ----------------------- | ------------------------------------------------- |
 * | `toImageMediaType`      | deleted (verbatim alias) → `tmdbTypeOf` table     |
 * | `toPublicMovieOrSeries` | `movieOrSeriesOf` / `toMovieOrSeries`             |
 * | `toPublicDetailType`    | `detailTypeOf` / `toDetailMediaType`              |
 * | `jellyfinToUIType`      | deleted (no callers) → `toInternalMediaType`      |
 *
 * All four ended in a `'movie'` fallback, and the tests here ASSERTED that
 * fallback ("returns movie for unknown types"). The replacements assert `null`
 * instead — that inversion is the point of the refactor, so the old expectations
 * were removed rather than migrated.
 */
import { describe, it, expect } from 'vitest';
import {
    UIMediaType,
    JellyfinType,
    isMovie,
    isSeries,
    isEpisode,
    isSeason,
    isMusic,
    isAudioTrack,
    isAudio,
    isAudiobook,
    isTvChannel,
    isHomeVideo,
    isTraining,
    isEducational,
    isPersonal,
    isNonEntertainment,
    isAlbum,
    isArtist,
    isTrack,
    isMusicType,
    normalizeForComparison,
    mediaTypesMatch,
    toTmdbType,
    toPublicMediaType,
    ENTERTAINMENT_LIBRARY_TYPES,
    NON_ENTERTAINMENT_LIBRARY_TYPES,
    ALL_LIBRARY_TYPES,
} from './media-types';
import { publicMediaTypeSchema } from '$lib/schemas/common';

// =============================================================================
// CONSTANTS
// =============================================================================

describe('UIMediaType', () => {
    it('has correct lowercase canonical values', () => {
        expect(UIMediaType.MOVIE).toBe('movie');
        expect(UIMediaType.SERIES).toBe('tv');
        expect(UIMediaType.EPISODE).toBe('episode');
        expect(UIMediaType.SEASON).toBe('season');
        expect(UIMediaType.AUDIOBOOK).toBe('audiobook');
        expect(UIMediaType.AUDIO).toBe('audio');
        expect(UIMediaType.TVCHANNEL).toBe('tvchannel');
        expect(UIMediaType.BOOK).toBe('book');
        expect(UIMediaType.MANGA).toBe('manga');
        expect(UIMediaType.COMIC).toBe('comic');
        expect(UIMediaType.ANFRAGEN).toBe('anfragen');
        expect(UIMediaType.SONARR).toBe('sonarr');
        expect(UIMediaType.RADARR).toBe('radarr');
        expect(UIMediaType.PODCAST).toBe('podcast');
        expect(UIMediaType.MUSIC).toBe('music');
        expect(UIMediaType.ARTIST).toBe('artist');
        expect(UIMediaType.ALBUM).toBe('album');
        expect(UIMediaType.TRACK).toBe('track');
        expect(UIMediaType.HOME_VIDEO).toBe('home_video');
        expect(UIMediaType.TRAINING).toBe('training');
        expect(UIMediaType.EDUCATIONAL).toBe('educational');
        expect(UIMediaType.PERSONAL).toBe('personal');
    });
});

describe('JellyfinType', () => {
    it('has correct PascalCase values', () => {
        expect(JellyfinType.Movie).toBe('Movie');
        expect(JellyfinType.Series).toBe('Series');
        expect(JellyfinType.Episode).toBe('Episode');
        expect(JellyfinType.Season).toBe('Season');
        expect(JellyfinType.Audio).toBe('Audio');
        expect(JellyfinType.TvChannel).toBe('TvChannel');
        expect(JellyfinType.MusicAlbum).toBe('MusicAlbum');
        expect(JellyfinType.MusicArtist).toBe('MusicArtist');
        expect(JellyfinType.Person).toBe('Person');
        expect(JellyfinType.Folder).toBe('Folder');
        expect(JellyfinType.CollectionFolder).toBe('CollectionFolder');
        expect(JellyfinType.BoxSet).toBe('BoxSet');
    });
});

describe('ENTERTAINMENT_LIBRARY_TYPES', () => {
    it('contains expected entertainment types', () => {
        expect(ENTERTAINMENT_LIBRARY_TYPES).toEqual(['movie', 'tv', 'anime', 'music', 'audiobook']);
    });
});

describe('NON_ENTERTAINMENT_LIBRARY_TYPES', () => {
    it('contains expected non-entertainment types', () => {
        expect(NON_ENTERTAINMENT_LIBRARY_TYPES).toEqual([
            'home_video',
            'training',
            'educational',
            'personal',
            'product',
        ]);
    });
});

describe('ALL_LIBRARY_TYPES', () => {
    it('contains all entertainment and non-entertainment types', () => {
        expect(ALL_LIBRARY_TYPES).toEqual([
            'movie',
            'tv',
            'anime',
            'music',
            'audiobook',
            'home_video',
            'training',
            'educational',
            'personal',
            'product',
        ]);
    });
});

// =============================================================================
// NORMALIZATION
// =============================================================================

describe('normalizeForComparison', () => {
    it('converts lowercase to uppercase', () => {
        expect(normalizeForComparison('movie')).toBe('MOVIE');
    });

    it('converts PascalCase to uppercase', () => {
        expect(normalizeForComparison('Movie')).toBe('MOVIE');
    });

    it('keeps UPPERCASE unchanged', () => {
        expect(normalizeForComparison('MOVIE')).toBe('MOVIE');
    });

    it('converts mixed case to uppercase', () => {
        expect(normalizeForComparison('mOvIe')).toBe('MOVIE');
    });

    it('returns empty string for undefined', () => {
        expect(normalizeForComparison(undefined)).toBe('');
    });

    it('returns empty string for null', () => {
        expect(normalizeForComparison(null)).toBe('');
    });

    it('returns empty string for empty string', () => {
        expect(normalizeForComparison('')).toBe('');
    });
});

// =============================================================================
// MEDIA TYPE MATCHING
// =============================================================================

describe('mediaTypesMatch', () => {
    it('returns true for identical lowercase types', () => {
        expect(mediaTypesMatch('movie', 'movie')).toBe(true);
    });

    it('returns true for case-different types', () => {
        expect(mediaTypesMatch('movie', 'Movie')).toBe(true);
        expect(mediaTypesMatch('EPISODE', 'episode')).toBe(true);
        expect(mediaTypesMatch('Series', 'SERIES')).toBe(true);
    });

    it('returns true for both undefined', () => {
        expect(mediaTypesMatch(undefined, undefined)).toBe(true);
    });

    it('returns false when one is undefined', () => {
        expect(mediaTypesMatch('movie', undefined)).toBe(false);
        expect(mediaTypesMatch(undefined, 'movie')).toBe(false);
    });

    it('returns false when one is null', () => {
        expect(mediaTypesMatch('movie', null)).toBe(false);
        expect(mediaTypesMatch(null, 'movie')).toBe(false);
    });

    it('returns false for different types', () => {
        expect(mediaTypesMatch('movie', 'series')).toBe(false);
    });
});

// =============================================================================
// TMDB TYPE CONVERSION
// =============================================================================

describe('toTmdbType', () => {
    it("maps 'movie' to 'movie'", () => {
        expect(toTmdbType('movie')).toBe('movie');
    });

    it("maps 'Movie' to 'movie'", () => {
        expect(toTmdbType('Movie')).toBe('movie');
    });

    it("maps 'MOVIE' to 'movie'", () => {
        expect(toTmdbType('MOVIE')).toBe('movie');
    });

    it("maps 'series' to 'tv'", () => {
        expect(toTmdbType('series')).toBe('tv');
    });

    it("maps 'Series' to 'tv'", () => {
        expect(toTmdbType('Series')).toBe('tv');
    });

    it("maps 'tv' to 'tv'", () => {
        expect(toTmdbType('tv')).toBe('tv');
    });

    it("maps 'TV' to 'tv'", () => {
        expect(toTmdbType('TV')).toBe('tv');
    });

    it("maps 'episode' to 'tv'", () => {
        expect(toTmdbType('episode')).toBe('tv');
    });

    it("maps 'Episode' to 'tv'", () => {
        expect(toTmdbType('Episode')).toBe('tv');
    });

    it("maps 'season' to 'tv'", () => {
        expect(toTmdbType('season')).toBe('tv');
    });

    it("maps 'Season' to 'tv'", () => {
        expect(toTmdbType('Season')).toBe('tv');
    });

    it("maps 'anime' to 'tv'", () => {
        expect(toTmdbType('anime')).toBe('tv');
    });

    it("maps 'tvshows' to 'tv'", () => {
        expect(toTmdbType('tvshows')).toBe('tv');
    });

    // These three cases used to assert `'movie'` — they encoded the bug rather
    // than a behaviour. `toTmdbType` answering 'movie' for an audiobook is what
    // sent audiobook rows to /3/movie/{id} and built `?type=movie` image paths
    // for books. They now assert `null`: TMDB has no entity for these, and the
    // caller must decide whether to skip or substitute.
    it('returns null for types TMDB does not catalog', () => {
        expect(toTmdbType('audiobook')).toBeNull();
        expect(toTmdbType('music')).toBeNull();
        expect(toTmdbType('audio')).toBeNull();
        expect(toTmdbType('track')).toBeNull();
        expect(toTmdbType('album')).toBeNull();
        expect(toTmdbType('artist')).toBeNull();
        expect(toTmdbType('tvchannel')).toBeNull();
        expect(toTmdbType('home_video')).toBeNull();
    });

    it('returns null rather than movie for unknown strings', () => {
        expect(toTmdbType('some_future_type')).toBeNull();
    });

    it('returns null for undefined', () => {
        expect(toTmdbType(undefined)).toBeNull();
    });

    it('returns null for null', () => {
        expect(toTmdbType(null)).toBeNull();
    });
});

// =============================================================================
// IMAGE MEDIA TYPE CONVERSION
// =============================================================================

// =============================================================================
// TYPE GUARDS
// =============================================================================

describe('isMovie', () => {
    it('returns true for lowercase', () => {
        expect(isMovie('movie')).toBe(true);
    });

    it('returns true for PascalCase', () => {
        expect(isMovie('Movie')).toBe(true);
    });

    it('returns true for UPPERCASE', () => {
        expect(isMovie('MOVIE')).toBe(true);
    });

    it('returns false for non-movie types', () => {
        expect(isMovie('series')).toBe(false);
        expect(isMovie('episode')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isMovie(undefined)).toBe(false);
        expect(isMovie(null)).toBe(false);
        expect(isMovie('')).toBe(false);
    });
});

describe('isSeries', () => {
    it('returns true for lowercase', () => {
        expect(isSeries('series')).toBe(true);
        expect(isSeries('tv')).toBe(true);
    });

    it('returns true for PascalCase', () => {
        expect(isSeries('Series')).toBe(true);
    });

    it('returns true for UPPERCASE', () => {
        expect(isSeries('SERIES')).toBe(true);
        expect(isSeries('TV')).toBe(true);
    });

    it('returns false for non-series types', () => {
        expect(isSeries('movie')).toBe(false);
        expect(isSeries('episode')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isSeries(undefined)).toBe(false);
        expect(isSeries(null)).toBe(false);
        expect(isSeries('')).toBe(false);
    });
});

describe('isEpisode', () => {
    it('returns true for lowercase', () => {
        expect(isEpisode('episode')).toBe(true);
    });

    it('returns true for PascalCase', () => {
        expect(isEpisode('Episode')).toBe(true);
    });

    it('returns true for UPPERCASE', () => {
        expect(isEpisode('EPISODE')).toBe(true);
    });

    it('returns false for non-episode types', () => {
        expect(isEpisode('movie')).toBe(false);
        expect(isEpisode('series')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isEpisode(undefined)).toBe(false);
        expect(isEpisode(null)).toBe(false);
        expect(isEpisode('')).toBe(false);
    });
});

describe('isSeason', () => {
    it('returns true for lowercase', () => {
        expect(isSeason('season')).toBe(true);
    });

    it('returns true for PascalCase', () => {
        expect(isSeason('Season')).toBe(true);
    });

    it('returns true for UPPERCASE', () => {
        expect(isSeason('SEASON')).toBe(true);
    });

    it('returns false for non-season types', () => {
        expect(isSeason('movie')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isSeason(undefined)).toBe(false);
        expect(isSeason(null)).toBe(false);
        expect(isSeason('')).toBe(false);
    });
});

describe('isMusic', () => {
    it('returns true for lowercase', () => {
        expect(isMusic('music')).toBe(true);
        expect(isMusic('artist')).toBe(true);
    });

    it('returns true for PascalCase', () => {
        expect(isMusic('Music')).toBe(true);
        expect(isMusic('Artist')).toBe(true);
    });

    it('returns true for UPPERCASE', () => {
        expect(isMusic('MUSIC')).toBe(true);
        expect(isMusic('ARTIST')).toBe(true);
    });

    it('returns false for non-music types', () => {
        expect(isMusic('movie')).toBe(false);
        expect(isMusic('album')).toBe(false);
        expect(isMusic('track')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isMusic(undefined)).toBe(false);
        expect(isMusic(null)).toBe(false);
        expect(isMusic('')).toBe(false);
    });
});

describe('isAudioTrack', () => {
    it('returns true for lowercase', () => {
        expect(isAudioTrack('audio')).toBe(true);
        expect(isAudioTrack('track')).toBe(true);
    });

    it('returns true for PascalCase', () => {
        expect(isAudioTrack('Audio')).toBe(true);
        expect(isAudioTrack('Track')).toBe(true);
    });

    it('returns true for UPPERCASE', () => {
        expect(isAudioTrack('AUDIO')).toBe(true);
        expect(isAudioTrack('TRACK')).toBe(true);
    });

    it('returns false for non-audio-track types', () => {
        expect(isAudioTrack('movie')).toBe(false);
        expect(isAudioTrack('music')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isAudioTrack(undefined)).toBe(false);
        expect(isAudioTrack(null)).toBe(false);
        expect(isAudioTrack('')).toBe(false);
    });
});

describe('isAudio', () => {
    it('returns true for lowercase', () => {
        expect(isAudio('audio')).toBe(true);
        expect(isAudio('track')).toBe(true);
    });

    it('returns true for PascalCase', () => {
        expect(isAudio('Audio')).toBe(true);
    });

    it('returns true for UPPERCASE', () => {
        expect(isAudio('AUDIO')).toBe(true);
    });

    it('returns false for non-audio types', () => {
        expect(isAudio('movie')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isAudio(undefined)).toBe(false);
        expect(isAudio(null)).toBe(false);
        expect(isAudio('')).toBe(false);
    });
});

describe('isAudiobook', () => {
    it('returns true for lowercase', () => {
        expect(isAudiobook('audiobook')).toBe(true);
    });

    it('returns true for PascalCase', () => {
        expect(isAudiobook('Audiobook')).toBe(true);
    });

    it('returns true for UPPERCASE', () => {
        expect(isAudiobook('AUDIOBOOK')).toBe(true);
    });

    it('returns false for non-audiobook types', () => {
        expect(isAudiobook('book')).toBe(false);
        expect(isAudiobook('movie')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isAudiobook(undefined)).toBe(false);
        expect(isAudiobook(null)).toBe(false);
        expect(isAudiobook('')).toBe(false);
    });
});

describe('isTvChannel', () => {
    it('returns true for lowercase', () => {
        expect(isTvChannel('tvchannel')).toBe(true);
    });

    it('returns true for PascalCase', () => {
        expect(isTvChannel('TvChannel')).toBe(true);
    });

    it('returns true for UPPERCASE', () => {
        expect(isTvChannel('TVCHANNEL')).toBe(true);
    });

    it('returns false for non-tvchannel types', () => {
        expect(isTvChannel('tv')).toBe(false);
        expect(isTvChannel('movie')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isTvChannel(undefined)).toBe(false);
        expect(isTvChannel(null)).toBe(false);
        expect(isTvChannel('')).toBe(false);
    });
});

describe('isHomeVideo', () => {
    it('returns true for lowercase', () => {
        expect(isHomeVideo('home_video')).toBe(true);
    });

    it('returns true for PascalCase', () => {
        expect(isHomeVideo('Home_Video')).toBe(true);
    });

    it('returns true for UPPERCASE', () => {
        expect(isHomeVideo('HOME_VIDEO')).toBe(true);
    });

    it('returns false for non-home-video types', () => {
        expect(isHomeVideo('movie')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isHomeVideo(undefined)).toBe(false);
        expect(isHomeVideo(null)).toBe(false);
        expect(isHomeVideo('')).toBe(false);
    });
});

describe('isTraining', () => {
    it('returns true for lowercase', () => {
        expect(isTraining('training')).toBe(true);
    });

    it('returns true for PascalCase', () => {
        expect(isTraining('Training')).toBe(true);
    });

    it('returns true for UPPERCASE', () => {
        expect(isTraining('TRAINING')).toBe(true);
    });

    it('returns false for non-training types', () => {
        expect(isTraining('movie')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isTraining(undefined)).toBe(false);
        expect(isTraining(null)).toBe(false);
        expect(isTraining('')).toBe(false);
    });
});

describe('isEducational', () => {
    it('returns true for lowercase', () => {
        expect(isEducational('educational')).toBe(true);
    });

    it('returns true for PascalCase', () => {
        expect(isEducational('Educational')).toBe(true);
    });

    it('returns true for UPPERCASE', () => {
        expect(isEducational('EDUCATIONAL')).toBe(true);
    });

    it('returns false for non-educational types', () => {
        expect(isEducational('movie')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isEducational(undefined)).toBe(false);
        expect(isEducational(null)).toBe(false);
        expect(isEducational('')).toBe(false);
    });
});

describe('isPersonal', () => {
    it('returns true for lowercase', () => {
        expect(isPersonal('personal')).toBe(true);
    });

    it('returns true for PascalCase', () => {
        expect(isPersonal('Personal')).toBe(true);
    });

    it('returns true for UPPERCASE', () => {
        expect(isPersonal('PERSONAL')).toBe(true);
    });

    it('returns false for non-personal types', () => {
        expect(isPersonal('movie')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isPersonal(undefined)).toBe(false);
        expect(isPersonal(null)).toBe(false);
        expect(isPersonal('')).toBe(false);
    });
});

describe('isNonEntertainment', () => {
    it('returns true for all non-entertainment types', () => {
        expect(isNonEntertainment('home_video')).toBe(true);
        expect(isNonEntertainment('training')).toBe(true);
        expect(isNonEntertainment('educational')).toBe(true);
        expect(isNonEntertainment('personal')).toBe(true);
    });

    it('returns true for PascalCase non-entertainment types', () => {
        expect(isNonEntertainment('Home_Video')).toBe(true);
        expect(isNonEntertainment('Training')).toBe(true);
    });

    it('returns false for entertainment types', () => {
        expect(isNonEntertainment('movie')).toBe(false);
        expect(isNonEntertainment('tv')).toBe(false);
        expect(isNonEntertainment('music')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isNonEntertainment(undefined)).toBe(false);
        expect(isNonEntertainment(null)).toBe(false);
        expect(isNonEntertainment('')).toBe(false);
    });
});

describe('isAlbum', () => {
    it('returns true for lowercase', () => {
        expect(isAlbum('album')).toBe(true);
    });

    it('returns true for PascalCase', () => {
        expect(isAlbum('Album')).toBe(true);
    });

    it('returns true for UPPERCASE', () => {
        expect(isAlbum('ALBUM')).toBe(true);
    });

    it('returns false for non-album types', () => {
        expect(isAlbum('music')).toBe(false);
        expect(isAlbum('movie')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isAlbum(undefined)).toBe(false);
        expect(isAlbum(null)).toBe(false);
        expect(isAlbum('')).toBe(false);
    });
});

describe('isArtist', () => {
    it('returns true for lowercase', () => {
        expect(isArtist('artist')).toBe(true);
    });

    it('returns true for PascalCase', () => {
        expect(isArtist('Artist')).toBe(true);
    });

    it('returns true for UPPERCASE', () => {
        expect(isArtist('ARTIST')).toBe(true);
    });

    it('returns false for non-artist types', () => {
        expect(isArtist('music')).toBe(false);
        expect(isArtist('movie')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isArtist(undefined)).toBe(false);
        expect(isArtist(null)).toBe(false);
        expect(isArtist('')).toBe(false);
    });
});

describe('isTrack', () => {
    it('returns true for lowercase', () => {
        expect(isTrack('track')).toBe(true);
    });

    it('returns true for PascalCase', () => {
        expect(isTrack('Track')).toBe(true);
    });

    it('returns true for UPPERCASE', () => {
        expect(isTrack('TRACK')).toBe(true);
    });

    it('returns false for non-track types', () => {
        expect(isTrack('audio')).toBe(false);
        expect(isTrack('movie')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isTrack(undefined)).toBe(false);
        expect(isTrack(null)).toBe(false);
        expect(isTrack('')).toBe(false);
    });
});

describe('isMusicType', () => {
    it('returns true for artist, album, and track', () => {
        expect(isMusicType('artist')).toBe(true);
        expect(isMusicType('album')).toBe(true);
        expect(isMusicType('track')).toBe(true);
    });

    it('returns true for PascalCase variants', () => {
        expect(isMusicType('Artist')).toBe(true);
        expect(isMusicType('Album')).toBe(true);
        expect(isMusicType('Track')).toBe(true);
    });

    it('returns false for music (root level only)', () => {
        expect(isMusicType('music')).toBe(false);
    });

    it('returns false for non-music types', () => {
        expect(isMusicType('movie')).toBe(false);
        expect(isMusicType('audio')).toBe(false);
    });

    it('returns false for falsy values', () => {
        expect(isMusicType(undefined)).toBe(false);
        expect(isMusicType(null)).toBe(false);
        expect(isMusicType('')).toBe(false);
    });
});

// =============================================================================
// JELLYFIN TO UI TYPE CONVERSION
// =============================================================================

// =============================================================================
// PUBLIC BOUNDARY CONVERSION
// =============================================================================

describe('toPublicMediaType', () => {
    it('promotes the legacy/storage tokens to the canonical public value', () => {
        expect(toPublicMediaType('tv')).toBe('series');
        expect(toPublicMediaType('show')).toBe('series');
        expect(toPublicMediaType('series')).toBe('series');
    });

    it('passes the already-canonical values through', () => {
        expect(toPublicMediaType('movie')).toBe('movie');
        expect(toPublicMediaType('season')).toBe('season');
        expect(toPublicMediaType('episode')).toBe('episode');
        expect(toPublicMediaType('track')).toBe('track');
        expect(toPublicMediaType('album')).toBe('album');
        expect(toPublicMediaType('artist')).toBe('artist');
    });

    it('maps audiobook to itself rather than dropping it', () => {
        // AudiobookShelf books are real media_items rows served by /audiobooks,
        // so they need a public discriminator. Before this they returned null and
        // every caller using `toPublicMediaType(x) ?? x` leaked the raw DB token
        // while schema-validated callers dropped the row entirely.
        expect(toPublicMediaType('audiobook')).toBe('audiobook');
    });

    it('is case-insensitive', () => {
        expect(toPublicMediaType('TV')).toBe('series');
        expect(toPublicMediaType('Movie')).toBe('movie');
        expect(toPublicMediaType('AUDIOBOOK')).toBe('audiobook');
    });

    it('still returns null for provider-leaked / storage-only types', () => {
        expect(toPublicMediaType('tvchannel')).toBeNull();
        expect(toPublicMediaType('home_video')).toBeNull();
        expect(toPublicMediaType('music')).toBeNull();
        expect(toPublicMediaType('radio')).toBeNull();
        expect(toPublicMediaType('book')).toBeNull();
        expect(toPublicMediaType('product')).toBeNull();
    });

    it('returns null for empty input', () => {
        expect(toPublicMediaType(undefined)).toBeNull();
        expect(toPublicMediaType(null)).toBeNull();
        expect(toPublicMediaType('')).toBeNull();
    });

    /**
     * The mapper and the zod enum are the same contract stated twice — the enum
     * is what OpenAPI publishes and what response schemas validate against, so a
     * value the mapper can emit but the schema rejects is a 500 at serialisation
     * time (or a silently stripped field).
     */
    it('only ever emits values publicMediaTypeSchema accepts', () => {
        const dbTypes = [
            'movie',
            'tv',
            'show',
            'series',
            'season',
            'episode',
            'track',
            'album',
            'artist',
            'audiobook',
            'tvchannel',
            'home_video',
            'music',
            'radio',
        ];
        for (const t of dbTypes) {
            const mapped = toPublicMediaType(t);
            if (mapped === null) continue;
            expect(publicMediaTypeSchema.safeParse(mapped).success).toBe(true);
        }
    });

    it('covers every value publicMediaTypeSchema declares', () => {
        // Guards the other direction: a public value no DB type maps onto would
        // be a member of the contract nothing can ever produce. `publicMediaTypeSchema`
        // is a preprocess pipe, so the enum members live on the pipe's output side.
        const declaredValues = publicMediaTypeSchema.def.out.options;
        expect(declaredValues.length).toBeGreaterThan(0);

        const reachable = new Set(
            ['movie', 'tv', 'season', 'episode', 'track', 'album', 'artist', 'audiobook']
                .map((t) => toPublicMediaType(t))
                .filter((t): t is NonNullable<typeof t> => t !== null),
        );
        for (const declared of declaredValues) {
            expect(reachable.has(declared)).toBe(true);
        }
    });
});
