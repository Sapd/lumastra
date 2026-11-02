// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for ImageScannerService
 *
 * Tests pattern parsing, artwork type detection, and matching logic.
 */

import { describe, it, expect } from 'vitest';
import {
    buildPatterns,
    isTargetsOwnImage,
    parseArtworkType,
    parseEpisodeNumbers,
    parseBroadEpisodeNumbers,
    parseSeasonNumber,
    resolveEffectiveNumbers,
    type ArtworkType,
    type ImageScanTarget,
} from './image-scanner.service.js';

// Production default of IMAGE_SYNC_LOCAL_PATTERNS (config.ts). buildPatterns
// derives a single-capture "episode" regex from `season#-poster` that matches
// season posters — the source of the NaN episodeNumber -> Postgres 22P02 bug.
const DEFAULT_PATTERNS = buildPatterns([
    'S##E##-backdrop',
    'S##E##-poster',
    'season#-backdrop',
    'season#-poster',
    'backdrop',
    'poster',
]);

describe('ImageScannerService - season poster must not parse as episode (22P02 regression)', () => {
    for (const name of ['season01-poster.jpg', 'season13-poster.jpg', 'season05-backdrop.jpg']) {
        it(`does not treat ${name} as an episode (no NaN episodeNumber)`, () => {
            const parsed = parseEpisodeNumbers(name, DEFAULT_PATTERNS.episode);
            expect(parsed === null || !Number.isNaN(parsed.episodeNumber)).toBe(true);
        });
    }

    it('parses season01-poster.jpg as season 1', () => {
        expect(parseSeasonNumber('season01-poster.jpg', DEFAULT_PATTERNS.season)).toBe(1);
    });

    it('parses real episode art with the default config patterns', () => {
        expect(parseEpisodeNumbers('S01E05-poster.jpg', DEFAULT_PATTERNS.episode)).toEqual({
            seasonNumber: 1,
            episodeNumber: 5,
        });
        expect(parseEpisodeNumbers('S02E10-backdrop.jpg', DEFAULT_PATTERNS.episode)).toEqual({
            seasonNumber: 2,
            episodeNumber: 10,
        });
    });

    it('routes S##E## to episode (2 fields) and season# to season (1 field)', () => {
        const p = buildPatterns(['S##E##-poster', 'season#-poster']);
        expect(p.episode.length).toBe(1);
        expect(p.season.length).toBe(1);
        // '#'-runs become CAPTURING groups so the numbers are extractable.
        expect(parseEpisodeNumbers('S03E07-poster.jpg', p.episode)).toEqual({
            seasonNumber: 3,
            episodeNumber: 7,
        });
        expect(parseSeasonNumber('season4-poster.jpg', p.season)).toBe(4);
    });

    it('never yields a NaN episode/season number for any season poster (default config)', () => {
        for (const n of ['0', '01', '2', '05', '11', '13', '99']) {
            for (const type of ['poster', 'backdrop']) {
                const name = `season${n}-${type}.jpg`;
                const ep = parseEpisodeNumbers(name, DEFAULT_PATTERNS.episode);
                expect(ep === null || Number.isFinite(ep.episodeNumber)).toBe(true);
                const se = parseSeasonNumber(name, DEFAULT_PATTERNS.season);
                expect(se === null || Number.isFinite(se)).toBe(true);
            }
        }
    });
});

describe('ImageScannerService - Pattern Building', () => {
    describe('buildPatterns', () => {
        it('should build episode patterns from config patterns', () => {
            const patterns = buildPatterns(['S##E##-backdrop', 'S##E##-poster']);
            expect(patterns.episode.length).toBeGreaterThan(0);
        });

        it('should build season patterns from config patterns', () => {
            const patterns = buildPatterns(['season#-backdrop', 'season#-poster']);
            expect(patterns.season.length).toBeGreaterThan(0);
        });

        it('should return default patterns for empty input', () => {
            const patterns = buildPatterns([]);
            expect(patterns.episode.length).toBeGreaterThan(0);
            expect(patterns.season.length).toBeGreaterThan(0);
        });

        it('should handle invalid patterns gracefully', () => {
            const patterns = buildPatterns(['invalid-pattern', '']);
            expect(patterns.episode.length).toBeGreaterThan(0);
            expect(patterns.season.length).toBeGreaterThan(0);
        });
    });

    describe('default regex matching', () => {
        it('should match S01E01-backdrop with default patterns', () => {
            const patterns = buildPatterns([]);
            const found = patterns.episode.some((p: RegExp) => p.test('S01E01-backdrop.jpg'));
            expect(found).toBe(true);
        });

        it('should match season1-backdrop with default patterns', () => {
            const patterns = buildPatterns([]);
            const found = patterns.season.some((p: RegExp) => p.test('season1-backdrop.jpg'));
            expect(found).toBe(true);
        });

        it('should match 1x01-poster with default patterns', () => {
            const patterns = buildPatterns([]);
            const found = patterns.episode.some((p: RegExp) => p.test('1x01-poster.jpg'));
            expect(found).toBe(true);
        });
    });
});

describe('ImageScannerService - Artwork Type Detection', () => {
    const testCases: { filename: string; expected: ArtworkType | null }[] = [
        { filename: 'S01E01-backdrop.jpg', expected: 'backdrop' },
        { filename: 'S01E01-poster.png', expected: 'poster' },
        { filename: 'season1-logo.webp', expected: 'logo' },
        { filename: 'thumb.jpg', expected: 'thumb' },
        { filename: 'banner.gif', expected: 'banner' },
        { filename: 'not-an-image.txt', expected: null },
        { filename: 'random-file.jpg', expected: null },
    ];

    testCases.forEach(({ filename, expected }) => {
        it(`should detect "${expected}" from "${filename}"`, () => {
            expect(parseArtworkType(filename)).toBe(expected);
        });
    });
});

describe('ImageScannerService - Episode Number Parsing', () => {
    it('should parse episode number from S01E01 pattern', () => {
        const patterns = buildPatterns([]);
        const result = 'S01E05-backdrop.jpg'.match(patterns.episode[0]);
        expect(result).not.toBeNull();
        expect(parseInt(result![1], 10)).toBe(1);
        expect(parseInt(result![2], 10)).toBe(5);
    });

    it('should parse episode number from 1x01 pattern', () => {
        const patterns = buildPatterns([]);
        const hasMatch = patterns.episode.some((p: RegExp) => p.test('2x10-poster.jpg'));
        expect(hasMatch).toBe(true);
    });
});

describe('ImageScannerService - Season Number Parsing', () => {
    it('should parse season number from season1 pattern', () => {
        const patterns = buildPatterns([]);
        const result = 'season1-backdrop.jpg'.match(patterns.season[0]);
        expect(result).not.toBeNull();
        expect(parseInt(result![1], 10)).toBe(1);
    });

    it('should parse season number from Season 01 pattern', () => {
        const patterns = buildPatterns([]);
        const result = 'Season 01-backdrop.jpg'.match(patterns.season[0]);
        expect(result).not.toBeNull();
    });
});

describe('ImageScannerService - absolute-numbered (3-digit) episodes', () => {
    // Long-running anime uses absolute episode numbering. On prod this left
    // Soruto (200 episodes), Sky Harbor (158), Ink Grimoire (92), Sorami and
    // Lumemon all sharing a single thumbnail: the scanner's broad fallback
    // capped the episode group at two digits, so "S01E293" resolved to
    // episode 29 and episodes >= 100 could never be matched to their own art.
    // The retired episode-thumbnail-repair task therefore re-enqueued those series forever.
    const REAL_NAMES: Array<[string, number, number]> = [
        [
            'Soruto - Sorami Next Generations (2017) - S01E293 - 293 - Farewell [Bluray-720p][8bit][x264][DTS 5.1][DE+JA]-STARS-thumb.jpg',
            1,
            293,
        ],
        [
            'Sky Harbor (1999) - S21E99 - 990 - Thunder Bagua! [Bluray-720p][8bit][x264][AC3 2.0][DE+JA]-STARS-thumb.jpg',
            21,
            99,
        ],
        [
            'Ink Grimoire (2017) - S01E099 - 099 - The Desperate Path [WEBDL-1080p][8bit][x264][AAC 2.0][DE+JA]-snk-thumb.jpg',
            1,
            99,
        ],
        [
            'Sorami (2002) - S04E48 - 179 - The Remembered Lullaby [Bluray-1080p][8bit][x264][AC3 2.0][JA+EN+FR]-uP-thumb.jpg',
            4,
            48,
        ],
    ];

    it.each(REAL_NAMES)('parses %s', (filename, season, episode) => {
        expect(parseBroadEpisodeNumbers(filename)).toEqual({
            seasonNumber: season,
            episodeNumber: episode,
        });
    });

    it('parses a 3-digit episode when the artwork type is adjacent (built-in defaults)', () => {
        expect(parseEpisodeNumbers('S01E293-thumb.jpg', buildPatterns([]).episode)).toEqual({
            seasonNumber: 1,
            episodeNumber: 293,
        });
    });

    it('documents why the broad fallback carries episode thumbs in production', () => {
        // The shipped IMAGE_SYNC_LOCAL_PATTERNS default is
        // "S##E##-backdrop,S##E##-poster,season#-backdrop,season#-poster,backdrop,poster"
        // — it contains NO thumb pattern. So a real episode thumbnail never
        // matches a configured pattern and always falls through to
        // parseBroadEpisodeNumbers. That is why the two-digit cap there was
        // the one that mattered on prod.
        expect(parseEpisodeNumbers('S01E01-thumb.jpg', DEFAULT_PATTERNS.episode)).toBeNull();
        expect(parseBroadEpisodeNumbers('S01E01-thumb.jpg')).toEqual({
            seasonNumber: 1,
            episodeNumber: 1,
        });
    });

    it('still parses ordinary 2-digit episodes unchanged', () => {
        expect(
            parseBroadEpisodeNumbers('Friends - S02E01 - The One - Bluray-1080p-thumb.jpg'),
        ).toEqual({
            seasonNumber: 2,
            episodeNumber: 1,
        });
    });

    it('no longer truncates an over-long digit run', () => {
        // This assertion previously documented the WEAKER inherited behaviour
        // (episode 1234 from "S01E12345"), because filename-parser's
        // S_E_PATTERN capped the capture at \d{1,4}. Fixing it there — rather
        // than guarding locally — updated this module for free. That is the
        // payoff of consolidating onto one parser: video ingest and artwork
        // scanning cannot drift apart again.
        expect(parseBroadEpisodeNumbers('Show - S01E12345 - thumb.jpg')).toEqual({
            seasonNumber: 1,
            episodeNumber: 12345,
        });
    });

    it('inherits filename-parser guards this module never had', () => {
        // Free wins from delegating: resolution and aspect-ratio tokens are
        // rejected by filename-parser's lookbehind + two-digit-minimum rules.
        expect(parseBroadEpisodeNumbers('1920x1080-thumb.jpg')).toBeNull();
        expect(parseBroadEpisodeNumbers('16x9-poster.jpg')).toBeNull();
    });

    it('returns null when there is no SxxExx token at all', () => {
        expect(parseBroadEpisodeNumbers('Show - backdrop.jpg')).toBeNull();
    });
});

describe('ImageScannerService - resolution filenames must not parse as episodes', () => {
    // Guards the fix above: widening the NxM pattern's episode group to
    // \d{1,4} would make "1920x1080-thumb.jpg" parse as season 20 episode
    // 1080, attaching a resolution-named file to a real episode. The NxM form
    // is for classic "1x05" numbering and deliberately stays at two digits.
    const RESOLUTION_NAMES = [
        '1920x1080-thumb.jpg',
        '3840x2160-backdrop.jpg',
        '1280x720-poster.jpg',
    ];

    it.each(RESOLUTION_NAMES)('does not treat %s as an episode', (filename) => {
        expect(parseEpisodeNumbers(filename, DEFAULT_PATTERNS.episode)).toBeNull();
        expect(parseEpisodeNumbers(filename, buildPatterns([]).episode)).toBeNull();
    });

    it('still parses genuine 1x05 numbering', () => {
        expect(parseEpisodeNumbers('1x05-poster.jpg', buildPatterns([]).episode)).toEqual({
            seasonNumber: 1,
            episodeNumber: 5,
        });
    });
});

describe('ImageScannerService - configured #-runs respect their width', () => {
    it('compiles S##E### so a 3-digit episode is accepted', () => {
        const p = buildPatterns(['S##E###-thumb']);
        expect(parseEpisodeNumbers('S01E293-thumb.jpg', p.episode)).toEqual({
            seasonNumber: 1,
            episodeNumber: 293,
        });
    });

    it('keeps S##E## limited to two digits (unchanged behaviour)', () => {
        const p = buildPatterns(['S##E##-thumb']);
        expect(parseEpisodeNumbers('S01E29-thumb.jpg', p.episode)).toEqual({
            seasonNumber: 1,
            episodeNumber: 29,
        });
    });

    it('a single # still matches a zero-padded two-digit number', () => {
        // Regression guard: making '#'-runs width-aware without a floor of 2
        // compiles the shipped "season#-poster" default to \d{1}, which then
        // fails to match the real "season01-poster.jpg". A '#'-run is a field
        // marker, not a strict width.
        expect(
            parseSeasonNumber('season01-poster.jpg', buildPatterns(['season#-poster']).season),
        ).toBe(1);
        expect(
            parseSeasonNumber('season1-poster.jpg', buildPatterns(['season#-poster']).season),
        ).toBe(1);
    });
});

describe('resolveEffectiveNumbers - one resolution path for every scan scope', () => {
    const SONARR = '/data/series/Show/Season 01/Show - S01E05 - Title - Bluray-1080p-thumb.jpg';

    it('configured pattern numbers always win (operator intent is explicit)', () => {
        // Even with the release-name fallback enabled, an explicit pattern
        // match is never second-guessed.
        expect(resolveEffectiveNumbers(SONARR, 3, 9, true)).toEqual({
            effSeasonNumber: 3,
            effEpisodeNumber: 9,
        });
    });

    it('resolves a Sonarr-style name when release-name matching is enabled', () => {
        expect(resolveEffectiveNumbers(SONARR, undefined, undefined, true)).toEqual({
            effSeasonNumber: 1,
            effEpisodeNumber: 5,
        });
    });

    it('leaves it unresolved when the gate is off (library-scope default)', () => {
        // This is the pre-existing library-scope behaviour the flag preserves
        // for one release: the file is enumerated, then discarded.
        expect(resolveEffectiveNumbers(SONARR, undefined, undefined, false)).toEqual({
            effSeasonNumber: undefined,
            effEpisodeNumber: undefined,
        });
    });

    it('resolves absolute-numbered anime, the case that regressed on prod', () => {
        const boruto =
            '/data/anime/Soruto/Season 01/Soruto - Sorami Next Generations (2017) - S01E293 - 293 - Farewell [Bluray-720p]-STARS-thumb.jpg';
        expect(resolveEffectiveNumbers(boruto, undefined, undefined, true)).toEqual({
            effSeasonNumber: 1,
            effEpisodeNumber: 293,
        });
    });

    it('stays unresolved for folder-level art even when enabled', () => {
        expect(
            resolveEffectiveNumbers('/data/series/Show/backdrop.jpg', undefined, undefined, true),
        ).toEqual({ effSeasonNumber: undefined, effEpisodeNumber: undefined });
    });

    it('does not invent numbers from a resolution token', () => {
        expect(
            resolveEffectiveNumbers(
                '/data/series/Show/1920x1080-thumb.jpg',
                undefined,
                undefined,
                true,
            ),
        ).toEqual({ effSeasonNumber: undefined, effEpisodeNumber: undefined });
    });

    it('preserves a season-only match', () => {
        expect(resolveEffectiveNumbers('/x/season01-poster.jpg', 1, undefined, true)).toEqual({
            effSeasonNumber: 1,
            effEpisodeNumber: undefined,
        });
    });
});

describe("isTargetsOwnImage - a targeted scan attaches only its anchor's own files", () => {
    const AHS = '/data/series/American Horror Story/Season 13';
    const s13e01: ImageScanTarget = {
        id: 'd25ac256-6997-4a63-970e-54c6f76d54de',
        mediaType: 'episode',
        seasonNumber: 13,
        episodeNumber: 1,
        videoPaths: [`${AHS}/American Horror Story - S13E01 - 13 - WEBRip-1080p.mkv`],
    };
    const thumb = (name: string, dir = AHS) => ({
        filePath: `${dir}/${name}`,
        artworkType: 'thumb' as const,
    });

    it('rejects a STALE sidecar of a sibling (prod: S13E01 got S13E03 WEBDL)', () => {
        expect(
            isTargetsOwnImage(
                thumb('American Horror Story - S13E03 - Rauhnacht - WEBDL-1080p-thumb.jpg'),
                s13e01,
            ),
        ).toBe(false);
    });

    it("accepts the episode's own sidecar, named after its video", () => {
        expect(
            isTargetsOwnImage(
                thumb('American Horror Story - S13E01 - 13 - WEBRip-1080p-thumb.jpg'),
                s13e01,
            ),
        ).toBe(true);
    });

    it('rejects a replaced release sidecar even when its episode numbers match', () => {
        expect(
            isTargetsOwnImage(
                thumb('American Horror Story - S13E01 - 13 - WEBDL-1080p-thumb.jpg'),
                s13e01,
            ),
        ).toBe(false);
    });

    it("accepts the frame extractor's length-clamped `-<id8>-thumb` name", () => {
        expect(
            isTargetsOwnImage(thumb('American Horror Story - S13E0-d25ac256-thumb.jpg'), s13e01),
        ).toBe(true);
    });

    it('rejects a bare sibling name (prod: Real Girl E02 got E01)', () => {
        const dir = '/data/anime/Real Girl/Season 01';
        const e02: ImageScanTarget = {
            id: '11111111-0000-0000-0000-000000000000',
            mediaType: 'episode',
            seasonNumber: 1,
            episodeNumber: 2,
            videoPaths: [`${dir}/3D Kanojo Real Girl - S01E02.mp4`],
        };
        expect(isTargetsOwnImage(thumb('3D Kanojo Real Girl - S01E01-thumb.jpg', dir), e02)).toBe(
            false,
        );
        expect(isTargetsOwnImage(thumb('3D Kanojo Real Girl - S01E02-thumb.jpg', dir), e02)).toBe(
            true,
        );
    });

    it('rejects folder art with no episode of its own (season poster.jpg, Season 10/thumb.jpg)', () => {
        expect(
            isTargetsOwnImage({ filePath: `${AHS}/poster.jpg`, artworkType: 'poster' }, s13e01),
        ).toBe(false);
        expect(isTargetsOwnImage(thumb('thumb.jpg'), s13e01)).toBe(false);
    });

    it('a FILE-LESS episode owns only files that name its own episode', () => {
        const fileless: ImageScanTarget = { ...s13e01, videoPaths: [] };
        expect(
            isTargetsOwnImage(
                thumb('American Horror Story - S13E03 - Rauhnacht - WEBDL-1080p-thumb.jpg'),
                fileless,
            ),
        ).toBe(false);
        expect(isTargetsOwnImage(thumb('thumb.jpg'), fileless)).toBe(false);
    });

    it("a season owns its folder art but no episode's thumb and no other season's art", () => {
        const season: ImageScanTarget = {
            id: '22222222-0000-0000-0000-000000000000',
            mediaType: 'season',
            seasonNumber: 13,
            episodeNumber: null,
            videoPaths: [],
        };
        expect(
            isTargetsOwnImage({ filePath: `${AHS}/poster.jpg`, artworkType: 'poster' }, season),
        ).toBe(true);
        expect(
            isTargetsOwnImage(
                thumb('American Horror Story - S13E03 - Rauhnacht - WEBDL-1080p-thumb.jpg'),
                season,
            ),
        ).toBe(false);
        expect(
            isTargetsOwnImage(
                { filePath: `${AHS}/season12-poster.jpg`, artworkType: 'poster', seasonNumber: 12 },
                season,
            ),
        ).toBe(false);
    });

    it("a movie folder is unchanged — everything in it is the movie's", () => {
        const movie: ImageScanTarget = {
            id: '33333333-0000-0000-0000-000000000000',
            mediaType: 'movie',
            seasonNumber: null,
            episodeNumber: null,
            videoPaths: ['/data/movies/Film (2020)/Film (2020).mkv'],
        };
        expect(
            isTargetsOwnImage(
                { filePath: '/data/movies/Film (2020)/poster.jpg', artworkType: 'poster' },
                movie,
            ),
        ).toBe(true);
    });
});
