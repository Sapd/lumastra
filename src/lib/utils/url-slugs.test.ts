// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';

import {
    buildEpisodeSlug,
    buildTitleSlug,
    buildWatchSlug,
    slugKindForMediaType,
} from './url-slugs';

/**
 * Example names are fictional; production shapes and measurements are retained.
 * The KIND SELECTION, not the formatting.
 *
 * `buildTitleSlug('audiobook', …)` was already covered below and always passed —
 * which is precisely why prod stayed broken: nothing tested whether anything ever
 * *chose* 'audiobook'. Both modal-URL writers hand-rolled the three-way, and the
 * one in `modal-url-sync.ts` fed it an already-collapsed 'movie' | 'tv' | 'episode'
 * value, so its `isAudiobook()` arm was dead code and an audiobook shipped as
 * `?slug=movie-milo-farrow-…`.
 */
describe('slugKindForMediaType', () => {
    it('selects audiobook for an audiobook', () => {
        expect(slugKindForMediaType('audiobook')).toBe('audiobook');
    });

    it('accepts every case convention (comparator, not string equality)', () => {
        expect(slugKindForMediaType('AUDIOBOOK')).toBe('audiobook');
        expect(slugKindForMediaType('Audiobook')).toBe('audiobook');
    });

    it('selects tv for both series spellings', () => {
        expect(slugKindForMediaType('tv')).toBe('tv');
        expect(slugKindForMediaType('series')).toBe('tv');
        expect(slugKindForMediaType('SERIES')).toBe('tv');
    });

    it('falls back to movie for movies and for unknown/absent types', () => {
        expect(slugKindForMediaType('movie')).toBe('movie');
        expect(slugKindForMediaType('MOVIE')).toBe('movie');
        expect(slugKindForMediaType('home_video')).toBe('movie');
        expect(slugKindForMediaType(undefined)).toBe('movie');
        expect(slugKindForMediaType(null)).toBe('movie');
    });

    it('composes with buildTitleSlug into the audiobook- prefixed slug', () => {
        const title = 'Milo Farrow und der Stein der Weisen';
        expect(buildTitleSlug(slugKindForMediaType('AUDIOBOOK'), title)).toBe(
            'audiobook-milo-farrow-und-der-stein-der-weisen',
        );
    });
});

describe('url-slugs', () => {
    it('builds title slugs for simple media titles', () => {
        expect(buildTitleSlug('movie', 'Quiet Orbit')).toBe('movie-quiet-orbit');
        expect(buildTitleSlug('album', 'Månelys - Glow!')).toBe('album-manelys-glow');
    });

    it('builds an audiobook slug rather than collapsing to movie', () => {
        expect(
            buildTitleSlug(
                'audiobook',
                'Milo Farrow und der Stein der Weisen, gesprochen von Felix Vale',
            ),
        ).toBe('audiobook-milo-farrow-und-der-stein-der-weisen-gesprochen-von-felix-vale');
    });

    it('builds episode slugs with season and episode tokens', () => {
        expect(buildEpisodeSlug('Drifting Clouds', 2, 4)).toBe('tv-drifting-clouds-s02e04');
    });

    it('builds watch slugs for playable items', () => {
        expect(
            buildWatchSlug({
                mediaType: 'episode',
                title: 'Four Nights Out',
                seriesTitle: 'Drifting Clouds',
                seasonNumber: 2,
                episodeNumber: 4,
            }),
        ).toBe('tv-drifting-clouds-s02e04');

        expect(
            buildWatchSlug({
                mediaType: 'movie',
                title: 'Quiet Orbit',
            }),
        ).toBe('movie-quiet-orbit');
    });
});
