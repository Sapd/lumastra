// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import AddGroupInline from './AddGroupInline.svelte';

vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

describe('AddGroupInline', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('disables add for a duplicate (case-insensitive)', async () => {
        render(AddGroupInline, { availableGroups: ['Librarians'], onadded: () => {} });
        const input = screen.getByPlaceholderText(/group/i);
        await fireEvent.input(input, { target: { value: 'librarians' } });
        const button = screen.getByRole('button', { name: /add group|gruppe/i });
        expect((button as HTMLButtonElement).disabled).toBe(true);
    });

    it('posts and calls onadded with the returned list', async () => {
        const onadded = vi.fn();
        const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(
                JSON.stringify({
                    availableGroups: ['Librarians', 'New'],
                    persisted: true,
                }),
                {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                },
            ),
        );
        render(AddGroupInline, { availableGroups: ['Librarians'], onadded });
        const input = screen.getByPlaceholderText(/group/i);
        await fireEvent.input(input, { target: { value: 'New' } });
        const button = screen.getByRole('button', { name: /add group|gruppe/i });
        await fireEvent.click(button);
        await vi.waitFor(() => expect(onadded).toHaveBeenCalledWith(['Librarians', 'New']));
        expect(fetchMock).toHaveBeenCalledWith(
            '/api/admin/navigation/groups',
            expect.objectContaining({ method: 'POST' }),
        );
    });
});
