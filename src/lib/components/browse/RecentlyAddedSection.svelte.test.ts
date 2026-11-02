// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

const getRecentlyAdded = vi.fn();
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/api/browse', () => ({
    getLibraries: vi.fn(async () => ({ data: { libraries: [] }, error: null })),
    getRecentlyAdded: (...args: unknown[]) => getRecentlyAdded(...args),
}));

import RecentlyAddedSection from './RecentlyAddedSection.svelte';

afterEach(cleanup);

test('a failed recent filter shows a retry instead of silently displaying the previous scope', async () => {
    getRecentlyAdded
        .mockResolvedValueOnce({ data: null, error: 'offline' })
        .mockResolvedValue({ data: { recentlyAdded: [] }, error: null });
    render(RecentlyAddedSection, {
        type: 'movies',
        initialItems: [{ id: 'recent-review-fixture', name: 'Previous scope', type: 'movie' }],
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    await fireEvent.click(screen.getByRole('button', { name: /New seasons/ }));
    await screen.findByRole('alert');
    expect(screen.queryByText('Previous scope')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(getRecentlyAdded).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: 'movies', new: 'seasons' }),
    );
    expect(getRecentlyAdded).toHaveBeenCalledTimes(2);
});
