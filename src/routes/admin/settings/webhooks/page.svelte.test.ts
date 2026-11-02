// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The webhook editor seeds its fields from the hook it was opened for, once.
 * Clicking Edit on a second hook while the first was open kept the first
 * hook's URL and filters on screen, and Save then PUT them to the second
 * hook's id — silently overwriting a webhook the admin never edited.
 */

import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { mockGet, mockDelete } = vi.hoisted(() => ({ mockGet: vi.fn(), mockDelete: vi.fn() }));

vi.mock('$lib/api/client.js', () => ({
    apiGet: mockGet,
    apiDelete: mockDelete,
    apiPost: vi.fn(),
    apiPut: vi.fn(),
}));
vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return {
        page: readable({ url: new URL('http://localhost/admin/settings/webhooks'), data: {} }),
    };
});
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));
vi.mock('$lib/stores/toast.store.js', () => ({
    toasts: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import Page from './+page.svelte';

function hook(id: string, url: string) {
    return {
        id,
        url,
        eventFilter: ['task.completed'],
        active: true,
        includeProgress: false,
        batchWindowSeconds: 0,
        maxBatchSize: 1,
        hasSecret: true,
        createdBy: 'admin',
        createdAt: '2026-10-01T00:00:00.000Z',
    };
}

afterEach(cleanup);

describe('/admin/settings/webhooks', () => {
    it('re-seeds the editor when Edit is clicked on another hook', async () => {
        mockGet.mockResolvedValue({
            data: {
                items: [hook('a', 'https://a.example/hook'), hook('b', 'https://b.example/hook')],
            },
            error: null,
        });
        render(Page);
        await waitFor(() => expect(screen.getAllByTitle('Edit webhook')).toHaveLength(2));

        const [editA, editB] = screen.getAllByTitle('Edit webhook');
        await fireEvent.click(editA);
        const urlInput = (): HTMLInputElement =>
            screen.getByPlaceholderText('https://example.com/webhook') as HTMLInputElement;
        expect(urlInput().value).toBe('https://a.example/hook');

        await fireEvent.click(editB);
        await waitFor(() => expect(urlInput().value).toBe('https://b.example/hook'));
    });
});
