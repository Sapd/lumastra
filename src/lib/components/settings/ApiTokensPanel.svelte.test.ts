// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

const deleteToken = vi.fn(async (_id?: string) => ({ error: null, data: null }));
const createUserToken = vi.fn(async (_body?: unknown) => ({
    error: null,
    data: { id: 2, token: 'lum_secret', message: 'Created' },
}));
vi.mock('$lib/api/user', () => ({
    deleteToken: (id: string) => deleteToken(id),
    createUserToken: (body: unknown) => createUserToken(body),
    getTokens: vi.fn(async () => ({
        error: null,
        data: { items: [], page: { limit: 0, offset: 0, hasMore: false } },
    })),
}));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: vi.fn(), error: vi.fn() },
}));

import ApiTokensPanel from './ApiTokensPanel.svelte';

const seeded: import('$lib/schemas/api-user-responses').UserTokenInfo[] = [
    {
        id: 1,
        name: 'My Dashboard',
        description: null,
        tokenPrefix: 'lum_ab',
        scopes: ['read'],
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
        expiresAt: null,
        lastUsedIp: null,
        usageCount: 0,
        isExpired: false,
        allowedIps: null,
    },
];

/**
 * Fills the create-token modal's name field and submits it.
 * `tweak` runs after the modal opens so a test can flip scope/expiry first.
 */
async function submitCreateForm(tweak?: () => Promise<void>): Promise<void> {
    await fireEvent.click(screen.getByRole('button', { name: /Create token/ }));
    await fireEvent.input(screen.getByLabelText(/Name/), { target: { value: 'claude2' } });
    await tweak?.();
    await fireEvent.click(screen.getByRole('button', { name: /Create Token/ }));
}

describe('ApiTokensPanel', () => {
    afterEach(() => {
        cleanup();
        deleteToken.mockClear();
        createUserToken.mockClear();
    });

    test('renders SSR-seeded tokens without a client fetch', () => {
        render(ApiTokensPanel, { initialTokens: seeded });
        expect(screen.getByText('My Dashboard')).toBeTruthy();
    });

    test('PAT delete requires an inline confirm before calling the API', async () => {
        render(ApiTokensPanel, { initialTokens: seeded });
        await fireEvent.click(screen.getByRole('button', { name: /Revoke token/ }));
        expect(deleteToken).not.toHaveBeenCalled();
        await fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
        expect(deleteToken).toHaveBeenCalledWith('1');
    });

    // Regression: the modal promised "read and write access" but posted only
    // `{ name }`, so the server applied its `['read']` default and every POST
    // from the resulting token was rejected with `insufficient_scope`.
    test('transmits the selected write scope instead of relying on the server default', async () => {
        render(ApiTokensPanel);
        await submitCreateForm();
        expect(createUserToken).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'claude2', scopes: ['read', 'write'] }),
        );
    });

    test('transmits a read-only scope when the user narrows access', async () => {
        render(ApiTokensPanel);
        await submitCreateForm(async () => {
            await fireEvent.click(screen.getByLabelText(/Read-only/));
        });
        expect(createUserToken).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'claude2', scopes: ['read'] }),
        );
    });

    // The same dropped-payload bug left `expiresAt` null on every self-service
    // token, so expiry has to travel explicitly too.
    //
    // Only the default is asserted here: happy-dom mis-reports `option.selected`,
    // so a `<select bind:value>` always reads back its FIRST option no matter
    // what the test selects — reproducible with a 20-line component, unrelated
    // to this panel. The choice→payload mapping is covered directly in
    // pat-create-payload.test.ts instead.
    test('defaults the transmitted expiry to one year', async () => {
        render(ApiTokensPanel);
        await submitCreateForm();
        expect(createUserToken).toHaveBeenCalledWith(
            expect.objectContaining({ expiresInDays: 365 }),
        );
    });

    // A narrowed scope surviving a cancel would silently apply to the next
    // token — the same "I asked for write, I got read" trap in quieter form.
    test('discards a narrowed scope when the modal is cancelled', async () => {
        render(ApiTokensPanel);
        await fireEvent.click(screen.getByRole('button', { name: /Create token/ }));
        await fireEvent.click(screen.getByLabelText(/Read-only/));
        await fireEvent.click(screen.getByRole('button', { name: /Cancel/ }));

        await submitCreateForm();
        expect(createUserToken).toHaveBeenCalledWith(
            expect.objectContaining({ scopes: ['read', 'write'] }),
        );
    });

    test('shows the scope, expiry and last use of existing tokens', () => {
        render(ApiTokensPanel, { initialTokens: seeded });
        expect(screen.getByText(/Read-only/)).toBeTruthy();
        expect(screen.getByText(/Never expires/)).toBeTruthy();
        expect(screen.getByText(/Never used/)).toBeTruthy();
    });

    // Eight identical "Revoke token" buttons told a screen reader nothing.
    test('names the token in its revoke button', () => {
        render(ApiTokensPanel, { initialTokens: seeded });
        expect(screen.getByRole('button', { name: /Revoke token .My Dashboard./ })).toBeTruthy();
    });

    // The secret is shown once; a stray click or Escape used to throw it away.
    test('the one-time token dialog survives Escape and a backdrop click', async () => {
        render(ApiTokensPanel);
        await submitCreateForm();
        const dialog = await screen.findByRole('dialog', { name: /Token/ });
        await fireEvent.keyDown(dialog, { key: 'Escape' });
        await fireEvent.click(dialog.parentElement!);
        expect(screen.getByText('lum_secret')).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: /Done/ }));
        expect(screen.queryByText('lum_secret')).toBeNull();
    });

    // Folding an unknown scope into "Read-only" is how a write-capable token
    // gets displayed as harmless.
    test('shows an unrecognised scope verbatim rather than calling it read-only', () => {
        render(ApiTokensPanel, {
            initialTokens: [{ ...seeded[0], scopes: ['playback:remote'] }],
        });
        expect(screen.getByText(/playback:remote/)).toBeTruthy();
        expect(screen.queryByText(/Read-only/)).toBeNull();
    });

    // Found in review: Escape during the request "cancelled" the dialog, the
    // token was created anyway and the secret dialog popped up later.
    test('the create form cannot be dismissed while the request is out', async () => {
        let release: () => void = () => {};
        createUserToken.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = () => resolve({ error: null, data: { id: 1, token: 'lum_late', message: 'ok' } });
                }),
        );
        render(ApiTokensPanel);
        await submitCreateForm();
        const form = screen.getByRole('dialog', { name: /Create API Token/ });
        await fireEvent.keyDown(form, { key: 'Escape' });
        expect(screen.getByRole('dialog', { name: /Create API Token/ })).toBeTruthy();
        release();
        expect(await screen.findByText('lum_late')).toBeTruthy();
    });
});
