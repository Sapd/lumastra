// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The viewer feed picker on /livetv: right-click a multi-feed station, pick a
 * feed, and the device remembers it for the next click; a remembered feed the
 * server refuses falls back to the default feed and is forgotten.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { LiveTvCategory, LiveTvStation, LiveTvStationFeeds } from '$lib/schemas/livetv.js';
import ChannelGrid from './ChannelGrid.svelte';

const mockGoto = vi.fn();
vi.mock('$app/navigation', () => ({
    goto: (...args: unknown[]) => mockGoto(...args),
    replaceState: vi.fn(),
}));

const mockStreamInfo = vi.fn();
const mockStationFeeds = vi.fn();
vi.mock('$lib/api/livetv-playback.js', () => ({
    handoffPlaybackSession: vi.fn(),
    leaveChannel: vi.fn(),
    getStreamInfoWithLimitCheck: (...args: unknown[]) => mockStreamInfo(...args),
    getStationFeeds: (...args: unknown[]) => mockStationFeeds(...args),
}));
vi.mock('$lib/api/playback.js', () => ({
    getLiveTvChannels: vi.fn().mockResolvedValue({ data: null, error: 'x' }),
}));
vi.mock('$lib/stores/modal.store.js', () => ({ modals: { open: vi.fn(), close: vi.fn() } }));
vi.mock('$lib/stores/toast.store.js', () => ({
    toasts: { warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('$lib/stores/playerNavigation.js', () => ({ saveReturnPath: vi.fn() }));
vi.mock('$app/paths', () => ({ resolve: (path: string) => path, base: '' }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/livetv') } }));

vi.mock('$lib/paraglide/messages.js', () => ({
    viewer_livetv_other: () => 'Other',
    viewer_livetv_search_scope: () => 'Search',
    viewer_livetv_channel_filter: () => 'Channel filter',
    viewer_livetv_favorites: () => 'Favorites',
    viewer_livetv_no_favorites: () => 'No favorites',
    media_live_tv: () => 'Live TV',
    livetv_all_channels: () => 'All',
    livetv_no_channels: () => 'No channels',
    livetv_no_search_results: () => 'No results',
    livetv_search_placeholder: () => 'Search channels...',
    livetv_off_air: () => 'Off air',
    livetv_off_air_until: () => 'Off air until',
    livetv_no_guide_data: () => 'No guide data',
    livetv_show_more: () => 'Show more',
    livetv_availability_channel: () => 'Unavailable',
    livetv_stream_kicked_message: () => 'Kicked',
    livetv_live_now: () => 'LIVE',
    livetv_ends_in: ({ minutes }: { minutes: number }) => `Ends in ${minutes} min`,
    livetv_channels_count: ({ count }: { count: number }) => `${count} channels`,
    livetv_group_expand: ({ count }: { count: number }) => `Show all ${count}`,
    livetv_group_collapse: () => 'Collapse',
    livetv_favorite_add: ({ name }: { name: string }) => `Add ${name}`,
    livetv_favorite_remove: ({ name }: { name: string }) => `Remove ${name}`,
    livetv_feed_menu_label: ({ name }: { name: string }) => `Feeds of ${name}`,
    livetv_feed_menu_hint: () => 'Try another feed.',
    livetv_feed_loading: () => 'Loading feeds…',
    livetv_feed_error: () => 'Could not load',
    livetv_feed_single: () => 'Only one feed',
    livetv_feed_default: () => 'Default',
    livetv_feed_degraded: () => 'Backup',
}));

const GROUP = 'group-k9';
const station: LiveTvStation = {
    id: GROUP,
    feedId: 'feed-fhdplus',
    name: 'Kanal Neun',
    images: {},
    categoryId: 'cat-de',
    sortOrder: 1,
    isVisible: true,
    nowNext: { current: null, next: null },
};
const single: LiveTvStation = {
    id: 'lone',
    feedId: 'lone',
    name: 'Lonely',
    images: {},
    categoryId: 'cat-de',
    sortOrder: 2,
    isVisible: true,
    nowNext: { current: null, next: null },
};
const categories: LiveTvCategory[] = [
    { id: 'cat-de', name: 'Germany', sortOrder: 0, isVisible: true },
];
const feeds: LiveTvStationFeeds = {
    stationId: station.id,
    feeds: [
        {
            id: 'feed-fhdplus',
            name: 'Kanal Neun FHD+',
            qualityTier: 'fhd',
            isDegraded: false,
            isPrimary: false,
            isVisible: true,
            isDefault: true,
        },
        {
            id: 'feed-hd',
            name: 'Kanal Neun HD',
            qualityTier: 'hd',
            isDegraded: false,
            isPrimary: true,
            isVisible: false,
            isDefault: false,
        },
    ],
};

function feedOption(id: string): HTMLElement {
    const option = screen
        .getAllByRole('menuitemradio')
        .find((el) => el.getAttribute('data-feed-id') === id);
    if (!option) throw new Error(`no option for ${id}`);
    return option;
}

function getStoredFeeds(): Record<string, string> {
    return JSON.parse(localStorage.getItem('lumastra:livetv-feeds:v1') ?? '{}') as Record<
        string,
        string
    >;
}

function renderGrid(feedChoice = true): void {
    render(ChannelGrid, { channels: [station, single], categories, feedChoice });
}

describe('ChannelGrid feed picker', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
        mockStreamInfo.mockResolvedValue({ ok: true });
        mockStationFeeds.mockResolvedValue({ data: feeds, error: null, status: 200 });
    });

    test('right-click lists the feeds; picking one plays it and remembers it', async () => {
        const user = userEvent.setup();
        renderGrid();
        await fireEvent.contextMenu(screen.getByLabelText('Kanal Neun'), {
            clientX: 40,
            clientY: 40,
        });
        const menu = await screen.findByRole('menu', { name: 'Feeds of Kanal Neun' });
        expect(mockStationFeeds).toHaveBeenCalledWith(station.id);
        const options = await screen.findAllByRole('menuitemradio');
        expect(options.map((o) => o.getAttribute('aria-checked'))).toEqual(['true', 'false']);
        expect(menu.textContent).toContain('Default');

        await user.click(feedOption('feed-hd'));

        await waitFor(() => expect(mockGoto).toHaveBeenCalledWith(`/watch/${GROUP}`));
        expect(mockStreamInfo).toHaveBeenCalledWith(GROUP, expect.anything(), undefined, 'feed-hd');
        expect(screen.queryByRole('menu')).toBeNull();

        // The next plain click opens the remembered feed.
        mockGoto.mockClear();
        await user.click(screen.getByLabelText('Kanal Neun'));
        await waitFor(() => expect(mockGoto).toHaveBeenCalledWith(`/watch/${GROUP}`));
    });

    test('picking the default feed forgets the earlier choice', async () => {
        localStorage.setItem('lumastra:livetv-feeds:v1', JSON.stringify({ [GROUP]: 'feed-hd' }));
        const user = userEvent.setup();
        renderGrid();
        await fireEvent.contextMenu(screen.getByLabelText('Kanal Neun'), {
            clientX: 5,
            clientY: 5,
        });
        await screen.findAllByRole('menuitemradio');
        await user.click(feedOption('feed-fhdplus'));
        await waitFor(() => expect(mockGoto).toHaveBeenCalledWith(`/watch/${GROUP}`));
        expect(JSON.parse(localStorage.getItem('lumastra:livetv-feeds:v1') ?? '{}')).toEqual({});
    });

    test('a remembered feed the server refuses falls back to the default and is forgotten', async () => {
        localStorage.setItem('lumastra:livetv-feeds:v1', JSON.stringify({ [GROUP]: 'gone' }));
        mockStreamInfo.mockImplementation(
            async (_id: string, _quality: unknown, _signal: unknown, feedId?: string) =>
                feedId === 'gone'
                    ? { ok: false, error: 'Stream unavailable (404)', status: 404 }
                    : { ok: true },
        );
        const user = userEvent.setup();
        renderGrid();
        await user.click(screen.getByLabelText('Kanal Neun'));
        await waitFor(() => expect(mockGoto).toHaveBeenCalledWith(`/watch/${GROUP}`));
        expect(mockStreamInfo.mock.calls.map((c) => c[0])).toEqual([GROUP, GROUP]);
        expect(localStorage.getItem('lumastra:livetv-feeds:v1')).toBe('{}');
    });

    test('a remembered feed that fails for another reason is kept and not swapped silently', async () => {
        localStorage.setItem('lumastra:livetv-feeds:v1', JSON.stringify({ [GROUP]: 'feed-hd' }));
        mockStreamInfo.mockResolvedValue({
            ok: false,
            error: 'Stream unavailable (500)',
            status: 500,
        });
        const user = userEvent.setup();
        renderGrid();
        await user.click(screen.getByLabelText('Kanal Neun'));
        await waitFor(() => expect(mockGoto).toHaveBeenCalledWith(`/watch/${GROUP}`));
        expect(mockStreamInfo.mock.calls.map((c) => c[0])).toEqual([GROUP]);
        expect(getStoredFeeds()).toEqual({ [GROUP]: 'feed-hd' });
    });

    test('a touch long-press opens the menu and the lift does not open the channel', async () => {
        renderGrid();
        const card = screen.getByLabelText('Kanal Neun');
        await fireEvent.pointerDown(card, { pointerType: 'touch', clientX: 20, clientY: 20 });
        await new Promise((resolve) => setTimeout(resolve, 600));
        await fireEvent.pointerUp(card, { pointerType: 'touch' });
        await fireEvent.click(card);
        expect(await screen.findByRole('menu', { name: 'Feeds of Kanal Neun' })).toBeTruthy();
        expect(mockStreamInfo).not.toHaveBeenCalled();
        expect(mockGoto).not.toHaveBeenCalled();
    });

    test('a touch press that moves (a scroll) opens nothing', async () => {
        renderGrid();
        const card = screen.getByLabelText('Kanal Neun');
        await fireEvent.pointerDown(card, { pointerType: 'touch', clientX: 20, clientY: 20 });
        await fireEvent.pointerMove(card, { pointerType: 'touch', clientX: 20, clientY: 80 });
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(screen.queryByRole('menu')).toBeNull();
    });

    test('can ask for the feeds of any station without inferring group membership', async () => {
        mockStationFeeds.mockResolvedValue({
            data: { stationId: single.id, feeds: [feeds.feeds[0]] },
            error: null,
            status: 200,
        });
        renderGrid();
        await fireEvent.contextMenu(screen.getByLabelText('Lonely'));
        expect(await screen.findByRole('menu')).toBeTruthy();
        expect(screen.getByLabelText('Kanal Neun').getAttribute('aria-haspopup')).toBe('menu');
        expect(screen.getByLabelText('Lonely').getAttribute('aria-haspopup')).toBe('menu');
    });

    test('feed choice off: no menu, and a remembered feed is ignored', async () => {
        localStorage.setItem('lumastra:livetv-feeds:v1', JSON.stringify({ [GROUP]: 'feed-hd' }));
        const user = userEvent.setup();
        renderGrid(false);
        await fireEvent.contextMenu(screen.getByLabelText('Kanal Neun'));
        expect(screen.queryByRole('menu')).toBeNull();
        await user.click(screen.getByLabelText('Kanal Neun'));
        await waitFor(() => expect(mockGoto).toHaveBeenCalledWith(`/watch/${GROUP}`));
    });

    test('Escape closes the menu', async () => {
        const user = userEvent.setup();
        renderGrid();
        await fireEvent.contextMenu(screen.getByLabelText('Kanal Neun'), {
            clientX: 5,
            clientY: 5,
        });
        await screen.findAllByRole('menuitemradio');
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('menu')).toBeNull();
    });
});
