// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/svelte';
import { writable, type Writable } from 'svelte/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { musicTrackFromCard } from '$lib/utils/music-track';
import MusicMixes from './MusicMixes.svelte';
import ModalContainer from '$lib/components/ui/ModalContainer.svelte';

const mocks = vi.hoisted(() => ({
    smart: vi.fn(),
    clusters: vi.fn(),
    members: vi.fn(),
    play: vi.fn(),
    context: vi.fn(),
}));
vi.mock('$lib/api/music', () => ({
    getMusicSmartMixes: mocks.smart,
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
        url: new URL('https://example.test/music'),
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
            (
                page as unknown as Writable<{
                    url: URL;
                    state: App.PageState;
                    data: { features: { musicClusters: boolean } };
                }>
            ).update((current) => ({
                ...current,
                url: new URL(url),
                state,
            }));
        },
        replaceState: vi.fn(),
    };
});
import { page } from '$app/stores';
const pageStore = page as unknown as Writable<{
    url: URL;
    state: App.PageState;
    data: { features: { musicClusters: boolean } };
}>;
const first = {
    id: 'one',
    title: 'First track',
    subtitle: 'Artist',
    externalIds: { internal: 'one' },
    clickData: {},
    image: null,
};
const second = { ...first, id: 'two', title: 'Second track', externalIds: { internal: 'two' } };
const collection = {
    id: 7,
    label: 'Library dance',
    trackCount: 1876,
    topArtists: ['A', 'B'],
    topGenres: [],
};
beforeEach(() => {
    vi.clearAllMocks();
    pageStore.set({
        url: new URL('https://example.test/music'),
        state: {},
        data: { features: { musicClusters: true } },
    });
    mocks.smart.mockResolvedValue({
        data: { sections: [{ id: 'music-mix-dance', title: 'Dance Mix', items: [first, second] }] },
    });
    mocks.clusters.mockResolvedValue({ data: { items: [collection] } });
    mocks.members.mockResolvedValue({
        data: {
            items: [
                musicTrackFromCard({
                    id: 'member',
                    title: 'Library song',
                    artists: [{ id: null, title: 'A' }],
                    durationMs: 90000,
                }),
            ],
        },
    });
    mocks.play.mockResolvedValue(undefined);
});
/** The preview opens in the app-wide modal stack, so mount its container too. */
function renderMixes(): void {
    render(ModalContainer);
    render(MusicMixes);
}
afterEach(cleanup);
describe('music mix rails', () => {
    it.each([
        [{ card: '/collage-card', thumb: '/collage-thumb' }, '/original', '/collage-card'],
        [{ thumb: '/collage-thumb' }, '/original', '/collage-thumb'],
        [{}, '/original', '/original'],
    ])('uses the best available composed collection artwork', async (variants, href, expected) => {
        mocks.clusters.mockResolvedValueOnce({
            data: { items: [{ ...collection, images: { primary: { variants, href } } }] },
        });
        renderMixes();
        const open = await screen.findByRole('button', { name: 'Open Library dance' });
        const art = open.closest('.mix-card')?.querySelector('.collage');
        expect(art?.querySelectorAll('img')).toHaveLength(1);
        expect(art?.querySelector('img')?.getAttribute('src')).toBe(expected);
    });

    it("builds the Smart Mix cover from its tracks' artwork", async () => {
        const art = (id: string) => ({
            primary: {
                href: `/${id}-card`,
                variants: { thumb: `/${id}-thumb`, card: `/${id}-card` },
            },
        });
        mocks.smart.mockResolvedValueOnce({
            data: {
                sections: [
                    {
                        id: 'music-mix-dance',
                        title: 'Dance Mix',
                        items: [
                            { ...first, images: art('one') },
                            { ...second, images: art('two') },
                        ],
                    },
                ],
            },
        });
        renderMixes();
        const open = await screen.findByRole('button', { name: 'Open Dance Mix' });
        const srcs = [...(open.closest('.mix-card')?.querySelectorAll('img') ?? [])].map((img) =>
            img.getAttribute('src'),
        );
        expect(srcs).toEqual(['/one-thumb', '/two-thumb']);
    });

    it('opens a Smart Mix without playing and plays exactly the preview selection', async () => {
        renderMixes();
        await fireEvent.click(await screen.findByRole('button', { name: 'Open Dance Mix' }));
        await screen.findByText('First track');
        expect(mocks.play).not.toHaveBeenCalled();
        expect(screen.getByRole('heading', { name: 'Smart Mixes' })).toBeTruthy();
        expect(screen.getByRole('heading', { name: 'Mixes for You' })).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
        expect(mocks.play.mock.calls[0][0].map((track: { id: string }) => track.id)).toEqual([
            'one',
            'two',
        ]);
        expect(mocks.context).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'Dance Mix', href: '/music?mix=music-mix-dance' }),
        );
    });
    it('shows retry on service failure and keeps the loading state until the response arrives', async () => {
        let finish!: (value: unknown) => void;
        mocks.smart.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        renderMixes();
        expect(screen.getByRole('status', { name: 'Loading Smart Mixes' })).toBeTruthy();
        finish({ error: 'Unavailable' });
        await screen.findByRole('alert');
        await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await screen.findByRole('button', { name: 'Open Dance Mix' });
    });
    it('reuses the collection selection for quick play and preview and discloses the library total', async () => {
        renderMixes();
        await fireEvent.click(await screen.findByRole('button', { name: 'Play Library dance' }));
        await waitFor(() => expect(mocks.play).toHaveBeenCalledOnce());
        await fireEvent.click(screen.getByRole('button', { name: 'Open Library dance' }));
        await screen.findByText(/1-track selection from 1,876/);
        expect(mocks.members).toHaveBeenCalledTimes(1);
        expect(mocks.members).toHaveBeenCalledWith(7, 200);
    });
    it('opens a direct Smart Mix link after its data arrives', async () => {
        pageStore.set({
            url: new URL('https://example.test/music?mix=music-mix-dance'),
            state: {},
            data: { features: { musicClusters: false } },
        });
        renderMixes();
        await screen.findByRole('dialog', { name: 'Dance Mix' });
        await screen.findByText('Second track');
        expect(mocks.clusters).not.toHaveBeenCalled();
        expect(mocks.play).not.toHaveBeenCalled();
    });
});
