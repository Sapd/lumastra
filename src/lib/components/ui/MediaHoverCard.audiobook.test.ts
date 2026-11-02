// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Wiring test for the audiobook hover popup.
 *
 * `media-hover-decisions.test.ts` proves the decision tables. This file proves
 * MediaHoverCard actually CONSULTS them — the failure mode this bug family keeps
 * repeating is a guard that reads correctly at the point of inspection and is
 * never reached (see the header of `no-comparator-on-narrowed-media-type`). So
 * this mounts the real component, hovers a real audiobook Continue Watching
 * card, and asserts on the two observables the user reported:
 *
 *   1. no preview session is opened (there is no video in a book), and
 *   2. the play button starts the audiobook player instead of navigating to
 *      `/watch/{id}`.
 */

import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRawSnippet } from 'svelte';
import { readable } from 'svelte/store';

const goto = vi.fn(async (_url: string) => {});
const playAudiobook = vi.fn(async (_mediaId: string, _options?: unknown) => true);
const createPreviewSession = vi.fn(async (..._args: unknown[]) => ({
    error: 'not expected',
    data: null,
}));

vi.mock('$app/navigation', () => ({ goto: (url: string) => goto(url), beforeNavigate: () => {} }));
vi.mock('$app/stores', () => ({
    page: readable({ data: { features: {}, user: {} }, url: new URL('http://localhost/') }),
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/services/audiobook-playback', () => ({
    // Forwards EVERY argument on purpose: the assertion below is
    // toHaveBeenCalledWith(BOOK_UUID) exactly, so a second `{ positionMs }`
    // argument must be visible to it. A wrapper that dropped extra args would
    // make the "no position is threaded" claim untestable.
    playAudiobook: (id: string, options?: unknown) =>
        options === undefined ? playAudiobook(id) : playAudiobook(id, options),
    audiobookStartFailureMessage: () => 'could not start',
}));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
// MediaPreviewPlayer's only way to obtain a stream. If a preview is attempted
// for a book, this is what would fire.
vi.mock('$lib/api/playback', () => ({
    releasePreviewPlayback: vi.fn(),
    createPreviewSession: (...args: unknown[]) => createPreviewSession(...args),
}));
// happy-dom cannot lay out a floating element; positioning is not under test.
vi.mock('@floating-ui/dom', () => ({
    computePosition: async () => ({ x: 0, y: 0, placement: 'top', strategy: 'absolute' }),
    autoUpdate: () => () => {},
    offset: () => ({}),
    shift: () => ({}),
    flip: () => ({}),
}));
vi.mock('$lib/utils/video-player-utils', () => ({
    ensureYouTubeApi: () => {},
    waitForYouTubeApi: () => {},
    createYouTubePlayer: () => null,
    destroyYouTubePlayer: () => null,
    calculateSmartPreviewPosition: () => ({ x: 0, y: 0 }),
    PREVIEW_FALLBACK_START_SECONDS: 0,
}));

import MediaHoverCard from './MediaHoverCard.svelte';
// The REAL exclusive-audio store (not mocked): the audiobook path must not leave
// a preview owner behind, which would keep every other player muted.
import { previewAudio } from '$lib/stores/preview-audio.svelte';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';

const BOOK_UUID = '11111111-2222-4333-8444-555555555555';
const MOVIE_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/**
 * Exactly what `audiobookProgressToEntry()` puts in the Continue Watching rail:
 * available, has files, real progress. The progress is what turned the stream
 * preview on — `isContinueWatchingItem` is the arm that fired.
 */
const audiobookItem: UniversalMediaItem = {
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

const movieItem: UniversalMediaItem = {
    id: MOVIE_UUID,
    externalIds: { internal: MOVIE_UUID },
    mediaType: 'movie',
    title: 'Haze',
    image: `/api/media/${MOVIE_UUID}/images/poster`,
    isAvailable: true,
    hasFiles: true,
    canRequest: false,
    progress: 37,
};

/** The wrapped card. `[data-play-button]` is what arms the hover intent. */
const cardSnippet = createRawSnippet(() => ({
    render: () => '<div data-play-button data-testid="card">card</div>',
}));

/** Hover the card and let the two rAF hops that build the popup run. */
async function hover(): Promise<void> {
    const card = document.querySelector('[data-play-button]');
    if (!card) throw new Error('card not rendered');
    await fireEvent.mouseOver(card);
    for (let i = 0; i < 4; i++) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
}

function popupPlayButton(): HTMLElement {
    const btn = document.querySelector('[data-action="play"]');
    if (!(btn instanceof HTMLElement)) throw new Error('popup play button not rendered');
    return btn;
}

describe('MediaHoverCard — audiobook', () => {
    beforeEach(() => {
        goto.mockClear();
        playAudiobook.mockClear();
        createPreviewSession.mockClear();
    });

    afterEach(() => {
        cleanup();
        document.body.querySelectorAll('.media-hover-portal').forEach((el) => {
            el.textContent = '';
        });
    });

    test('opens no preview session for a book', async () => {
        render(MediaHoverCard, {
            item: audiobookItem,
            children: cardSnippet,
            trailersEnabled: true,
            videoPreviewEnabled: true,
            delay: 0,
            videoLoadDelay: 0,
        });
        await hover();

        // The popup itself must still open — the still cover is the point.
        expect(document.querySelector('.popup-content')).toBeTruthy();
        expect(document.querySelector('.popup-preview-container')).toBeNull();
        expect(document.querySelector('.popup-video-container')).toBeNull();
        expect(createPreviewSession).not.toHaveBeenCalled();
    });

    test('play starts the audiobook player and never navigates to /watch', async () => {
        render(MediaHoverCard, {
            item: audiobookItem,
            children: cardSnippet,
            videoPreviewEnabled: true,
            delay: 0,
        });
        await hover();
        await fireEvent.click(popupPlayButton());

        // Resume is the SERVER's business: no position is threaded, so the
        // client structurally cannot overwrite AudiobookShelf's progress. This
        // asserts the ARGUMENT LIST, so a `{ positionMs }` sneaking in fails
        // here (item.progress is 37% — a tempting, and wrong, thing to pass).
        expect(playAudiobook).toHaveBeenCalledWith(BOOK_UUID);
        expect(playAudiobook.mock.calls[0]).toHaveLength(1);
        expect(playAudiobook).toHaveBeenCalledTimes(1);
        expect(goto).not.toHaveBeenCalled();
    });

    test('claims no preview audio for a book, and offers no mute button', async () => {
        render(MediaHoverCard, {
            item: audiobookItem,
            children: cardSnippet,
            trailersEnabled: true,
            videoPreviewEnabled: true,
            delay: 0,
        });
        await hover();

        // No video → no mute control → nothing can claim exclusive preview
        // audio, so the real audiobook player (which arbitrates through the
        // separate audio-exclusivity module) can never be muted by this popup,
        // and no phantom owner survives the popup.
        expect(document.querySelector('[data-mute-toggle]')).toBeNull();
        expect(previewAudio.owner).toBeNull();

        await fireEvent.click(popupPlayButton());
        expect(previewAudio.owner).toBeNull();
    });

    test('a movie still opens a preview and still navigates to /watch', async () => {
        render(MediaHoverCard, {
            item: movieItem,
            children: cardSnippet,
            videoPreviewEnabled: true,
            delay: 0,
        });
        await hover();

        expect(document.querySelector('.popup-preview-container')).toBeTruthy();

        await fireEvent.click(popupPlayButton());
        expect(playAudiobook).not.toHaveBeenCalled();
        expect(goto).toHaveBeenCalledTimes(1);
        expect(goto.mock.calls[0]?.[0]).toBe(`/watch/${MOVIE_UUID}`);
    });
});
