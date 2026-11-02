// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ArtistCard from './ArtistCard.svelte';
import AlbumCard from './AlbumCard.svelte';
import MusicCover from './MusicCover.svelte';

vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return { page: readable({ data: { features: {} } }) };
});
vi.mock('$lib/utils/modal-utils', () => ({ openArtistModal: vi.fn(), openAlbumModal: vi.fn() }));

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function image(container: HTMLElement): HTMLImageElement {
    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    return img!;
}

const initialProps = { id: 'artist-a', title: 'Artist A', hasCustomPoster: true };

// The shared action is exercised through each card's actual error/fallback wiring.
describe.each([
    ['artist', () => render(ArtistCard, { props: initialProps })],
    ['album', () => render(AlbumCard, { props: initialProps })],
    ['shared cover', () => render(MusicCover, { props: initialProps })],
] as const)('%s image recovery', (_name, create) => {
    it('retries after two seconds and accepts a successful load', async () => {
        const { container } = create();
        const img = image(container);
        const originalSrc = img.src;
        const requestSrc = img.getAttribute('src');
        const srcSetter = vi.spyOn(img, 'src', 'set');
        await fireEvent.error(img);
        expect(image(container)).toBe(img);
        await vi.advanceTimersByTimeAsync(1999);
        expect(srcSetter).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(srcSetter).toHaveBeenCalledExactlyOnceWith(requestSrc);
        await fireEvent.load(img);
        expect(image(container)).toBe(img);
        expect(img.src).toBe(originalSrc);
    });

    it('falls back after the retry fails and never retries again', async () => {
        const { container } = create();
        const img = image(container);
        const srcSetter = vi.spyOn(img, 'src', 'set');
        await fireEvent.error(img);
        await vi.advanceTimersByTimeAsync(2000);
        await fireEvent.error(img);
        expect(container.querySelector('img')).toBeNull();
        expect(container.textContent).toContain('♪');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(srcSetter).toHaveBeenCalledTimes(1);
    });

    it('cancels a pending retry when the card is reused for another image', async () => {
        const { container, rerender } = create();
        const img = image(container);
        await fireEvent.error(img);
        await rerender({ id: 'artist-b', title: 'Artist B', hasCustomPoster: true });
        const next = image(container);
        const srcSetter = vi.spyOn(next, 'src', 'set');
        await vi.advanceTimersByTimeAsync(2000);
        expect(srcSetter).not.toHaveBeenCalled();
        await fireEvent.error(next);
        await vi.advanceTimersByTimeAsync(2000);
        expect(srcSetter).toHaveBeenCalledTimes(1);
    });
});

it('cancels the retry on unmount', async () => {
    const { container, unmount } = render(MusicCover, { props: { src: '/cover.jpg' } });
    const img = image(container);
    const srcSetter = vi.spyOn(img, 'src', 'set');
    await fireEvent.error(img);
    unmount();
    await vi.advanceTimersByTimeAsync(2000);
    expect(srcSetter).not.toHaveBeenCalled();
});

it('reports a shared cover error only after both attempts fail, and resets for a new URL', async () => {
    const onImageError = vi.fn();
    const { container, rerender } = render(MusicCover, {
        props: { src: '/cover.jpg', onImageError },
    });
    await fireEvent.error(image(container));
    expect(onImageError).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await fireEvent.error(image(container));
    expect(onImageError).toHaveBeenCalledExactlyOnceWith('/cover.jpg');
    await rerender({ src: '/next.jpg', onImageError });
    await tick();
    expect(image(container).getAttribute('src')).toBe('/next.jpg');
});

it('adds up to one second of jitter while keeping a single retry', async () => {
    vi.mocked(Math.random).mockReturnValue(0.75);
    const { container } = render(MusicCover, { props: { src: '/jitter.jpg' } });
    const img = image(container);
    const srcSetter = vi.spyOn(img, 'src', 'set');
    await fireEvent.error(img);
    await vi.advanceTimersByTimeAsync(2749);
    expect(srcSetter).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(srcSetter).toHaveBeenCalledTimes(1);
    await fireEvent.error(img);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(srcSetter).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')).toBeNull();
});
