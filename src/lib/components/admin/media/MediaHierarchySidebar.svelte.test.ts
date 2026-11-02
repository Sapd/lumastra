// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
import { cleanup, render, waitFor } from '@testing-library/svelte';
import { afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/api/admin', () => ({
    getMediaHierarchy: vi.fn(async () => ({
        data: {
            series: { id: 'series-1', title: 'Show', externalIds: {} },
            seasons: [
                {
                    id: 'season-1',
                    title: 'Season',
                    seasonNumber: 1,
                    episodeCount: 1,
                    externalIds: {},
                    episodes: [
                        {
                            id: 'episode-1',
                            title: 'Episode',
                            episodeNumber: 1,
                            seasonNumber: 1,
                            externalIds: {},
                            hasFile: true,
                        },
                    ],
                },
            ],
        },
    })),
}));
import MediaHierarchySidebar from './MediaHierarchySidebar.svelte';
import { getLocale, overwriteGetLocale } from '$lib/paraglide/runtime.js';
const originalGetLocale = getLocale;
import * as m from '$lib/paraglide/messages.js';
afterEach(() => {
    cleanup();
    overwriteGetLocale(originalGetLocale);
});

describe('hierarchy artwork refresh', () => {
    it('changes the episode preview URL after an artwork save without losing the expanded season', async () => {
        const view = render(MediaHierarchySidebar, {
            seriesId: 'series-1',
            currentItemId: 'episode-1',
            activeSeason: 1,
            artworkRevision: 0,
        });
        const thumb = (): HTMLImageElement | null =>
            view.container.querySelector('img[src*="episode-1"]');
        await waitFor(() => expect(thumb()).not.toBeNull());
        const before = thumb()!.src;
        await view.rerender({
            seriesId: 'series-1',
            currentItemId: 'episode-1',
            activeSeason: 1,
            artworkRevision: 123,
        });
        await waitFor(() => expect(thumb()!.src).not.toBe(before));
        expect(thumb()!.src).toContain('v=123');
    });
});

it('renders localized seasons, including singular and plural counts', async () => {
    overwriteGetLocale(() => 'de');
    const view = render(MediaHierarchySidebar, { seriesId: 'series-1', currentItemId: 'series-1' });
    await view.findByText('1 Staffel');
    expect(view.getAllByText('Staffel 1')).toHaveLength(2);
    expect(view.queryByText('Season 1')).toBeNull();
    expect(m.series_seasons_count({ count: 0 })).toBe('0 Staffeln');
    expect(m.series_seasons_count({ count: 3 })).toBe('3 Staffeln');
});
