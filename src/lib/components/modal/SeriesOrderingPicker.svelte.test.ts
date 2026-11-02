// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { getSeriesOrdering, setSeriesOrdering, applySeriesOrdering, toasts } = vi.hoisted(() => ({
    getSeriesOrdering: vi.fn(),
    setSeriesOrdering: vi.fn(),
    applySeriesOrdering: vi.fn(),
    toasts: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock('$lib/api/content', () => ({
    getSeriesOrdering,
    setSeriesOrdering,
    applySeriesOrdering,
    resetSeriesOrdering: vi.fn(),
    syncSeriesOrderings: vi.fn(),
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));
vi.mock('$lib/stores/modal.store', () => ({ modals: { open: vi.fn() } }));

import SeriesOrderingPicker from './SeriesOrderingPicker.svelte';

const ordering = {
    type: 'other',
    provider: 'tmdb',
    groupId: '62c942aec8113d004c7b261e',
    name: 'German Broadcast Combined',
    episodeCount: 65,
    groupCount: 4,
};
beforeEach(() => {
    vi.resetAllMocks();
    getSeriesOrdering.mockResolvedValue({
        data: {
            current: {
                orderingType: 'standard',
                orderingSource: 'manual',
                provider: 'tmdb',
                groupId: ordering.groupId,
            },
            available: [ordering],
        },
    });
    setSeriesOrdering.mockResolvedValue({
        data: {
            orderingType: 'other',
            orderingSource: 'manual',
            provider: ordering.provider,
            groupId: ordering.groupId,
        },
    });
});
afterEach(() => {
    cleanup();
});

async function selectGroup(onapply = vi.fn()): Promise<void> {
    render(SeriesOrderingPicker, {
        seriesId: '31a748e6-a74c-426c-b6d4-292c12eb38cc',
        isAdmin: true,
        onapply,
    });
    await fireEvent.click(
        await screen.findByRole('button', { name: /episode ordering: .*change ordering/i }),
    );
    await fireEvent.click(screen.getByRole('button', { name: /German Broadcast Combined/ }));
}

it('shows only one error toast when apply returns an error', async () => {
    applySeriesOrdering.mockResolvedValue({ error: { message: 'Cannot link episodes' } });
    await selectGroup();
    await waitFor(() => {
        expect(toasts.error).toHaveBeenCalledTimes(1);
    });
    expect(toasts.success).not.toHaveBeenCalled();
    expect(toasts.warning).not.toHaveBeenCalled();
    expect(toasts.info).not.toHaveBeenCalled();
});

it('shows only one error toast when apply throws', async () => {
    applySeriesOrdering.mockRejectedValue(new Error('Connection lost'));
    await selectGroup();
    await waitFor(() => {
        expect(toasts.error).toHaveBeenCalledTimes(1);
    });
    expect(toasts.success).not.toHaveBeenCalled();
});

it('updates the current label after save and apply without remounting', async () => {
    applySeriesOrdering.mockResolvedValue({ data: { applied: 65, skipped: 0, combined: 0 } });
    const onapply = vi.fn();
    await selectGroup(onapply);
    await waitFor(() => {
        expect(onapply).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText(ordering.name)).toBeTruthy();
    expect(screen.queryByText('Standard (default)')).toBeNull();
    expect(toasts.success).toHaveBeenCalledTimes(1);
    expect(toasts.error).not.toHaveBeenCalled();
});

it('names the group type in plain words, under its own provider heading', async () => {
    getSeriesOrdering.mockResolvedValue({
        data: {
            current: {
                orderingType: 'standard',
                orderingSource: 'default',
                provider: null,
                groupId: null,
            },
            available: [{ ...ordering, providerType: 1 }],
        },
    });
    render(SeriesOrderingPicker, { seriesId: 'series-1', isAdmin: true });
    const trigger = await screen.findByRole('button', {
        name: /episode ordering: standard \(default\)\. change ordering/i,
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await fireEvent.click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Episode groups from TMDB')).toBeTruthy();
    expect(screen.getByText('Original air date')).toBeTruthy();
    expect(screen.getByText('65 episodes in 4 groups')).toBeTruthy();
    expect(screen.queryByText(/^standard$/i)).toBeNull();
});

it('disables a group TMDB lists without episodes', async () => {
    getSeriesOrdering.mockResolvedValue({
        data: {
            current: {
                orderingType: 'standard',
                orderingSource: 'default',
                provider: null,
                groupId: null,
            },
            available: [
                {
                    ...ordering,
                    name: 'Production Order',
                    groupId: 'empty',
                    providerType: 1,
                    episodeCount: 0,
                },
                { ...ordering, name: 'DVD (Germany)', groupId: 'dvd', providerType: 3 },
            ],
        },
    });
    render(SeriesOrderingPicker, { seriesId: 'series-1', isAdmin: true });
    await fireEvent.click(
        await screen.findByRole('button', { name: /episode ordering: .*change ordering/i }),
    );
    const emptyRow = screen.getByRole('button', { name: /Production Order/ }) as HTMLButtonElement;
    expect(emptyRow.disabled).toBe(true);
    expect(screen.getByText('TMDB lists no episodes in this group')).toBeTruthy();
    const dvdRow = screen.getByRole('button', { name: /DVD \(Germany\)/ }) as HTMLButtonElement;
    expect(dvdRow.disabled).toBe(false);
    // One heading per type, in TMDB type order.
    expect(screen.getByText('Original air date')).toBeTruthy();
    expect(screen.getByText('DVD')).toBeTruthy();
});
