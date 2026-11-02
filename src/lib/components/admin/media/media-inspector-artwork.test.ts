// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The artwork decision table. Pure data — no DOM, so nothing here depends on
 * happy-dom's (absent) layout engine. These assert WHICH role is requested for
 * a type and in what order; whether the resulting image looks right, fits, or
 * exists at all is the server's business and is not provable here.
 */

import { describe, it, expect } from 'vitest';
import { INTERNAL_MEDIA_TYPES } from '$lib/shared/media-type-domain';
import { artworkCandidatesFor, artworkShapeOf } from './media-inspector-artwork.js';

describe('artworkCandidatesFor — coverage of the vocabulary', () => {
    it('answers for every internal media type without falling through to a default', () => {
        // The compile-time guarantee is the Record's completeness check; this
        // is its runtime twin, and it also pins `toInternalMediaType` actually
        // recognising each stored token. A type added to INTERNAL_MEDIA_TYPES
        // and forgotten here cannot reach this assertion (it is a type error
        // first), but a type whose *alias* handling regresses can.
        for (const type of INTERNAL_MEDIA_TYPES) {
            expect(Array.isArray(artworkCandidatesFor(type))).toBe(true);
        }
    });

    it('returns an empty chain for an unrecognised type rather than guessing a movie', () => {
        // "I don't know what this is" must not become a confident request for
        // a movie backdrop — that is the exact failure mode media-type-domain
        // exists to prevent.
        expect(artworkCandidatesFor('quiche')).toEqual([]);
        expect(artworkCandidatesFor('')).toEqual([]);
        expect(artworkCandidatesFor(undefined)).toEqual([]);
    });

    it('normalises input aliases onto the stored type', () => {
        const tv = artworkCandidatesFor('tv');
        expect(artworkCandidatesFor('Series')).toEqual(tv);
        expect(artworkCandidatesFor('show')).toEqual(tv);
    });
});

describe('artworkCandidatesFor — the per-type decisions', () => {
    it('leads with the backdrop for movies and series', () => {
        // Shape, not taste: a 2:3 poster costs ~630px of height at the panel's
        // 420px width and buries State/Health/Actions.
        expect(artworkCandidatesFor('movie')[0]).toBe('backdrop');
        expect(artworkCandidatesFor('tv')[0]).toBe('backdrop');
    });

    it('falls back to the poster for movies and series rather than showing nothing', () => {
        expect(artworkCandidatesFor('movie')).toEqual(['backdrop', 'poster']);
        expect(artworkCandidatesFor('tv')).toEqual(['backdrop', 'poster']);
    });

    it('inverts the order for a season: poster first, backdrop second', () => {
        // A season's backdrop INHERITS from the series, so backdrop-first
        // renders the identical image for all eight seasons and proves nothing
        // about which one is selected. Copying the movie/tv chain here is the
        // obvious-looking "consistency" fix that breaks it.
        expect(artworkCandidatesFor('season')).toEqual(['poster', 'backdrop']);
    });

    it('asks an episode for its OWN still and never for a backdrop', () => {
        // `thumb` is the only role that resolves an episode's own frame;
        // `backdrop` inherits from the season/series (see image-utils.ts).
        const episode = artworkCandidatesFor('episode');
        expect(episode[0]).toBe('thumb');
        expect(episode).not.toContain('backdrop');
    });

    it('never asks a book-shaped type for a backdrop', () => {
        // ImageProxyService deliberately serves no backdrop for a book rather
        // than stretching its cover, so every such request is a known miss.
        for (const type of ['audiobook', 'book', 'manga', 'comic', 'podcast'] as const) {
            expect(artworkCandidatesFor(type)).not.toContain('backdrop');
        }
    });

    it('asks music types for cover art only', () => {
        for (const type of ['artist', 'album', 'track', 'audio'] as const) {
            expect(artworkCandidatesFor(type)).toEqual(['poster']);
        }
    });

    it('asks for nothing at all for library markers and bookkeeping rows', () => {
        // An empty chain is what keeps arrow-walking a folder of provider-leaked
        // rows from firing a guaranteed 404 per keypress.
        for (const type of ['music', 'anfragen', 'sonarr', 'radarr'] as const) {
            expect(artworkCandidatesFor(type)).toEqual([]);
        }
    });
});

describe('artworkShapeOf', () => {
    it('lays landscape roles out full-width and the poster inline', () => {
        expect(artworkShapeOf('backdrop')).toBe('hero');
        expect(artworkShapeOf('thumb')).toBe('hero');
        // A poster rendered `hero` would either cost ~630px of height or be
        // cropped to a meaningless middle band of itself.
        expect(artworkShapeOf('poster')).toBe('inline');
    });
});
