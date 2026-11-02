// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The hover popup covers the card, and with it the card's Continue Watching
 * X. The popup therefore carries its own hide button, but only where the
 * caller passes `onhide` (the CW row). An episode's hide covers the whole
 * series, so the label names the series.
 */

import { render, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createRawSnippet } from 'svelte';
import { readable } from 'svelte/store';

vi.mock('$app/navigation', () => ({
    goto: async () => {},
    beforeNavigate: () => {},
    invalidate: async () => {},
}));
vi.mock('$app/stores', () => ({
    page: readable({ data: { features: {}, user: {} }, url: new URL('http://localhost/') }),
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/api/ai', () => ({
    saveMovie: async () => ({ error: null }),
    unsaveMovie: async () => ({ error: null }),
    submitRating: async () => ({ error: null }),
}));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('$lib/api/user', () => ({
    markWatched: vi.fn().mockResolvedValue({ error: null }),
    unmarkWatched: vi.fn().mockResolvedValue({ error: null }),
}));
vi.mock('$lib/utils/invalidate-when-idle', () => ({ invalidateWhenIdle: vi.fn() }));
vi.mock('$lib/utils/similar-prefetch', () => ({ prefetchSimilar: vi.fn() }));
vi.mock('$lib/api/playback', () => ({
    releasePreviewPlayback: vi.fn(),
    createPreviewSession: async () => ({ error: 'not expected', data: null }),
}));
// happy-dom cannot lay out a floating element; positioning is not under test.
vi.mock('@floating-ui/dom', () => ({
    computePosition: async () => ({ x: 0, y: 0, placement: 'top', strategy: 'absolute' }),
    autoUpdate: (_reference: Element, _floating: HTMLElement, update: () => void) => {
        update();
        return () => {};
    },
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
import UniversalMediaCard from './UniversalMediaCard.svelte';
import { mediaHoverCoordinator } from './media-hover-coordinator.svelte';
import { previewAudio } from '$lib/stores/preview-audio.svelte';
import { markWatched, unmarkWatched } from '$lib/api/user';
import { invalidateWhenIdle } from '$lib/utils/invalidate-when-idle';
import { getCwDismissArgs } from '$lib/utils/cw-dismiss-helper';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';

const EPISODE_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const SERIES_UUID = '11111111-2222-4333-8444-555555555555';

const episodeItem: UniversalMediaItem = {
    id: EPISODE_UUID,
    externalIds: { internal: EPISODE_UUID },
    mediaType: 'episode',
    title: 'Prince Randall',
    seriesId: SERIES_UUID,
    seriesName: 'Hafentage',
    seasonNumber: 4,
    episodeNumber: 38,
    image: `/api/media/${EPISODE_UUID}/images/poster`,
    isAvailable: true,
    hasFiles: true,
    canRequest: false,
};

const cardSnippet = createRawSnippet(() => ({
    render: () => '<div data-play-button data-testid="card">card</div>',
}));

async function hover(): Promise<void> {
    const card = document.querySelector('[data-play-button]');
    if (!card) throw new Error('card not rendered');
    await fireEvent.mouseOver(card);
    for (let i = 0; i < 4; i++) {
        await new Promise((r) => requestAnimationFrame(() => r(null)));
    }
}

describe('MediaHoverCard — hide from Continue Watching', () => {
    afterEach(() => {
        vi.useRealTimers();
        cleanup();
        document.body.querySelectorAll('.media-hover-portal').forEach((el) => {
            el.textContent = '';
        });
    });

    test('no hide button without onhide', async () => {
        render(MediaHoverCard, { item: episodeItem, children: cardSnippet, delay: 0 });
        await hover();

        expect(document.querySelector('.popup-actions')).not.toBeNull();
        expect(document.querySelector('[data-action="hide"]')).toBeNull();
    });

    test('names the series and hands the item to onhide', async () => {
        const onhide = vi.fn();
        render(MediaHoverCard, { item: episodeItem, children: cardSnippet, delay: 0, onhide });
        await hover();

        const btn = document.querySelector('[data-action="hide"]');
        if (!(btn instanceof HTMLElement)) throw new Error('hide button not rendered');
        expect(btn.getAttribute('aria-label')).toBe('Remove Hafentage from Continue Watching');
        expect(btn.textContent).toBe('Remove Hafentage from Continue Watching');
        expect(btn.closest('.popup-actions')).toBeNull();
        expect(btn.querySelector('path')?.getAttribute('d')).toBe('M6 18 18 6M6 6l12 12');

        await fireEvent.click(btn);
        expect(onhide).toHaveBeenCalledTimes(1);
        expect(onhide).toHaveBeenCalledWith(episodeItem);
        expect(getCwDismissArgs(onhide.mock.calls[0][0])).toEqual({
            targetId: SERIES_UUID,
            targetType: 'series',
        });
    });
});

describe('MediaHoverCard — resume context and control hints', () => {
    afterEach(() => {
        vi.useRealTimers();
        cleanup();
    });

    test('shows 3 minutes left for 21 minutes at 86%, preserving the progress bar', async () => {
        render(MediaHoverCard, {
            item: { ...episodeItem, progress: 86, durationMs: 21 * 60_000 },
            children: cardSnippet,
        });
        await hover();
        expect(document.querySelector('.progress-text')?.textContent).toBe('3 min left');
        expect(document.querySelector<HTMLElement>('.progress-fill')?.style.width).toBe('86%');
        expect(document.querySelector('[data-action="play"]')?.textContent).toContain('Continue');
    });

    test('does not round an exact six remaining minutes up due to floating point', async () => {
        render(MediaHoverCard, {
            item: { ...episodeItem, progress: 70, durationMs: 20 * 60_000 },
            children: cardSnippet,
        });
        await hover();
        expect(document.querySelector('.progress-text')?.textContent).toBe('6 min left');
    });

    test.each([undefined, 0, -1, NaN, Infinity])(
        'falls back to percentage for unknown/invalid runtime %s',
        async (durationMs) => {
            render(MediaHoverCard, {
                item: { ...episodeItem, progress: 86, durationMs },
                children: cardSnippet,
            });
            await hover();
            expect(document.querySelector('.progress-text')?.textContent).toBe('86%');
            expect(document.querySelector('.popup-content')?.textContent).not.toMatch(
                /NaN|Infinity/,
            );
        },
    );

    test('clamps excess progress and ignores non-finite progress', async () => {
        const view = render(MediaHoverCard, {
            item: { ...episodeItem, progress: 140, durationMs: 21 * 60_000 },
            children: cardSnippet,
        });
        await hover();
        expect(document.querySelector('.progress-text')?.textContent).toBe('0 min left');
        expect(document.querySelector<HTMLElement>('.progress-fill')?.style.width).toBe('100%');
        view.unmount();
        render(MediaHoverCard, {
            item: { ...episodeItem, progress: NaN, durationMs: 21 * 60_000 },
            children: cardSnippet,
        });
        await hover();
        expect(document.querySelector('.popup-progress')).toBeNull();
    });

    test.each([
        { title: 'Prince Randall', subtitle: undefined },
        { title: 'Hafentage', subtitle: 'S4:E38 - Prince Randall' },
        { title: 'Hafentage', subtitle: 'Prince Randall' },
        { title: 'Hafentage', subtitle: 'S4:E38 • Prince Randall' },
    ])('shows real episode title once for %j', async (fields) => {
        render(MediaHoverCard, { item: { ...episodeItem, ...fields }, children: cardSnippet });
        await hover();
        expect(document.querySelector('.popup-title')?.textContent).toBe('Hafentage');
        expect(document.querySelector('.popup-episode')?.textContent).toBe(
            'S4E38 · Prince Randall',
        );
    });

    test('does not fabricate an episode name or repeat a series name', async () => {
        render(MediaHoverCard, {
            item: { ...episodeItem, title: 'Hafentage', subtitle: 'S4:E38 - Hafentage' },
            children: cardSnippet,
        });
        await hover();
        expect(document.querySelector('.popup-episode')?.textContent).toBe('S4E38');
    });

    test('does not duplicate title when seriesName is absent', async () => {
        render(MediaHoverCard, {
            item: { ...episodeItem, seriesName: undefined, subtitle: 'Prince Randall' },
            children: cardSnippet,
        });
        await hover();
        expect(document.querySelector('.popup-title')?.textContent).toBe('Prince Randall');
        expect(document.querySelector('.popup-episode')?.textContent).toBe('S4E38');
    });

    test.each([NaN, Infinity, 1.5])('omits invalid episode code %s', async (seasonNumber) => {
        render(MediaHoverCard, {
            item: { ...episodeItem, seasonNumber },
            children: cardSnippet,
        });
        await hover();
        expect(document.querySelector('.popup-episode')?.textContent).toBe('Prince Randall');
    });

    test('preserves season zero', async () => {
        render(MediaHoverCard, {
            item: { ...episodeItem, seasonNumber: 0 },
            children: cardSnippet,
        });
        await hover();
        expect(document.querySelector('.popup-episode')?.textContent).toBe(
            'S0E38 · Prince Randall',
        );
    });

    test('icon hints appear visibly on hover and focus outside clipped popup and clean up on close', async () => {
        render(MediaHoverCard, { item: episodeItem, children: cardSnippet });
        await hover();
        vi.useFakeTimers();
        for (const button of document.querySelectorAll<HTMLElement>('.has-tooltip')) {
            await fireEvent.mouseEnter(button);
            let hint = document.querySelector<HTMLElement>('.popup-action-tooltip')!;
            expect(hint?.parentElement).toBe(document.body);
            expect(hint?.style.visibility).toBe('visible');
            expect(hint?.textContent).toBe(button.getAttribute('aria-label'));
            expect(button.getAttribute('aria-describedby')).toBe(hint?.id);
            await fireEvent.mouseLeave(button);
            button.focus();
            await vi.advanceTimersByTimeAsync(200);
            hint = document.querySelector<HTMLElement>('.popup-action-tooltip')!;
            expect(hint?.style.visibility).toBe('visible');
            expect(hint?.textContent).toBe(button.getAttribute('aria-label'));
            button.blur();
            await vi.advanceTimersByTimeAsync(200);
            expect(document.querySelector('.popup-action-tooltip')).toBeNull();
        }
        const more = document.querySelector<HTMLElement>('[data-action="more"]')!;
        more.focus();
        await fireEvent.click(more);
        expect(document.querySelector('.popup-action-tooltip')).toBeNull();
    });

    test('keeps the hint and popup open when the pointer crosses onto the hint', async () => {
        render(MediaHoverCard, { item: episodeItem, children: cardSnippet });
        await hover();
        vi.useFakeTimers();
        const more = document.querySelector<HTMLElement>('[data-action="more"]')!;
        await fireEvent.mouseOut(document.querySelector('[data-play-button]')!, {
            relatedTarget: more,
        });
        await fireEvent.mouseEnter(more);
        const hint = document.querySelector<HTMLElement>('.popup-action-tooltip')!;
        await fireEvent.mouseLeave(more);
        await fireEvent.mouseLeave(document.querySelector('.popup-content')!);
        await fireEvent.mouseEnter(hint);
        await vi.advanceTimersByTimeAsync(200);
        expect(document.querySelector('.popup-action-tooltip')).toBe(hint);
        expect(document.querySelector('.popup-content')).not.toBeNull();
        more.focus();
        await fireEvent.mouseLeave(hint, { relatedTarget: more });
        await fireEvent.mouseEnter(more);
        await vi.advanceTimersByTimeAsync(200);
        expect(document.querySelector('.popup-action-tooltip')).toBe(hint);
        await fireEvent.mouseLeave(more);
        await fireEvent.mouseLeave(document.querySelector('.popup-content')!);
        await fireEvent.mouseEnter(hint);
        more.blur();
        await vi.advanceTimersByTimeAsync(200);
        expect(document.querySelector('.popup-action-tooltip')).toBe(hint);
        await fireEvent.mouseLeave(hint);
        await vi.advanceTimersByTimeAsync(200);
        expect(document.querySelector('.popup-content')).toBeNull();
    });

    test('controls over another poster retain their popup; the preview image still hands off', async () => {
        render(MediaHoverCard, { item: episodeItem, children: cardSnippet });
        await hover();
        const content = document.querySelector<HTMLElement>('.popup-content')!;
        const underlying = document.createElement('div');
        underlying.dataset.cardPopupId = 'underlying-card';
        // happy-dom has no hit testing API. Supply its browser result explicitly.
        const hitTest = Object.getOwnPropertyDescriptor(document, 'elementsFromPoint');
        Object.defineProperty(document, 'elementsFromPoint', {
            configurable: true,
            value: () => [underlying],
        });
        const claim = vi.spyOn(mediaHoverCoordinator, 'claim');
        try {
            // happy-dom's card bounds are zero; these coordinates are outside
            // the originating poster, as controls below it are in the browser.
            for (const selector of ['.popup-actions', '[data-action="more"]', '.popup-title']) {
                await fireEvent.mouseMove(content.querySelector(selector)!, {
                    clientX: 100,
                    clientY: 200,
                });
                expect(document.querySelector('.popup-content')).toBe(content);
                expect(claim).not.toHaveBeenCalled();
            }
            await fireEvent.mouseMove(content.querySelector('.popup-backdrop')!, {
                clientX: 101,
                clientY: 201,
            });
            expect(claim).toHaveBeenCalledWith('underlying-card');
        } finally {
            if (hitTest) Object.defineProperty(document, 'elementsFromPoint', hitTest);
            else Reflect.deleteProperty(document, 'elementsFromPoint');
            claim.mockRestore();
        }
    });

    test('sound hint and accessible state follow the audio owner', async () => {
        render(MediaHoverCard, {
            item: { ...episodeItem, progress: 86 },
            children: cardSnippet,
            videoPreviewEnabled: true,
            videoLoadDelay: 30_000,
        });
        await hover();
        const sound = document.querySelector<HTMLElement>('[data-mute-toggle]')!;
        expect(sound).not.toBeNull();
        expect(sound.getAttribute('aria-label')).toBe('Unmute');
        expect(sound.getAttribute('aria-pressed')).toBe('false');
        await fireEvent.focus(sound);
        await fireEvent.click(sound);
        expect(sound.getAttribute('aria-label')).toBe('Mute');
        expect(sound.getAttribute('aria-pressed')).toBe('true');
        expect(document.querySelector('.popup-action-tooltip')?.textContent).toBe('Mute');
        previewAudio.claim('other-preview');
        await Promise.resolve();
        expect(sound.getAttribute('aria-label')).toBe('Unmute');
        previewAudio.release('other-preview');
    });

    test('suppresses preview over the X and its SVG child, including an existing timer', async () => {
        const children = createRawSnippet(() => ({
            render: () =>
                `<div data-play-button><button data-preview-suppress><svg><path /></svg></button></div>`,
        }));
        render(MediaHoverCard, { item: episodeItem, children, delay: 100 });
        vi.useFakeTimers();
        const play = document.querySelector<HTMLElement>('[data-play-button]')!;
        const remove = play.querySelector('button')!;
        const path = play.querySelector('path')!;
        await fireEvent.mouseOver(path);
        await vi.advanceTimersByTimeAsync(150);
        expect(document.querySelector('.popup-content')).toBeNull();
        await fireEvent.mouseOver(play);
        await vi.advanceTimersByTimeAsync(50);
        await fireEvent.mouseOut(play, { relatedTarget: path });
        await fireEvent.mouseOver(path);
        await vi.advanceTimersByTimeAsync(150);
        expect(document.querySelector('.popup-content')).toBeNull();
        await fireEvent.mouseOver(remove);
        await vi.advanceTimersByTimeAsync(150);
        expect(document.querySelector('.popup-content')).toBeNull();
        await fireEvent.mouseOut(remove, { relatedTarget: play });
        await fireEvent.mouseOver(play);
        await vi.advanceTimersByTimeAsync(120);
        expect(document.querySelector('.popup-content')).not.toBeNull();
    });

    test('zero-delay suppression cancels and fences popup construction across show cycles', async () => {
        const children = createRawSnippet(() => ({
            render: () =>
                '<div data-play-button><button data-preview-suppress><svg><path /></svg></button></div>',
        }));
        render(MediaHoverCard, { item: episodeItem, children });
        const frames: Array<(time: number) => void> = [];
        const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            frames.push(callback);
            return frames.length;
        });
        const cancel = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
        try {
            const play = document.querySelector<HTMLElement>('[data-play-button]')!;
            const path = play.querySelector('path')!;
            await fireEvent.mouseOver(play);
            expect(frames).toHaveLength(1);
            await fireEvent.mouseOut(play, { relatedTarget: path });
            await fireEvent.mouseOver(path);
            expect(cancel).toHaveBeenCalledWith(1);
            await fireEvent.mouseOut(path, { relatedTarget: play });
            await fireEvent.mouseOver(play);
            expect(frames).toHaveLength(2);
            // Deliberately run a cancelled callback after a newer show request.
            frames[0](0);
            expect(document.querySelector('.popup-content')).toBeNull();
            frames[1](0);
            const popup = document.querySelector('.popup-content');
            expect(popup).not.toBeNull();
            frames[0](0);
            expect(document.querySelector('.popup-content')).toBe(popup);
        } finally {
            raf.mockRestore();
            cancel.mockRestore();
        }
    });

    test.each(['hide', 'play'])(
        'closes after focused %s loses focus following an expired pointer-leave timer',
        async (action) => {
            render(MediaHoverCard, { item: episodeItem, children: cardSnippet, onhide: vi.fn() });
            await hover();
            const outside = document.createElement('button');
            document.body.appendChild(outside);
            try {
                vi.useFakeTimers();
                const content = document.querySelector<HTMLElement>('.popup-content')!;
                const button = document.querySelector<HTMLElement>(`[data-action="${action}"]`)!;
                await fireEvent.mouseOut(document.querySelector('[data-play-button]')!, {
                    relatedTarget: content,
                });
                await fireEvent.mouseEnter(content);
                button.focus();
                expect(document.activeElement).toBe(button);
                await fireEvent.mouseLeave(content);
                await vi.advanceTimersByTimeAsync(200);
                expect(document.querySelector('.popup-content')).toBe(content);
                outside.focus();
                expect(document.activeElement).toBe(outside);
                await vi.advanceTimersByTimeAsync(200);
                expect(document.querySelector('.popup-content')).toBeNull();
            } finally {
                outside.remove();
            }
        },
    );

    test('icon blur preserves actual popup pointer containment until the pointer leaves', async () => {
        render(MediaHoverCard, { item: episodeItem, children: cardSnippet });
        await hover();
        const outside = document.createElement('button');
        document.body.appendChild(outside);
        try {
            vi.useFakeTimers();
            const content = document.querySelector<HTMLElement>('.popup-content')!;
            await fireEvent.mouseOut(document.querySelector('[data-play-button]')!, {
                relatedTarget: content,
            });
            await fireEvent.mouseEnter(content);
            document.querySelector<HTMLElement>('[data-action="more"]')!.focus();
            outside.focus();
            await vi.advanceTimersByTimeAsync(200);
            expect(document.querySelector('.popup-content')).toBe(content);
            await fireEvent.mouseLeave(content);
            await vi.advanceTimersByTimeAsync(200);
            expect(document.querySelector('.popup-content')).toBeNull();
        } finally {
            outside.remove();
        }
    });

    test('ordinary play hover still opens on the next frame without a hover delay', async () => {
        render(MediaHoverCard, { item: episodeItem, children: cardSnippet });
        await fireEvent.mouseOver(document.querySelector('[data-play-button]')!);
        await new Promise((r) => requestAnimationFrame(r));
        expect(document.querySelector('.popup-actions')).not.toBeNull();
    });
});

describe('UniversalMediaCard — Similar titles hover action', () => {
    afterEach(cleanup);

    test('poster actions suppress preview and Similar does not play', async () => {
        const onmore = vi.fn();
        const onplay = vi.fn();
        const { container } = render(UniversalMediaCard, {
            item: { ...episodeItem, mediaType: 'movie' },
            variant: 'poster',
            onmore,
            onplay,
        });
        const card = container.querySelector<HTMLElement>('.card-touch-root')!;
        await fireEvent.mouseEnter(card);
        const actions = card.querySelector<HTMLElement>('button[aria-haspopup="menu"]')!;
        expect(actions).not.toBeNull();
        expect(actions.closest('[data-preview-suppress]')).not.toBeNull();
        expect(actions.querySelector('svg')?.closest('[data-preview-suppress]')).not.toBeNull();
        await fireEvent.click(actions, { detail: 1 });
        const similar =
            document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Similar titles"]') ??
            Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
                (entry) => entry.textContent?.trim() === 'Similar titles',
            );
        expect(similar).toBeTruthy();
        await new Promise((resolve) => setTimeout(resolve, 260));
        await fireEvent.click(similar!);
        expect(onmore).toHaveBeenCalledWith(expect.objectContaining({ mediaType: 'movie' }));
        expect(onplay).not.toHaveBeenCalled();
    });
});

describe('UniversalMediaCard — Continue Watching remove hint', () => {
    afterEach(cleanup);

    test.each(['poster', 'backdrop'] as const)(
        '%s keeps focused Play attached when the pointer leaves and resets on focusout',
        async (variant) => {
            const { container } = render(UniversalMediaCard, { item: episodeItem, variant });
            const outside = document.createElement('button');
            document.body.appendChild(outside);
            try {
                const card = container.querySelector<HTMLElement>('.card-touch-root')!;
                await fireEvent.mouseEnter(card);
                const play = card.querySelector<HTMLElement>('[data-play-button]')!;
                expect(play).not.toBeNull();
                play.focus();
                await fireEvent.mouseLeave(card);
                expect(document.activeElement).toBe(play);
                expect(play.isConnected).toBe(true);
                expect(card.querySelector('[data-play-button]')).toBe(play);
                outside.focus();
                await waitFor(() => expect(card.querySelector('[data-play-button]')).toBeNull());
            } finally {
                outside.remove();
            }
        },
    );

    test.each(['poster', 'backdrop'] as const)(
        '%s menu explains series removal and does not play',
        async (variant) => {
            const onremove = vi.fn();
            const onplay = vi.fn();
            const { container } = render(UniversalMediaCard, {
                item: { ...episodeItem, progress: 86 },
                variant,
                showDismiss: true,
                continueWatching: true,
                onremove,
                onplay,
            });
            const card = container.querySelector<HTMLElement>('.card-touch-root')!;
            await fireEvent.mouseEnter(card);
            const actions = card.querySelector<HTMLElement>('button[aria-haspopup="menu"]')!;
            expect(actions).not.toBeNull();
            await fireEvent.click(actions, { detail: 1 });
            const remove = Array.from(
                document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
            ).find(
                (entry) => entry.textContent?.trim() === 'Remove Hafentage from Continue Watching',
            );
            expect(remove).toBeTruthy();
            await new Promise((resolve) => setTimeout(resolve, 260));
            await fireEvent.click(remove!);
            expect(onremove).toHaveBeenCalledWith(
                expect.objectContaining({ seriesId: SERIES_UUID }),
            );
            expect(onplay).not.toHaveBeenCalled();
        },
    );
});

describe('Continue Watching episode context menus', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    afterEach(() => {
        cleanup();
        vi.restoreAllMocks();
    });

    const completeLabel = 'Mark this episode as complete';
    const unwatchedLabel = 'Mark this episode as not watched';
    const removeLabel = 'Remove Hafentage from Continue Watching';

    async function openEpisodeMenu(
        surface: 'card' | 'popup',
        isPlayed = false,
        progress = 86,
    ): Promise<{
        buttons: HTMLButtonElement[];
        onremove: ReturnType<typeof vi.fn>;
        legacyWatched: ReturnType<typeof vi.fn>;
    }> {
        const onremove = vi.fn();
        const legacyWatched = vi.fn();
        const item = { ...episodeItem, progress, isPlayed };
        if (surface === 'card') {
            const { container } = render(UniversalMediaCard, {
                item,
                variant: 'backdrop',
                showDismiss: true,
                alwaysShowDismiss: true,
                continueWatching: true,
                onremove,
                onmarkWatched: legacyWatched,
            });
            await fireEvent.contextMenu(container.querySelector('.card-touch-root')!);
        } else {
            render(MediaHoverCard, { item, children: cardSnippet, onhide: onremove });
            await hover();
            await fireEvent.contextMenu(document.querySelector('.popup-info')!);
        }
        await waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
        const buttons = Array.from(
            document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
        );
        // ContextMenu ignores the gesture that opened it for 250ms.
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 300);
        return { buttons, onremove, legacyWatched };
    }

    test.each(['card', 'popup'] as const)(
        '%s orders episode actions directly after series removal, without generic duplicates',
        async (surface) => {
            const { buttons } = await openEpisodeMenu(surface, true);
            const labels = buttons.map((button) => button.textContent?.trim());
            const removal = labels.indexOf(removeLabel);
            expect(removal).toBeGreaterThanOrEqual(0);
            expect(labels.slice(removal, removal + 3)).toEqual([
                removeLabel,
                completeLabel,
                unwatchedLabel,
            ]);
            expect(labels.filter((label) => label === completeLabel)).toHaveLength(1);
            expect(labels.filter((label) => label === unwatchedLabel)).toHaveLength(1);
            expect(labels).not.toContain('Mark as watched');
            expect(labels).not.toContain('Mark unwatched');
        },
    );

    test.each([
        ['card', true],
        ['card', false],
        ['popup', true],
        ['popup', false],
    ] as const)(
        '%s changes only this partially watched episode (watched=%s) and refreshes',
        async (surface, watched) => {
            const { buttons, onremove, legacyWatched } = await openEpisodeMenu(surface);
            const button = buttons.find(
                (entry) => entry.textContent?.trim() === (watched ? completeLabel : unwatchedLabel),
            );
            expect(button).toBeDefined();
            await fireEvent.click(button!);
            await waitFor(() =>
                expect(invalidateWhenIdle).toHaveBeenCalledExactlyOnceWith('app:watch-state'),
            );
            if (watched) {
                expect(markWatched).toHaveBeenCalledExactlyOnceWith(EPISODE_UUID, {
                    externalIds: episodeItem.externalIds,
                    mediaType: 'episode',
                    title: episodeItem.title,
                });
                expect(unmarkWatched).not.toHaveBeenCalled();
            } else {
                expect(unmarkWatched).toHaveBeenCalledExactlyOnceWith(EPISODE_UUID);
                expect(markWatched).not.toHaveBeenCalled();
            }
            expect(onremove).not.toHaveBeenCalled();
            expect(legacyWatched).not.toHaveBeenCalled();
        },
    );

    test.each([true, false])(
        'zero-progress Next Up targets this episode (watched=%s)',
        async (watched) => {
            const { buttons } = await openEpisodeMenu('card', false, 0);
            const labels = buttons.map((entry) => entry.textContent?.trim());
            expect(labels).toContain(completeLabel);
            expect(labels).toContain(unwatchedLabel);
            const label = watched ? completeLabel : unwatchedLabel;
            await fireEvent.click(buttons.find((entry) => entry.textContent?.trim() === label)!);
            await waitFor(() => expect(watched ? markWatched : unmarkWatched).toHaveBeenCalled());
            if (watched) {
                expect(markWatched).toHaveBeenCalledExactlyOnceWith(
                    EPISODE_UUID,
                    expect.objectContaining({ mediaType: 'episode' }),
                );
            } else {
                expect(unmarkWatched).toHaveBeenCalledExactlyOnceWith(EPISODE_UUID);
            }
        },
    );

    test('retains generic unwatched when CW episode dismissal and replacement actions are hidden', async () => {
        const { container } = render(UniversalMediaCard, {
            item: { ...episodeItem, isPlayed: true, progress: 86 },
            variant: 'backdrop',
            showDismiss: false,
            continueWatching: true,
        });
        await fireEvent.contextMenu(container.querySelector('.card-touch-root')!);
        const labels = Array.from(document.querySelectorAll('[role="menuitem"]')).map((entry) =>
            entry.textContent?.trim(),
        );
        expect(labels).toContain('Mark unwatched');
        expect(labels).not.toContain(completeLabel);
        expect(labels).not.toContain(unwatchedLabel);
    });

    test('preserves generic watched movie actions outside Continue Watching episodes', async () => {
        const onmarkWatched = vi.fn();
        const { container } = render(UniversalMediaCard, {
            item: { ...episodeItem, mediaType: 'movie', isPlayed: true, progress: 86 },
            variant: 'backdrop',
            showDismiss: true,
            continueWatching: true,
            onmarkWatched,
        });
        await fireEvent.contextMenu(container.querySelector('.card-touch-root')!);
        const labels = Array.from(document.querySelectorAll('[role="menuitem"]')).map((entry) =>
            entry.textContent?.trim(),
        );
        expect(labels).toContain('Mark as watched');
        expect(labels).toContain('Mark unwatched');
        expect(labels).not.toContain(completeLabel);
        expect(labels).not.toContain(unwatchedLabel);
    });
});
