// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { createRawSnippet, tick } from 'svelte';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import Layout from './+layout.svelte';
import { searchPrograms } from '$lib/api/livetv-playback.js';
import { getLiveTvAvailability } from '$lib/api/livetv-availability.js';
import { page } from '$app/state';
import type { LayoutServerData } from './$types';

vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/livetv?q=news') } }));
vi.mock('$app/navigation', () => ({
    replaceState: vi.fn(),
    goto: vi.fn(),
    invalidate: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }));
vi.mock('$lib/api/livetv-availability.js', () => ({
    getLiveTvAvailability: vi.fn().mockResolvedValue({ data: undefined, error: null }),
}));
vi.mock('$lib/api/livetv-playback.js', async (original) => ({
    ...(await original<object>()),
    searchPrograms: vi.fn(),
}));
vi.mock('$lib/paraglide/messages.js', async (original) => ({
    ...(await original<object>()),
    viewer_livetv_search_scope: () => 'Search all channels and scheduled programs.',
    viewer_livetv_search_minimum: () => 'Enter at least 2 characters to find programs.',
    viewer_livetv_search_error: () => 'Could not search programs',
}));

function mount(channels: LayoutServerData['channels'] = []): void {
    const data: LayoutServerData = {
        liveTvDisabled: false,
        loadError: false,
        liveTvFeedChoice: false,
        availability: undefined,
        channels,
        categories: [],
    };
    render(Layout, {
        data,
        children: createRawSnippet(() => ({ render: () => '<p>Library</p>' })),
    });
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    page.url.search = '?q=news';
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe('Live TV program search', () => {
    it('fetches a query restored from the URL and distinguishes a failure with retry', async () => {
        vi.mocked(searchPrograms)
            .mockResolvedValueOnce({ data: null, error: 'offline', status: 503 })
            .mockResolvedValueOnce({
                data: { items: [], page: { limit: 15, offset: 0, hasMore: false, total: 0 } },
                error: null,
                status: 200,
            });
        mount();
        await vi.advanceTimersByTimeAsync(300);
        expect(searchPrograms).toHaveBeenCalledWith('news', 50);
        expect(screen.getByRole('alert').textContent).toContain('Could not search programs');
        await fireEvent.click(screen.getByRole('alert').querySelector('button')!);
        await tick();
        expect(screen.queryByRole('alert')).toBeNull();
        expect(searchPrograms).toHaveBeenCalledTimes(2);
    });

    it('does not publish an old failure during a newer query debounce', async () => {
        let finish!: (value: Awaited<ReturnType<typeof searchPrograms>>) => void;
        vi.mocked(searchPrograms).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        mount();
        await vi.advanceTimersByTimeAsync(300);
        await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'sport' } });
        finish({ data: null, error: 'old failure', status: 503 });
        await tick();
        expect(screen.queryByRole('alert')).toBeNull();
        expect(searchPrograms).toHaveBeenCalledTimes(1);
        await fireEvent.input(screen.getByRole('searchbox'), { target: { value: '' } });
        await vi.advanceTimersByTimeAsync(350);
        expect(screen.getByText('Library')).toBeTruthy();
        expect(searchPrograms).toHaveBeenCalledTimes(1);
    });

    it('explains the minimum program query without sending a request', async () => {
        page.url.search = '?q=a';
        mount();
        await vi.advanceTimersByTimeAsync(400);
        expect(screen.getByText('Enter at least 2 characters to find programs.')).toBeTruthy();
        expect(searchPrograms).not.toHaveBeenCalled();
    });
});

describe('Live TV recovery polling', () => {
    it('updates outage warnings without resetting search, and automatically clears them on recovery', async () => {
        const source = {
            sourceId: 's',
            channelFeed: { state: 'failed' as const },
            guideFeed: { state: 'failed' as const },
            playback: 'upstream' as const,
            failedChannelIds: ['a'],
        };
        vi.mocked(getLiveTvAvailability)
            .mockResolvedValueOnce({
                data: {
                    observedAt: new Date().toISOString(),
                    evidenceUnavailable: false,
                    sources: [source],
                    channels: { a: 'upstream' },
                    suppressedChannelIds: ['a'],
                },
                error: null,
                status: 200,
            })
            .mockResolvedValueOnce({
                data: {
                    observedAt: new Date().toISOString(),
                    evidenceUnavailable: false,
                    sources: [],
                    channels: {},
                    suppressedChannelIds: [],
                },
                error: null,
                status: 200,
            });
        vi.mocked(searchPrograms).mockResolvedValue({
            data: { items: [], page: { limit: 15, hasMore: false } },
            error: null,
            status: 200,
        });
        mount([
            {
                id: 'a',
                feedId: 'a',
                images: {},
                name: 'News channel',
                sourceId: 's',
                isVisible: true,
                nowNext: { current: null, next: null },
                sortOrder: 0,
            },
        ]);
        await vi.advanceTimersByTimeAsync(30_000);
        await tick();
        expect(screen.getByText(/TV provider is currently unavailable/)).toBeTruthy();
        expect(page.url.searchParams.get('q')).toBe('news');
        expect(screen.getByText(/Recently unavailable/)).toBeTruthy();
        await vi.advanceTimersByTimeAsync(30_000);
        await tick();
        expect(screen.queryByText(/TV provider is currently unavailable/)).toBeNull();
        expect(screen.queryByText(/Recently unavailable/)).toBeNull();
        expect(page.url.searchParams.get('q')).toBe('news');
    });
});
