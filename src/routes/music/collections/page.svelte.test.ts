// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { writable, type Writable } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { musicTrackFromCard } from '$lib/utils/music-track';
import ModalContainer from '$lib/components/ui/ModalContainer.svelte';

const mocks = vi.hoisted(() => ({
    clusters: vi.fn(),
    members: vi.fn(),
    play: vi.fn(),
    context: vi.fn(),
}));
vi.mock('$lib/api/music', () => ({
    getMusicClusters: mocks.clusters,
    getMusicClusterMembers: mocks.members,
}));
vi.mock('$lib/api/playlists', () => ({ createPlaylist: vi.fn(), addItem: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));
vi.mock('$lib/utils/image-utils', () => ({ getCatalogPosterUrl: (id: string) => `/cover/${id}` }));
vi.mock('$lib/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$app/stores', () => ({
    page: writable({
        url: new URL('https://example.test/music/collections'),
        route: { id: '/music/collections' },
        state: {},
        data: { features: { musicClusters: true } },
    }),
}));
vi.mock('$lib/stores/music-player.store', () => ({
    musicPlayerStore: {
        ...writable({ currentTrack: null }),
        enqueueFromBrew: mocks.play,
        setPlaybackContext: mocks.context,
    },
}));
vi.mock('$app/navigation', async () => {
    const { page } = await import('$app/stores');
    return {
        pushState: (url: string, state: App.PageState) => {
            (page as unknown as Writable<{ url: URL; state: App.PageState }>).update((current) => ({
                ...current,
                url: new URL(url),
                state,
            }));
        },
        replaceState: vi.fn(),
    };
});

import { page } from '$app/stores';
import Collections from './+page.svelte';

const pageStore = page as unknown as Writable<{
    url: URL;
    route: { id: string };
    state: App.PageState;
    data: { features: { musicClusters: boolean } };
}>;
const collection = {
    id: 7,
    label: 'Evening selection',
    trackCount: 120,
    topArtists: ['Example artist'],
    topGenres: [],
};
const track = musicTrackFromCard({
    id: 'library-song',
    title: 'Library song',
    artists: [{ id: null, title: 'Example artist' }],
    durationMs: 90_000,
});

beforeEach(() => {
    vi.clearAllMocks();
    pageStore.set({
        url: new URL('https://example.test/music/collections'),
        route: { id: '/music/collections' },
        state: {},
        data: { features: { musicClusters: true } },
    });
    mocks.clusters.mockResolvedValue({ data: { items: [collection] } });
    mocks.members.mockResolvedValue({ data: { items: [track] } });
    mocks.play.mockResolvedValue(undefined);
});
afterEach(cleanup);

function renderCollections(): void {
    render(ModalContainer);
    render(Collections);
}

describe('Collections route artwork and actions', () => {
    it.each([
        [{ card: '/collage-card', thumb: '/collage-thumb' }, '/original', '/collage-card'],
        [{ thumb: '/collage-thumb' }, '/original', '/collage-thumb'],
        [{}, '/original', '/original'],
    ])('uses card, thumb, then href for its composed cover', async (variants, href, expected) => {
        mocks.clusters.mockResolvedValueOnce({
            data: { items: [{ ...collection, images: { primary: { variants, href } } }] },
        });
        renderCollections();
        const open = await screen.findByRole('button', { name: 'Open Evening selection' });
        const art = open.closest('.mix-card')?.querySelector('.collage');
        expect(art?.querySelectorAll('img')).toHaveLength(1);
        expect(art?.querySelector('img')?.getAttribute('src')).toBe(expected);
        expect(art?.getAttribute('data-cover-count')).toBe('1');
    });

    it('opens the preview without playing and plays only when its Play action is selected', async () => {
        renderCollections();
        await fireEvent.click(
            await screen.findByRole('button', { name: 'Open Evening selection' }),
        );
        const preview = await screen.findByRole('dialog', { name: 'Evening selection' });
        await within(preview).findByText('Library song');
        expect(mocks.play).not.toHaveBeenCalled();
        await fireEvent.click(within(preview).getByRole('button', { name: 'Play' }));
        await waitFor(() => expect(mocks.play).toHaveBeenCalledWith([track]));
        expect(mocks.context).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'Evening selection',
                href: '/music/collections?collection=7',
            }),
        );
    });

    it('plays directly from the card without opening its preview', async () => {
        renderCollections();
        await fireEvent.click(
            await screen.findByRole('button', { name: 'Play Evening selection' }),
        );
        await waitFor(() => expect(mocks.play).toHaveBeenCalledWith([track]));
        expect(mocks.members).toHaveBeenCalledWith(7, 200);
        expect(screen.queryByRole('dialog')).toBeNull();
    });
});
