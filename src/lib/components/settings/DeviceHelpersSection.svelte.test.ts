// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const listDeviceGrants = vi.fn();
const addDeviceGrant = vi.fn();
const removeDeviceGrant = vi.fn();
vi.mock('$lib/api/device-commands', () => ({
    listDeviceGrants: () => listDeviceGrants(),
    addDeviceGrant: (name: string) => addDeviceGrant(name),
    removeDeviceGrant: (name: string) => removeDeviceGrant(name),
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { success: vi.fn(), error: vi.fn() } }));

import DeviceHelpersSection from './DeviceHelpersSection.svelte';

const bob = { username: 'Bob', createdAt: '2026-10-16T10:00:00.000Z' };

describe('DeviceHelpersSection', () => {
    beforeEach(() => {
        listDeviceGrants.mockResolvedValue({ data: { items: [bob] }, error: null, status: 200 });
    });
    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    test('lists the helpers and shows an empty note when there are none', async () => {
        render(DeviceHelpersSection);
        expect(await screen.findByText('Bob')).toBeTruthy();
        cleanup();
        listDeviceGrants.mockResolvedValue({ data: { items: [] }, error: null, status: 200 });
        render(DeviceHelpersSection);
        expect(await screen.findByText('Nobody can control your devices yet.')).toBeTruthy();
    });

    test('adds a helper by username', async () => {
        listDeviceGrants.mockResolvedValue({ data: { items: [] }, error: null, status: 200 });
        addDeviceGrant.mockResolvedValue({ data: bob, error: null, status: 201 });
        render(DeviceHelpersSection);
        await screen.findByText('Nobody can control your devices yet.');
        const input = screen.getByLabelText('Username') as HTMLInputElement;
        const add = screen.getByRole('button', { name: 'Allow' }) as HTMLButtonElement;
        expect(add.disabled).toBe(true);
        await fireEvent.input(input, { target: { value: ' bob ' } });
        await fireEvent.click(add);
        await waitFor(() => expect(addDeviceGrant).toHaveBeenCalledWith('bob'));
        expect(await screen.findByText('Bob')).toBeTruthy();
        expect(input.value).toBe('');
    });

    test('shows why an add failed', async () => {
        listDeviceGrants.mockResolvedValue({ data: { items: [] }, error: null, status: 200 });
        addDeviceGrant.mockResolvedValue({ data: null, error: 'nope', status: 404 });
        render(DeviceHelpersSection);
        await screen.findByText('Nobody can control your devices yet.');
        await fireEvent.input(screen.getByLabelText('Username'), { target: { value: 'zed' } });
        await fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
        expect(await screen.findByText('No user with that name.')).toBeTruthy();
    });

    test('says so when the limit is reached (422 with 20 helpers) or when changes come too fast (429)', async () => {
        const many = Array.from({ length: 20 }, (_, i) => ({
            username: `Helper${i}`,
            createdAt: '2026-10-16T10:00:00.000Z',
        }));
        listDeviceGrants.mockResolvedValue({ data: { items: many }, error: null, status: 200 });
        addDeviceGrant.mockResolvedValue({ data: null, error: 'full', status: 422 });
        render(DeviceHelpersSection);
        await screen.findByText('Helper0');
        await fireEvent.input(screen.getByLabelText('Username'), { target: { value: 'zed' } });
        await fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
        expect(await screen.findByText('You can allow at most 20 people.')).toBeTruthy();

        addDeviceGrant.mockResolvedValue({ data: null, error: 'slow down', status: 429 });
        await fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
        expect(await screen.findByText('Too many changes. Try again in a minute.')).toBeTruthy();
    });

    test('removing needs an inline confirm', async () => {
        removeDeviceGrant.mockResolvedValue({ data: null, error: null, status: 204 });
        render(DeviceHelpersSection);
        await screen.findByText('Bob');
        await fireEvent.click(
            screen.getByRole('button', { name: /Stop allowing Bob to control your devices/ }),
        );
        expect(removeDeviceGrant).not.toHaveBeenCalled();
        await fireEvent.click(screen.getByRole('button', { name: /Confirm/ }));
        await waitFor(() => expect(removeDeviceGrant).toHaveBeenCalledWith('Bob'));
        await waitFor(() => expect(screen.queryByText('Bob')).toBeNull());
    });
});
