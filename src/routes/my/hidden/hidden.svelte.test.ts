// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import HiddenPage from './+page.svelte';
import type { PageData } from './$types';
import { invalidate } from '$app/navigation';
import { deleteCwDismissal } from '$lib/api/for-you';
import { toasts } from '$lib/stores/toast.store';
import * as m from '$lib/paraglide/messages';

vi.mock('$app/navigation', () => ({ invalidate: vi.fn() }));
vi.mock('$lib/api/for-you', () => ({ deleteCwDismissal: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: vi.fn() } }));

const data = {
    items: [
        {
            targetId: 'movie-1',
            targetType: 'movie',
            title: 'Hidden movie',
            dismissedAt: '2026-09-26T00:00:00Z',
        },
    ],
} as PageData;

describe('hidden item restoration', () => {
    test('audiobooks use the audiobook badge rather than Movie', () => {
        const view = render(HiddenPage, {
            data: { ...data, items: [{ ...data.items[0], targetType: 'audiobook' }] },
        });
        expect(view.getByText(m.media_audiobook())).toBeTruthy();
        expect(view.queryByText(m.media_movie())).toBeNull();
    });
    beforeEach(() => {
        vi.mocked(deleteCwDismissal).mockResolvedValue({
            data: { success: true },
            error: null,
            status: 200,
        });
        vi.mocked(invalidate).mockResolvedValue();
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => {
        cleanup();
        vi.resetAllMocks();
        vi.restoreAllMocks();
    });

    test('successful restore invalidates the registered key and does not resurrect stale data', async () => {
        const view = render(HiddenPage, { data });
        await fireEvent.click(view.getByRole('button', { name: m.hidden_restore() }));
        await waitFor(() => expect(invalidate).toHaveBeenCalledWith('app:hidden-items'));
        expect(view.container.textContent).not.toContain('Hidden movie');
        expect(toasts.error).not.toHaveBeenCalled();
    });

    test('refresh failure after a successful restore is not reported as a failed mutation', async () => {
        vi.mocked(invalidate).mockRejectedValueOnce(new Error('refresh failed'));
        const view = render(HiddenPage, { data });
        await fireEvent.click(view.getByRole('button', { name: m.hidden_restore() }));
        await waitFor(() => expect(console.error).toHaveBeenCalled());
        expect(view.container.textContent).not.toContain('Hidden movie');
        expect(toasts.error).not.toHaveBeenCalled();
    });

    test('failed mutation brings the card back and offers restore again', async () => {
        vi.mocked(deleteCwDismissal).mockResolvedValueOnce({
            data: null,
            error: 'offline',
            status: 503,
        });
        const view = render(HiddenPage, { data });
        await fireEvent.click(view.getByRole('button', { name: m.hidden_restore() }));
        await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(m.hidden_restore_error()));
        expect(view.getByRole('button', { name: m.hidden_restore() })).toBeTruthy();
        expect(invalidate).not.toHaveBeenCalled();
    });
});
