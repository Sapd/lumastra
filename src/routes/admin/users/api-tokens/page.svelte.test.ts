// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * /admin/users/api-tokens list loading:
 *   - an API error used to leave the table empty and silent, which reads as
 *     "no tokens exist";
 *   - Refresh, create and revoke each start a reload, and an older response
 *     landing last brought a just-revoked token back.
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$app/stores', () => ({
    page: readable({
        data: { deviceAuth: true },
        url: new URL('http://localhost/admin/users/api-tokens'),
    }),
    navigating: readable(null),
}));
vi.mock('$app/state', () => ({
    page: { data: {}, url: new URL('http://localhost/admin/users/api-tokens') },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), invalidateAll: vi.fn() }));
vi.mock('$app/paths', () => ({ base: '', resolve: (p: string) => p }));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));

const adminApi = vi.hoisted(() => ({
    getAdminPats: vi.fn(),
    getServiceTokens: vi.fn(),
    getLocalUsers: vi.fn().mockResolvedValue({ data: { items: [] }, error: null, status: 200 }),
    addNavPin: vi.fn(),
    removeNavPin: vi.fn(),
}));
vi.mock('$lib/api/admin', () => adminApi);
vi.mock('$lib/components/jellyfin-connect/ConnectedAppTokens.svelte', async () => ({
    default: (await import('./test-empty-stub.svelte')).default,
}));

import ApiTokensPage from './+page.svelte';
import type { PatInfo } from '$lib/schemas/api-admin-responses';

function pat(id: number, name: string): PatInfo {
    return {
        id,
        name,
        owner: {
            userId: '550e8400-e29b-41d4-a716-446655440000',
            displayName: 'Alice',
            images: { primary: { href: '/api/users/550e8400-e29b-41d4-a716-446655440000/images/avatar', revision: '0', source: 'self' } },
        },
        description: null,
        lastUsedIp: null,
        usageCount: 0,
        allowedIps: null,
        scopes: ['read'],
        tokenPrefix: `pat_${id}`,
        createdAt: '2026-10-01T00:00:00Z',
        expiresAt: null,
        lastUsedAt: null,
        isExpired: false,
    };
}

const page = { limit: 50, offset: 0, hasMore: false };
const emptyList = { data: { items: [], page }, error: null };

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('/admin/users/api-tokens', () => {
    it('reports a failed PAT list load instead of showing an empty list', async () => {
        adminApi.getAdminPats.mockResolvedValue({ data: null, error: 'Forbidden' });
        adminApi.getServiceTokens.mockResolvedValue(emptyList);

        render(ApiTokensPage);

        await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Forbidden'));
    });

    it('keeps the newest list when an older reload resolves last', async () => {
        let resolveFirst!: (v: unknown) => void;
        adminApi.getAdminPats
            .mockImplementationOnce(() => new Promise((r) => (resolveFirst = r)))
            .mockResolvedValueOnce({ data: { items: [pat(2, 'fresh-token')], page }, error: null });
        adminApi.getServiceTokens.mockResolvedValue(emptyList);

        render(ApiTokensPage);
        await waitFor(() => expect(adminApi.getAdminPats).toHaveBeenCalledTimes(1));

        await fireEvent.click(screen.getAllByRole('button', { name: /refresh/i })[0]);
        await waitFor(() => expect(screen.getAllByText('fresh-token')[0]).toBeTruthy());

        // The first (stale) request now lands with a token revoked since.
        resolveFirst({ data: { items: [pat(1, 'revoked-token')], page }, error: null });
        await new Promise((r) => setTimeout(r, 0));

        expect(screen.queryByText('revoked-token')).toBeNull();
        expect(screen.getAllByText('fresh-token')[0]).toBeTruthy();
    });
});
