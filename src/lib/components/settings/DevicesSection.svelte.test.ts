// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

const deleteDevice = vi.fn(async (_id?: string) => ({ error: null, data: null }));
const deleteAllDevices = vi.fn(async () => ({
    error: null,
    data: { revoked: 1, failedStores: [] },
}));
vi.mock('$lib/api/user', () => ({
    deleteDevice: (id: string) => deleteDevice(id),
    deleteAllDevices: () => deleteAllDevices(),
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { success: vi.fn(), error: vi.fn() } }));
vi.mock('$lib/components/player/device-id', () => ({ getDeviceId: () => 'dashboard-THIS' }));

import DevicesSection from './DevicesSection.svelte';
import type { UserDeviceInfo } from '$lib/schemas/api-user-responses';

// Typed as UserDeviceInfo[] deliberately: the component's props are declared in a
// .svelte file, so nothing type-checks this fixture against the schema on its own
// (tsgo resolves `*.svelte` imports to `any`). The annotation is the only thing that
// makes a schema change surface here instead of silently changing what is rendered —
// which is exactly how this fixture drifted past the deviceId/isCustomName split.
const sessions: UserDeviceInfo[] = [
    {
        deviceSessionId: 'dashboard-THIS',
        deviceId: 'dashboard-THIS',
        deviceName: 'This Mac',
        isCustomName: false,
        clientId: 'web',
        createdAt: '2026-01-01T00:00:00Z',
        lastUsedAt: null,
    },
    {
        deviceSessionId: 'tv-9',
        deviceId: 'tv-device-9',
        deviceName: 'Living Room TV',
        isCustomName: false,
        clientId: 'tvos',
        createdAt: '2026-01-01T00:00:00Z',
        lastUsedAt: null,
    },
];

describe('DevicesSection', () => {
    afterEach(() => {
        cleanup();
        deleteDevice.mockClear();
        deleteAllDevices.mockClear();
    });

    test('marks the current device and renders SSR-seeded sessions', () => {
        render(DevicesSection, { initialSessions: sessions });
        expect(screen.getByText('Living Room TV')).toBeTruthy();
        expect(screen.getByText(/This device/)).toBeTruthy();
    });

    test('shows which device approved a dependent sign-in', () => {
        render(DevicesSection, {
            initialSessions: [{ ...sessions[1], approvedByDeviceName: 'Denis iPhone' }],
        });
        expect(screen.getByText(/Approved by Denis iPhone/)).toBeTruthy();
    });

    test('single revoke needs an inline confirm', async () => {
        render(DevicesSection, { initialSessions: sessions });
        await fireEvent.click(screen.getByRole('button', { name: /Log out Living Room TV/ }));
        expect(deleteDevice).not.toHaveBeenCalled();
        await fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
        expect(deleteDevice).toHaveBeenCalledWith('tv-9');
    });

    test('Revoke-All excludes the current device from the count and confirms', async () => {
        const phone: UserDeviceInfo = {
            ...sessions[1],

            deviceSessionId: 'phone-1',
            deviceId: 'phone-device-1',
            deviceName: 'Phone',
        };
        render(DevicesSection, { initialSessions: [...sessions, phone] });
        // De-emphasized trigger names the count of OTHER devices (2), not 3.
        await fireEvent.click(screen.getByRole('button', { name: /Sign out 2 other devices/ }));
        await fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
        expect(deleteAllDevices).toHaveBeenCalled();
    });

    // With one other device its own Log out does the same job; a second
    // "Sign out 1 other device" button next to it was noise.
    test('offers no sign-out-all button when only one other device exists', () => {
        render(DevicesSection, { initialSessions: sessions });
        expect(screen.queryByRole('button', { name: /Sign out 1 other device/ })).toBeNull();
    });

    test('flags an older sign-in of the same device', () => {
        const again: UserDeviceInfo = {
            ...sessions[1],

            deviceSessionId: 'tv-10',
            createdAt: '2026-02-01T00:00:00Z',
        };
        render(DevicesSection, { initialSessions: [...sessions, again] });
        expect(screen.getAllByText(/Older sign-in/)).toHaveLength(1);
    });
});
