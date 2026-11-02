// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { LiveTvStationFeeds } from '$lib/schemas/livetv.js';
import PlayerFeedButton from './PlayerFeedButton.svelte';

const mockStationFeeds = vi.fn();
vi.mock('$lib/api/livetv-playback.js', () => ({
    getStationFeeds: (...args: unknown[]) => mockStationFeeds(...args),
}));
vi.mock('$lib/paraglide/messages.js', () => ({
    close: () => 'Close',
    livetv_feed_choose: () => 'Choose feed',
    livetv_feed_choose_named: ({ name }: { name: string }) => `Choose a feed of ${name}`,
    livetv_feed_menu_label: ({ name }: { name: string }) => `Feeds of ${name}`,
    livetv_feed_menu_hint: () => 'Try another feed.',
    livetv_feed_loading: () => 'Loading feeds…',
    livetv_feed_error: () => 'Could not load',
    livetv_feed_single: () => 'Only one feed',
    livetv_feed_default: () => 'Default',
    livetv_feed_degraded: () => 'Backup',
}));

const GROUP = 'g1';
function feeds(count: number): LiveTvStationFeeds {
    return {
        stationId: GROUP,
        feeds: ['a', 'b', 'c'].slice(0, count).map((id, i) => ({
            id,
            name: `Station ${id}`,
            qualityTier: 'hd' as const,
            isDegraded: false,
            isPrimary: i === 0,
            isVisible: i === 0,
            isDefault: i === 0,
        })),
    };
}

// The "feed choice is off" memo is module state: the 403 case runs last.
async function renderButton(onselectfeed = vi.fn()): Promise<typeof onselectfeed> {
    render(PlayerFeedButton, { channelId: GROUP, feedId: 'a', name: 'Station', onselectfeed });
    return onselectfeed;
}

describe('PlayerFeedButton', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        localStorage.clear();
    });

    test('stays hidden for a single-feed station', async () => {
        mockStationFeeds.mockResolvedValue({ data: feeds(1), error: null, status: 200 });
        await renderButton();
        await waitFor(() => expect(mockStationFeeds).toHaveBeenCalledWith(GROUP));
        expect(screen.queryByRole('button', { name: /Choose a feed/ })).toBeNull();
    });

    test('picking another feed switches to it and remembers it', async () => {
        mockStationFeeds.mockResolvedValue({ data: feeds(3), error: null, status: 200 });
        const user = userEvent.setup();
        const onselectfeed = await renderButton();
        await user.click(await screen.findByRole('button', { name: 'Choose a feed of Station' }));
        expect(mockStationFeeds).toHaveBeenCalledTimes(1);
        const options = await screen.findAllByRole('menuitemradio');
        expect(options[0].getAttribute('aria-checked')).toBe('true');
        await user.click(options[2]);
        expect(onselectfeed).toHaveBeenCalledWith('c');
        expect(JSON.parse(localStorage.getItem('lumastra:livetv-feeds:v1') ?? '{}')).toEqual({
            [GROUP]: 'c',
        });
    });

    test('picking the feed already playing does not reload the player', async () => {
        mockStationFeeds.mockResolvedValue({ data: feeds(2), error: null, status: 200 });
        const user = userEvent.setup();
        const onselectfeed = await renderButton();
        await user.click(await screen.findByRole('button', { name: 'Choose a feed of Station' }));
        await user.click((await screen.findAllByRole('menuitemradio'))[0]);
        expect(onselectfeed).not.toHaveBeenCalled();
    });

    test('closes on Escape and the close button without refetching', async () => {
        mockStationFeeds.mockResolvedValue({ data: feeds(2), error: null, status: 200 });
        const user = userEvent.setup();
        await renderButton();
        const button = await screen.findByRole('button', { name: 'Choose a feed of Station' });
        await user.click(button);
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('menu')).toBeNull();
        await user.click(button);
        await user.click(screen.getByRole('button', { name: 'Close' }));
        expect(screen.queryByRole('menu')).toBeNull();
        expect(mockStationFeeds).toHaveBeenCalledTimes(1);
    });

    test('navigates and selects with the keyboard, restoring focus to the trigger', async () => {
        mockStationFeeds.mockResolvedValue({ data: feeds(3), error: null, status: 200 });
        const user = userEvent.setup();
        const onselectfeed = await renderButton();
        const button = await screen.findByRole('button', { name: 'Choose a feed of Station' });
        await user.click(button);
        const options = await screen.findAllByRole('menuitemradio');
        await waitFor(() => expect(document.activeElement).toBe(options[0]));
        await user.keyboard('{End}');
        expect(document.activeElement).toBe(options[2]);
        await user.keyboard('{ArrowUp}');
        expect(document.activeElement).toBe(options[1]);
        await user.keyboard(' ');
        expect(onselectfeed).toHaveBeenCalledWith('b');
        expect(document.activeElement).toBe(button);
    });

    test('focuses the first feed if neither current nor default is available', async () => {
        const data = feeds(2);
        data.feeds.forEach((feed) => {
            feed.isDefault = false;
        });
        mockStationFeeds.mockResolvedValue({ data, error: null, status: 200 });
        const user = userEvent.setup();
        render(PlayerFeedButton, {
            channelId: GROUP,
            feedId: 'gone',
            name: 'Station',
            onselectfeed: vi.fn(),
        });
        await user.click(await screen.findByRole('button', { name: 'Choose a feed of Station' }));
        const options = await screen.findAllByRole('menuitemradio');
        await waitFor(() => expect(document.activeElement).toBe(options[0]));
    });

    test('refreshes stale feed choices on open while keeping cached options usable', async () => {
        mockStationFeeds.mockResolvedValue({ data: feeds(2), error: null, status: 200 });
        const user = userEvent.setup();
        await renderButton();
        const button = await screen.findByRole('button', { name: 'Choose a feed of Station' });
        const now = Date.now();
        const date = vi.spyOn(Date, 'now').mockReturnValue(now + 61000);
        try {
            mockStationFeeds.mockResolvedValueOnce({ data: feeds(3), error: null, status: 200 });
            await user.click(button);
            await waitFor(() => expect(screen.getAllByRole('menuitemradio')).toHaveLength(3));
            expect(mockStationFeeds).toHaveBeenCalledTimes(2);
        } finally {
            date.mockRestore();
        }
    });

    test('stays hidden while feed choice is off (403)', async () => {
        mockStationFeeds.mockResolvedValue({ data: null, error: 'Forbidden', status: 403 });
        await renderButton();
        await waitFor(() => expect(mockStationFeeds).toHaveBeenCalled());
        expect(screen.queryByRole('button', { name: /Choose a feed/ })).toBeNull();
        // …and is not asked again on the next channel.
        cleanup();
        await renderButton();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(mockStationFeeds).toHaveBeenCalledTimes(1);
    });
});
