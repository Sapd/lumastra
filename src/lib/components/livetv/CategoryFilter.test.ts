// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { LiveTvCategory } from '$lib/schemas/livetv.js';
import CategoryFilter from './CategoryFilter.svelte';

vi.mock('$lib/paraglide/messages.js', () => ({
    media_live_tv: () => 'Live TV',
    livetv_all_channels: () => 'All',
}));

function makeCategory(
    overrides: Partial<LiveTvCategory> & { id: string; name: string },
): LiveTvCategory {
    return {
        sortOrder: 0,
        isVisible: true,
        channelCount: undefined,
        ...overrides,
    };
}

const sportsCategory = makeCategory({
    id: 'cat-1',
    name: 'Sports',
    channelCount: 12,
});
const newsCategory = makeCategory({
    id: 'cat-2',
    name: 'News',
    channelCount: 5,
});

const defaultCategories: LiveTvCategory[] = [sportsCategory, newsCategory];

describe('CategoryFilter', () => {
    test('renders "All" tab and category tabs', () => {
        render(CategoryFilter, {
            categories: defaultCategories,
            selectedCategoryId: null,
            onselect: vi.fn(),
            totalChannelCount: 17,
        });

        const tabs = screen.getAllByRole('tab');
        expect(tabs).toHaveLength(3); // All + 2 categories

        expect(tabs[0].textContent).toContain('All');
        expect(tabs[0].textContent).toContain('17');
        expect(tabs[1].textContent).toContain('Sports');
        expect(tabs[1].textContent).toContain('12');
        expect(tabs[2].textContent).toContain('News');
        expect(tabs[2].textContent).toContain('5');
    });

    test('"All" tab fires onselect with null', async () => {
        const user = userEvent.setup();
        const onselect = vi.fn();

        render(CategoryFilter, {
            categories: defaultCategories,
            selectedCategoryId: 'cat-1', // Sports selected, so "All" is clickable
            onselect,
            totalChannelCount: 17,
        });

        const allTab = screen.getAllByRole('tab')[0];
        await user.click(allTab);

        expect(onselect).toHaveBeenCalledOnce();
        expect(onselect).toHaveBeenCalledWith(null);
    });

    test('clicking category tab fires onselect with correct ID', async () => {
        const user = userEvent.setup();
        const onselect = vi.fn();

        render(CategoryFilter, {
            categories: defaultCategories,
            selectedCategoryId: null,
            onselect,
            totalChannelCount: 17,
        });

        const sportsTab = screen.getAllByRole('tab')[1];
        await user.click(sportsTab);

        expect(onselect).toHaveBeenCalledOnce();
        expect(onselect).toHaveBeenCalledWith('cat-1');
    });

    test('active "All" tab has aria-selected=true', () => {
        render(CategoryFilter, {
            categories: defaultCategories,
            selectedCategoryId: null,
            onselect: vi.fn(),
            totalChannelCount: 17,
        });

        const tabs = screen.getAllByRole('tab');
        expect(tabs[0].getAttribute('aria-selected')).toBe('true');
        expect(tabs[1].getAttribute('aria-selected')).toBe('false');
        expect(tabs[2].getAttribute('aria-selected')).toBe('false');
    });

    test('active category tab has aria-selected=true', () => {
        render(CategoryFilter, {
            categories: defaultCategories,
            selectedCategoryId: 'cat-2',
            onselect: vi.fn(),
            totalChannelCount: 17,
        });

        const tabs = screen.getAllByRole('tab');
        expect(tabs[0].getAttribute('aria-selected')).toBe('false');
        expect(tabs[1].getAttribute('aria-selected')).toBe('false');
        expect(tabs[2].getAttribute('aria-selected')).toBe('true'); // News
    });

    test('active tab has correct tabindex for keyboard accessibility', () => {
        render(CategoryFilter, {
            categories: defaultCategories,
            selectedCategoryId: 'cat-1',
            onselect: vi.fn(),
            totalChannelCount: 17,
        });

        const tabs = screen.getAllByRole('tab');
        // Only the active tab gets tabindex=0, others get -1
        expect(tabs[0].getAttribute('tabindex')).toBe('-1'); // All (inactive)
        expect(tabs[1].getAttribute('tabindex')).toBe('0'); // Sports (active)
        expect(tabs[2].getAttribute('tabindex')).toBe('-1'); // News (inactive)
    });

    test('renders with empty categories (only "All" tab)', () => {
        render(CategoryFilter, {
            categories: [],
            selectedCategoryId: null,
            onselect: vi.fn(),
            totalChannelCount: 0,
        });

        const tabs = screen.getAllByRole('tab');
        expect(tabs).toHaveLength(1);
        expect(tabs[0].textContent).toContain('All');
    });
});
