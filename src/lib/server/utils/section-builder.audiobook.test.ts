// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Regression test for the home "Jump back in" (Continue Watching) rail
 * relabelling audiobooks as movies.
 *
 * MEASURED SYMPTOMS ON PROD (all from ONE mistyped field):
 *   - the card rendered the popcorn placeholder instead of the book cover,
 *     because `UniversalMediaCard`'s `isAudiobook(item.mediaType)` guard was
 *     handed 'movie' and therefore asked for the (non-existent) backdrop art;
 *   - the modal URL came out as `?slug=movie-milo-farrow-…`;
 *   - the modal said "Watch Movie" / "Mark Movie as watched" and rendered no
 *     author / narrator / chapter block, because `ModalMovie` gates
 *     `ModalAudiobookDetails` on `isAudiobook(mediaType)` too.
 *
 * ROOT CAUSE: `MediaTransformerService.normalizeMediaType()` collapsed the
 * media type to a THREE-way episode/series/else decision and returned 'movie'
 * for everything else — silently relabelling every non-video type that can
 * reach the CW rail. `transformContinueWatching` (and therefore
 * `buildMergedWatchingSection`) runs every CW row through it.
 *
 * The DB row's real `media_type` survives intact all the way from
 * `getContinueWatchingFromDb` through `continueWatchingRowToItem`
 * (effective-watching.service.ts) and `arbitrateWatching` — the ONLY place it
 * is lost is that normalizer, which is why this test asserts at the section
 * boundary (the payload the browser actually receives).
 */

import { describe, it, expect } from 'vitest';
import { buildMergedWatchingSection, type ContinueWatchingItem } from './section-builder.js';

const AUDIOBOOK_UUID = '4993e963-4220-4f1e-adc0-fb475034149a';
const MOVIE_UUID = '11111111-2222-3333-4444-555555555555';
const EPISODE_UUID = '22222222-3333-4444-5555-666666666666';

/**
 * Shaped exactly like `continueWatchingRowToItem()` builds it for an
 * AudiobookShelf book: `media_type` is the canonical lowercase 'audiobook',
 * there are no provider ids (an ABS book has no TMDB/IMDB id), and `imageUrl`
 * is the poster href (the ONLY image role an audiobook resolves).
 */
function makeAudiobook(overrides: Partial<ContinueWatchingItem> = {}): ContinueWatchingItem {
    return {
        id: AUDIOBOOK_UUID,
        title: 'Milo Farrow und der Stein der Weisen - Gesprochen von Felix Vale',
        mediaType: 'audiobook',
        overview: 'Milo Farrow entdeckt eine Welt voller Magie.',
        customMetadata: {
            audiobookshelf: {
                authors: ['M.K. Fenwick'],
                narrators: ['Felix Vale'],
            },
        },
        watchProgress: 6,
        externalIds: { internal: AUDIOBOOK_UUID },
        imageUrl: `/api/media/${AUDIOBOOK_UUID}/images/poster?size=thumb`,
        resumeRatio: 0.06,
        updatedAt: new Date().toISOString(),
        source: 'continue-watching',
        ...overrides,
    };
}

describe('Continue Watching rail: audiobook media type survives the transform', () => {
    it('emits mediaType "audiobook" for an audiobook CW row (not "movie")', () => {
        const section = buildMergedWatchingSection({
            continueWatching: [makeAudiobook()],
            nextUp: [],
        });

        expect(section).not.toBeNull();
        expect(section?.items).toHaveLength(1);
        // THE bug: this was 'movie'. Every downstream audiobook guard
        // (card image role, slug kind, modal detail block, Listen button)
        // reads this one field.
        expect(section?.items[0].mediaType).toBe('audiobook');
    });

    it('does not emit a backdrop URL for an audiobook (it would 302 to the placeholder)', () => {
        const section = buildMergedWatchingSection({
            continueWatching: [makeAudiobook()],
            nextUp: [],
        });
        const item = section?.items[0];

        // ImageProxyService.getImageByCatalogId() returns null for any
        // non-'poster' role on an audiobook, and the media image route turns
        // that null into a 302 to the popcorn placeholder. An absent field is
        // strictly better than a URL guaranteed to resolve to the wrong image:
        // every consumer already falls back to the poster on its own.
        expect(item?.backdrop).toBeUndefined();
        // The poster the server already resolved must still be there.
        expect(item?.image).toBe(`/api/media/${AUDIOBOOK_UUID}/images/poster?size=thumb`);
        expect(item?.overview).toBe('Milo Farrow entdeckt eine Welt voller Magie.');
        expect(item?.customMetadata?.audiobookshelf).toEqual({
            authors: ['M.K. Fenwick'],
            narrators: ['Felix Vale'],
        });
    });

    it('still emits mediaType "movie" + a backdrop for a real movie CW row', () => {
        const section = buildMergedWatchingSection({
            continueWatching: [
                {
                    id: MOVIE_UUID,
                    title: 'Test Movie',
                    mediaType: 'movie',
                    watchProgress: 42,
                    externalIds: { internal: MOVIE_UUID, tmdb: '550' },
                    resumeRatio: 0.42,
                    updatedAt: new Date().toISOString(),
                    source: 'continue-watching',
                },
            ],
            nextUp: [],
        });

        expect(section?.items[0].mediaType).toBe('movie');
        expect(section?.items[0].backdrop).toContain('/images/backdrop');
    });

    it('still emits mediaType "episode" for an episode CW row', () => {
        const section = buildMergedWatchingSection({
            continueWatching: [
                {
                    id: EPISODE_UUID,
                    title: 'S1E1',
                    mediaType: 'episode',
                    seriesName: 'Test Series',
                    seriesId: 'series-A',
                    seasonNumber: 1,
                    episodeNumber: 1,
                    watchProgress: 30,
                    externalIds: { internal: EPISODE_UUID },
                    resumeRatio: 0.3,
                    updatedAt: new Date().toISOString(),
                    source: 'continue-watching',
                },
            ],
            nextUp: [],
        });

        expect(section?.items[0].mediaType).toBe('episode');
    });

    it('accepts the legacy UPPERCASE media-type convention via the comparator', () => {
        // media_items.media_type stores lowercase, but external/legacy clients
        // send 'AUDIOBOOK'. The normalizer must go through isAudiobook(), not
        // a bare === 'audiobook'.
        const section = buildMergedWatchingSection({
            continueWatching: [makeAudiobook({ mediaType: 'AUDIOBOOK' })],
            nextUp: [],
        });

        expect(section?.items[0].mediaType).toBe('audiobook');
        expect(section?.items[0].backdrop).toBeUndefined();
    });
});

/**
 * A book is listened to, not watched. "Playing now" is the video verb and
 * "Paused just now" is what a live listen actually rendered as, because the
 * audiobook's live session never reached the overlay at all (see
 * `live-watching-overlay.ts`, source 'audiobookshelf').
 */
describe('Continue Watching rail: audiobook resume label', () => {
    it('says "Listening now" for a live audiobook', () => {
        const section = buildMergedWatchingSection({
            continueWatching: [makeAudiobook({ livePlaybackState: 'playing' })],
            nextUp: [],
        });

        expect(section?.items[0].contextLabel).toBe('Listening now');
        expect(section?.items[0].isPlaying).toBe(true);
    });

    it('keeps the video verb for a live movie', () => {
        const section = buildMergedWatchingSection({
            continueWatching: [
                {
                    id: MOVIE_UUID,
                    title: 'Test Movie',
                    mediaType: 'movie',
                    watchProgress: 42,
                    externalIds: { internal: MOVIE_UUID, tmdb: '550' },
                    resumeRatio: 0.42,
                    updatedAt: new Date().toISOString(),
                    source: 'continue-watching',
                    livePlaybackState: 'playing',
                },
            ],
            nextUp: [],
        });

        expect(section?.items[0].contextLabel).toBe('Playing now');
    });

    it('falls back to the paused label when nothing is live', () => {
        const section = buildMergedWatchingSection({
            continueWatching: [makeAudiobook()],
            nextUp: [],
        });

        expect(section?.items[0].contextLabel).toMatch(/^Paused/);
    });
});
