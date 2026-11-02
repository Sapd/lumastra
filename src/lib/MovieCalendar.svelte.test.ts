// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getCalendar } = vi.hoisted(() => ({ getCalendar: vi.fn() }));

vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/api/content', () => ({
    getCalendar,
    getExcludedSeries: vi.fn().mockResolvedValue({ data: { items: [] }, error: null }),
    excludeSeries: vi.fn().mockResolvedValue({ error: null }),
    unexcludeSeries: vi.fn().mockResolvedValue({ error: null }),
}));
vi.mock('$lib/api/notifications', () => ({ followSeries: vi.fn() }));

import * as m from '$lib/paraglide/messages';
import MovieCalendar from './MovieCalendar.svelte';
import { excludeSeries } from '$lib/api/content';

function episode(series: { id: string; catalogId: string | null }, title = 'Show') {
    const airDate = new Date(new Date().setHours(12, 0, 0, 0)).toISOString();
    return {
        id: 'ep-1',
        catalogId: null,
        type: 'episode',
        title: 'TBA',
        ids: {},
        images: {},
        context: {
            series: { ...series, title },
            seasonNumber: 1,
            episodeNumber: 3,
            airDate,
        },
        monitored: true,
        hasFile: false,
    };
}

async function openMenuOn(item: ReturnType<typeof episode>) {
    getCalendar.mockResolvedValue({ data: { items: [item], page: {} }, error: null });
    window.innerWidth = 1400;
    const { container } = render(MovieCalendar, { variant: 'agenda' });
    await waitFor(() => expect(container.querySelector('[data-event-data]')).not.toBeNull());
    const target = container.querySelector('[data-event-data]')!;
    const notPrevented = await fireEvent.contextMenu(target);
    return { container, prevented: !notPrevented };
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe('calendar context menu', () => {
    it('offers hiding a not-in-library series through the TMDB id in its handle', async () => {
        const { prevented } = await openMenuOn(
            episode({ id: 'tmdb:4242:series', catalogId: null }, 'Welsh & Shedar'),
        );
        expect(prevented).toBe(true);
        await waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
        const items = document.querySelectorAll('[role="menuitem"]');
        // hide only: following needs the catalog series
        expect(items).toHaveLength(1);
        expect(items[0].getAttribute('aria-label')).toBe(m.upcoming_exclude_series());
    });

    it('keeps the right-click menu usable while active and pending previews are dismissed', async () => {
        const item = episode({ id: 'tmdb:4242:series', catalogId: null });
        getCalendar.mockResolvedValue({ data: { items: [item], page: {} }, error: null });
        window.innerWidth = 1400;
        const { container } = render(MovieCalendar, { variant: 'agenda' });
        await waitFor(() => expect(container.querySelector('.calendar-day-thumb')).not.toBeNull());
        const thumb = container.querySelector('.calendar-day-thumb')!;
        await fireEvent.focus(thumb);
        expect(document.getElementById('calendar-week-thumb-tooltip')).not.toBeNull();
        await fireEvent.contextMenu(thumb);
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
        expect(document.getElementById('calendar-week-thumb-tooltip')).toBeNull();
        // Some browsers deliver a secondary-button click after contextmenu.
        await fireEvent.click(window, { button: 2 });
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
        await fireEvent.mouseEnter(thumb);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(document.getElementById('calendar-week-thumb-tooltip')).toBeNull();
        await fireEvent.click(document.querySelector('[role="menuitem"]')!);
        expect(excludeSeries).toHaveBeenCalledWith({
            seriesName: 'Show',
            tmdbId: 4242,
            mediaType: 'series',
        });
        expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    it('cancels a pending hover preview on right click and restores previews after Escape', async () => {
        const { container } = await openMenuOn(
            episode({ id: 'tmdb:4242:series', catalogId: null }),
        );
        await fireEvent.keyDown(window, { key: 'Escape' });
        const thumb = container.querySelector('.calendar-day-thumb')!;
        await fireEvent.mouseEnter(thumb);
        await fireEvent.contextMenu(thumb);
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(document.getElementById('calendar-week-thumb-tooltip')).toBeNull();
        expect(document.querySelector('[role="menu"]')).not.toBeNull();
        await fireEvent.keyDown(window, { key: 'Escape' });
        await fireEvent.focus(thumb);
        expect(document.getElementById('calendar-week-thumb-tooltip')).not.toBeNull();
        await fireEvent.contextMenu(thumb);
        await fireEvent.click(document.body);
        expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    it('offers hide and follow for a catalog series', async () => {
        await openMenuOn(
            episode({
                id: 'a'.repeat(8) + '-0000-4000-8000-000000000000',
                catalogId: 'a'.repeat(8) + '-0000-4000-8000-000000000000',
            }),
        );
        await waitFor(() => expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(2));
    });

    it('opens no menu at all when the entry has no usable id', async () => {
        const { prevented } = await openMenuOn(episode({ id: 'unresolvable', catalogId: null }));
        expect(prevented).toBe(false);
        expect(document.querySelector('[role="menu"]')).toBeNull();
    });
});
