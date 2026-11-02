// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import TrackArtistLine from './TrackArtistLine.svelte';
import { openArtistModal } from '$lib/utils/modal-utils';

vi.mock('$lib/utils/modal-utils', () => ({ openArtistModal: vi.fn() }));

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('TrackArtistLine', () => {
    it('renders multiple known artists byte-for-byte with no injected whitespace', () => {
        const { container } = render(TrackArtistLine, {
            props: {
                artist: 'DJ Fenwick, Milo Sebastian',
                artists: [
                    { id: 'a', title: 'DJ Fenwick' },
                    { id: 'b', title: 'Milo Sebastian' },
                ],
            },
        });
        expect(container.textContent).toBe('DJ Fenwick, Milo Sebastian');
    });

    it('renders both known artists joined by "&" byte-for-byte', () => {
        const { container } = render(TrackArtistLine, {
            props: {
                artist: 'Alice & Bob',
                artists: [
                    { id: 'a', title: 'Alice' },
                    { id: 'b', title: 'Bob' },
                ],
            },
        });
        expect(container.textContent).toBe('Alice & Bob');
    });

    it('opens each visible credit using its own UUID despite an unrelated fallback', async () => {
        const onNavigate = vi.fn();
        const { container, getByRole } = render(TrackArtistLine, {
            props: {
                artist: 'DJ Fenwick, MILO SEBASTIAN',
                artists: [
                    { id: 'primary', title: 'DJ Fenwick' },
                    { id: 'additional', title: 'Milo Sebastian' },
                ],
                artistId: 'primary',
                onNavigate,
            },
        });

        expect(container.textContent).toBe('DJ Fenwick, MILO SEBASTIAN');
        await fireEvent.click(getByRole('button', { name: 'MILO SEBASTIAN' }));
        expect(openArtistModal).toHaveBeenLastCalledWith('additional');
        await fireEvent.click(getByRole('button', { name: 'DJ Fenwick' }));
        expect(openArtistModal).toHaveBeenLastCalledWith('primary');
        expect(onNavigate).toHaveBeenCalledTimes(2);
    });

    it('links a case-variant label to its structured artist instead of the fallback', async () => {
        const { getByRole } = render(TrackArtistLine, {
            props: {
                artist: 'milo sebastian',
                artists: [{ id: 'additional', title: 'Milo Sebastian' }],
                artistId: 'primary',
            },
        });

        await fireEvent.click(getByRole('button', { name: 'milo sebastian' }));
        expect(openArtistModal).toHaveBeenCalledExactlyOnceWith('additional');
    });

    it('updates paired targets on rerender and removes a contradictory stale link', async () => {
        const { container, getByRole, getByText, rerender } = render(TrackArtistLine, {
            props: {
                artist: 'Milo Sebastian',
                artists: [{ id: 'secondary', title: 'Milo Sebastian' }],
                artistId: 'album-owner',
            },
        });

        await fireEvent.click(getByRole('button', { name: 'Milo Sebastian' }));
        expect(openArtistModal).toHaveBeenCalledExactlyOnceWith('secondary');

        await rerender({
            artist: 'Silver Meadow',
            artists: [{ id: 'next-credit', title: 'Silver Meadow' }],
            artistId: 'album-owner',
        });
        expect(container.textContent).toBe('Silver Meadow');
        await fireEvent.click(getByRole('button', { name: 'Silver Meadow' }));
        expect(vi.mocked(openArtistModal).mock.calls).toEqual([['secondary'], ['next-credit']]);

        await rerender({
            artist: 'Amber Harbor',
            artists: [{ id: 'next-credit', title: 'Silver Meadow' }],
            artistId: 'next-credit',
        });
        expect(container.textContent).toBe('Amber Harbor');
        expect(container.querySelector('button')).toBeNull();
        await fireEvent.click(getByText('Amber Harbor'));
        expect(vi.mocked(openArtistModal).mock.calls).toEqual([['secondary'], ['next-credit']]);
        expect(openArtistModal).not.toHaveBeenCalledWith('album-owner');
    });

    it('leaves a contradictory label unlinked instead of using the fallback UUID', () => {
        const { container } = render(TrackArtistLine, {
            props: {
                artist: 'Milo Sebastian',
                artists: [{ id: 'primary', title: 'DJ Fenwick' }],
                artistId: 'primary',
            },
        });

        expect(container.textContent).toBe('Milo Sebastian');
        expect(container.querySelector('button')).toBeNull();
        expect(openArtistModal).not.toHaveBeenCalled();
    });

    it.each([undefined, []])(
        'preserves unstructured radio artist navigation (%j)',
        async (artists) => {
            const { container, getByRole } = render(TrackArtistLine, {
                props: { artist: 'Radio Performer', artists, artistId: 'radio-artist' },
            });

            expect(container.textContent).toBe('Radio Performer');
            await fireEvent.click(getByRole('button', { name: 'Radio Performer' }));
            expect(openArtistModal).toHaveBeenCalledExactlyOnceWith('radio-artist');
        },
    );

    it('renders plain text when nothing resolves', () => {
        const { container } = render(TrackArtistLine, {
            props: { artist: 'Some Artist', artists: [] },
        });
        expect(container.textContent).toBe('Some Artist');
        expect(container.querySelector('button')).toBeNull();
    });
});
