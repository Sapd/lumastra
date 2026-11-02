// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import CategoryRail from './CategoryRail.svelte';

vi.mock('$lib/paraglide/messages.js', () => ({
    admin_livetv_category_rail: () => 'Categories',
    admin_livetv_jump_to_category: () => 'Jump to category…',
}));

const categories = [
    { id: 'news', name: 'News', count: 120 },
    { id: 'sport', name: 'Sport', count: 1840 },
];

describe('CategoryRail', () => {
    test('rail lists categories with counts and marks the current one', () => {
        render(CategoryRail, { categories, variant: 'rail', activeId: 'sport', onJump: vi.fn() });
        const nav = screen.getByRole('navigation', { name: 'Categories' });
        const buttons = nav.querySelectorAll('button');
        expect([...buttons].map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
            'News 120',
            'Sport 1840',
        ]);
        expect(screen.getByRole('button', { name: /Sport/ }).getAttribute('aria-current')).toBe(
            'true',
        );
        expect(screen.getByRole('button', { name: /News/ }).hasAttribute('aria-current')).toBe(
            false,
        );
    });

    test('clicking a rail entry jumps to it', async () => {
        const user = userEvent.setup();
        const onJump = vi.fn();
        render(CategoryRail, { categories, variant: 'rail', onJump });
        await user.click(screen.getByRole('button', { name: /News/ }));
        expect(onJump).toHaveBeenCalledWith('news');
    });

    test('the select variant jumps and goes back to its placeholder', async () => {
        const user = userEvent.setup();
        const onJump = vi.fn();
        render(CategoryRail, { categories, variant: 'select', onJump });
        const select = screen.getByRole('combobox', { name: 'Jump to category…' });
        await user.selectOptions(select, 'sport');
        expect(onJump).toHaveBeenCalledWith('sport');
        expect((select as HTMLSelectElement).value).toBe('');
    });
});
