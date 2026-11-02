// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { goto } from '$app/navigation';
import { load } from './+page';
import Page from './+page.svelte';
import type { PageData } from './$types';

vi.mock('$lib/components/app-shell', () => ({ GlobalChrome: () => {} }));
vi.mock('$app/state', () => ({
    page: { url: new URL('http://localhost/livetv'), data: { user: { username: 'viewer' } } },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$lib/api/livetv-playback.js', () => ({
    fetchGuidePrograms: vi.fn(async () => ({ data: null, error: 'offline' })),
}));
vi.mock('$lib/stores/playerNavigation.js', () => ({ saveReturnPath: vi.fn() }));
afterEach(cleanup);

it('renders the real simple interface from the loader and opens the selected channel', async () => {
    const station = {
        id: 'simple-channel',
        feedId: 'simple-channel',
        name: 'Evening News',
        images: {},
        isVisible: true,
        sortOrder: 0,
        nowNext: { current: null, next: null },
    };
    const result = await load({
        data: {
            simpleMode: {
                enabled: true,
                layout: 'list',
                textSize: 'large',
                autostart: false,
                locked: false,
                stationIds: [station.id],
            },
            personalizedChannels: [],
            favoriteChannelIds: [],
        },
    } as unknown as Parameters<typeof load>[0]);
    render(Page, {
        data: {
            ...result,
            channels: [station],
            categories: [],
            liveTvFeedChoice: false,
            loadError: false,
            user: { username: 'viewer' },
        } as unknown as PageData,
    });
    expect(screen.getByTestId('livetv-simple-home')).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: /Evening News/ }));
    expect(goto).toHaveBeenCalledWith('/watch/simple-channel');
});
