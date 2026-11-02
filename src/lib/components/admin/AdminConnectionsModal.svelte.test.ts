// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * "Revoke all devices" is a best-effort sweep that answers 200 with
 * a numeric revoked count and failedStores when a credential store failed. The modal
 * used to read only `error` and report "All devices revoked" regardless.
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$app/stores', () => ({
    page: readable({ data: { features: { deviceAuth: true } } }),
}));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));

const adminApi = vi.hoisted(() => ({
    getAdminDevices: vi.fn(),
    deleteAllAdminDevices: vi.fn(),
}));
vi.mock('$lib/api/admin', () => adminApi);

import AdminConnectionsModal from './AdminConnectionsModal.svelte';
import * as m from '$lib/paraglide/messages.js';

const device = {
    deviceSessionId: 'dev-1',
    deviceId: 'd1',
    deviceName: 'Living room TV',
    isCustomName: false,
    createdAt: '2026-10-01T00:00:00Z',
    lastUsedAt: '2026-10-06T00:00:00Z',
};

beforeEach(() => {
    adminApi.getAdminDevices.mockResolvedValue({
        data: { items: [device], page: { limit: 50, offset: 0, hasMore: false } },
        error: null,
    });
});

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

async function revokeAll(): Promise<void> {
    render(AdminConnectionsModal, {
        username: 'bob',
        userId: '11111111-1111-4111-8111-111111111111',
        formatDate: () => 'today',
        onclose: vi.fn(),
    });
    await waitFor(() => expect(screen.getByText('Living room TV')).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: m.admin_conn_revoke_all() }));
    const confirms = screen.getAllByRole('button', { name: m.admin_conn_revoke_all() });
    await fireEvent.click(confirms[confirms.length - 1]);
}

describe('AdminConnectionsModal revoke all devices', () => {
    it('reports a partial sweep as an error naming the failed stores', async () => {
        adminApi.deleteAllAdminDevices.mockResolvedValue({
            data: { revoked: 0, failedStores: ['refresh_tokens'] },
            error: null,
        });
        await revokeAll();
        await waitFor(() =>
            expect(toasts.error).toHaveBeenCalledWith(
                m.admin_conn_revoke_partial({ stores: 'refresh_tokens' }),
            ),
        );
        expect(toasts.success).not.toHaveBeenCalled();
    });

    it('reports success only when every store was revoked', async () => {
        adminApi.deleteAllAdminDevices.mockResolvedValue({
            data: { revoked: 1, failedStores: [] },
            error: null,
        });
        await revokeAll();
        await waitFor(() =>
            expect(toasts.success).toHaveBeenCalledWith(m.admin_conn_all_devices_revoked()),
        );
    });

    it('surfaces a thrown request instead of swallowing it', async () => {
        adminApi.deleteAllAdminDevices.mockRejectedValue(new Error('network down'));
        await revokeAll();
        await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    });
});
