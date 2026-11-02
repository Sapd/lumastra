// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, cleanup } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import GenreBar from './GenreBar.svelte';

afterEach(cleanup);

const chips = Array.from({ length: 12 }, (_, i) => ({
    slug: `g${i}`,
    name: `Genre ${i}`,
    count: 100 - i * 5,
    imageUrl: i === 0 ? '/api/media/x/images/poster?size=thumb' : undefined,
}));

describe('GenreBar', () => {
    it('shows the largest categories and the selected one, the rest behind More', async () => {
        render(GenreBar, { props: { chips, selected: 'g11', onselect: vi.fn() } });
        expect(screen.getByRole('button', { name: /Genre 0/ })).toBeTruthy();
        expect(screen.getByRole('button', { name: /Genre 11/ })).toBeTruthy(); // selected
        expect(screen.queryByRole('button', { name: /Genre 9/ })).toBeNull();
        await userEvent.click(screen.getByRole('button', { name: /More/ }));
        expect(screen.getByRole('button', { name: /Genre 9/ })).toBeTruthy();
    });

    it('shows a chip logo and selects with arrow keys among the shown chips', async () => {
        const onselect = vi.fn();
        const { container } = render(GenreBar, { props: { chips, selected: null, onselect } });
        expect(container.querySelectorAll('img')).toHaveLength(1);
        screen.getByRole('button', { name: 'All' }).focus();
        await userEvent.keyboard('{ArrowRight}');
        expect(onselect).toHaveBeenCalledWith('g0');
    });
});
