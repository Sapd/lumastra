// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The two new player components, against a driven store.
 *
 * The end-to-end behaviour was verified in a real browser against the real
 * AudiobookShelf (session → byte proxy → position reports → chapter seek across
 * a file boundary). What these cover is the part that a browser run cannot
 * cheaply pin: that the two scrubbers read DIFFERENT clocks, and that the
 * accidental-seek affordance appears only for a seek worth taking back.
 *
 * The whole-book bar showing chapter progress — or the chapter bar showing book
 * progress — is a silent bug: both render a plausible-looking partly-filled bar
 * and both numbers are milliseconds.
 */

import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { tick } from 'svelte';
import type { AudiobookPlayerState } from '$lib/stores/audiobook-player.store';
import type { SocialActivityItem } from '$lib/schemas/api-media-responses';
import { chapterTitlesAreUninformative, formatChapterLabels } from '$lib/utils/audiobook-timeline';

/**
 * A hand-driven store double. The real store needs an AudioBackend and a
 * transport, neither of which is what these cases are about.
 *
 * Built inside a SYNCHRONOUS `vi.hoisted` with a hand-rolled store rather than
 * svelte's `writable`. Two constraints collide: `vi.mock`'s factory is hoisted
 * above every import and every top-level `const`, so it cannot close over an
 * ordinary module-scope variable; and an `await import(...)` inside an async
 * `vi.hoisted` is rewritten by the Svelte transform into something that fails
 * to parse at the top level. `vi.fn()` inside `vi.hoisted` is fine — that is
 * the documented pattern.
 */
const { state, pageState, calls, getSocialWatchActivity } = vi.hoisted(() => {
    function makeStore() {
        let value: unknown;
        const subscribers = new Set<(v: unknown) => void>();
        const store = {
            subscribe(fn: (v: unknown) => void) {
                subscribers.add(fn);
                fn(value);
                return () => subscribers.delete(fn);
            },
            set(next: unknown) {
                value = next;
                for (const fn of subscribers) fn(value);
            },
            update(fn: (v: never) => unknown) {
                store.set(fn(value as never));
            },
        };
        return store;
    }
    const store = makeStore();
    return {
        state: store,
        // `$page` is only read for the server-configured volume curve, but that
        // has to be settable per test: a curve is exactly the kind of mapping a
        // fixed `{ data: {} }` mock would let drift.
        pageState: makeStore(),
        calls: {
            pause: vi.fn(),
            resume: vi.fn(),
            skipBy: vi.fn(),
            skipChapter: vi.fn(),
            seekTo: vi.fn(),
            undoSeek: vi.fn(),
            dismissUndo: vi.fn(),
            setPlaybackRate: vi.fn(),
            setVolume: vi.fn(),
            toggleMute: vi.fn(),
            stop: vi.fn(),
        },
        getSocialWatchActivity: vi.fn(),
    };
});

vi.mock('$lib/stores/audiobook-player.store', async () => {
    const actual = await import('$lib/stores/audiobook-player.store');
    return {
        ...actual,
        audiobookPlayerStore: { subscribe: state.subscribe, ...calls },
    };
});

vi.mock('$lib/api/integrations', () => ({ getSocialWatchActivity }));

vi.mock('$app/stores', () => ({ page: { subscribe: pageState.subscribe } }));

import AudiobookMiniPlayer from './AudiobookMiniPlayer.svelte';
import AudiobookFullScreen from './AudiobookFullScreen.svelte';
import { audiobookFullScreenOpen } from '$lib/stores/audiobook-ui';

function baseState(): AudiobookPlayerState {
    return {
        mediaId: 'media-1',
        book: { title: 'Operation Rainbow', author: 'Tom Clancy', images: {} },
        timeline: {
            tracks: [],
            chapters: [
                { index: 0, title: 'CD1', startMs: 0, endMs: 600_000, synthetic: false },
                { index: 1, title: 'CD2', startMs: 600_000, endMs: 1_200_000, synthetic: false },
            ],
            durationMs: 1_200_000,
            chaptersAreSynthetic: false,
        },
        playMethod: 'direct',
        playbackSessionId: 'abs-1',
        isLoading: false,
        isPlaying: true,
        // 11 minutes into the book = 1 minute into chapter 2. The two clocks
        // differ by an order of magnitude, which is the point.
        bookPositionMs: 660_000,
        durationMs: 1_200_000,
        currentChapter: {
            index: 1,
            title: 'CD2',
            startMs: 600_000,
            endMs: 1_200_000,
            synthetic: false,
        },
        chapterPositionMs: 60_000,
        chapterDurationMs: 600_000,
        playbackRate: 1,
        volume: 1,
        isMuted: false,
        supportsVolumeControl: true,
        error: null,
        pendingUndo: null,
        isDwelling: false,
    };
}

// happy-dom has no Web Animations API, and the full-screen player's root uses
// `transition:fly`. Svelte only reaches for `element.animate` when a transition
// actually runs, so this bites exactly when a child (the chapter sheet) mounts
// inside a transitioning parent — which is the case one of these tests is about.
beforeEach(() => {
    if (typeof Element.prototype.animate !== 'function') {
        Element.prototype.animate = (() => ({
            cancel() {},
            finish() {},
            addEventListener() {},
            removeEventListener() {},
            currentTime: 0,
            playState: 'finished',
        })) as unknown as Element['animate'];
    }
    state.set(baseState());
    pageState.set({ data: {} });
    getSocialWatchActivity.mockResolvedValue({
        data: { activities: [] },
        error: null,
        status: 200,
    });
    audiobookFullScreenOpen.set(false);
    for (const fn of Object.values(calls)) fn.mockReset();
    getSocialWatchActivity.mockClear();
});
afterEach(cleanup);

describe('AudiobookMiniPlayer', () => {
    it('is not mounted without a book', () => {
        state.update((s: AudiobookPlayerState) => ({ ...s, book: null }));
        const { container } = render(AudiobookMiniPlayer);
        expect(container.querySelector('.audiobook-mini')).toBeNull();
    });

    it('shows the chapter title, not the author, when a chapter is known', () => {
        const { container } = render(AudiobookMiniPlayer);
        expect(container.textContent).toContain('Operation Rainbow');
        expect(container.textContent).toContain('CD2');
    });

    /**
     * The bar is CHAPTER-scoped. Book-scoped would read 55% here; chapter-scoped
     * reads 10%. A whole-book bar on a phone is ~4 minutes per pixel and looks
     * motionless for a quarter of an hour, which is why the mini bar tracks the
     * chapter like the full-screen scrubber does.
     */
    it('fills its progress bar from CHAPTER position, not book position', () => {
        const { container } = render(AudiobookMiniPlayer);
        const fill = container.querySelector('.bg-primary-500') as HTMLElement;
        expect(fill.style.width).toBe('10%');
    });

    /**
     * Whole-BOOK elapsed/remaining, not the chapter clock the bar above
     * already shows. 660 000 ms elapsed of a 1 200 000 ms book = 11:00 shown,
     * 9:00 (540 000 ms) left.
     */
    /**
     * A chapter boundary snaps the chapter fraction from ~1 back to ~0. With
     * the width transition still applied, the browser plays that backwards as
     * a slow right-to-left crawl, so the bar appears to rewind through the
     * chapter that just finished. The transition has to be off for exactly
     * that commit — and back on for the ordinary ticks it exists to smooth.
     */
    it('drops the width transition when the chapter rolls over, and restores it after', async () => {
        const { container } = render(AudiobookMiniPlayer);
        const fill = () => container.querySelector('.bg-primary-500') as HTMLElement;

        // An ordinary forward tick within the chapter: transition on.
        state.update((s: AudiobookPlayerState) => ({
            ...s,
            bookPositionMs: 665_000,
            chapterPositionMs: 65_000,
        }));
        await tick();
        expect(fill().className).toContain('transition-[width]');

        // Chapter 1 ends, chapter 2 starts at zero.
        state.update((s: AudiobookPlayerState) => ({
            ...s,
            bookPositionMs: 1_200_000,
            currentChapter: {
                index: 2,
                title: 'CD3',
                startMs: 1_200_000,
                endMs: 1_800_000,
                synthetic: false,
            },
            chapterPositionMs: 0,
        }));
        await tick();
        expect(fill().style.width).toBe('0%');
        expect(fill().className).not.toContain('transition-[width]');

        // The next ordinary tick gets its smoothing back.
        state.update((s: AudiobookPlayerState) => ({ ...s, chapterPositionMs: 6_000 }));
        await tick();
        expect(fill().className).toContain('transition-[width]');
    });

    /** A backwards seek is the same discontinuity, minus the chapter change. */
    it('drops the width transition for a backwards seek inside one chapter', async () => {
        const { container } = render(AudiobookMiniPlayer);
        const fill = () => container.querySelector('.bg-primary-500') as HTMLElement;

        state.update((s: AudiobookPlayerState) => ({ ...s, chapterPositionMs: 65_000 }));
        await tick();
        expect(fill().className).toContain('transition-[width]');

        state.update((s: AudiobookPlayerState) => ({ ...s, chapterPositionMs: 5_000 }));
        await tick();
        expect(fill().className).not.toContain('transition-[width]');
    });

    it('shows whole-book elapsed and remaining time', () => {
        const { container } = render(AudiobookMiniPlayer);
        expect(container.textContent).toContain('11:00');
        expect(container.textContent).toContain('-9:00');
    });

    /**
     * The session payload can report a zero/unresolved duration for a moment
     * at load. `formatChapterTime(0)` prints "0:00", which reads as "this
     * book is zero seconds long" rather than "still loading" — so this must
     * show a placeholder, not a false zero.
     */
    it('shows a placeholder instead of a false zero before duration is known', () => {
        state.update((s: AudiobookPlayerState) => ({ ...s, durationMs: 0, bookPositionMs: 0 }));
        const { container } = render(AudiobookMiniPlayer);
        expect(container.textContent).toContain('--:--');
        expect(container.textContent).not.toContain('0:00 / 0:00');
    });

    it('skips by 30 s without opening the full-screen player', async () => {
        const { getByLabelText } = render(AudiobookMiniPlayer);
        await fireEvent.click(getByLabelText('Forward 30 seconds'));
        expect(calls.skipBy).toHaveBeenCalledWith(30_000);
        expect(get(audiobookFullScreenOpen)).toBe(false);
    });

    it('pauses without opening the full-screen player', async () => {
        const { getByTestId } = render(AudiobookMiniPlayer);
        await fireEvent.click(getByTestId('audiobook-mini-toggle'));
        expect(calls.pause).toHaveBeenCalledTimes(1);
        expect(get(audiobookFullScreenOpen)).toBe(false);
    });

    it('stops and closes the player from the mini bar', async () => {
        audiobookFullScreenOpen.set(true);
        const { getByTestId } = render(AudiobookMiniPlayer);
        await fireEvent.click(getByTestId('audiobook-mini-close'));
        expect(calls.stop).toHaveBeenCalledTimes(1);
        expect(get(audiobookFullScreenOpen)).toBe(false);
    });

    it('opens the full-screen player when the row itself is tapped', async () => {
        const { getByLabelText } = render(AudiobookMiniPlayer);
        await fireEvent.click(getByLabelText('Open the audiobook player'));
        expect(get(audiobookFullScreenOpen)).toBe(true);
    });

    /**
     * Every control on this bar sits inside a row whose own click opens the
     * full-screen player, so a volume control that does not stop propagation
     * would throw the sheet open on every nudge — which is the bug that makes
     * the control useless rather than merely imperfect.
     */
    it('mutes from the mini bar without opening the full-screen player', async () => {
        const { getByTestId } = render(AudiobookMiniPlayer);
        await fireEvent.click(getByTestId('audiobook-mini-mute'));
        expect(calls.toggleMute).toHaveBeenCalledTimes(1);
        expect(get(audiobookFullScreenOpen)).toBe(false);
    });

    /**
     * Regression: the row wraps every control and opens the full-screen player
     * on its own Enter/Space keydown handler. A keydown on the mute button
     * bubbles to the row BEFORE the button's native activation (its default
     * click) fires, so without a guard the row wins the race, calls
     * `preventDefault()` and opens the sheet -- mute never runs. happy-dom does
     * not synthesize a click from a button's own Enter/Space keydown (verified:
     * a bare `<button>` with only a click listener does not fire it here), so
     * the only assertion this environment can make is the one that matters: the
     * row's own handler must never see the event.
     */
    it.each(['Enter', ' '])(
        'does not open the full-screen player when %s is pressed on the mute button',
        async (key) => {
            const { getByTestId } = render(AudiobookMiniPlayer);
            await fireEvent.keyDown(getByTestId('audiobook-mini-mute'), { key, bubbles: true });
            expect(get(audiobookFullScreenOpen)).toBe(false);
        },
    );

    it('sets volume from the slider without opening the full-screen player', async () => {
        const { getByTestId } = render(AudiobookMiniPlayer);
        const slider = getByTestId('audiobook-mini-volume') as HTMLInputElement;
        expect(slider.value).toBe('1');
        await fireEvent.input(slider, { target: { value: '0.5' } });
        expect(calls.setVolume).toHaveBeenCalledWith(0.5);
        expect(get(audiobookFullScreenOpen)).toBe(false);
    });

    /**
     * The slider is in CURVE space, the store is in volume space. Reading
     * `volume` straight into the input (or writing the raw position back) is
     * silent: both numbers are 0-1 and both render a plausible handle, but the
     * mini bar and the full-screen row would then disagree about where 50% is.
     */
    it('runs the slider through the configured volume curve, both ways', async () => {
        pageState.set({ data: { player: { volumeCurve: 'quadratic' } } });
        state.update((s: AudiobookPlayerState) => ({ ...s, volume: 0.25 }));
        const { getByTestId } = render(AudiobookMiniPlayer);
        const slider = getByTestId('audiobook-mini-volume') as HTMLInputElement;

        // 25% volume sits at the halfway handle position under x².
        expect(slider.value).toBe('0.5');

        await fireEvent.input(slider, { target: { value: '0.5' } });
        expect(calls.setVolume).toHaveBeenCalledWith(0.25);
    });

    it('shows a muted slider at zero while keeping the stored volume', () => {
        state.update((s: AudiobookPlayerState) => ({ ...s, isMuted: true, volume: 0.8 }));
        const { getByTestId } = render(AudiobookMiniPlayer);
        expect((getByTestId('audiobook-mini-volume') as HTMLInputElement).value).toBe('0');
    });

    /** iOS is hardware-only: an inert slider there is worse than none. */
    it('drops the volume controls where the browser cannot set volume', () => {
        state.update((s: AudiobookPlayerState) => ({ ...s, supportsVolumeControl: false }));
        const { queryByTestId } = render(AudiobookMiniPlayer);
        expect(queryByTestId('audiobook-mini-volume')).toBeNull();
        expect(queryByTestId('audiobook-mini-mute')).toBeNull();
    });

    it('offers Undo only when a seek is worth taking back', async () => {
        const { container, queryByText } = render(AudiobookMiniPlayer);
        expect(queryByText('Undo')).toBeNull();

        state.update((s: AudiobookPlayerState) => ({
            ...s,
            pendingUndo: { fromMs: 660_000, toMs: 0 },
        }));
        await Promise.resolve();
        const undo = container.querySelector('button');
        expect(container.textContent).toContain('Undo');

        await fireEvent.click(
            [...container.querySelectorAll('button')].find(
                (b) => b.textContent?.trim() === 'Undo',
            )!,
        );
        expect(calls.undoSeek).toHaveBeenCalledTimes(1);
        expect(undo).toBeTruthy();
    });

    /**
     * The bar has no error banner, and that is the contract rather than an
     * omission: every store error path resets to INITIAL_STATE, so `book` is
     * null whenever `error` is set — and the whole component is gated on
     * `book !== null`. A banner here could never render. Start failures are
     * toasted by the caller instead.
     */
    it('has no error surface, because the store never sets one while a book is open', () => {
        state.update((s: AudiobookPlayerState) => ({
            ...s,
            error: { kind: 'transcode_unsupported' as const, message: 'needs transcoding' },
        }));
        const { container } = render(AudiobookMiniPlayer);
        expect(container.querySelector('[role="alert"]')).toBeNull();
    });
});

describe('AudiobookFullScreen', () => {
    beforeEach(() => audiobookFullScreenOpen.set(true));

    it('renders nothing while closed', () => {
        audiobookFullScreenOpen.set(false);
        const { container } = render(AudiobookFullScreen);
        expect(container.querySelector('[aria-label="Audiobook player"]')).toBeNull();
    });

    /**
     * The design's whole point: two bars, two clocks. 11:00 of 20:00 for the
     * book, 1:00 of 10:00 for the chapter. If either read the other's clock the
     * numbers below would match, and a reviewer looking at the rendered page
     * could not tell.
     */
    it('reads the book clock on the thin bar and the chapter clock on the scrubber', () => {
        const { container } = render(AudiobookFullScreen);
        const book = container.querySelector('[role="progressbar"][aria-label="Book progress"]');
        expect(book?.getAttribute('aria-valuetext')).toBe('11:00 of 20:00');

        const scrubber = container.querySelector('[aria-label="Seek within the chapter"]');
        expect(scrubber?.getAttribute('aria-valuetext')).toBe('1:00 of 10:00');
        expect(scrubber?.getAttribute('aria-valuemax')).toBe('600');
    });

    /**
     * The desktop layout fills the space beside the artwork with the chapter
     * list, because for a 20-hour book that list IS the navigation. Before this
     * it lived behind an icon while a third of the screen sat empty.
     */
    it('lists chapters beside the cover and marks the playing one', () => {
        audiobookFullScreenOpen.set(true);
        const { container } = render(AudiobookFullScreen);
        const list = container.querySelector('[data-testid="audiobook-chapter-list"]')!;
        const rows = list.querySelectorAll('button[data-chapter-index]');
        expect(rows).toHaveLength(2);
        expect(rows[0].textContent).toContain('CD1');
        // Book position 11:00 sits inside chapter 2 (10:00–20:00).
        expect(rows[0].getAttribute('aria-current')).toBeNull();
        expect(rows[1].getAttribute('aria-current')).toBe('true');
    });

    /**
     * `nearest` alone is a no-op while the row is inside the scrollport, and
     * scrollTop starts at 0 — so a listener 80 chapters into a 108-chapter book
     * was shown chapter 1. The first positioning for a book must centre.
     */
    it('centres the playing chapter the first time, then only nudges', async () => {
        audiobookFullScreenOpen.set(true);
        const seen: Array<{ block?: string } | boolean | undefined> = [];
        const original = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function (arg?: { block?: string } | boolean) {
            seen.push(arg);
        };
        try {
            render(AudiobookFullScreen);
            expect(seen.at(-1)).toEqual({ block: 'center' });

            // Same book, chapter advances → must not yank the list. `$effect`
            // flushes asynchronously, so this cannot be asserted synchronously.
            state.update((s: AudiobookPlayerState) => ({ ...s, bookPositionMs: 100 }));
            await waitFor(() => expect(seen.at(-1)).toEqual({ block: 'nearest' }));
        } finally {
            Element.prototype.scrollIntoView = original;
        }
    });

    it('seeks to a chapter start from the list, in BOOK time', async () => {
        audiobookFullScreenOpen.set(true);
        const { container } = render(AudiobookFullScreen);
        const rows = container.querySelectorAll(
            '[data-testid="audiobook-chapter-list"] button[data-chapter-index]',
        );
        await fireEvent.click(rows[0]);
        expect(calls.seekTo).toHaveBeenCalledWith(0, { source: 'seek' });
    });

    /**
     * A bare uturn arrow reads as undo. The numeral is drawn from the store
     * constant, so the label and the jump cannot drift apart — a hardcoded "30"
     * would keep rendering after someone changed SKIP_BACK_MS.
     */
    it('draws the skip amount inside the seek buttons', async () => {
        audiobookFullScreenOpen.set(true);
        const { container } = render(AudiobookFullScreen);
        const { SKIP_BACK_MS, SKIP_FORWARD_MS } =
            await import('$lib/stores/audiobook-player.store');
        const back = container.querySelector(
            `button[aria-label="Back ${SKIP_BACK_MS / 1000} seconds"]`,
        )!;
        const forward = container.querySelector(
            `button[aria-label="Forward ${SKIP_FORWARD_MS / 1000} seconds"]`,
        )!;
        expect(back.querySelector('svg text')?.textContent).toBe(String(SKIP_BACK_MS / 1000));
        expect(forward.querySelector('svg text')?.textContent).toBe(String(SKIP_FORWARD_MS / 1000));
    });

    /**
     * Parity with the music full-screen player: the two players should feel
     * like one app. What is audiobook-specific is what must NOT start the
     * gesture — the chapter scrubber captures its own pointer and the chapter
     * list scrolls, so a swipe beginning on either belongs to that control.
     */
    describe('swipe down to minimise', () => {
        function swipe(el: Element, fromY: number, toY: number, x = 100): void {
            void fireEvent.touchStart(el, { touches: [{ clientX: x, clientY: fromY }] });
            void fireEvent.touchMove(el, { touches: [{ clientX: x, clientY: toY }] });
            void fireEvent.touchEnd(el, { changedTouches: [{ clientX: x, clientY: toY }] });
        }

        it('closes on a downward swipe past the threshold', () => {
            audiobookFullScreenOpen.set(true);
            const { container } = render(AudiobookFullScreen);
            const sheet = container.querySelector('[aria-label="Audiobook player"]')!;

            swipe(sheet, 100, 300);

            expect(get(audiobookFullScreenOpen)).toBe(false);
        });

        it('keeps the player open for a short drag', () => {
            audiobookFullScreenOpen.set(true);
            const { container } = render(AudiobookFullScreen);
            const sheet = container.querySelector('[aria-label="Audiobook player"]')!;

            // 40px is under the 80px commit distance.
            swipe(sheet, 100, 140);

            expect(get(audiobookFullScreenOpen)).toBe(true);
        });

        it('ignores an upward swipe', () => {
            audiobookFullScreenOpen.set(true);
            const { container } = render(AudiobookFullScreen);
            const sheet = container.querySelector('[aria-label="Audiobook player"]')!;

            swipe(sheet, 300, 100);

            expect(get(audiobookFullScreenOpen)).toBe(true);
        });

        it('ignores a horizontal-dominant drag', () => {
            audiobookFullScreenOpen.set(true);
            const { container } = render(AudiobookFullScreen);
            const sheet = container.querySelector('[aria-label="Audiobook player"]')!;

            void fireEvent.touchStart(sheet, { touches: [{ clientX: 100, clientY: 100 }] });
            void fireEvent.touchMove(sheet, { touches: [{ clientX: 400, clientY: 200 }] });
            void fireEvent.touchEnd(sheet, { changedTouches: [{ clientX: 400, clientY: 200 }] });

            expect(get(audiobookFullScreenOpen)).toBe(true);
        });

        /**
         * The control for the two exclusion cases below. Without it they would
         * pass even if touch events never reached the sheet at all, and would
         * be proving nothing about the guard.
         */
        it('closes when the swipe starts on a non-excluded child', () => {
            audiobookFullScreenOpen.set(true);
            const { container } = render(AudiobookFullScreen);
            const title = container.querySelector('h1')!;

            swipe(title, 100, 300);

            expect(get(audiobookFullScreenOpen)).toBe(false);
        });

        /**
         * The regression that matters: dragging the scrubber downward off the
         * bar would otherwise dismiss the player mid-seek.
         */
        it('does not start on the chapter scrubber', () => {
            audiobookFullScreenOpen.set(true);
            const { container } = render(AudiobookFullScreen);
            const scrubber = container.querySelector('[role="slider"]')!;

            swipe(scrubber, 100, 300);

            expect(get(audiobookFullScreenOpen)).toBe(true);
        });

        it('does not start on the chapter list', () => {
            audiobookFullScreenOpen.set(true);
            const { container } = render(AudiobookFullScreen);
            const list = container.querySelector('[data-testid="audiobook-chapter-list"]')!;

            swipe(list, 100, 300);

            expect(get(audiobookFullScreenOpen)).toBe(true);
        });
    });

    describe('keyboard shortcuts', () => {
        function press(key: string, target: Element | Window = window, init = {}) {
            void fireEvent.keyDown(target, { key, bubbles: true, ...init });
        }

        it('toggles playback on space and k', () => {
            audiobookFullScreenOpen.set(true);
            render(AudiobookFullScreen);

            // baseState is playing, so both are a pause.
            press(' ');
            press('k');
            expect(calls.pause).toHaveBeenCalledTimes(2);
        });

        it('resumes when paused', () => {
            state.update((s: AudiobookPlayerState) => ({ ...s, isPlaying: false }));
            audiobookFullScreenOpen.set(true);
            render(AudiobookFullScreen);

            press(' ');
            expect(calls.resume).toHaveBeenCalledOnce();
        });

        it('seeks by the transport step on arrows and j/l', async () => {
            audiobookFullScreenOpen.set(true);
            render(AudiobookFullScreen);
            const { SKIP_BACK_MS, SKIP_FORWARD_MS } =
                await import('$lib/stores/audiobook-player.store');

            press('ArrowLeft');
            press('ArrowRight');
            press('j');
            press('l');

            expect(calls.skipBy.mock.calls).toEqual([
                [-SKIP_BACK_MS],
                [SKIP_FORWARD_MS],
                [-SKIP_BACK_MS],
                [SKIP_FORWARD_MS],
            ]);
        });

        it('closes on Escape', () => {
            audiobookFullScreenOpen.set(true);
            render(AudiobookFullScreen);

            press('Escape');
            expect(get(audiobookFullScreenOpen)).toBe(false);
        });

        /**
         * A focused button already activates on space. Handling it here too
         * would fire the button AND toggle playback.
         */
        it('leaves space to a focused button', () => {
            audiobookFullScreenOpen.set(true);
            const { container } = render(AudiobookFullScreen);
            const chapters = container.querySelector('button[aria-label="Chapters"]')!;

            press(' ', chapters);
            expect(calls.pause).not.toHaveBeenCalled();
        });

        /**
         * The scrubber is an ARIA slider with its own 10 s arrow step. The
         * transport's 30 s must not also fire, or one keypress moves 40 s.
         */
        it('leaves arrows to the focused chapter scrubber', () => {
            audiobookFullScreenOpen.set(true);
            const { container } = render(AudiobookFullScreen);
            const scrubber = container.querySelector('[role="slider"]')!;

            press('ArrowRight', scrubber);
            // The scrubber's own handler runs; the window handler must not add
            // a second, larger seek on top of it.
            expect(calls.skipBy.mock.calls).toEqual([[10_000]]);
        });

        it('ignores keys carrying a browser modifier', () => {
            audiobookFullScreenOpen.set(true);
            render(AudiobookFullScreen);

            press('ArrowLeft', window, { metaKey: true });
            press(' ', window, { ctrlKey: true });
            expect(calls.skipBy).not.toHaveBeenCalled();
            expect(calls.pause).not.toHaveBeenCalled();
        });

        it('does nothing once the player is closed', () => {
            audiobookFullScreenOpen.set(true);
            const { unmount } = render(AudiobookFullScreen);
            audiobookFullScreenOpen.set(false);

            press(' ');
            expect(calls.pause).not.toHaveBeenCalled();
            unmount();
        });
    });

    /**
     * A 555-file split carries no chapter names — every entry is its own
     * ordinal, which the number column already prints. The start time is then
     * the only thing that tells one row from another.
     */
    it('labels chapters by start time when the titles are just ordinals', () => {
        const chapters = Array.from({ length: 24 }, (_, i) => ({
            index: i,
            title: `Liu Cixin - Jenseits der Zeit - ${String(i + 1).padStart(3, '0')}`,
            startMs: i * 180_000,
            endMs: (i + 1) * 180_000,
            synthetic: false,
        }));
        state.update((s: AudiobookPlayerState) => ({
            ...s,
            timeline: { ...s.timeline!, chapters, durationMs: 24 * 180_000 },
            durationMs: 24 * 180_000,
        }));
        audiobookFullScreenOpen.set(true);
        const { container } = render(AudiobookFullScreen);

        const rows = container.querySelectorAll(
            '[data-testid="audiobook-chapter-list"] button[data-chapter-index]',
        );
        expect(rows[0].textContent).toContain('0:00');
        expect(rows[1].textContent).toContain('3:00');
        // The repeated book title must be gone entirely.
        expect(rows[1].textContent).not.toContain('Jenseits der Zeit');
    });

    it('keeps real chapter names', () => {
        audiobookFullScreenOpen.set(true);
        const { container } = render(AudiobookFullScreen);
        const rows = container.querySelectorAll(
            '[data-testid="audiobook-chapter-list"] button[data-chapter-index]',
        );
        expect(rows[0].textContent).toContain('CD1');
    });

    /**
     * 555 ticks over ~1800px is a mark every three pixels — a grey texture, not
     * navigation. A dozen real chapters is the case they help.
     */
    it('draws chapter ticks on the book rail only when they would be legible', () => {
        audiobookFullScreenOpen.set(true);
        const { container, unmount } = render(AudiobookFullScreen);
        // baseState has 2 chapters → one interior boundary.
        expect(container.querySelectorAll('[role="progressbar"] span.w-px')).toHaveLength(1);
        unmount();

        const many = Array.from({ length: 80 }, (_, i) => ({
            index: i,
            title: `Kapitel ${i + 1}`,
            startMs: i * 60_000,
            endMs: (i + 1) * 60_000,
            synthetic: false,
        }));
        state.update((s: AudiobookPlayerState) => ({
            ...s,
            timeline: { ...s.timeline!, chapters: many, durationMs: 80 * 60_000 },
            durationMs: 80 * 60_000,
        }));
        const second = render(AudiobookFullScreen);
        expect(second.container.querySelectorAll('[role="progressbar"] span.w-px')).toHaveLength(0);
    });

    /**
     * `5:20` beside `-26:46:38` was two formats for two halves of one number.
     */
    it('uses one clock format on both ends of the book rail', () => {
        state.update((s: AudiobookPlayerState) => ({
            ...s,
            bookPositionMs: 320_000,
            durationMs: 96_000_000,
        }));
        audiobookFullScreenOpen.set(true);
        const { container } = render(AudiobookFullScreen);
        const rail = container.querySelector('[aria-label="Book progress"]')!.parentElement!;
        expect(rail.textContent).toContain('0:05:20');
        expect(rail.textContent).toContain('-26:34:40');
    });

    it('leaves the whole-book bar non-interactive', () => {
        const { container } = render(AudiobookFullScreen);
        const book = container.querySelector('[aria-label^="Book progress"]')!;
        // `progressbar`, not `slider`: both are range roles, but only `slider`
        // advertises "you can move this". A mis-tap must be bounded to one
        // chapter, and a full-width book bar cannot offer that.
        expect(book.getAttribute('role')).toBe('progressbar');
        expect(book.closest('[role="slider"]')).toBeNull();
    });

    it('shows other listeners as non-interactive markers on the whole-book track', async () => {
        getSocialWatchActivity.mockResolvedValue({
            data: {
                activities: [
                    {
                        author: {
                            userId: 'testmember-id',
                            displayName: 'Testmember',
                            images: {
                                primary: {
                                    href: '/api/users/testmember-id/images/avatar',
                                    variants: { thumb: '/api/users/testmember-id/images/avatar?quality=50' },
                                    revision: '0',
                                    source: 'self',
                                },
                            },
                        },
                        description: 'Testmember is listening',
                        positionMs: 300_000,
                        durationMs: 1_200_000,
                        chapterTitle: 'CD1',
                    } satisfies SocialActivityItem,
                ],
            },
            error: null,
            status: 200,
        });

        const { container } = render(AudiobookFullScreen);

        await waitFor(() => {
            expect(
                container.querySelectorAll('[data-testid="social-listening-marker"]'),
            ).toHaveLength(1);
        });
        const marker = container.querySelector(
            '[data-testid="social-listening-marker"]',
        ) as HTMLElement;
        expect(marker.style.left).toBe('25%');
        // A real hover tooltip, not `title`: the native one waits a second and
        // cannot be styled, which on a 16px circle reads as "no tooltip at all".
        expect(
            marker.querySelector('[data-testid="social-listening-tooltip"]')?.textContent,
        ).toContain('Testmember');
        expect(marker.closest('[role="slider"]')).toBeNull();
        expect(getSocialWatchActivity).toHaveBeenCalledWith('media-1');
    });

    it('shows a finished listener at the completed endpoint without inventing a position', async () => {
        getSocialWatchActivity.mockResolvedValue({
            data: {
                activities: [
                    {
                        author: {
                            userId: 'testlistener-id',
                            displayName: 'Testlistener',
                            images: {
                                primary: {
                                    href: '/api/users/testlistener-id/images/avatar',
                                    variants: { thumb: '/api/users/testlistener-id/images/avatar?quality=50' },
                                    revision: '0',
                                    source: 'self',
                                },
                            },
                        },
                        description: 'Testlistener finished this book',
                        finished: true,
                        recentlyFinished: true,
                        timesFinished: 1,
                    } satisfies SocialActivityItem,
                ],
            },
            error: null,
            status: 200,
        });

        const { container } = render(AudiobookFullScreen);

        await waitFor(() => {
            expect(
                container.querySelectorAll('[data-testid="social-listening-marker"]'),
            ).toHaveLength(1);
        });
        const marker = container.querySelector(
            '[data-testid="social-listening-marker"]',
        ) as HTMLElement;
        expect(marker.style.left).toBe('calc(100% - 0.5rem)');
        expect(marker.dataset.finished).toBe('true');
        expect(
            marker.querySelector('[data-testid="social-listening-tooltip"]')?.textContent,
        ).toContain('Testlistener');
        expect(marker.querySelector('[data-testid="social-listening-complete"]')).not.toBeNull();
    });

    it('does not show a timeline marker for a completion older than 60 days', async () => {
        getSocialWatchActivity.mockResolvedValue({
            data: {
                activities: [
                    {
                        author: {
                            userId: 'testlistener-id',
                            displayName: 'Testlistener',
                            images: {
                                primary: {
                                    href: '/api/users/testlistener-id/images/avatar',
                                    variants: { thumb: '/api/users/testlistener-id/images/avatar?quality=50' },
                                    revision: '0',
                                    source: 'self',
                                },
                            },
                        },
                        description: 'Testlistener finished this book',
                        finished: true,
                        timesFinished: 1,
                    } satisfies SocialActivityItem,
                ],
            },
            error: null,
            status: 200,
        });

        const { container } = render(AudiobookFullScreen);

        await waitFor(() => expect(getSocialWatchActivity).toHaveBeenCalled());
        expect(container.querySelector('[data-testid="social-listening-marker"]')).toBeNull();
    });

    it('keeps a repeat listener at their active position instead of the endpoint', async () => {
        getSocialWatchActivity.mockResolvedValue({
            data: {
                activities: [
                    {
                        author: {
                            userId: 'testmember-id',
                            displayName: 'Testmember',
                            images: {
                                primary: {
                                    href: '/api/users/testmember-id/images/avatar',
                                    variants: { thumb: '/api/users/testmember-id/images/avatar?quality=50' },
                                    revision: '0',
                                    source: 'self',
                                },
                            },
                        },
                        description: 'Testmember is listening again',
                        finished: true,
                        positionMs: 300_000,
                        durationMs: 1_200_000,
                    } satisfies SocialActivityItem,
                ],
            },
            error: null,
            status: 200,
        });

        const { container } = render(AudiobookFullScreen);

        await waitFor(() => {
            expect(
                container.querySelectorAll('[data-testid="social-listening-marker"]'),
            ).toHaveLength(1);
        });
        const marker = container.querySelector(
            '[data-testid="social-listening-marker"]',
        ) as HTMLElement;
        expect(marker.style.left).toBe('25%');
        expect(marker.dataset.finished).toBeUndefined();
        expect(marker.querySelector('[data-testid="social-listening-complete"]')).toBeNull();
    });

    it('renders no markers when the social request fails', async () => {
        getSocialWatchActivity.mockResolvedValue({
            data: null,
            error: 'Social features are disabled',
            status: 403,
        });

        const { container } = render(AudiobookFullScreen);
        await waitFor(() => expect(getSocialWatchActivity).toHaveBeenCalled());
        expect(container.querySelector('[data-testid="social-listening-marker"]')).toBeNull();
    });

    it('seeks in BOOK time when the chapter scrubber is released', async () => {
        const { container } = render(AudiobookFullScreen);
        const scrubber = container.querySelector(
            '[aria-label="Seek within the chapter"]',
        ) as HTMLElement;
        scrubber.getBoundingClientRect = () =>
            ({
                left: 0,
                width: 200,
                x: 0,
                y: 0,
                top: 0,
                bottom: 0,
                right: 200,
                height: 6,
            }) as DOMRect;
        scrubber.setPointerCapture = vi.fn();
        scrubber.releasePointerCapture = vi.fn();

        // Halfway across a 10-minute chapter that starts at 10 minutes → 15:00
        // of BOOK time, not 5:00.
        await fireEvent.pointerDown(scrubber, { clientX: 100, pointerId: 1 });
        await fireEvent.pointerUp(scrubber, { clientX: 100, pointerId: 1 });

        expect(calls.seekTo).toHaveBeenCalledWith(900_000, { source: 'seek' });
    });

    it('changes speed through the store, with pitch preservation left to it', async () => {
        const { getByTestId, getByRole } = render(AudiobookFullScreen);
        await fireEvent.click(getByTestId('audiobook-speed'));
        await fireEvent.click(getByRole('menuitemradio', { name: '1.5×' }));
        expect(calls.setPlaybackRate).toHaveBeenCalledWith(1.5);
    });

    it('maps the chapter buttons to CHAPTERS, not files', async () => {
        const { getByLabelText } = render(AudiobookFullScreen);
        await fireEvent.click(getByLabelText('Next chapter'));
        expect(calls.skipChapter).toHaveBeenCalledWith(1);
        await fireEvent.click(getByLabelText('Previous chapter'));
        expect(calls.skipChapter).toHaveBeenCalledWith(-1);
    });

    it('hands the chapter sheet BOOK time so the highlight is right after file one', async () => {
        const { getByLabelText, container } = render(AudiobookFullScreen);
        await fireEvent.click(getByLabelText('Chapters'));
        const sheet = [...container.querySelectorAll('[role="dialog"]')].find((d) =>
            d.textContent?.includes('Chapters'),
        );
        const active = sheet?.querySelector('.bg-primary-500\\/15');
        // 660 000 ms of book time is inside CD2. Fed the element's file clock
        // (60 000 ms) it would have highlighted CD1.
        expect(active?.textContent).toContain('CD2');
    });

    /**
     * Defect 2: raw ABS file-per-chapter titles ("02-Ein Junge überlebt" ×6)
     * read as duplicates. The sheet must show the cleaned, numbered label —
     * seeking must still land on the timeline's own (untouched) chapter
     * offsets, not anything derived from the display string.
     */
    it('shows cleaned, numbered chapter labels in the sheet, and seeks by the untouched offsets', async () => {
        state.update((s: AudiobookPlayerState) => ({
            ...s,
            timeline: {
                tracks: [],
                chapters: [
                    {
                        index: 0,
                        title: '02-Ein Junge überlebt',
                        startMs: 0,
                        endMs: 100,
                        synthetic: false,
                    },
                    {
                        index: 1,
                        title: '03-Ein Junge überlebt',
                        startMs: 100,
                        endMs: 200,
                        synthetic: false,
                    },
                ],
                durationMs: 200,
                chaptersAreSynthetic: false,
            },
            currentChapter: {
                index: 0,
                title: '02-Ein Junge überlebt',
                startMs: 0,
                endMs: 100,
                synthetic: false,
            },
        }));
        const { getByLabelText, container } = render(AudiobookFullScreen);
        await fireEvent.click(getByLabelText('Chapters'));

        expect(container.textContent).toContain('Ein Junge überlebt (1/2)');
        expect(container.textContent).toContain('Ein Junge überlebt (2/2)');
        // The raw upstream title is still surfaced (via the sheet's artist
        // subtitle slot) for an operator to cross-check against the file.
        expect(container.textContent).toContain('03-Ein Junge überlebt');

        const items = [...container.querySelectorAll('li button')];
        await fireEvent.click(items[1]);
        // Seeks to the SECOND chapter's real startMs (100), not anything
        // derived from the "(2/2)" label.
        expect(calls.seekTo).toHaveBeenCalledWith(100, { source: 'seek' });
    });
});

describe('formatChapterLabels', () => {
    it('numbers the German file-per-chapter case as parts of each consecutive run, leaving singletons alone', () => {
        const raw = [
            '01-Jingle und Ansage',
            '02-Ein Junge überlebt',
            '03-Ein Junge überlebt',
            '04-Ein Junge überlebt',
            '05-Ein Junge überlebt',
            '06-Ein Junge überlebt',
            '07-Ein Junge überlebt',
            '08-Ein Fenster verschwindet',
            '09-Ein Fenster verschwindet',
            // File index restarts at 01 for the next real chapter — must NOT
            // merge with the '01-Jingle und Ansage' run at the top.
            '01-Briefe von niemandem',
        ];
        const labels = formatChapterLabels(raw);

        expect(labels.map((l) => l.display)).toEqual([
            'Jingle und Ansage',
            'Ein Junge überlebt (1/6)',
            'Ein Junge überlebt (2/6)',
            'Ein Junge überlebt (3/6)',
            'Ein Junge überlebt (4/6)',
            'Ein Junge überlebt (5/6)',
            'Ein Junge überlebt (6/6)',
            'Ein Fenster verschwindet (1/2)',
            'Ein Fenster verschwindet (2/2)',
            'Briefe von niemandem',
        ]);
        // Raw titles are preserved verbatim alongside the cleaned display.
        expect(labels[1].raw).toBe('02-Ein Junge überlebt');
        expect(labels.every((l, i) => l.raw === raw[i])).toBe(true);
    });

    /**
     * The live Lanternlight-451 fixture (`audiobook-timeline.test.ts`): a REAL,
     * non-synthesised chapter list where one chapter is split across 5 files,
     * each titled with its own track number plus the book's own title. This
     * is the same shape as the German case, just narrower.
     */
    it('numbers a same-book-title-per-file chapter list, matching the live Lanternlight 451 fixture', () => {
        const labels = formatChapterLabels([
            '01 - Lanternlight 451',
            '02 - Lanternlight 451',
            '03 - Lanternlight 451',
            '04 - Lanternlight 451',
            '05 - Lanternlight 451',
        ]);
        expect(labels.map((l) => l.display)).toEqual([
            'Lanternlight 451 (1/5)',
            'Lanternlight 451 (2/5)',
            'Lanternlight 451 (3/5)',
            'Lanternlight 451 (4/5)',
            'Lanternlight 451 (5/5)',
        ]);
    });

    it('leaves an already-clean chapter list completely unchanged', () => {
        const raw = [
            'The Boy Who Lived',
            'The Vanishing Glass',
            'The Letters from No One',
            'The Keeper of the Keys',
            'Diagon Alley',
            'The Journey from Platform Nine and Three-Quarters',
            'The Sorting Hat',
            'The Potions Master',
            'The Midnight Duel',
            'Halloween',
            'Quidditch',
            'The Mirror of Erised',
            'Nicolas Flamel',
            'The Forbidden Forest',
            'Through the Trapdoor',
            'The Man with Two Faces',
            'The Boy Who Lived Twice',
        ];
        const labels = formatChapterLabels(raw);
        expect(labels).toEqual(raw.map((title) => ({ display: title, raw: title })));
    });

    it('does not group the same cleaned name across a non-consecutive gap', () => {
        // Two files literally titled "02-Intro" separated by an unrelated
        // chapter — a global grouping-by-text would number all three "Intro"
        // occurrences together and merge two unrelated parts of the book.
        const labels = formatChapterLabels(['02-Intro', '02-Intro', 'Middle', '02-Intro']);
        expect(labels.map((l) => l.display)).toEqual([
            'Intro (1/2)',
            'Intro (2/2)',
            'Middle',
            'Intro',
        ]);
    });

    it('handles a single-chapter book, still stripping a file-index prefix with no part suffix', () => {
        expect(formatChapterLabels(['01-Only Chapter'])).toEqual([
            { display: 'Only Chapter', raw: '01-Only Chapter' },
        ]);
    });

    it('returns an empty list for an empty list', () => {
        expect(formatChapterLabels([])).toEqual([]);
    });

    it('does not strip a title that is entirely digits — there is nothing left to strip it to', () => {
        expect(formatChapterLabels(['1984'])).toEqual([{ display: '1984', raw: '1984' }]);
    });
});

describe('formatChapterLabels — shared prefix', () => {
    /**
     * The complement of the leading-index case: this export puts the number
     * LAST, so stripping a leading index does nothing and every row renders the
     * book's own title. A 555-file book showed 555 copies of one sentence.
     */
    it('strips a prefix every title shares', () => {
        const raw = Array.from(
            { length: 24 },
            (_, i) => `Liu Cixin - Jenseits der Zeit - ${String(i + 1).padStart(3, '0')}`,
        );

        expect(formatChapterLabels(raw).map((l) => l.display)).toEqual(
            Array.from({ length: 24 }, (_, i) => String(i + 1).padStart(3, '0')),
        );
    });

    /**
     * The raw common prefix of `… - 001` and `… - 010` includes that first `0`.
     * Cutting to it would renumber the book as 01, 10, 55 — so the prefix has to
     * be trimmed back to a separator.
     */
    it('cuts the shared prefix at a separator, never mid-number', () => {
        // 001 and 010 agree on a leading `0`, so an untrimmed common prefix
        // would renumber the book as 01 / 10 / 55.
        const raw = Array.from(
            { length: 24 },
            (_, i) => `Book - ${String(i + 1).padStart(3, '0')}`,
        );
        expect(
            formatChapterLabels(raw)
                .map((l) => l.display)
                .slice(0, 3),
        ).toEqual(['001', '002', '003']);
        expect(formatChapterLabels(raw)[23].display).toBe('024');
    });

    it('leaves real chapter names alone', () => {
        const raw = ['Prolog', 'Die Ankunft', 'Der Wald', 'Das Ende'];
        expect(formatChapterLabels(raw).map((l) => l.display)).toEqual(raw);
    });

    /**
     * `Kapitel 1` is a numbering scheme, not the book's title repeated: the
     * word is what a reader recognises, and a bare `1` … `108` would read as
     * "this book has no chapter names". The separator is what tells the two
     * apart — a space means a label, punctuation means an index bolted onto a
     * title.
     */
    it('keeps a numbering word in front of the number', () => {
        const raw = Array.from({ length: 108 }, (_, i) => `Kapitel ${i + 1}`);
        expect(formatChapterLabels(raw)[0].display).toBe('Kapitel 1');
        expect(chapterTitlesAreUninformative(formatChapterLabels(raw))).toBe(false);
    });

    it('strips a title carrying a punctuated index', () => {
        const raw = Array.from(
            { length: 108 },
            (_, i) => `Book - ${String(i + 1).padStart(3, '0')}`,
        );
        expect(formatChapterLabels(raw)[0].display).toBe('001');
        expect(chapterTitlesAreUninformative(formatChapterLabels(raw))).toBe(true);
    });

    /**
     * Repetition only hurts at length. A short list keeps the publisher's own
     * wording, which says more than the bare ordinal that would replace it.
     */
    it('leaves a short list alone even when it shares a prefix', () => {
        const raw = Array.from({ length: 12 }, (_, i) => `Kapitel ${i + 1}`);
        expect(formatChapterLabels(raw).map((l) => l.display)).toEqual(raw);
    });
});

describe('chapterTitlesAreUninformative', () => {
    it('is true when every entry is just its own ordinal', () => {
        const labels = formatChapterLabels(
            Array.from({ length: 24 }, (_, i) => `Some Book - ${String(i + 1).padStart(3, '0')}`),
        );
        expect(chapterTitlesAreUninformative(labels)).toBe(true);
    });

    it('is false for a short list, which keeps its own wording', () => {
        const labels = formatChapterLabels(
            Array.from({ length: 12 }, (_, i) => `Kapitel ${i + 1}`),
        );
        expect(chapterTitlesAreUninformative(labels)).toBe(false);
    });

    it('is false when the titles carry names', () => {
        const labels = formatChapterLabels(['Prolog', 'Die Ankunft', 'Der Wald', 'Das Ende']);
        expect(chapterTitlesAreUninformative(labels)).toBe(false);
    });

    it('is false for a mix — one named chapter is still information', () => {
        const raw = Array.from(
            { length: 24 },
            (_, i) => `Book - ${String(i + 1).padStart(3, '0')}`,
        );
        raw[5] = 'Book - Epilog';
        expect(chapterTitlesAreUninformative(formatChapterLabels(raw))).toBe(false);
    });
});
