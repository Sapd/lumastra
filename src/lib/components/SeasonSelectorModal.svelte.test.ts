// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
const { getRequestSeasons, replace } = vi.hoisted(() => ({
    getRequestSeasons: vi.fn(),
    replace: vi.fn(),
}));
vi.mock('$lib/api/content', () => ({
    getRequestSeasons,
    getRequestQuota: async () => ({ data: {}, error: null }),
}));
vi.mock('$lib/stores/modal.store', () => ({ modals: { replace, close: vi.fn() } }));
vi.mock('$lib/components/RequestModal.svelte', () => ({ default: vi.fn() }));
import SeasonSelectorModal from './SeasonSelectorModal.svelte';
afterEach(cleanup);

test('selects unrequested Seerr seasons without requiring a local catalog entry', async () => {
    getRequestSeasons.mockResolvedValue({
        data: {
            items: [
                {
                    seasonNumber: 1,
                    name: 'Season 1',
                    episodeCount: 6,
                    airDate: null,
                    overview: null,
                    posterPath: null,
                    isAvailable: true,
                    isPending: false,
                },
                {
                    seasonNumber: 2,
                    name: 'Season 2',
                    episodeCount: 8,
                    airDate: null,
                    overview: null,
                    posterPath: null,
                    isAvailable: false,
                    isPending: false,
                },
            ],
        },
        error: null,
    });
    render(SeasonSelectorModal, {
        props: {
            modalId: 'test',
            externalIds: { tmdb: '123' },
            title: 'New series',
            posterPath: undefined,
        },
    });
    await waitFor(() =>
        expect(
            (screen.getByRole('checkbox', { name: /Season 2/ }) as HTMLInputElement).checked,
        ).toBe(true),
    );
    expect(getRequestSeasons).toHaveBeenCalledWith({ tmdb: '123' });
    await fireEvent.click(screen.getByRole('button', { name: /Request 1 Season/i }));
    expect(replace).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ seasons: [2], mediaType: 'series' }),
    );
});
