// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { AdminChannel, AdminChannelCategory } from '$lib/schemas/livetv.js';
import ChannelActionBar from './ChannelActionBar.svelte';

const ch = (id: string, isVisible = true): AdminChannel =>
    ({ id, name: id, isVisible }) as AdminChannel;
const categories: AdminChannelCategory[] = [
    {
        id: 'news',
        name: 'News',
        sortOrder: 0,
        isVisible: true,
        channels: [ch('a'), ch('b', false)],
    },
    { id: 'sport', name: 'Sport', sortOrder: 1, isVisible: true, channels: [ch('c')] },
];

function setup(showHidden = true): { onBulkMoveToCategory: ReturnType<typeof vi.fn> } {
    const onBulkMoveToCategory = vi.fn();
    render(ChannelActionBar, {
        selectedCount: 2,
        categories,
        showHidden,
        onBulkHide: vi.fn(),
        onBulkShow: vi.fn(),
        onBulkMoveToCategory,
        onBulkSetQuality: vi.fn(),
        onDeselectAll: vi.fn(),
    });
    return { onBulkMoveToCategory };
}

describe('ChannelActionBar move to category', () => {
    test('passes the picked category and "At the top" on', async () => {
        const user = userEvent.setup();
        const { onBulkMoveToCategory } = setup();
        await user.click(screen.getByRole('button', { name: /Move to category/ }));
        await user.click(screen.getByRole('button', { name: 'At the top' }));
        await user.click(screen.getByRole('option', { name: /Sport/ }));
        expect(onBulkMoveToCategory).toHaveBeenCalledWith('sport', 'top');
    });

    test('counts leave hidden channels out while they are not on screen', async () => {
        const user = userEvent.setup();
        setup(false);
        await user.click(screen.getByRole('button', { name: /Move to category/ }));
        const news = screen.getByRole('option', { name: /News/ });
        expect(news.textContent?.replace(/\s+/g, ' ').trim()).toBe('News 1');
    });

    test('Escape closes the list and returns focus to its button', async () => {
        const user = userEvent.setup();
        setup();
        const trigger = screen.getByRole('button', { name: /Move to category/ });
        await user.click(trigger);
        await user.keyboard('{Escape}');
        expect(screen.queryByRole('listbox')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });
});
