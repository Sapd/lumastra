// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    pickFallbackAlbumPosterImageName,
    artworkTypeFromStem,
    seasonArtworkFromStem,
    extraTypeFromFilename,
    parseExtraFilename,
    isExtrasFilePath,
    providerSourceTag,
    seasonArtworkFileName,
} from './media-extras.js';

describe('parseExtraFilename — base name for sibling matching', () => {
    it('strips the suffix to the base stem', () => {
        expect(parseExtraFilename('B-trailer.mkv')).toEqual({
            extraType: 'trailer',
            baseName: 'B',
        });
        expect(parseExtraFilename('Best Movie (2019)-behindthescenes.mkv')).toEqual({
            extraType: 'behind_the_scenes',
            baseName: 'Best Movie (2019)',
        });
        expect(parseExtraFilename('Ep05-deletedscene.mkv')).toEqual({
            extraType: 'deleted_scene',
            baseName: 'Ep05',
        });
    });

    it('handles trailer with each separator', () => {
        expect(parseExtraFilename('Movie.trailer.mkv')?.baseName).toBe('Movie');
        expect(parseExtraFilename('Movie_trailer.mkv')?.baseName).toBe('Movie');
        expect(parseExtraFilename('Making Of trailer.mp4')?.baseName).toBe('Making Of');
    });

    it('standalone trailer has an empty base name', () => {
        expect(parseExtraFilename('trailer.mp4')).toEqual({ extraType: 'trailer', baseName: '' });
    });

    it('returns null for a normal media file', () => {
        expect(parseExtraFilename('The Lantern (1999).mkv')).toBeNull();
        expect(parseExtraFilename('Crime Scene.mkv')).toBeNull();
    });
});

describe('extraTypeFromFilename — filename-suffix / single-file extras', () => {
    it('recognises standalone trailer.mp4', () => {
        expect(extraTypeFromFilename('trailer.mp4')).toBe('trailer');
    });

    it('recognises trailer with -, ., _ and space separators', () => {
        expect(extraTypeFromFilename('Movie-trailer.mkv')).toBe('trailer');
        expect(extraTypeFromFilename('Preview.trailer.mkv')).toBe('trailer');
        expect(extraTypeFromFilename('Movie_trailer.mkv')).toBe('trailer');
        expect(extraTypeFromFilename('Making Of trailer.mp4')).toBe('trailer');
    });

    it('recognises hyphen-suffixed extras keywords', () => {
        expect(extraTypeFromFilename('Making of-behindthescenes.mkv')).toBe('behind_the_scenes');
        expect(extraTypeFromFilename('Cut-deleted.mkv')).toBe('deleted_scene');
        expect(extraTypeFromFilename('X-deletedscene.mkv')).toBe('deleted_scene');
        expect(extraTypeFromFilename('X-featurette.mkv')).toBe('featurette');
        expect(extraTypeFromFilename('X-interview.mkv')).toBe('interview');
        expect(extraTypeFromFilename('X-scene.mkv')).toBe('scene');
        expect(extraTypeFromFilename('X-clip.mkv')).toBe('extra');
        expect(extraTypeFromFilename('X-short.mkv')).toBe('short');
        expect(extraTypeFromFilename('X-other.mkv')).toBe('extra');
        expect(extraTypeFromFilename('X-extra.mkv')).toBe('extra');
    });

    it('does NOT misclassify ordinary titles (space-separated keyword)', () => {
        expect(extraTypeFromFilename('Crime Scene.mkv')).toBeNull();
        expect(extraTypeFromFilename('Extra Innings (2019).mkv')).toBeNull();
        expect(extraTypeFromFilename('The Interview (2014).mkv')).toBeNull();
        expect(extraTypeFromFilename('Deleted (2005).mkv')).toBeNull();
    });

    it('does NOT treat a normal movie file as an extra', () => {
        expect(extraTypeFromFilename('The Lantern (1999).mkv')).toBeNull();
        expect(extraTypeFromFilename('Movie-1080p.mkv')).toBeNull();
        expect(extraTypeFromFilename('Movie-directors-cut.mkv')).toBeNull();
    });

    it('sample files are not treated as extras (left to the sample skip)', () => {
        expect(extraTypeFromFilename('Movie-sample.mkv')).toBeNull();
        expect(extraTypeFromFilename('sample.mkv')).toBeNull();
    });
});

describe('isExtrasFilePath — single source of truth for "is this path an extra"', () => {
    it('judges only the segments below the library root (a library at /media/Shorts is not extras)', () => {
        expect(isExtrasFilePath('/media/Shorts/Film (2020)/Film (2020).mkv', '/media/Shorts')).toBe(
            false,
        );
        expect(isExtrasFilePath('/mnt/Extras/tv/Show/Season 1/S01E01.mkv', '/mnt/Extras/tv')).toBe(
            false,
        );
        expect(isExtrasFilePath('/media/Shorts/Film (2020)/trailers/t.mkv', '/media/Shorts')).toBe(
            true,
        );
        expect(
            isExtrasFilePath('/media/Shorts/Film (2020)/Film-trailer.mkv', '/media/Shorts/'),
        ).toBe(true);
    });

    it('matches every EXTRAS_FOLDER_MAP subfolder name, case-insensitively', () => {
        const folderNames = [
            'behind the scenes',
            'trailers',
            'featurettes',
            'deleted scenes',
            'interviews',
            'scenes',
            'shorts',
            'extras',
            'bonus',
            'bonus disc',
        ];
        for (const folder of folderNames) {
            expect(isExtrasFilePath(`/data/movies/Film (2020)/${folder}/Film-clip.mkv`)).toBe(true);
            expect(isExtrasFilePath(`/data/movies/Film (2020)/${folder.toUpperCase()}/x.mkv`)).toBe(
                true,
            );
        }
    });

    it('matches a filename-suffix extra beside the primary (no subfolder)', () => {
        expect(isExtrasFilePath('/data/movies/Film (2020)/trailer.mp4')).toBe(true);
        expect(isExtrasFilePath('/data/movies/Film (2020)/Film-trailer.mkv')).toBe(true);
        expect(isExtrasFilePath('/data/movies/Film (2020)/Film-behindthescenes.mkv')).toBe(true);
        expect(isExtrasFilePath('/data/movies/Film (2020)/Film-deleted.mkv')).toBe(true);
        expect(isExtrasFilePath('/data/movies/Film (2020)/Film.trailer.mkv')).toBe(true);
        expect(isExtrasFilePath('/data/movies/Film (2020)/Film_trailer.mkv')).toBe(true);
    });

    it('handles Windows-style backslash separators', () => {
        expect(isExtrasFilePath('C:\\movies\\Film (2020)\\trailers\\Film-trailer.mkv')).toBe(true);
    });

    it('does NOT misclassify ordinary titles that merely contain an extras keyword', () => {
        expect(isExtrasFilePath('/data/movies/Crime Scene (2020)/Crime Scene (2020).mkv')).toBe(
            false,
        );
        expect(isExtrasFilePath('/data/movies/Extra Innings (2019)/Extra Innings.mkv')).toBe(false);
    });

    it('does NOT misclassify a multi-part edition as an extra', () => {
        expect(isExtrasFilePath('/data/movies/Film (2020)/Film-cd1.mkv')).toBe(false);
        expect(isExtrasFilePath('/data/movies/Film (2020)/Film-part1.mkv')).toBe(false);
        expect(isExtrasFilePath("/data/movies/Film (2020)/Film-director's cut.mkv")).toBe(false);
    });

    it('does NOT treat a normal primary video as an extra', () => {
        expect(isExtrasFilePath('/data/movies/Film (2020)/Film (2020).mkv')).toBe(false);
        expect(
            isExtrasFilePath(
                '/data/movies/Cinderella (1950) [imdbid-tt0042332]/Cinderella (1950) [imdbid-tt0042332].mkv',
            ),
        ).toBe(false);
    });
});

describe('artworkTypeFromStem — Jellyfin/Kodi aliases', () => {
    it('recognises existing poster/backdrop/logo/thumb/banner names', () => {
        expect(artworkTypeFromStem('folder')).toBe('poster');
        expect(artworkTypeFromStem('poster')).toBe('poster');
        expect(artworkTypeFromStem('cover')).toBe('poster');
        expect(artworkTypeFromStem('backdrop')).toBe('backdrop');
        expect(artworkTypeFromStem('backdrop2')).toBe('backdrop');
        expect(artworkTypeFromStem('logo')).toBe('logo');
        expect(artworkTypeFromStem('thumb')).toBe('thumb');
        expect(artworkTypeFromStem('banner')).toBe('banner');
    });

    it('recognises Kodi backdrop aliases (fanart/background/art)', () => {
        expect(artworkTypeFromStem('fanart')).toBe('backdrop');
        expect(artworkTypeFromStem('fanart1')).toBe('backdrop');
        expect(artworkTypeFromStem('background')).toBe('backdrop');
        expect(artworkTypeFromStem('art')).toBe('backdrop');
    });

    it('recognises poster aliases (default/movie/show/jacket)', () => {
        expect(artworkTypeFromStem('default')).toBe('poster');
        expect(artworkTypeFromStem('movie')).toBe('poster');
        expect(artworkTypeFromStem('show')).toBe('poster');
        expect(artworkTypeFromStem('jacket')).toBe('poster');
    });

    it('recognises clearlogo as a logo', () => {
        expect(artworkTypeFromStem('clearlogo')).toBe('logo');
    });

    it('leaves unstored/official-client-unused types unrecognised', () => {
        expect(artworkTypeFromStem('disc')).toBeNull();
        expect(artworkTypeFromStem('discart')).toBeNull();
        expect(artworkTypeFromStem('clearart')).toBeNull();
        expect(artworkTypeFromStem('random')).toBeNull();
    });
});

describe('pickFallbackAlbumPosterImageName', () => {
    it('does not accept a single neutral scene-release image', () => {
        expect(
            pickFallbackAlbumPosterImageName(['000-va-beat_hits_vol.59-bootleg-2cd-2012.png']),
        ).toBeNull();
    });

    it('prefers a unique front or cover image over non-poster scans', () => {
        expect(
            pickFallbackAlbumPosterImageName([
                'disc.png',
                'album-front.webp',
                'booklet.jpg',
                'back.jpg',
            ]),
        ).toBe('album-front.webp');
    });

    it('accepts a single image with clear cover wording', () => {
        expect(pickFallbackAlbumPosterImageName(['album-art.jpg'])).toBe('album-art.jpg');
    });

    it('does not guess between multiple neutral images', () => {
        expect(pickFallbackAlbumPosterImageName(['image-a.jpg', 'image-b.jpg'])).toBeNull();
    });

    it('does not guess when the best-ranked candidates tie', () => {
        expect(pickFallbackAlbumPosterImageName(['album-art.jpg', 'artwork.png'])).toBeNull();
    });

    it('does not use one neutral image when every other image is explicitly non-poster', () => {
        expect(
            pickFallbackAlbumPosterImageName([
                'release.jpg',
                'back.jpg',
                'disc1.png',
                'booklet01.webp',
            ]),
        ).toBeNull();
    });
});

describe('seasonArtworkFromStem — flat season convention in the series root', () => {
    it('parses a zero-padded season number', () => {
        expect(seasonArtworkFromStem('season01-poster')).toEqual({
            artworkType: 'poster',
            seasonNumber: 1,
            suffix: 'poster',
        });
        expect(seasonArtworkFromStem('season12-backdrop')).toEqual({
            artworkType: 'backdrop',
            seasonNumber: 12,
            suffix: 'backdrop',
        });
    });

    it('maps the specials label to season 0', () => {
        expect(seasonArtworkFromStem('season-specials-poster')).toEqual({
            artworkType: 'poster',
            seasonNumber: 0,
            suffix: 'poster',
        });
        // Sonarr also writes the numeric form for specials.
        expect(seasonArtworkFromStem('season00-poster')).toEqual({
            artworkType: 'poster',
            seasonNumber: 0,
            suffix: 'poster',
        });
    });

    it('is case-insensitive and accepts an unpadded number', () => {
        expect(seasonArtworkFromStem('Season1-Poster')).toEqual({
            artworkType: 'poster',
            seasonNumber: 1,
            suffix: 'Poster',
        });
        expect(seasonArtworkFromStem('SEASON-SPECIALS-POSTER')).toEqual({
            artworkType: 'poster',
            seasonNumber: 0,
            suffix: 'POSTER',
        });
    });

    it('reuses the Kodi alias vocabulary for the suffix', () => {
        expect(seasonArtworkFromStem('season01-fanart')).toEqual({
            artworkType: 'backdrop',
            seasonNumber: 1,
            suffix: 'fanart',
        });
        expect(seasonArtworkFromStem('season01-clearlogo')).toEqual({
            artworkType: 'logo',
            seasonNumber: 1,
            suffix: 'clearlogo',
        });
        expect(seasonArtworkFromStem('season01-thumb')).toEqual({
            artworkType: 'thumb',
            seasonNumber: 1,
            suffix: 'thumb',
        });
    });

    it('rejects banner — it is not a materializable type, so it round-trips to nothing', () => {
        expect(seasonArtworkFromStem('season01-banner')).toBeNull();
    });

    it('rejects the Kodi all-seasons label (it names no single season)', () => {
        expect(seasonArtworkFromStem('season-all-poster')).toBeNull();
    });

    it('rejects stems that are not the season convention', () => {
        expect(seasonArtworkFromStem('poster')).toBeNull();
        expect(seasonArtworkFromStem('folder')).toBeNull();
        expect(seasonArtworkFromStem('season01poster')).toBeNull();
        expect(seasonArtworkFromStem('seasons-poster')).toBeNull();
        expect(seasonArtworkFromStem('season01-random')).toBeNull();
        expect(seasonArtworkFromStem('')).toBeNull();
    });

    it('round-trips the filenames the write side produces', () => {
        // The materializer names its season files `season{NN}-{type}.jpg`
        // (season 0 -> `season-specials-{type}.jpg`). Read and write MUST agree,
        // or a materialized file is re-registered onto the wrong item next scan.
        expect(seasonArtworkFromStem('season01-poster')?.seasonNumber).toBe(1);
        expect(seasonArtworkFromStem('season-specials-poster')?.seasonNumber).toBe(0);
    });
});

describe('artworkTypeFromStem — REGRESSION LOCK (music callsites must not shift)', () => {
    // Two music callsites call artworkTypeFromStem directly on album image
    // names: findSingleDirectAlbumImage (audio-processor.ts:411) and
    // albumDirHasDirectArtworkCandidate (file-scanner.ts:140). Widening it
    // would change album cover selection. Unit 4 adds a SEPARATE classifier
    // instead; this lock fails if anyone folds the season convention in here.
    it('still returns null for every season-convention stem', () => {
        expect(artworkTypeFromStem('season01-poster')).toBeNull();
        expect(artworkTypeFromStem('season-specials-poster')).toBeNull();
        expect(artworkTypeFromStem('season12-backdrop')).toBeNull();
        expect(artworkTypeFromStem('season01-fanart')).toBeNull();
    });

    it('still classifies album image stems exactly as before', () => {
        expect(artworkTypeFromStem('cover')).toBe('poster');
        expect(artworkTypeFromStem('folder')).toBe('poster');
        expect(artworkTypeFromStem('front')).toBe('poster');
        expect(artworkTypeFromStem('poster')).toBe('poster');
        expect(artworkTypeFromStem('back')).toBeNull();
        expect(artworkTypeFromStem('disc')).toBeNull();
        expect(artworkTypeFromStem('booklet01')).toBeNull();
        expect(artworkTypeFromStem('album-front')).toBeNull();
    });
});

describe('providerSourceTag', () => {
    it('produces a tag isManagedArtworkFile classifies as managed', () => {
        expect(providerSourceTag('tmdb', 'poster')).toBe('provider:tmdb:poster');
        expect(providerSourceTag('tmdb', 'poster').startsWith('provider:')).toBe(true);
    });

    it('carries the provider row name, not a hardcoded provider', () => {
        expect(providerSourceTag('aggregated', 'backdrop')).toBe('provider:aggregated:backdrop');
        expect(providerSourceTag('tvdb', 'logo')).toBe('provider:tvdb:logo');
    });

    it('never produces an admin: tag (admin tags clear suppressions)', () => {
        for (const type of ['poster', 'backdrop', 'logo', 'thumb'] as const) {
            expect(providerSourceTag('tmdb', type).startsWith('admin:')).toBe(false);
        }
    });
});

describe('seasonArtworkFileName', () => {
    it('zero-pads the season number', () => {
        expect(seasonArtworkFileName('poster', 1, '.jpg')).toBe('season01-poster.jpg');
        expect(seasonArtworkFileName('poster', 9, '.jpg')).toBe('season09-poster.jpg');
    });

    it('does not pad past two digits', () => {
        expect(seasonArtworkFileName('poster', 12, '.jpg')).toBe('season12-poster.jpg');
        expect(seasonArtworkFileName('poster', 123, '.png')).toBe('season123-poster.png');
    });

    it('maps season 0 to the specials label', () => {
        expect(seasonArtworkFileName('poster', 0, '.jpg')).toBe('season-specials-poster.jpg');
    });

    it('carries the artwork type and the extension through', () => {
        expect(seasonArtworkFileName('backdrop', 2, '.webp')).toBe('season02-backdrop.webp');
    });
});
