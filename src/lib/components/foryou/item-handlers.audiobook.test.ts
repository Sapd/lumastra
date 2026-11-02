// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * `handleItemPlay` is the ▶ handler behind the For-You / Continue Watching
 * ("Continue listening") strip and the recommendation feed. Its music arm only
 * covers track/album/artist, so an audiobook fell through to
 * `navigateToWatch()` — the VIDEO route, which hard-404s a book. Continue
 * Watching is exactly where books and episodes share a rail, so this is the
 * surface where it happened.
 */

import { describe, expect, test, vi, beforeEach } from 'vitest';

// vi.hoisted: the mock factories below are hoisted above these declarations, and
// this module graph pulls in UniversalMediaCard (→ the music store) early enough
// that a plain `const` is still uninitialised when the factory runs.
const { navigateToWatch, playAudiobook, musicPlay } = vi.hoisted(() => ({
    navigateToWatch: vi.fn(async (_key: string) => {}),
    playAudiobook: vi.fn(async (_mediaId: string, _options?: unknown) => true),
    musicPlay: vi.fn(),
}));

vi.mock('$lib/stores/watch-navigation', () => ({
    navigateToWatch: (key: string) => navigateToWatch(key),
    getWatchUrl: (key: string) => `/watch/${key}`,
}));
// Forwards every argument: a `{ positionMs }` sneaking in must be visible to the
// argument-list assertion below.
vi.mock('$lib/services/audiobook-playback', () => ({
    playAudiobook: (id: string, options?: unknown) =>
        options === undefined ? playAudiobook(id) : playAudiobook(id, options),
    audiobookStartFailureMessage: () => 'could not start',
}));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('$lib/stores/music-player.store', () => ({
    musicPlayerStore: { play: musicPlay },
}));
// The module graph reaches modal-utils → $env/dynamic/public, which has no
// runtime env object under vitest.
vi.mock('$env/dynamic/public', () => ({ env: {} }));

import { handleItemPlay } from './item-handlers';
import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';

const BOOK_UUID = '11111111-2222-4333-8444-555555555555';
const MOVIE_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const section = { id: 'continue-watching', type: 'standard' } as unknown as PageSection;

function play(item: UniversalMediaItem): void {
    handleItemPlay({ section, item }, false, '', false);
}

const book: UniversalMediaItem = {
    id: BOOK_UUID,
    externalIds: { internal: BOOK_UUID },
    mediaType: 'audiobook',
    title: 'Der Sternwind',
    image: `/api/media/${BOOK_UUID}/images/poster`,
    isAvailable: true,
    hasFiles: true,
    canRequest: false,
    progress: 37,
};

describe('handleItemPlay', () => {
    beforeEach(() => {
        navigateToWatch.mockClear();
        playAudiobook.mockClear();
        musicPlay.mockClear();
    });

    // The card type only admits lowercase, but the value is a runtime string
    // that arrives from Jellyfin (PascalCase) and legacy clients (UPPERCASE) at
    // other boundaries — hence the cast and hence a comparator, not `===`.
    for (const mediaType of ['audiobook', 'AudioBook', 'AUDIOBOOK'] as Array<
        UniversalMediaItem['mediaType']
    >) {
        test(`starts the audiobook player for mediaType='${mediaType}'`, () => {
            play({ ...book, mediaType });

            expect(playAudiobook).toHaveBeenCalledWith(BOOK_UUID);
            // Argument LIST: no position is threaded, so the client cannot
            // overwrite AudiobookShelf's own progress.
            expect(playAudiobook.mock.calls[0]).toHaveLength(1);
            expect(navigateToWatch).not.toHaveBeenCalled();
        });
    }

    test('still navigates a movie to /watch', () => {
        play({
            id: MOVIE_UUID,
            externalIds: { internal: MOVIE_UUID },
            mediaType: 'movie',
            title: 'Haze',
            image: `/api/media/${MOVIE_UUID}/images/poster`,
            isAvailable: true,
            hasFiles: true,
            canRequest: false,
        });

        expect(navigateToWatch).toHaveBeenCalledWith(MOVIE_UUID);
        expect(playAudiobook).not.toHaveBeenCalled();
    });

    test('still routes a track to the music player', () => {
        play({
            id: MOVIE_UUID,
            externalIds: { internal: MOVIE_UUID },
            mediaType: 'track',
            title: 'Fat Lip',
            image: '',
            isAvailable: true,
            canRequest: false,
        });

        expect(musicPlay).toHaveBeenCalled();
        expect(navigateToWatch).not.toHaveBeenCalled();
        expect(playAudiobook).not.toHaveBeenCalled();
    });
});
