// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, fireEvent, cleanup } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
const { searchPerson } = vi.hoisted(() => ({ searchPerson: vi.fn() }));
vi.mock('$lib/api/content', () => ({ searchPerson }));
vi.mock('$lib/api/admin', () => ({
    getPerson: vi.fn(async () => ({ data: { images: {} }, error: null })),
}));
import ActorChip from './ActorChip.svelte';

afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

test('click waits for the person lookup already started by hover', async () => {
    vi.useFakeTimers();
    let finish!: (value: { data: { personId: number }; error: null }) => void;
    searchPerson.mockReturnValue(
        new Promise((resolve) => {
            finish = resolve;
        }),
    );
    const onclick = vi.fn();
    render(ActorChip, { name: 'Patrick Vale', onclick });
    const chip = screen.getByRole('button', { name: /Patrick Vale/ });
    await fireEvent.mouseEnter(chip);
    await vi.advanceTimersByTimeAsync(100);
    expect(searchPerson).toHaveBeenCalledTimes(1);
    await fireEvent.click(chip);
    finish({ data: { personId: 2387 }, error: null });
    await vi.advanceTimersByTimeAsync(1);
    expect(onclick).toHaveBeenCalledWith({ id: 2387, name: 'Patrick Vale' });
    expect(searchPerson).toHaveBeenCalledTimes(1);
});
