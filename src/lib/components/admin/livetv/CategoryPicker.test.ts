// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import CategoryPicker from './CategoryPicker.svelte';

vi.mock('$lib/paraglide/messages.js', () => ({
    admin_livetv_move_search: () => 'Find a category…',
    admin_livetv_move_position: () => 'Where to add the channels',
    admin_livetv_move_position_bottom: () => 'At the end',
    admin_livetv_move_position_top: () => 'At the top',
    admin_livetv_move_no_match: () => 'No matching category',
}));

const categories = [
    { id: 'news', name: 'News', count: 120 },
    { id: 'sport', name: 'Sport', count: 1840 },
    { id: 'kids', name: 'Kids', count: 75 },
    { id: 'esports', name: 'eSports', count: 12 },
];

function optionNames(): string[] {
    return screen
        .getAllByRole('option')
        .map((o) => o.textContent?.replace(/\s+/g, ' ').trim() ?? '');
}

describe('CategoryPicker', () => {
    test('lists every category with its count and focuses the search', () => {
        render(CategoryPicker, { categories, onPick: vi.fn() });
        expect(optionNames()).toEqual(['News 120', 'Sport 1840', 'Kids 75', 'eSports 12']);
        expect(document.activeElement).toBe(screen.getByRole('combobox'));
    });

    test('type-ahead narrows the list, names starting with the query first', async () => {
        const user = userEvent.setup();
        render(CategoryPicker, { categories, onPick: vi.fn() });
        await user.type(screen.getByRole('combobox'), 'sp');
        expect(optionNames()).toEqual(['Sport 1840', 'eSports 12']);
    });

    test('Enter picks the highlighted match at the end by default', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        render(CategoryPicker, { categories, onPick });
        await user.type(screen.getByRole('combobox'), 'sp{ArrowDown}{Enter}');
        expect(onPick).toHaveBeenCalledWith('esports', 'bottom');
    });

    test('"At the top" picks with the top position', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        render(CategoryPicker, { categories, onPick });
        await user.click(screen.getByRole('button', { name: 'At the top' }));
        await user.click(screen.getByRole('option', { name: /Kids/ }));
        expect(onPick).toHaveBeenCalledWith('kids', 'top');
    });

    test('keys typed in the search do not reach a surrounding menu', async () => {
        const user = userEvent.setup();
        const outer = vi.fn();
        document.addEventListener('keydown', outer);
        render(CategoryPicker, { categories, onPick: vi.fn() });
        await user.type(screen.getByRole('combobox'), 'n{ArrowDown}{Home}');
        expect(outer).not.toHaveBeenCalled();
        document.removeEventListener('keydown', outer);
    });

    test('Escape clears the search first, then reaches the surrounding menu', async () => {
        const user = userEvent.setup();
        const outer = vi.fn();
        document.addEventListener('keydown', outer);
        render(CategoryPicker, { categories, onPick: vi.fn() });
        const input = screen.getByRole('combobox') as HTMLInputElement;
        await user.type(input, 'sp{Escape}');
        expect(input.value).toBe('');
        expect(outer).not.toHaveBeenCalled();
        await user.keyboard('{Escape}');
        expect(outer).toHaveBeenCalledTimes(1);
        document.removeEventListener('keydown', outer);
    });

    test('says so when nothing matches', async () => {
        const user = userEvent.setup();
        const onPick = vi.fn();
        render(CategoryPicker, { categories, onPick });
        await user.type(screen.getByRole('combobox'), 'zzz{Enter}');
        expect(screen.getByText('No matching category')).toBeTruthy();
        expect(onPick).not.toHaveBeenCalled();
    });
});
