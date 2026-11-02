// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock('$app/stores', () => ({
    page: readable({
        data: {
            user: { username: 'testuser' },
            features: { jellyfinCompat: true, subsonicCompat: true },
        },
        url: new URL('http://localhost/settings/connections?mal_link=error&reason=profile'),
    }),
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { success: vi.fn(), error: vi.fn() } }));
vi.mock('$app/navigation', () => ({ afterNavigate: vi.fn() }));
// These modals have transitive SvelteKit virtual-env imports; stub them out for the unit test.
vi.mock('$lib/components/jellyfin-connect/JellyfinConnectModal.svelte', () => ({
    default: { render: () => ({ c: () => {}, m: () => {}, d: () => {}, e: () => {} }) },
}));
vi.mock('$lib/components/subsonic-connect/SubsonicConnectModal.svelte', () => ({
    default: { render: () => ({ c: () => {}, m: () => {}, d: () => {}, e: () => {} }) },
}));

vi.mock('$lib/api/integrations.js', () => ({
    getMalStatus: vi.fn(),
    initiateMalAuthorize: vi.fn(),
    unlinkMal: vi.fn(),
    getTraktStatus: vi.fn(),
    initiateTraktAuthorize: vi.fn(),
    unlinkTrakt: vi.fn(),
}));

import ConnectionsSection from './ConnectionsSection.svelte';
import * as integrationsApi from '$lib/api/integrations.js';

describe('ConnectionsSection', () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    test('MAL unlink requires an inline confirm before calling DELETE', async () => {
        const getMalStatus = vi.mocked(integrationsApi.getMalStatus);
        const unlinkMal = vi.mocked(integrationsApi.unlinkMal);

        // status -> linked
        getMalStatus.mockResolvedValueOnce({
            data: { linked: true, configured: true, malUsername: 'testuser' },
            error: null,
            status: 200,
        });
        render(ConnectionsSection, {});
        await waitFor(() => expect(screen.getByText(/testuser/)).toBeTruthy());

        // DELETE only after confirm
        unlinkMal.mockResolvedValueOnce({ data: {}, error: null, status: 200 });
        await fireEvent.click(screen.getByRole('button', { name: /Unlink/ }));
        expect(unlinkMal).not.toHaveBeenCalled(); // still just the status call
        await fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
        await waitFor(() => expect(unlinkMal).toHaveBeenCalledTimes(1));
    });

    test('Trakt unlink requires an inline confirm before calling DELETE', async () => {
        const getTraktStatus = vi.mocked(integrationsApi.getTraktStatus);
        const unlinkTrakt = vi.mocked(integrationsApi.unlinkTrakt);

        // status -> linked
        getTraktStatus.mockResolvedValueOnce({
            data: { linked: true, configured: true, traktUsername: 'trakt_joe' },
            error: null,
            status: 200,
        });
        render(ConnectionsSection, {});
        await waitFor(() => expect(screen.getByText(/trakt_joe/)).toBeTruthy());

        // DELETE only after confirm
        unlinkTrakt.mockResolvedValueOnce({ data: {}, error: null, status: 200 });
        await fireEvent.click(screen.getByRole('button', { name: /Unlink/ }));
        expect(unlinkTrakt).not.toHaveBeenCalled(); // still just the status call
        await fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
        await waitFor(() => expect(unlinkTrakt).toHaveBeenCalledTimes(1));
    });
});

import { toasts } from '$lib/stores/toast.store';
test('shows an actionable callback failure', async () => {
    render(ConnectionsSection, {});
    await waitFor(() =>
        expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/profile.*try.*again/i)),
    );
    cleanup();
});
test.each(['mal', 'trakt'] as const)(
    '%s offers reconnection after refresh failure',
    async (provider) => {
        const status =
            provider === 'mal' ? integrationsApi.getMalStatus : integrationsApi.getTraktStatus;
        vi.mocked(status).mockResolvedValueOnce({
            data: { configured: true, linked: false, auth_failed: true },
            error: null,
            status: 200,
        });
        render(ConnectionsSection, {});
        await waitFor(() => expect(screen.getByText('Reconnect needed')).toBeTruthy());
        expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy();
        cleanup();
    },
);
