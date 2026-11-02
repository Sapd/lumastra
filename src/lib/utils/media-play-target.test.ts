// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A card's play button sent an audiobook to `/watch/{id}` — the VIDEO route,
 * which 404s every non-video type. `getPlayableId()` returns a book's UUID just
 * like a movie's, so every `if (playableId) navigateToWatch(...)` gate passed.
 *
 * The case-convention cases are not decoration: `media_items.media_type` stores
 * `'audiobook'`, Jellyfin says `'AudioBook'`, and legacy/tvOS clients send
 * `'AUDIOBOOK'`. A bare `=== 'audiobook'` would pass the first and ship the bug
 * for the other two.
 */

import { describe, it, expect } from 'vitest';
import {
    buildWatchUrlWithPosition,
    continueTargetFor,
    resolveMediaPlayTarget,
} from './media-play-target';

const BOOK_UUID = '11111111-2222-4333-8444-555555555555';
const MOVIE_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('resolveMediaPlayTarget', () => {
    for (const mediaType of ['audiobook', 'AudioBook', 'AUDIOBOOK']) {
        it(`sends mediaType='${mediaType}' to the audiobook player, never /watch`, () => {
            expect(
                resolveMediaPlayTarget({
                    mediaType,
                    id: BOOK_UUID,
                    externalIds: { internal: BOOK_UUID },
                    hasFiles: true,
                }),
            ).toEqual({ kind: 'audiobook', mediaId: BOOK_UUID });
        });
    }

    it('prefers the internal UUID over a Jellyfin id for a book', () => {
        // The audiobook session route resolves media_items.id; a Jellyfin id
        // would 404 there.
        expect(
            resolveMediaPlayTarget({
                mediaType: 'audiobook',
                id: 'not-a-uuid',
                externalIds: { internal: BOOK_UUID, jellyfin: 'jf-123' },
            }),
        ).toEqual({ kind: 'audiobook', mediaId: BOOK_UUID });
    });

    it('delegates a book with no internal UUID rather than guessing', () => {
        expect(
            resolveMediaPlayTarget({
                mediaType: 'audiobook',
                id: 'not-a-uuid',
                externalIds: { jellyfin: 'jf-123' },
            }),
        ).toEqual({ kind: 'delegate' });
    });

    it('keeps movies on the /watch route', () => {
        expect(
            resolveMediaPlayTarget({
                mediaType: 'movie',
                id: MOVIE_UUID,
                externalIds: { internal: MOVIE_UUID },
            }),
        ).toEqual({ kind: 'watch', playbackId: MOVIE_UUID });
    });

    it('does not play a Jellyfin id (only the internal id is playable)', () => {
        expect(
            resolveMediaPlayTarget({
                mediaType: 'episode',
                externalIds: { jellyfin: 'jf-456' } as { internal?: string },
            }),
        ).toEqual({ kind: 'delegate' });
    });

    it('delegates a discovery-only item (no local file)', () => {
        expect(
            resolveMediaPlayTarget({
                mediaType: 'movie',
                id: MOVIE_UUID,
                hasFiles: false,
            }),
        ).toEqual({ kind: 'delegate' });
    });
});

describe('buildWatchUrlWithPosition', () => {
    it('omits ?t= without a preview position', () => {
        expect(buildWatchUrlWithPosition(MOVIE_UUID)).toBe(`/watch/${MOVIE_UUID}`);
    });

    it('omits ?t= at position 0', () => {
        expect(buildWatchUrlWithPosition(MOVIE_UUID, 0)).toBe(`/watch/${MOVIE_UUID}`);
    });

    it('floors a fractional preview position into ?t=', () => {
        expect(buildWatchUrlWithPosition(MOVIE_UUID, 42.7)).toBe(`/watch/${MOVIE_UUID}?t=42`);
    });
});

describe('continueTargetFor', () => {
    const SERIES_UUID = '99999999-8888-4777-8666-555555555555';

    it('a resumed episode with a seriesId continues the series', () => {
        expect(
            continueTargetFor({ mediaType: 'episode', seriesId: SERIES_UUID, progress: 42 }),
        ).toBe(SERIES_UUID);
    });

    it('a resumed season-0 special plays itself, never the series marker', () => {
        expect(
            continueTargetFor({
                mediaType: 'episode',
                seriesId: SERIES_UUID,
                seasonNumber: 0,
                progress: 42,
            }),
        ).toBeNull();
        expect(
            continueTargetFor({
                mediaType: 'episode',
                seriesId: SERIES_UUID,
                seasonNumber: 2,
                progress: 42,
            }),
        ).toBe(SERIES_UUID);
    });

    it('accepts any media-type case convention for the episode check', () => {
        expect(
            continueTargetFor({ mediaType: 'Episode', seriesId: SERIES_UUID, progress: 5 }),
        ).toBe(SERIES_UUID);
    });

    it('an episode without resume progress keeps its own target', () => {
        expect(
            continueTargetFor({ mediaType: 'episode', seriesId: SERIES_UUID, progress: 0 }),
        ).toBeNull();
        expect(continueTargetFor({ mediaType: 'episode', seriesId: SERIES_UUID })).toBeNull();
    });

    it('an episode without a seriesId keeps its own target', () => {
        expect(continueTargetFor({ mediaType: 'episode', progress: 42 })).toBeNull();
    });

    it('movies are never redirected to a series', () => {
        expect(
            continueTargetFor({ mediaType: 'movie', seriesId: SERIES_UUID, progress: 42 }),
        ).toBeNull();
    });
});
