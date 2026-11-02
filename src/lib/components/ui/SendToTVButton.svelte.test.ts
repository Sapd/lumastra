// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const getDevices = vi.fn();
vi.mock('$lib/api/user', () => ({ getDevices: (...a: unknown[]) => getDevices(...a) }));
const sendDeviceCommand = vi.fn();
const getDeviceCommand = vi.fn();
vi.mock('$lib/api/device-commands', () => ({
    sendDeviceCommand: (...a: unknown[]) => sendDeviceCommand(...a),
    getDeviceCommand: (...a: unknown[]) => getDeviceCommand(...a),
}));
vi.mock('$lib/stores/device-events', () => ({ onDeviceCommandStatus: () => () => {} }));
vi.mock('$lib/utils/popup', () => ({ popup: () => ({}) }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));

import SendToTVButton from './SendToTVButton.svelte';

const tv = (over: Record<string, unknown> = {}) => ({
    deviceSessionId: 'tv-1',
    deviceName: 'Living Room',
    isOnline: true,
    capabilities: { commands: { 'media.play': {} } },
    ...over,
});

describe('SendToTVButton', () => {
    beforeEach(() => {
        getDevices.mockReset();
        sendDeviceCommand.mockReset();
        getDeviceCommand.mockReset();
        Object.values(toasts).forEach((f) => f.mockReset());
    });
    afterEach(cleanup);

    test('offers no button without a device that announces media.play', async () => {
        getDevices.mockResolvedValue({
            data: {
                items: [
                    tv({ capabilities: { commands: { 'party.join': {} } } }),
                    tv({ deviceSessionId: 'x', capabilities: undefined }),
                ],
            },
            error: null,
        });
        render(SendToTVButton, { itemId: 'm1', title: 'Film', mediaType: 'movie' });
        await waitFor(() => expect(getDevices).toHaveBeenCalled());
        await Promise.resolve();
        expect(screen.queryByRole('button', { name: 'Send to TV' })).toBeNull();
    });

    test('sends media.play with the mapped kind and reports where it plays', async () => {
        getDevices.mockResolvedValue({ data: { items: [tv()] }, error: null });
        sendDeviceCommand.mockResolvedValue({
            data: { command: { id: 'c1', status: 'applied' } },
            error: null,
        });
        render(SendToTVButton, { itemId: 'm1', title: 'Film', mediaType: 'tv' });
        await screen.findByRole('button', { name: 'Send to TV' });
        await fireEvent.click(screen.getByRole('button', { name: /Living Room/ }));
        await waitFor(() => expect(sendDeviceCommand).toHaveBeenCalled());
        expect(sendDeviceCommand).toHaveBeenCalledWith('tv-1', {
            type: 'media.play',
            args: { kind: 'series', itemId: 'm1', mode: 'play', resume: true },
        });
        await waitFor(() => expect(toasts.success).toHaveBeenCalledWith('Playing on Living Room'));
    });

    test('names the device when it is not connected', async () => {
        getDevices.mockResolvedValue({ data: { items: [tv()] }, error: null });
        sendDeviceCommand.mockResolvedValue({
            data: null,
            error: 'x',
            details: 'device_unreachable',
        });
        render(SendToTVButton, { itemId: 'm1', title: 'Film', mediaType: 'movie' });
        await fireEvent.click(await screen.findByRole('button', { name: /Living Room/ }));
        await waitFor(() =>
            expect(toasts.error).toHaveBeenCalledWith('Living Room is not connected'),
        );
    });

    test('asks for an update when the device lacks the command', async () => {
        getDevices.mockResolvedValue({ data: { items: [tv()] }, error: null });
        sendDeviceCommand.mockResolvedValue({
            data: null,
            error: 'x',
            details: 'device_unsupported',
        });
        render(SendToTVButton, { itemId: 'm1', title: 'Film', mediaType: 'movie' });
        await fireEvent.click(await screen.findByRole('button', { name: /Living Room/ }));
        await waitFor(() =>
            expect(toasts.error).toHaveBeenCalledWith('Update Lumastra on Living Room'),
        );
    });
});
