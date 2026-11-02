// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import type { LiveTvStation, LiveTvCategory } from '$lib/schemas/livetv.js';
import ChannelGrid from './ChannelGrid.svelte';

// Mock SvelteKit modules
const mockGoto = vi.fn();
vi.mock('$app/navigation', () => ({
    goto: (...args: unknown[]) => mockGoto(...args),
    replaceState: vi.fn(),
}));

// Mock livetv-playback API so channel clicks don't make real network calls
const mockGetStreamInfoWithLimitCheck = vi.fn();
vi.mock('$lib/api/livetv-playback.js', () => ({
    handoffPlaybackSession: vi.fn(),
    leaveChannel: vi.fn(),
    getStreamInfoWithLimitCheck: (...args: unknown[]) => mockGetStreamInfoWithLimitCheck(...args),
}));

// Mock modal and toast stores
vi.mock('$lib/stores/modal.store.js', () => ({
    modals: { open: vi.fn(), close: vi.fn() },
}));
vi.mock('$lib/stores/toast.store.js', () => ({
    toasts: { warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

vi.mock('$app/paths', () => ({
    resolve: (path: string) => path,
    base: '',
}));

vi.mock('$app/state', () => ({
    page: {
        url: new URL('http://localhost/livetv'),
    },
}));

vi.mock('$lib/paraglide/messages.js', () => ({
    viewer_livetv_other: () => 'Other',
    viewer_livetv_search_scope: () => 'Search all channels and scheduled programs.',
    viewer_livetv_channel_filter: () => 'Channel filter',
    viewer_livetv_favorites: () => 'Favorites',
    viewer_livetv_no_favorites: () => 'No favorite channels yet',
    media_live_tv: () => 'Live TV',
    livetv_all_channels: () => 'All',
    livetv_live_now: () => 'LIVE',
    livetv_ends_in: ({ minutes }: { minutes: number }) => `Ends in ${minutes} min`,
    livetv_no_channels: () => 'No channels available',
    livetv_channels_count: ({ count }: { count: number }) => `${count} channels`,
    livetv_no_search_results: ({ query }: { query: string }) => `No results for "${query}"`,
    livetv_search_placeholder: () => 'Search channels...',
    livetv_off_air: () => 'Off air',
    livetv_off_air_until: ({ time }: { time: string }) => `Off air until ${time}`,
    livetv_no_guide_data: () => 'Live — no guide data',
    livetv_group_expand: ({ count }: { count: number }) => `Show all ${count}`,
    livetv_group_collapse: () => 'Collapse',
    livetv_show_more: () => 'Show more',
    livetv_favorite_add: ({ name }: { name: string }) => `Add ${name} to favorites`,
    livetv_favorite_remove: ({ name }: { name: string }) => `Remove ${name} from favorites`,
}));

vi.mock('$lib/shared/livetv-transforms.js', () => ({
    getRemainingMinutes: (endTime: string | undefined, now: number): number | undefined => {
        if (!endTime) return undefined;
        const remaining = Math.ceil((new Date(endTime).getTime() - now) / 60_000);
        return remaining > 0 ? remaining : undefined;
    },
    filterChannels: (channels: LiveTvStation[], query: string): LiveTvStation[] => {
        if (!query.trim()) return channels;
        const q = query.trim().toLowerCase();
        return channels.filter((ch) => ch.name.toLowerCase().includes(q));
    },
    isOffAirProgram: (title: string | undefined | null): boolean => {
        if (!title) return false;
        return title.trim().toLowerCase() === 'off air';
    },
    formatRemainingTime: (minutes: number): string => `${minutes}m`,
}));

function makeChannel(
    overrides: Partial<LiveTvStation> & { id: string; name: string },
): LiveTvStation {
    return {
        feedId: overrides.id,
        images: {},
        sortOrder: 0,
        isVisible: true,
        nowNext: { current: null, next: null },
        ...overrides,
    };
}

function makeCategory(
    overrides: Partial<LiveTvCategory> & { id: string; name: string },
): LiveTvCategory {
    return {
        sortOrder: 0,
        isVisible: true,
        channelCount: undefined,
        ...overrides,
    };
}

const sportsCategory = makeCategory({
    id: 'cat-sports',
    name: 'Sports',
    channelCount: 2,
});
const newsCategory = makeCategory({
    id: 'cat-news',
    name: 'News',
    channelCount: 1,
});

const channel1 = makeChannel({
    id: 'ch-1',
    feedId: 'ch-1',
    name: 'VELO',
    category: 'Sports',
    categoryId: 'cat-sports',
    sortOrder: 1,
});

const channel2 = makeChannel({
    id: 'ch-2',
    feedId: 'ch-2',
    name: 'Elk Sports',
    category: 'Sports',
    categoryId: 'cat-sports',
    sortOrder: 2,
});

const channel3 = makeChannel({
    id: 'ch-3',
    feedId: 'ch-3',
    name: 'VDD',
    category: 'News',
    categoryId: 'cat-news',
    sortOrder: 3,
});

const allChannels = [channel1, channel2, channel3];
const allCategories = [sportsCategory, newsCategory];

describe('ChannelGrid', () => {
    test('shows only favorites and returns to all channels', async () => {
        const user = userEvent.setup();
        render(ChannelGrid, {
            channels: allChannels,
            categories: allCategories,
            favoriteChannelIds: new Set(['ch-1']),
        });
        await user.click(screen.getByRole('button', { name: 'Favorites' }));
        expect(screen.getByLabelText('VELO')).toBeTruthy();
        expect(screen.queryByLabelText('VDD')).toBeNull();
        await user.click(screen.getByRole('button', { name: 'All' }));
        expect(screen.getByLabelText('VDD')).toBeTruthy();
    });

    test('explains an empty favorites view', async () => {
        const user = userEvent.setup();
        render(ChannelGrid, {
            channels: allChannels,
            categories: allCategories,
            favoriteChannelIds: new Set<string>(),
        });
        await user.click(screen.getByRole('button', { name: 'Favorites' }));
        expect(screen.getByText('No favorite channels yet')).toBeTruthy();
    });

    test('keeps channels whose category is not visible in Other', () => {
        render(ChannelGrid, { channels: allChannels, categories: [sportsCategory] });
        expect(screen.getByRole('heading', { name: /Other/ })).toBeTruthy();
        expect(screen.getByLabelText('VDD')).toBeTruthy();
    });
    beforeEach(() => {
        mockGoto.mockClear();
        mockGetStreamInfoWithLimitCheck.mockClear();
        mockGetStreamInfoWithLimitCheck.mockResolvedValue({ ok: true });
    });

    test('renders all channels when "All" is selected (default)', () => {
        render(ChannelGrid, {
            channels: allChannels,
            categories: allCategories,
        });

        // All 3 channel cards should be rendered as buttons with channel names
        // getByLabelText throws if not found — calling it IS the assertion
        expect(screen.getByLabelText('VELO')).toBeTruthy();
        expect(screen.getByLabelText('Elk Sports')).toBeTruthy();
        expect(screen.getByLabelText('VDD')).toBeTruthy();
    });

    test('groups channels by category with section headings', () => {
        render(ChannelGrid, {
            channels: allChannels,
            categories: allCategories,
        });

        // Category section headings should be rendered
        const headings = screen.getAllByRole('heading');
        const headingTexts = headings.map((h) => h.textContent ?? '');
        expect(headingTexts.some((t) => t.includes('Sports'))).toBe(true);
        expect(headingTexts.some((t) => t.includes('News'))).toBe(true);

        // All channels should still be visible (grouped, not filtered)
        expect(screen.getByLabelText('VELO')).toBeTruthy();
        expect(screen.getByLabelText('Elk Sports')).toBeTruthy();
        expect(screen.getByLabelText('VDD')).toBeTruthy();
    });

    test('shows all channels when no categories provided', () => {
        render(ChannelGrid, {
            channels: allChannels,
            categories: [],
        });

        // No section headings (flat list mode)
        expect(screen.queryByRole('heading')).toBeNull();

        // All channels still rendered
        expect(screen.getByLabelText('VELO')).toBeTruthy();
        expect(screen.getByLabelText('Elk Sports')).toBeTruthy();
        expect(screen.getByLabelText('VDD')).toBeTruthy();
    });

    test('renders empty state when no channels provided', () => {
        render(ChannelGrid, {
            channels: [],
            categories: [],
        });

        // No channel cards should exist
        expect(screen.queryByLabelText('VELO')).toBeNull();
        expect(screen.queryByLabelText('Elk Sports')).toBeNull();
        expect(screen.queryByLabelText('VDD')).toBeNull();
    });

    test('navigates to watch page when channel card is clicked', async () => {
        const user = userEvent.setup();

        render(ChannelGrid, {
            channels: allChannels,
            categories: allCategories,
        });

        const veloCard = screen.getByLabelText('VELO');
        await user.click(veloCard);

        // Wait for the async handleChannelClick to complete
        await vi.waitFor(() => {
            expect(mockGoto).toHaveBeenCalledWith('/watch/ch-1');
        });
    });

    test('hides category sections when no categories', () => {
        render(ChannelGrid, {
            channels: allChannels,
            categories: [],
        });

        // No section headings in flat list mode
        expect(screen.queryByRole('heading')).toBeNull();

        // But channels should still render
        expect(screen.getByLabelText('VELO')).toBeTruthy();
    });

    test('does not render a favorite star when onToggleFavorite is absent', () => {
        render(ChannelGrid, {
            channels: allChannels,
            categories: allCategories,
        });

        expect(screen.queryByLabelText('Add VELO to favorites')).toBeNull();
    });

    test('renders a favorite star reflecting favoriteChannelIds and toggles it without navigating', async () => {
        const user = userEvent.setup();
        const onToggleFavorite = vi.fn();

        render(ChannelGrid, {
            channels: allChannels,
            categories: allCategories,
            favoriteChannelIds: new Set(['ch-1']),
            onToggleFavorite,
        });

        // VELO (ch-1) is already a favorite -> "remove" affordance
        const veloStar = screen.getByLabelText('Remove VELO from favorites');
        expect(veloStar.getAttribute('aria-pressed')).toBe('true');

        // Elk Sports (ch-2) is not a favorite -> "add" affordance
        const elkStar = screen.getByLabelText('Add Elk Sports to favorites');
        expect(elkStar.getAttribute('aria-pressed')).toBe('false');

        await user.click(elkStar);

        expect(onToggleFavorite).toHaveBeenCalledWith(channel2);
        // Clicking the star must not trigger the card's own tune-in navigation
        expect(mockGoto).not.toHaveBeenCalled();
    });
});

describe('ChannelGrid — large lineups', () => {
    test('a category shows its first 24 channels and a "Show all" button', async () => {
        const cat = makeCategory({ id: 'big', name: 'Big' });
        const channels = Array.from({ length: 30 }, (_, i) =>
            makeChannel({
                id: `c${i}`,
                feedId: `c${i}`,
                name: `Station ${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`,
                categoryId: 'big',
                sortOrder: i,
            }),
        );
        render(ChannelGrid, { channels, categories: [cat] });
        expect(screen.getAllByText(/^Station /)).toHaveLength(24);
        await userEvent.click(screen.getByRole('button', { name: 'Show all 30' }));
        expect(screen.getAllByText(/^Station /)).toHaveLength(30);
    });

    test('a numbered family opens a dialog instead of expanding inline', async () => {
        const { modals } = await import('$lib/stores/modal.store.js');
        const cat = makeCategory({ id: 'ev', name: 'Events' });
        const channels = [1, 2, 3, 4, 5].map((n) =>
            makeChannel({
                id: `e${n}`,
                feedId: `e${n}`,
                name: `Live Event ${n}`,
                categoryId: 'ev',
                sortOrder: n,
            }),
        );
        render(ChannelGrid, { channels, categories: [cat] });
        const family = screen.getByRole('button', { name: 'Live Event' });
        expect(family.getAttribute('aria-haspopup')).toBe('dialog');
        await userEvent.click(family);
        expect(vi.mocked(modals.open)).toHaveBeenCalledTimes(1);
        const props = vi.mocked(modals.open).mock.calls[0][1] as { channels: LiveTvStation[] };
        expect(props.channels.map((c) => c.id)).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
        expect(screen.queryByText('Live Event 2')).toBeNull();
    });
});
