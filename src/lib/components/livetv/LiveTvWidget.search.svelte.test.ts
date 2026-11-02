// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, cleanup, fireEvent, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveTvStation } from '$lib/schemas/livetv';
import LiveTvWidget from './LiveTvWidget.svelte';
import { getLiveTvChannels } from '$lib/api/playback.js';
import { getLiveTvFavorites } from '$lib/api/livetv-favorites.js';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/api/playback.js', () => ({ getLiveTvChannels: vi.fn() }));
vi.mock('$lib/api/livetv-favorites.js', () => ({ getLiveTvFavorites: vi.fn() }));

function lineup(): LiveTvStation[] {
    return Array.from({ length: 45 }, (_, index) => ({
        id: `station-${index}`,
        feedId: `feed-${index}`,
        name: `Station ${index}`,
        images: {},
        isVisible: true,
        sortOrder: index,
        nowNext: {
            current: {
                id: `current-${index}`,
                stationId: `station-${index}`,
                title: index === 40 ? 'Morning at Meridian' : 'Everyday News',
                startTime: '2026-10-31T08:00:00Z',
                endTime: '2026-10-31T09:00:00Z',
            },
            next: {
                id: `next-${index}`,
                stationId: `station-${index}`,
                title: index === 42 ? 'Aurora Expedition' : 'Evening Journal',
                startTime: '2026-10-31T09:00:00Z',
                endTime: '2026-10-31T10:00:00Z',
            },
        },
    }));
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.mocked(getLiveTvChannels).mockResolvedValue({
        status: 200,
        error: null,
        data: {
            items: lineup(),
            page: { limit: 100, offset: 0, total: 45, hasMore: false },
        },
    });
    vi.mocked(getLiveTvFavorites).mockResolvedValue({
        status: 200,
        error: null,
        data: { stationIds: [] },
    });
    vi.stubGlobal(
        'IntersectionObserver',
        class {
            constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
            observe(): void {
                this.callback([{ isIntersecting: true }]);
            }
            disconnect(): void {}
            unobserve(): void {}
        },
    );
});

afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

async function mountWidget(): Promise<{ container: HTMLElement }> {
    const result = render(LiveTvWidget);
    await vi.advanceTimersByTimeAsync(1);
    await tick();
    return result;
}

describe('What’s On Now inline search', () => {
    it('matches channel names, the current programme and only the single next programme across the full lineup', async () => {
        const { container } = await mountWidget();
        const search = screen.getByRole('searchbox');
        expect(container.querySelectorAll('.card-touch-root')).toHaveLength(20);
        expect(search.closest('h2')).toBeNull();
        expect(
            search.closest('.section-header-content')?.querySelector('h2')?.textContent?.trim(),
        ).toBe("What's On Now");

        await fireEvent.input(search, { target: { value: ' station 41 ' } });
        expect(container.querySelectorAll('.card-touch-root')).toHaveLength(1);
        expect(container.querySelector('h3')?.textContent?.trim()).toBe('Station 41');

        await fireEvent.input(search, { target: { value: 'MERIDIAN' } });
        expect(container.querySelector('h3')?.textContent?.trim()).toBe('Station 40');

        await fireEvent.input(search, { target: { value: 'Aurora' } });
        expect(container.querySelector('h3')?.textContent?.trim()).toBe('Station 42');
        expect(screen.getByText('Next: Aurora Expedition')).toBeTruthy();
        expect(screen.queryByText('Morning at Meridian')).toBeNull();
    });

    it('keeps empty results searchable and clears back to a bounded row without another request', async () => {
        const { container } = await mountWidget();
        const search = screen.getByRole('searchbox');
        const requests = vi.mocked(getLiveTvChannels).mock.calls.length;
        await fireEvent.input(search, { target: { value: 'no-such-programme' } });
        expect(container.querySelectorAll('.card-touch-root')).toHaveLength(0);
        expect(screen.getByRole('searchbox')).toBe(search);
        expect(screen.getByText('No channels match "no-such-programme"')).toBeTruthy();

        await fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
        expect(container.querySelectorAll('.card-touch-root')).toHaveLength(20);
        expect((search as HTMLInputElement).value).toBe('');
        expect(document.activeElement).toBe(search);

        await fireEvent.click(screen.getByRole('button', { name: /Load more/i }));
        expect(container.querySelectorAll('.card-touch-root')).toHaveLength(40);
        await fireEvent.input(search, { target: { value: 'Everyday' } });
        expect(container.querySelectorAll('.card-touch-root')).toHaveLength(20);
        await fireEvent.keyDown(search, { key: 'Escape' });
        expect((search as HTMLInputElement).value).toBe('');
        expect(container.querySelectorAll('.card-touch-root')).toHaveLength(20);
        expect(vi.mocked(getLiveTvChannels).mock.calls.length).toBe(requests);
    });
});
