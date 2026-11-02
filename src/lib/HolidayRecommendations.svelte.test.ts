// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';
import HolidayRecommendations from './HolidayRecommendations.svelte';
import { apiGet, apiPost } from '$lib/api/client';
import { toasts } from '$lib/stores/toast.store';
import * as m from '$lib/paraglide/messages';

vi.mock('$lib/api/client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: vi.fn() } }));
vi.mock('$app/stores', () => ({ page: readable({ data: {} }), navigating: readable(null) }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/paths', () => ({ resolve: (path: string) => path }));

const success = {
    data: {
        active: true,
        holiday: {
            id: 'autumn',
            name: 'Autumn picks',
            emoji: '🍂',
            backgroundColor: '#123456',
            textColor: '#ffffff',
        },
        items: [],
    },
    error: null,
    status: 200,
};
beforeEach(() => {
    vi.mocked(apiGet).mockResolvedValue(success);
    vi.mocked(apiPost).mockResolvedValue(success);
});
afterEach(() => {
    cleanup();
    vi.resetAllMocks();
});

test.each(['result error', 'rejection'])(
    'refresh %s retains the shelf and a usable retry control',
    async (failure) => {
        const visibility = vi.fn();
        const view = render(HolidayRecommendations, { onvisibilityChange: visibility });
        await view.findByRole('heading', { name: 'Autumn picks' });
        if (failure === 'rejection') vi.mocked(apiPost).mockRejectedValueOnce(new Error('offline'));
        else
            vi.mocked(apiPost).mockResolvedValueOnce({ data: null, error: 'offline', status: 503 });
        await fireEvent.click(view.getByRole('button', { name: m.btn_refresh() }));
        await waitFor(() => expect(toasts.error).toHaveBeenCalledWith(m.error_generic()));
        expect(view.getByRole('heading', { name: 'Autumn picks' })).toBeTruthy();
        expect(visibility).toHaveBeenLastCalledWith({ visible: true });
        expect(
            (view.getByRole('button', { name: m.btn_refresh() }) as HTMLButtonElement).disabled,
        ).toBe(false);
        await fireEvent.click(view.getByRole('button', { name: m.btn_refresh() }));
        await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(2));
        expect(apiGet).toHaveBeenCalledOnce();
        expect(apiPost).toHaveBeenLastCalledWith(
            '/api/recommendations/holiday/refresh',
            expect.anything(),
            { limit: 20 },
        );
        expect(toasts.error).toHaveBeenCalledOnce();
    },
);
