// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

const listControllableDevices = vi.fn();
const getDeviceState = vi.fn(() => new Promise(() => {}));
vi.mock('$lib/api/device-commands', () => ({
    listControllableDevices: () => listControllableDevices(),
    getDeviceState: (...a: unknown[]) => getDeviceState(...(a as [])),
}));
vi.mock('$lib/stores/device-events', () => ({
    onDeviceState: () => () => {},
    onDeviceCommandStatus: () => () => {},
}));

import ControllableDevices from './ControllableDevices.svelte';

const row = {
    deviceSessionId: 'tv-1',
    deviceName: 'Living Room TV',
    isOnline: true,
    capabilities: { commands: { 'playback.pause': {} } },
    ownerUsername: 'grandma',
};

describe('ControllableDevices', () => {
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    test('renders nothing when nobody granted control', async () => {
        listControllableDevices.mockResolvedValue({
            data: { items: [] },
            error: null,
            status: 200,
        });
        const { container } = render(ControllableDevices);
        await Promise.resolve();
        expect(container.textContent?.trim()).toBe('');
    });

    test('labels a device "<device> (<owner>)" and opens its remote', async () => {
        listControllableDevices.mockResolvedValue({
            data: { items: [row] },
            error: null,
            status: 200,
        });
        render(ControllableDevices);
        expect(await screen.findByText('Living Room TV (grandma)')).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: /Living Room TV \(grandma\)/ }));
        expect(
            await screen.findByRole('dialog', { name: 'Remote for Living Room TV (grandma)' }),
        ).toBeTruthy();
        expect(getDeviceState).toHaveBeenCalledWith('tv-1');
    });

    test('a failed load says so instead of staying silently empty', async () => {
        listControllableDevices.mockResolvedValue({ data: null, error: 'boom', status: 500 });
        render(ControllableDevices);
        expect(
            await screen.findByText('The devices you can control could not be loaded.'),
        ).toBeTruthy();
        cleanup();
        listControllableDevices.mockRejectedValue(new Error('offline'));
        render(ControllableDevices);
        expect(
            await screen.findByText('The devices you can control could not be loaded.'),
        ).toBeTruthy();
    });

    test('when the owner took the grant back (404) the remote closes and the list is read again', async () => {
        listControllableDevices
            .mockResolvedValueOnce({ data: { items: [row] }, error: null, status: 200 })
            .mockResolvedValueOnce({ data: { items: [] }, error: null, status: 200 });
        getDeviceState.mockResolvedValueOnce({ data: null, error: 'gone', status: 404 } as never);
        render(ControllableDevices);
        await fireEvent.click(await screen.findByRole('button', { name: /Living Room TV/ }));
        await waitFor(() => expect(listControllableDevices).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        await waitFor(() => expect(screen.queryByText('Living Room TV (grandma)')).toBeNull());
    });
});
