// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
import NumberPreference from './NumberPreference.svelte';

afterEach(cleanup);

test.each(['', '0', '301', '1.5'])(
    'rejects invalid seconds %s without persisting them',
    async (value) => {
        const onchange = vi.fn();
        render(NumberPreference, { label: 'Seek step', min: 1, max: 300, value: 10, onchange });
        const input = screen.getByRole('spinbutton', { name: 'Seek step' });
        await fireEvent.change(input, { target: { value } });
        expect(onchange).not.toHaveBeenCalled();
        expect(input.getAttribute('aria-invalid')).toBe('true');
        expect(screen.getByRole('alert').textContent).toContain('1 to 300');
        await fireEvent.change(input, { target: { value: '20' } });
        expect(onchange).toHaveBeenCalledWith(20);
        expect(screen.queryByRole('alert')).toBeNull();
    },
);

test('accepts zero and negative values when the preference range allows them', async () => {
    const onchange = vi.fn();
    render(NumberPreference, { label: 'Popup lead', min: -60, max: 120, value: 0, onchange });
    const input = screen.getByRole('spinbutton', { name: 'Popup lead' });
    await fireEvent.change(input, { target: { value: '-60' } });
    await fireEvent.change(input, { target: { value: '0' } });
    expect(onchange.mock.calls).toEqual([[-60], [0]]);
});
