// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AdminChannel, AdminChannelCategory } from '$lib/schemas/livetv.js';

const apiPut = vi.fn();
vi.mock('$lib/api/client.js', () => ({
    apiPut: (...args: unknown[]) => apiPut(...args),
    apiPost: vi.fn(),
    apiDelete: vi.fn(),
    apiGet: vi.fn().mockResolvedValue({ data: null, error: null }),
}));

const { default: ChannelTable } = await import('./ChannelTable.svelte');

function category(id: string, n: number): AdminChannelCategory {
    return {
        id,
        name: id,
        sortOrder: 0,
        isVisible: true,
        channels: Array.from(
            { length: n },
            (_, i) =>
                ({
                    id: `${id}-${i}`,
                    name: `${id} ${i}`,
                    images: {},
                    sortOrder: i,
                    isVisible: true,
                    categoryId: id,
                }) as AdminChannel,
        ),
    };
}

// 3 × 40 channels: more than 100 in total, so every category starts collapsed.
const lineup = (): AdminChannelCategory[] => [
    category('News', 40),
    category('Sport', 40),
    category('Kids', 40),
];

/** Category order as the main list shows it. */
const order = (): string[] =>
    [...document.querySelectorAll<HTMLElement>('[data-category-id]')].map(
        (el) => el.dataset.categoryId ?? '',
    );
const header = (id: string): HTMLElement =>
    document.querySelector<HTMLElement>(
        `[data-category-id="${id}"] .category-header`,
    ) as HTMLElement;

function wideViewport(): void {
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: 1400 >= Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
    }));
}

beforeEach(() => {
    // Every test runs on fake timers. The store's 500 ms save debounce is a plain setTimeout
    // that outlives the unmounted component; on real timers a save left over from one test
    // fires during a later test on a slow machine and lands in that test's apiPut count.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    localStorage.clear();
    wideViewport();
    apiPut.mockResolvedValue({ data: { success: true }, error: null });
});
afterEach(async () => {
    // Flush saves a test left pending (they belong to this test), then drop the mock's calls.
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    apiPut.mockReset();
});

describe('Reordering categories', () => {
    test('the category menu moves a category to the top, also while expanded', async () => {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(ChannelTable, { categories: lineup() });
        await user.click(header('Kids')); // expanded: the old drag needed all collapsed
        await user.click(within(header('Kids')).getByRole('button', { name: 'Category actions' }));
        await user.click(screen.getByRole('button', { name: 'Move to top' }));
        expect(order()).toEqual(['Kids', 'News', 'Sport']);
    });

    test('Alt+↓ on a category header moves it one place and announces it', async () => {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(ChannelTable, { categories: lineup() });
        header('News').focus();
        await user.keyboard('{Alt>}{ArrowDown}{/Alt}');
        expect(order()).toEqual(['Sport', 'News', 'Kids']);
        await vi.advanceTimersByTimeAsync(50);
        expect(screen.getByRole('status').textContent).toContain('News moved to position 2 of 3');
    });

    test('a drag in the category rail reorders and saves only the category order', async () => {
        render(ChannelTable, { categories: lineup() });
        const rail = screen.getByRole('navigation', { name: 'Categories' });
        const zone = rail.querySelector('[data-rail-zone]') as HTMLElement;
        const items = ['Sport', 'Kids', 'News'].map((id) => ({ id, name: id, count: 40 }));
        zone.dispatchEvent(
            new CustomEvent('finalize', {
                detail: { items, info: { id: 'News', trigger: 'droppedIntoZone' } },
            }),
        );
        await tick();
        expect(order()).toEqual(['Sport', 'Kids', 'News']);

        await vi.advanceTimersByTimeAsync(600);
        expect(apiPut).toHaveBeenCalledTimes(1);
        const body = apiPut.mock.calls[0][2] as {
            categories: Array<{ id: string; sortOrder: number }>;
            channels?: unknown[];
        };
        expect(body.categories).toEqual([
            { id: 'Sport', sortOrder: 0 },
            { id: 'Kids', sortOrder: 1 },
            { id: 'News', sortOrder: 2 },
        ]);
        // No channel moved: the save carries no channel rows.
        expect(body.channels).toBeUndefined();
    });

    test('Alt+↑ on a rail entry moves that category', async () => {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
        render(ChannelTable, { categories: lineup() });
        const rail = screen.getByRole('navigation', { name: 'Categories' });
        within(rail).getByRole('button', { name: /Kids/ }).focus();
        await user.keyboard('{Alt>}{Home}{/Alt}');
        expect(order()).toEqual(['Kids', 'News', 'Sport']);
    });
});
