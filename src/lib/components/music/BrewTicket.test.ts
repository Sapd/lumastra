// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen, within, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { musicTrackFromCard } from '$lib/utils/music-track';
import type { MoodIslandAnchor } from '$lib/schemas/music-alchemy';
import { musicAlchemyStore } from '$lib/stores/music-alchemy.store.svelte';
import { setLocale } from '$lib/paraglide/runtime';
import BrewTicket from './BrewTicket.svelte';
import MixingDesk from './MixingDesk.svelte';
import MixingDeskDock from './MixingDeskDock.svelte';

const mocks = vi.hoisted(() => ({ play: vi.fn(), context: vi.fn(), success: vi.fn() }));
vi.mock('$lib/stores/music-player.store', () => ({
    musicPlayerStore: { enqueueFromBrew: mocks.play, setPlaybackContext: mocks.context },
}));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: mocks.success, info: vi.fn(), error: vi.fn() },
}));
vi.mock('$lib/api/music', () => ({ brewAlchemy: vi.fn() }));
vi.mock('$lib/api/content', () => ({ search: vi.fn() }));
vi.mock('$lib/paths', () => ({ resolve: (path: string) => `/base${path}` }));

const first = musicTrackFromCard({
    id: 'one',
    title: 'First track',
    artists: [{ id: null, title: 'Artist' }],
    durationMs: 90000,
    images: {
        primary: {
            href: '/original',
            variants: { thumb: '/thumb' },
            revision: '1',
            source: 'self',
        },
    },
});
const second = musicTrackFromCard({ id: 'two', title: 'Second track' });
const third = musicTrackFromCard({ id: 'three', title: 'Third track', durationMs: 125000 });
const tracks = [first, second, third];
const moods: MoodIslandAnchor[] = [
    { label: 'Happy', x: 0.2, y: 0.4, size: 12, color: '#fbbf24' },
    { label: 'party', x: 0.8, y: 0.5, size: 6, color: '#ec4899' },
];

beforeEach(() => {
    vi.clearAllMocks();
    mocks.play.mockResolvedValue(undefined);
    setLocale('en', { reload: false });
    localStorage.clear();
    musicAlchemyStore.clearBrew();
    musicAlchemyStore.seedTracks = [first];
    musicAlchemyStore.avoidTracks = [];
    musicAlchemyStore.brewing = false;
    musicAlchemyStore.dockCollapsed = false;
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setLocale('en', { reload: false });
});

describe('Mixing Desk results', () => {
    it('announces honest lifecycle states and hides stale results/moods while brewing', async () => {
        const view = render(BrewTicket, { tracks: [], seedCount: 0, moodAnchors: moods });
        expect(screen.getByRole('status').textContent).toContain('Add seed tracks to brew');
        expect(screen.queryByRole('group', { name: 'Explored moods' })).toBeNull();
        await view.rerender({ seedCount: 1 });
        expect(screen.getByRole('status').textContent).toContain('Ready to brew');
        await view.rerender({ tracks, hasBrewed: true, totalDurationMs: 215000 });
        expect(screen.getByRole('status').textContent).toContain('3 tracks · 3m');
        expect(screen.getByRole('group', { name: 'Explored moods' }).textContent).toContain(
            'Party',
        );
        await view.rerender({ loading: true });
        expect(screen.getByRole('status').textContent).toContain('Brewing');
        expect(screen.queryByRole('list', { name: 'Brewed tracks' })).toBeNull();
        expect(screen.queryByRole('group', { name: 'Explored moods' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Play' })).toBeNull();
        await view.rerender({ loading: false, tracks: [], moodAnchors: [], totalDurationMs: null });
        expect(screen.getByRole('status').textContent).toContain('No matching tracks');
        expect(screen.getByText('No mood data for these tracks')).toBeTruthy();
        expect(mocks.play).not.toHaveBeenCalled();
    });

    it('localizes known moods, keeps unknown labels and tolerates repeated descriptors', () => {
        setLocale('de', { reload: false });
        render(BrewTicket, {
            tracks: [first],
            hasBrewed: true,
            moodAnchors: [
                ...moods,
                { ...moods[0], label: 'Custom atmosphere' },
                { ...moods[0], label: 'constructor' },
                moods[0],
            ],
        });
        expect(screen.getByRole('heading', { name: 'Dein Mix' })).toBeTruthy();
        const summary = screen.getByRole('group', { name: 'Erkundete Stimmungen' });
        expect(within(summary).getByText('Custom atmosphere')).toBeTruthy();
        expect(within(summary).getAllByText('Fröhlich')).toHaveLength(2);
        expect(within(summary).getByText('constructor')).toBeTruthy();
        expect(within(summary).getAllByRole('listitem')).toHaveLength(5);
        expect(summary.textContent).not.toContain('%');
        expect(screen.getByRole('status').textContent).toContain('1 Titel');
    });

    it('shows readable metadata, artwork fallback, numbers and only known durations', () => {
        render(BrewTicket, { tracks, hasBrewed: true });
        const list = screen.getByRole('list', { name: 'Brewed tracks' });
        const rows = within(list).getAllByRole('listitem');
        expect(rows).toHaveLength(3);
        expect(rows[2].textContent).toContain('3');
        expect(list.querySelectorAll('img')).toHaveLength(1);
        expect(list.querySelector('img')?.getAttribute('src')).toBe('/thumb');
        expect(list.querySelector('img[src=""]')).toBeNull();
        expect(rows[0].textContent).toContain('1:30');
        expect(rows[1].textContent).not.toContain('0:00');
    });

    it('shows and plays the same unique first-occurrence mix and recomputes its duration', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        const duplicate = { ...first, title: 'Later duplicate metadata', durationMs: 500000 };
        render(BrewTicket, {
            tracks: [first, third, duplicate],
            hasBrewed: true,
            totalDurationMs: 715000,
        });
        const list = screen.getByRole('list', { name: 'Brewed tracks' });
        expect(within(list).getAllByRole('listitem')).toHaveLength(2);
        expect(screen.queryByText('Later duplicate metadata')).toBeNull();
        expect(screen.getByRole('status').textContent).toBe('2 tracks · 3m');
        await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
        expect(mocks.play).toHaveBeenLastCalledWith([first, third], true);
        expect(mocks.context).toHaveBeenLastCalledWith(expect.objectContaining({ trackCount: 2 }));
        await fireEvent.click(screen.getByRole('button', { name: 'Play Third track' }));
        expect(mocks.play).toHaveBeenLastCalledWith([third, first], true);
        await fireEvent.click(screen.getByRole('button', { name: 'Shuffle' }));
        expect(mocks.play).toHaveBeenLastCalledWith([third, first], true);
        await fireEvent.click(screen.getByRole('button', { name: 'Add to queue' }));
        expect(mocks.play).toHaveBeenLastCalledWith([first, third], false);
    });

    it('omits the total after deduplication if any retained track duration is unknown', async () => {
        render(BrewTicket, {
            tracks: [first, second, first],
            hasBrewed: true,
            totalDurationMs: 300000,
        });
        expect(screen.getByRole('status').textContent).toBe('2 tracks');
        expect(
            within(screen.getByRole('list', { name: 'Brewed tracks' })).getAllByRole('listitem'),
        ).toHaveLength(2);
        await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
        expect(mocks.play).toHaveBeenCalledWith([first, second], true);
    });

    it('plays all tracks with context and rotates playback at the selected row', async () => {
        render(BrewTicket, { tracks, hasBrewed: true });
        await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
        expect(mocks.play).toHaveBeenLastCalledWith(tracks, true);
        expect(mocks.context).toHaveBeenCalledWith({
            type: 'mix',
            name: 'Mixing Desk',
            trackCount: 3,
            href: '/base/music/alchemy',
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Play Second track' }));
        expect(mocks.play).toHaveBeenLastCalledWith([second, third, first], true);
    });

    it('shuffles a copy while preserving the result order', async () => {
        vi.spyOn(Math, 'random').mockReturnValue(0);
        render(BrewTicket, { tracks, hasBrewed: true });
        await fireEvent.click(screen.getByRole('button', { name: 'Shuffle' }));
        expect(mocks.play).toHaveBeenCalledWith([second, third, first], true);
        expect(tracks.map((track) => track.id)).toEqual(['one', 'two', 'three']);
    });

    it('enqueues without replacing playback and delegates clear', async () => {
        const onclear = vi.fn();
        render(BrewTicket, { tracks, hasBrewed: true, onclear });
        await fireEvent.click(screen.getByRole('button', { name: 'Add to queue' }));
        expect(mocks.play).toHaveBeenCalledWith(tracks, false);
        expect(mocks.context).not.toHaveBeenCalled();
        expect(mocks.success).toHaveBeenCalledWith('Queue updated');
        await fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        expect(onclear).toHaveBeenCalledOnce();
    });

    it('blocks duplicate play actions until playback setup completes', async () => {
        let finish!: () => void;
        mocks.play.mockReturnValueOnce(
            new Promise<void>((resolve) => {
                finish = resolve;
            }),
        );
        render(BrewTicket, { tracks, hasBrewed: true });
        await fireEvent.click(screen.getByRole('button', { name: 'Play' }));
        for (const name of ['Play', 'Shuffle', 'Play Second track']) {
            const button = screen.getByRole('button', { name }) as HTMLButtonElement;
            expect(button.disabled).toBe(true);
            await fireEvent.click(button);
        }
        expect(mocks.play).toHaveBeenCalledOnce();
        finish();
        await waitFor(() =>
            expect(
                (screen.getByRole('button', { name: 'Play' }) as HTMLButtonElement).disabled,
            ).toBe(false),
        );
    });

    it('composes page results with mood data and clears results while preserving seeds', async () => {
        musicAlchemyStore.brewedTracks = tracks;
        musicAlchemyStore.hasBrewed = true;
        musicAlchemyStore.moodAnchors = moods;
        render(MixingDesk);
        const result = screen.getByRole('region', { name: 'Brew result' });
        expect(result.classList.contains('compact')).toBe(false);
        expect(within(result).getByRole('group', { name: 'Explored moods' })).toBeTruthy();
        await fireEvent.click(within(result).getByRole('button', { name: 'Clear' }));
        expect(musicAlchemyStore.seedTracks).toEqual([first]);
        expect(musicAlchemyStore.brewedTracks).toEqual([]);
        expect(within(result).queryByRole('group')).toBeNull();
        expect(within(result).getByRole('status').textContent).toContain('Ready to brew');
        expect(mocks.play).not.toHaveBeenCalled();
    });

    it('explicitly compacts the Home dock and preserves its full-desk link and clear callback', async () => {
        musicAlchemyStore.brewedTracks = tracks;
        musicAlchemyStore.hasBrewed = true;
        render(MixingDeskDock);
        const result = screen.getByRole('region', { name: 'Brew result' });
        expect(result.classList.contains('compact')).toBe(true);
        expect(
            within(result)
                .getByRole('link', { name: /Open full desk/ })
                .getAttribute('href'),
        ).toBe('/base/music/alchemy');
        await fireEvent.click(within(result).getByRole('button', { name: 'Clear' }));
        expect(musicAlchemyStore.seedTracks).toEqual([first]);
        expect(screen.getByRole('link', { name: /Open full desk/ })).toBeTruthy();
    });
});
