// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

const updateWidgetOrder = vi.fn(
    async (_body?: { widgetOrder?: string[]; hiddenWidgets?: string[] }) => ({ error: null }),
);
vi.mock('$lib/api/user', () => ({
    updateWidgetOrder: (body: { widgetOrder?: string[]; hiddenWidgets?: string[] }) =>
        updateWidgetOrder(body),
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { success: vi.fn(), error: vi.fn() } }));
// SavedCue fades with svelte/transition (element.animate), which happy-dom lacks.
vi.mock('./SavedCue.svelte', () => ({ default: vi.fn() }));

import HomeWidgetsSection from './HomeWidgetsSection.svelte';

const props = {
    widgetOrder: ['for-you', 'trending', 'watchlist'],
    hiddenWidgets: [],
    allWidgetIds: ['for-you', 'trending', 'watchlist'],
    adminDisabledWidgets: [],
    getWidgetName: (id: string) => id,
};

describe('HomeWidgetsSection', () => {
    afterEach(() => {
        cleanup();
        updateWidgetOrder.mockClear();
        vi.useRealTimers();
    });

    test('each widget row has Move up / Move down controls', () => {
        render(HomeWidgetsSection, props);
        expect(screen.getAllByRole('button', { name: /Move up/ }).length).toBe(3);
        expect(screen.getAllByRole('button', { name: /Move down/ }).length).toBe(3);
    });

    test('Move down reorders and announces via aria-live', async () => {
        render(HomeWidgetsSection, props);
        const firstDown = screen.getAllByRole('button', { name: /Move down/ })[0];
        await fireEvent.click(firstDown);
        const live = document.querySelector('[aria-live="polite"]');
        expect(live?.textContent).toMatch(/moved/i);
    });

    // The page used to need a Save button; a reorder that was never saved was
    // silently lost on leaving. It now saves itself, once per burst of edits.
    test('saves the new order on its own after a burst of moves', async () => {
        vi.useFakeTimers();
        render(HomeWidgetsSection, props);
        const downs = screen.getAllByRole('button', { name: /Move down/ });
        await fireEvent.click(downs[0]);
        await fireEvent.click(screen.getAllByRole('button', { name: /Move down/ })[1]);
        expect(updateWidgetOrder).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        expect(updateWidgetOrder).toHaveBeenCalledTimes(1);
        expect(updateWidgetOrder).toHaveBeenCalledWith({
            widgetOrder: ['trending', 'watchlist', 'for-you'],
            hiddenWidgets: [],
        });
    });

    test('leaving the page saves a pending edit at once', async () => {
        vi.useFakeTimers();
        const { unmount } = render(HomeWidgetsSection, props);
        await fireEvent.click(screen.getAllByRole('button', { name: /Move down/ })[0]);
        unmount();
        await vi.advanceTimersByTimeAsync(0);
        expect(updateWidgetOrder).toHaveBeenCalledTimes(1);
    });

    test('hiding a section saves it as hidden', async () => {
        vi.useFakeTimers();
        render(HomeWidgetsSection, props);
        await fireEvent.click(screen.getByRole('switch', { name: /Show trending/ }));
        await vi.advanceTimersByTimeAsync(1000);
        expect(updateWidgetOrder).toHaveBeenCalledWith(
            expect.objectContaining({ hiddenWidgets: ['trending'] }),
        );
    });

    test('shows an empty-state when there are no widgets', () => {
        render(HomeWidgetsSection, {
            widgetOrder: [],
            hiddenWidgets: [],
            allWidgetIds: [],
            adminDisabledWidgets: [],
            getWidgetName: (id: string) => id,
        });
        expect(screen.getByText(/No configurable widgets/)).toBeTruthy();
    });
});
