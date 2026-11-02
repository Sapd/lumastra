// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';
import DataResetSection from './DataResetSection.svelte';

const { resetUserData } = vi.hoisted(() => ({
    resetUserData: vi.fn<() => Promise<{ error: string | null }>>(async () => ({ error: null })),
}));
vi.mock('$app/stores', () => ({ page: readable({ data: { activeLibraryTypes: ['music'] } }) }));
vi.mock('$lib/api/user', () => ({ resetUserData }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: vi.fn(), success: vi.fn() } }));

afterEach(() => {
    cleanup();
    resetUserData.mockClear();
});

test('destructive reset requires exact confirmation and exposes a labelled dialog', async () => {
    render(DataResetSection);
    await fireEvent.click(screen.getAllByRole('button', { name: 'Clear' })[0]);
    expect(screen.getByRole('dialog', { name: /listening history/i })).toBeTruthy();
    const input = screen.getByRole('textbox');
    const confirm = screen.getByRole('button', { name: 'Confirm' }) as HTMLButtonElement;
    await fireEvent.input(input, { target: { value: 'RESE' } });
    expect(confirm.disabled).toBe(true);
    expect(resetUserData).not.toHaveBeenCalled();
    // Case does not matter; the word itself does.
    await fireEvent.input(input, { target: { value: 'reset' } });
    await fireEvent.click(confirm);
    expect(resetUserData).toHaveBeenCalledWith('music-history', true);
});

test('Escape cancels confirmation without resetting data', async () => {
    render(DataResetSection);
    await fireEvent.click(screen.getAllByRole('button', { name: 'Clear' })[0]);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
    await fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(resetUserData).not.toHaveBeenCalled();
});

test('failed reset remains visible inline after the dialog closes', async () => {
    resetUserData.mockRejectedValueOnce(new Error('Offline'));
    render(DataResetSection);
    await fireEvent.click(screen.getAllByRole('button', { name: 'Refresh' })[0]);
    expect(await screen.findByRole('alert')).toBeTruthy();
});
