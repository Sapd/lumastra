// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
const api = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('$lib/api/client.js', () => api);
import Panel from './ActivitySharingDefaultPanel.svelte';

afterEach(cleanup);
beforeEach(() => {
    vi.clearAllMocks();
});
it.each([false, true])(
    'confirms the saved sharing=%s before changing any accounts',
    async (sharing) => {
        api.apiGet.mockResolvedValue({ data: { sharing }, error: null });
        api.apiPost.mockResolvedValue({ data: { sharing, changedCount: 2 }, error: null });
        render(Panel);
        await fireEvent.click(
            screen.getByRole('button', { name: 'Apply the default to existing users' }),
        );
        await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
        expect(
            screen.getByText(
                sharing ? /Apply sharing on to existing/ : /Apply sharing off to existing/,
            ),
        ).toBeTruthy();
        expect(api.apiPost).not.toHaveBeenCalled();
        const buttons = screen.getAllByRole('button', {
            name: 'Apply the default to existing users',
        });
        await fireEvent.click(buttons[buttons.length - 1]);
        await waitFor(() =>
            expect(api.apiPost).toHaveBeenCalledWith(
                '/api/admin/activity-sharing-default',
                expect.anything(),
                { confirmed: true, expectedDefault: sharing },
            ),
        );
        await waitFor(() => expect(screen.getByText('Updated 2 accounts.')).toBeTruthy());
    },
);
it('allows cancellation without applying anything', async () => {
    api.apiGet.mockResolvedValue({ data: { sharing: true }, error: null });
    render(Panel);
    await fireEvent.click(
        screen.getByRole('button', { name: 'Apply the default to existing users' }),
    );
    await waitFor(() => expect(screen.getByRole('dialog')).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.apiPost).not.toHaveBeenCalled();
});
it('shows a failure and never confirms when the saved default cannot be read', async () => {
    api.apiGet.mockRejectedValue(new Error('unavailable'));
    render(Panel);
    await fireEvent.click(
        screen.getByRole('button', { name: 'Apply the default to existing users' }),
    );
    await waitFor(() =>
        expect(screen.getByText('Could not apply the sharing default.')).toBeTruthy(),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.apiPost).not.toHaveBeenCalled();
});
