// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
import SimilarMoviesModal from './SimilarMoviesModal.svelte';
import * as m from '$lib/paraglide/messages';
import { openMediaModal } from '$lib/utils/modal-utils';
import { navigateToWatch } from '$lib/stores/watch-navigation';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$app/stores', () => ({ page: writable({ data: {} }), navigating: writable(null) }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: vi.fn() } }));
vi.mock('$lib/utils/modal-utils', () => ({
    openMediaModal: vi.fn(),
    handleRequestAction: vi.fn(),
}));
vi.mock('$lib/stores/watch-navigation', () => ({ navigateToWatch: vi.fn() }));
vi.mock('$lib/components/sections', async () => ({
    SectionRenderer: (await import('../__fixtures__/SimilarResults.svelte')).default,
}));

const fetchMock = vi.fn<typeof fetch>();
const source = { externalIds: { tmdb: '42' }, name: 'Source', type: 'movie' as const };
const match = {
    id: 'match',
    catalogId: null,
    type: 'movie' as const,
    title: 'A match',
    ids: { tmdb: '43' },
    images: {},
};

beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('AI Similar fetch states', () => {
    it.each(['http', 'network'])(
        'shows a retryable error for an initial %s failure and renders items after retry',
        async (failure) => {
            if (failure === 'http')
                fetchMock.mockResolvedValueOnce(new Response('', { status: 503 }));
            else fetchMock.mockRejectedValueOnce(new Error('offline'));
            fetchMock.mockResolvedValueOnce(Response.json({ items: [match], truncated: false }));
            const view = render(SimilarMoviesModal, {
                modalId: 'similar',
                sourceMedia: source,
                loading: true,
            });
            const alert = await view.findByRole('alert');
            expect(alert.textContent).toContain(m.similar_fetch_error());
            expect(view.queryByText(m.modal_no_embeddings())).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(1);
            await fireEvent.click(view.getByRole('button', { name: m.btn_retry() }));
            await view.findByRole('button', { name: 'Similar to A match' });
            expect(view.queryByRole('alert')).toBeNull();
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[0][0]);
        },
    );

    it('retries a failed chain lookup for the selected title', async () => {
        fetchMock.mockResolvedValueOnce(new Response('', { status: 500 }));
        fetchMock.mockResolvedValueOnce(Response.json({ items: [], truncated: false }));
        const view = render(SimilarMoviesModal, {
            modalId: 'similar',
            sourceMedia: source,
            similar: [match],
        });
        await fireEvent.click(view.getByRole('button', { name: 'Similar to A match' }));
        await view.findByRole('alert');
        expect(view.queryByText(m.modal_no_embeddings())).toBeNull();
        await fireEvent.click(view.getByRole('button', { name: m.btn_retry() }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(fetchMock.mock.calls[0][0]).toContain('tmdb:43:movie');
        expect(fetchMock.mock.calls[1][0]).toBe(fetchMock.mock.calls[0][0]);
        await view.findByText(m.modal_no_similar_found());
    });

    it('uses series wording for a successful empty series lookup', async () => {
        fetchMock.mockResolvedValueOnce(Response.json({ items: [], truncated: false }));
        const view = render(SimilarMoviesModal, {
            modalId: 'similar',
            sourceMedia: { ...source, type: 'tv' },
            loading: true,
        });
        // Assert the user-visible wording independently of generated message exports.
        await view.findByText('No similar series found');
        expect(view.getByText(/No AI embeddings available for this series yet/)).toBeTruthy();
        expect(view.queryByRole('alert')).toBeNull();
    });

    it('preserves explicit unavailable detail state and does not play by UUID alone', async () => {
        fetchMock.mockResolvedValueOnce(
            Response.json({
                items: [
                    {
                        ...match,
                        catalogId: 'catalog-uuid',
                        ids: { internal: 'catalog-uuid' },
                        availability: { isAvailable: false, canRequest: false },
                    },
                ],
                truncated: false,
            }),
        );
        const view = render(SimilarMoviesModal, {
            modalId: 'similar',
            sourceMedia: source,
            loading: true,
        });
        await fireEvent.click(await view.findByRole('button', { name: 'Details A match' }));
        expect(openMediaModal).toHaveBeenCalledWith(
            expect.objectContaining({ isAvailable: false }),
            expect.any(String),
        );
        await fireEvent.click(view.getByRole('button', { name: 'Play A match' }));
        expect(navigateToWatch).not.toHaveBeenCalled();
    });

    it('keeps the play action for an explicitly available item', async () => {
        fetchMock.mockResolvedValueOnce(
            Response.json({
                items: [
                    {
                        ...match,
                        catalogId: 'catalog-uuid',
                        ids: { internal: 'catalog-uuid' },
                        availability: { isAvailable: true, canRequest: false },
                    },
                ],
                truncated: false,
            }),
        );
        const view = render(SimilarMoviesModal, {
            modalId: 'similar',
            sourceMedia: source,
            loading: true,
        });
        await fireEvent.click(await view.findByRole('button', { name: 'Play A match' }));
        expect(navigateToWatch).toHaveBeenCalledWith('catalog-uuid');
    });
});
