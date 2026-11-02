// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { writable } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ search: vi.fn() }));
vi.mock('$lib/api/content', () => ({ search: mocks.search }));
vi.mock('$lib/api/music', () => ({ getSonicPath: vi.fn(), getTrack: vi.fn() }));
vi.mock('$lib/api/playlists', () => ({ createPlaylist: vi.fn(), addItem: vi.fn() }));
vi.mock('$lib/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$app/stores', () => ({
    page: writable({ url: new URL('https://example.test/music/path'), data: {} }),
}));
vi.mock('$lib/stores/music-player.store', () => ({
    musicPlayerStore: { ...writable({ currentTrack: null }), play: vi.fn(), addToQueue: vi.fn() },
}));

import SongPath from './SongPath.svelte';

const song = {
    id: 'song-a',
    type: 'track',
    title: 'Starting song',
    overview: 'Artist',
    ids: { internal: 'song-a' },
    images: {},
};

beforeEach(() => {
    vi.useFakeTimers();
    mocks.search.mockReset();
    mocks.search.mockResolvedValue({ data: { items: [song] } });
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

async function searchIn(input: HTMLElement): Promise<void> {
    await fireEvent.focus(input);
    await fireEvent.input(input, { target: { value: 'song' } });
    await vi.advanceTimersByTimeAsync(300);
}

describe('Song Paths guidance and picker searches', () => {
    it('explains missing endpoints and rejects an identical destination', async () => {
        render(SongPath);
        expect(
            screen.getByText('Choose both a start song and a destination song to find a path.'),
        ).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Find Path' }).hasAttribute('disabled')).toBe(
            true,
        );
        await searchIn(screen.getByRole('combobox', { name: 'Pick start track' }));
        await fireEvent.click(screen.getByRole('option', { name: /Starting song/ }));
        await searchIn(screen.getByRole('combobox', { name: 'Pick end track' }));
        await fireEvent.click(screen.getByRole('option', { name: /Starting song/ }));
        expect(
            screen.getByText(
                'Choose two different songs. The start and destination are currently the same.',
            ),
        ).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Find Path' }).hasAttribute('disabled')).toBe(
            true,
        );
    });

    it('cancels pending debounce and discards in-flight results when a search is cleared', async () => {
        render(SongPath);
        const input = screen.getByRole('combobox', { name: 'Pick start track' });
        await fireEvent.focus(input);
        await fireEvent.input(input, { target: { value: 'song' } });
        await fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
        await vi.advanceTimersByTimeAsync(300);
        expect(mocks.search).not.toHaveBeenCalled();

        let finish!: (value: unknown) => void;
        mocks.search.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        await searchIn(input);
        const signal = mocks.search.mock.calls[0][1].signal as AbortSignal;
        await fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
        expect(signal.aborted).toBe(true);
        finish({ data: { items: [song] } });
        await tick();
        expect(screen.queryByRole('option')).toBeNull();
    });

    it.each(['start', 'end'])(
        'keeps %s search feedback outside the listbox and restores input focus on retry',
        async (endpoint) => {
            mocks.search.mockResolvedValueOnce({ error: 'Unavailable' });
            render(SongPath);
            const input = screen.getByRole('combobox', { name: `Pick ${endpoint} track` });
            await searchIn(input);
            expect(screen.getByRole('alert').textContent).toContain(
                'Some music results could not be loaded.',
            );
            expect(screen.queryByRole('listbox')).toBeNull();
            expect(input.getAttribute('aria-expanded')).toBe('false');
            expect(input.hasAttribute('aria-controls')).toBe(false);
            expect(input.getAttribute('aria-describedby')).toBe('song-path-search-feedback');

            const retry = screen.getByRole('button', { name: 'Retry' });
            retry.focus();
            expect(document.activeElement).toBe(retry);
            await fireEvent.click(retry);
            expect(document.activeElement).toBe(input);
            expect(screen.getByRole('status').textContent).toContain('Searching…');
            expect(screen.queryByRole('listbox')).toBeNull();
            expect(input.hasAttribute('aria-controls')).toBe(false);

            await vi.advanceTimersByTimeAsync(300);
            const options = screen.getByRole('listbox', { name: 'Track suggestions' });
            expect(options.querySelector('[role="option"]')).toBeTruthy();
            expect(options.querySelector('[role="alert"], [role="status"]')).toBeNull();
            expect(input.getAttribute('aria-expanded')).toBe('true');
            expect(input.getAttribute('aria-controls')).toBe(options.id);
            expect(input.hasAttribute('aria-describedby')).toBe(false);
            expect(document.activeElement).toBe(input);
        },
    );

    it('discards search results when focus moves to the other endpoint', async () => {
        let finish!: (value: unknown) => void;
        mocks.search.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        render(SongPath);
        await searchIn(screen.getByRole('combobox', { name: 'Pick start track' }));
        const signal = mocks.search.mock.calls[0][1].signal as AbortSignal;
        await fireEvent.focus(screen.getByRole('combobox', { name: 'Pick end track' }));
        expect(signal.aborted).toBe(true);
        finish({ data: { items: [song] } });
        await tick();
        expect(screen.queryByRole('option')).toBeNull();
    });

    it('bounds the loading indicator even when an aborted search never settles', async () => {
        mocks.search.mockReturnValueOnce(new Promise(() => {}));
        render(SongPath);
        const input = screen.getByRole('combobox', { name: 'Pick start track' });
        await fireEvent.focus(input);
        await fireEvent.input(input, { target: { value: 'song' } });
        expect(screen.getByText('Searching…')).toBeTruthy();
        expect(screen.queryByText('No tracks found')).toBeNull();
        await vi.advanceTimersByTimeAsync(15_300);
        expect(screen.queryByText('Searching…')).toBeNull();
        expect(screen.getByRole('alert')).toBeTruthy();
        expect((mocks.search.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
    });
});
