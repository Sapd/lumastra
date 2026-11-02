// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

const getNotificationWebhook = vi.fn();
const setNotificationWebhook = vi.fn();
const clearNotificationWebhook = vi.fn();

vi.mock('$lib/api/user', () => ({
    getNotificationWebhook: () => getNotificationWebhook(),
    setNotificationWebhook: (body: unknown) => setNotificationWebhook(body),
    clearNotificationWebhook: () => clearNotificationWebhook(),
}));

vi.mock('$lib/stores/toast.store', () => ({
    toasts: { info: vi.fn(), error: vi.fn() },
}));

import NotificationWebhookPanel from './NotificationWebhookPanel.svelte';

describe('NotificationWebhookPanel', () => {
    afterEach(() => {
        cleanup();
        getNotificationWebhook.mockReset();
        setNotificationWebhook.mockReset();
        clearNotificationWebhook.mockReset();
    });

    test('unlocks Save after a successful load with an existing endpoint', async () => {
        getNotificationWebhook.mockResolvedValue({
            error: null,
            data: { url: 'https://ntfy.example.com/mytopic', enabled: true },
        });

        render(NotificationWebhookPanel);

        const input = await screen.findByLabelText<HTMLInputElement>(/Endpoint URL/);
        await waitFor(() => expect(input.disabled).toBe(false));
        expect(input.value).toBe('https://ntfy.example.com/mytopic');
    });

    // Regression (Finding 2): a failed GET on a user who already has a saved
    // endpoint used to render an empty field with Save unlocked — a click
    // would upsert the empty value, silently replacing the saved URL and
    // re-signing the secret, with no indication the read had failed.
    test('a failed load keeps Save disabled, leaves the field empty, and surfaces a retry', async () => {
        getNotificationWebhook.mockResolvedValue({ error: 'network error', data: null });

        render(NotificationWebhookPanel);

        const input = await screen.findByLabelText<HTMLInputElement>(/Endpoint URL/);
        const saveButton = screen.getByRole('button', { name: /^Save$/ });

        // Never unlocks — there is nothing to prove the empty field reflects
        // the truth rather than a request that never landed.
        expect(input.disabled).toBe(true);
        expect(saveButton).toHaveProperty('disabled', true);

        // A retry affordance must exist so the user isn't stuck.
        expect(await screen.findByRole('button', { name: /Retry/ })).toBeTruthy();

        // And typing into a disabled field can't be used to sneak a save
        // through — no call to the API happened at all.
        expect(setNotificationWebhook).not.toHaveBeenCalled();
    });

    test('a thrown load error (not just an { error } response) also keeps Save disabled', async () => {
        getNotificationWebhook.mockRejectedValue(new Error('boom'));

        render(NotificationWebhookPanel);

        const saveButton = await screen.findByRole('button', { name: /^Save$/ });
        expect(saveButton).toHaveProperty('disabled', true);
        expect(await screen.findByRole('button', { name: /Retry/ })).toBeTruthy();
    });

    test('retry re-fetches and unlocks the panel once the read succeeds', async () => {
        getNotificationWebhook
            .mockResolvedValueOnce({ error: 'network error', data: null })
            .mockResolvedValueOnce({
                error: null,
                data: { url: 'https://ntfy.example.com/mytopic', enabled: true },
            });

        render(NotificationWebhookPanel);

        const retryButton = await screen.findByRole('button', { name: /Retry/ });
        await fireEvent.click(retryButton);

        const input = await screen.findByLabelText<HTMLInputElement>(/Endpoint URL/);
        await waitFor(() => expect(input.disabled).toBe(false));
        expect(input.value).toBe('https://ntfy.example.com/mytopic');
        expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    });

    test('a successful load with no configured endpoint unlocks the field but not Save (empty is legitimately empty)', async () => {
        getNotificationWebhook.mockResolvedValue({ error: null, data: { url: '', enabled: true } });

        render(NotificationWebhookPanel);

        const input = await screen.findByLabelText<HTMLInputElement>(/Endpoint URL/);
        await waitFor(() => expect(input.disabled).toBe(false));
        const saveButton = screen.getByRole('button', { name: /^Save$/ });
        // Empty + unchanged (dirty === false) — disabled for a different,
        // legitimate reason than the load-failure case above.
        expect(saveButton).toHaveProperty('disabled', true);
        expect(screen.queryByRole('button', { name: /Retry/ })).toBeNull();
    });
});
