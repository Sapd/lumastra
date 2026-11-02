// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The admin media search is how operators jump between items. These tests pin
 * that series results are grouped as series (the API sends 'series', not the
 * storage value 'tv'), that the keyboard opens the row it highlights, and
 * that a slow response for an older query cannot replace newer results.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const apiGet = vi.hoisted(() => vi.fn());
const goto = vi.hoisted(() => vi.fn());

vi.mock('$lib/api/client.js', () => ({ apiGet }));
vi.mock('$app/navigation', () => ({ goto }));
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$lib/paths', () => ({ resolve: (p: string) => p }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: vi.fn() } }));

import AdminMediaSearch from './AdminMediaSearch.svelte';

const MOVIE = { id: 'movie-1', title: 'Nightfall', mediaType: 'movie', year: 2001 };
const SERIES = { id: 'series-1', title: 'Dark', mediaType: 'series', year: 2017 };

function input(): HTMLInputElement {
    return screen.getByPlaceholderText('Search by title...') as HTMLInputElement;
}

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('AdminMediaSearch', () => {
    it('groups series first under "Series" and Enter opens the highlighted row', async () => {
        apiGet.mockResolvedValue({ data: { results: [MOVIE, SERIES] }, error: undefined });
        render(AdminMediaSearch);
        await fireEvent.focus(input());
        await fireEvent.input(input(), { target: { value: 'dark' } });
        await new Promise((r) => setTimeout(r, 200));

        await screen.findByText('Nightfall');
        await fireEvent.keyDown(input(), { key: 'ArrowDown' });
        await fireEvent.keyDown(input(), { key: 'Enter' });

        // The first rendered row is the series, so that is what opens.
        expect(goto).toHaveBeenCalledWith('/admin/library/media/series-1');
    });

    it('a slow response for an older query does not replace newer results', async () => {
        let resolveOld!: (value: unknown) => void;
        apiGet
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    resolveOld = resolve;
                }),
            )
            .mockResolvedValueOnce({ data: { results: [SERIES] }, error: undefined });
        render(AdminMediaSearch);
        await fireEvent.focus(input());

        await fireEvent.input(input(), { target: { value: 'da' } });
        await new Promise((r) => setTimeout(r, 200));
        await fireEvent.input(input(), { target: { value: 'dark' } });
        await new Promise((r) => setTimeout(r, 200));
        await screen.findByText('Dark');

        resolveOld({ data: { results: [MOVIE] }, error: undefined });
        await new Promise((r) => setTimeout(r, 0));

        await waitFor(() => expect(screen.queryByText('Nightfall')).toBeNull());
        expect(screen.getByText('Dark')).toBeTruthy();
    });
});
