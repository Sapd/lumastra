// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AdminChannel, AdminChannelCategory } from '$lib/schemas/livetv.js';

vi.mock('$lib/api/client.js', () => ({
    apiPut: vi.fn().mockResolvedValue({ data: { success: true }, error: null }),
    apiPost: vi.fn(),
    apiDelete: vi.fn(),
    apiGet: vi.fn().mockResolvedValue({ data: null, error: null }),
}));

const { default: ChannelTable } = await import('./ChannelTable.svelte');

function channel(id: string, categoryId: string, isVisible = true): AdminChannel {
    return {
        id,
        name: id,
        images: {},
        sortOrder: 0,
        isVisible,
        qualityTier: 'hd',
        categoryId,
    } as AdminChannel;
}

function channels(prefix: string, n: number, categoryId: string): AdminChannel[] {
    return Array.from({ length: n }, (_, i) => channel(`${prefix}-${i}`, categoryId));
}

function lineup(): AdminChannelCategory[] {
    return [
        {
            id: 'sport',
            name: 'Sport',
            sortOrder: 0,
            isVisible: true,
            channels: channels('S', 250, 'sport'),
        },
        {
            id: 'news',
            name: 'News',
            sortOrder: 1,
            isVisible: true,
            channels: [...channels('N', 3, 'news'), channel('N-hidden', 'news', false)],
        },
    ];
}

/** A viewport of `width` px for every `(min-width: Npx)` media query. */
function viewport(width: number): void {
    vi.stubGlobal('matchMedia', (query: string) => {
        const min = Number(/min-width:\s*(\d+)px/.exec(query)?.[1] ?? 0);
        return {
            matches: width >= min,
            media: query,
            addEventListener: () => {},
            removeEventListener: () => {},
        };
    });
}

const rowIds = (root: Element | Document = document): string[] =>
    [...root.querySelectorAll<HTMLElement>('[data-channel-id]')].map(
        (el) => el.dataset.channelId ?? '',
    );
const categoryEl = (id: string): HTMLElement =>
    document.querySelector<HTMLElement>(`[data-category-id="${id}"]`) as HTMLElement;

async function expand(name: string): Promise<void> {
    const header = screen
        .getAllByRole('button', { name })[0]
        .closest<HTMLElement>('.category-header');
    expect(header).not.toBeNull();
    await userEvent.setup().click(header as HTMLElement);
}

/** svelte-dnd-action reports a drag as consider/finalize events on the zone. */
async function drag(zone: Element, leaderId: string, items: AdminChannel[]): Promise<void> {
    zone.dispatchEvent(
        new CustomEvent('consider', {
            detail: { items, info: { id: leaderId, trigger: 'dragStarted' } },
        }),
    );
    zone.dispatchEvent(
        new CustomEvent('finalize', {
            detail: { items, info: { id: leaderId, trigger: 'droppedIntoZone' } },
        }),
    );
    await tick();
}

/** The channel drop zone of an expanded category (the parent of its row wrappers). */
function zoneOf(categoryId: string): Element {
    const firstRow = categoryEl(categoryId).querySelector('[data-channel-id]');
    const zone = firstRow?.closest('[animate\\:flip], div')?.parentElement?.parentElement;
    expect(zone).toBeTruthy();
    return zone as Element;
}

beforeEach(() => {
    localStorage.clear();
    viewport(1400);
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('Channel Management with a large category', () => {
    test('an expanded category renders its first 100 rows, once, with drag on', async () => {
        const user = userEvent.setup();
        render(ChannelTable, { categories: lineup() });
        // 254 channels: categories start collapsed.
        expect(rowIds()).toHaveLength(0);

        await expand('Sport');
        // One layout mounted (not a hidden second copy) and only the first page.
        expect(rowIds()).toHaveLength(100);
        expect(document.querySelectorAll('[data-channel-id="S-0"]')).toHaveLength(1);

        await user.click(screen.getByRole('button', { name: /150 remaining/ }));
        expect(rowIds()).toHaveLength(200);
    });

    test('a drag inside the window keeps every channel after it', async () => {
        render(ChannelTable, { categories: lineup() });
        await expand('Sport');
        const window = channels('S', 100, 'sport');
        const reordered = [window[5], ...window.slice(0, 5), ...window.slice(6)];
        await drag(zoneOf('sport'), 'S-5', reordered);

        expect(rowIds(categoryEl('sport')).slice(0, 3)).toEqual(['S-5', 'S-0', 'S-1']);
        // Nothing lost behind the window: all 250 rows are still there.
        await userEvent.setup().click(screen.getByRole('button', { name: 'Show all' }));
        const all = rowIds(categoryEl('sport'));
        expect(all).toHaveLength(250);
        expect(new Set(all).size).toBe(250);
        expect(all.at(-1)).toBe('S-249');
    });

    test('a channel dropped on the last slot of the window stays rendered', async () => {
        render(ChannelTable, { categories: lineup() });
        await expand('Sport');
        const window = [...channels('S', 100, 'sport'), channel('N-0', 'news')];
        await drag(zoneOf('sport'), 'N-0', window);

        const sport = rowIds(categoryEl('sport'));
        expect(sport).toHaveLength(101);
        expect(sport[100]).toBe('N-0');
    });
});

describe('Show hidden', () => {
    test('hidden channels are left out until the switch is on', async () => {
        const user = userEvent.setup();
        render(ChannelTable, { categories: lineup() });
        await expand('News');
        expect(rowIds(categoryEl('news'))).toEqual(['N-0', 'N-1', 'N-2']);

        await user.click(screen.getByRole('checkbox', { name: 'Show hidden (1)' }));
        expect(rowIds(categoryEl('news'))).toEqual(['N-0', 'N-1', 'N-2', 'N-hidden']);
        expect(localStorage.getItem('livetv:admin:show-hidden')).toBe('1');
    });

    test('the remembered choice is restored', () => {
        localStorage.setItem('livetv:admin:show-hidden', '1');
        render(ChannelTable, { categories: lineup() });
        const box = screen.getByRole('checkbox', { name: 'Show hidden (1)' }) as HTMLInputElement;
        expect(box.checked).toBe(true);
    });
});

describe('Hidden channels and category actions', () => {
    test('a row hidden here stays on screen until the switch is toggled', async () => {
        const user = userEvent.setup();
        render(ChannelTable, { categories: lineup() });
        await expand('News');
        const row = categoryEl('news').querySelector('[data-channel-id="N-1"]') as HTMLElement;
        await user.click(within(row).getByRole('button', { name: 'Hide' }));
        expect(rowIds(categoryEl('news'))).toEqual(['N-0', 'N-1', 'N-2']);

        // Toggling the switch on and off again applies the filter afresh.
        const box = screen.getByRole('checkbox', { name: /Show hidden/ });
        await user.click(box);
        await user.click(box);
        expect(rowIds(categoryEl('news'))).toEqual(['N-0', 'N-2']);
    });

    test('a category holding only hidden channels is not offered for deletion', async () => {
        const user = userEvent.setup();
        const categories = [
            ...lineup(),
            {
                id: 'other',
                name: 'Other',
                sortOrder: 2,
                isVisible: true,
                channels: [channel('O-1', 'other', false), channel('O-2', 'other', false)],
            },
        ];
        render(ChannelTable, { categories });
        const header = categoryEl('other').querySelector('.category-header') as HTMLElement;
        expect(header.textContent).toContain('0 of 2');
        await user.click(within(header).getByRole('button', { name: 'Category actions' }));
        const del = within(header).getByRole('button', { name: /Delete/ }) as HTMLButtonElement;
        expect(del.disabled).toBe(true);
    });
});

describe('Category quick jump', () => {
    test('wide single view shows the rail, and a jump expands the category', async () => {
        const scrollTo = vi.fn();
        HTMLElement.prototype.scrollTo = scrollTo;
        render(ChannelTable, { categories: lineup() });
        const rail = screen.getByRole('navigation', { name: 'Categories' });
        expect(screen.queryByRole('combobox', { name: /Jump to category/ })).toBeNull();

        await userEvent.setup().click(within(rail).getByRole('button', { name: /News/ }));
        expect(rowIds(categoryEl('news'))).toEqual(['N-0', 'N-1', 'N-2']);
        expect(scrollTo).toHaveBeenCalled();
    });

    test('split view and phones get the Jump to… list instead', async () => {
        render(ChannelTable, { categories: lineup() });
        await userEvent.setup().click(screen.getByRole('button', { name: /Split/ }));
        expect(screen.queryByRole('navigation', { name: 'Categories' })).toBeNull();
        expect(screen.getAllByRole('combobox', { name: /Jump to category/ })).toHaveLength(2);
    });

    test('a phone gets the Jump to… list', () => {
        viewport(390);
        render(ChannelTable, { categories: lineup() });
        expect(screen.queryByRole('navigation', { name: 'Categories' })).toBeNull();
        expect(screen.getByRole('combobox', { name: /Jump to category/ })).toBeTruthy();
    });
});

describe('Move to category from the context menu', () => {
    test('"At the top" files the channel first in the target category', async () => {
        const user = userEvent.setup();
        render(ChannelTable, { categories: lineup() });
        await expand('Sport');
        const row = categoryEl('sport').querySelector('[data-channel-id="S-0"]') as HTMLElement;
        row.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 }),
        );
        await tick();

        await user.click(screen.getByRole('menuitem', { name: /Move to category/ }));
        await user.click(screen.getByRole('button', { name: 'At the top' }));
        await user.click(screen.getByRole('option', { name: /News/ }));

        await expand('News');
        expect(rowIds(categoryEl('news'))[0]).toBe('S-0');
        expect(rowIds(categoryEl('sport'))).not.toContain('S-0');
    });
});
