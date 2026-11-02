// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DeviceCommand, DeviceState } from '$lib/schemas/device-commands';

const getDeviceState = vi.fn();
const sendDeviceCommand = vi.fn();
const getDeviceCommand = vi.fn();
vi.mock('$lib/api/device-commands', () => ({
    getDeviceState: (...a: unknown[]) => getDeviceState(...a),
    sendDeviceCommand: (...a: unknown[]) => sendDeviceCommand(...a),
    getDeviceCommand: (...a: unknown[]) => getDeviceCommand(...a),
}));

let stateListener: ((s: DeviceState) => void) | null = null;
vi.mock('$lib/stores/device-events', () => ({
    onDeviceState: (cb: (s: DeviceState) => void) => {
        stateListener = cb;
        return () => (stateListener = null);
    },
    onDeviceCommandStatus: () => () => {},
}));

import DeviceRemote from './DeviceRemote.svelte';

function deviceState(overrides: Partial<DeviceState> = {}): DeviceState {
    return {
        deviceSessionId: 'tv-1',
        deviceName: 'Living Room',
        deviceType: 'tv',
        online: true,
        reachable: true,
        lastSeen: null,
        revision: 5,
        capabilities: { commands: { 'ui.message': { maxLength: 280 }, 'playback.stop': {} } },
        nowPlaying: null,
        ...overrides,
    } as DeviceState;
}

function playing(
    kind: 'video' | 'livetv' | 'audiobook',
    availableCommands: string[],
    extra: Record<string, unknown> = {},
): DeviceState {
    return deviceState({
        nowPlaying: {
            kind,
            sessionId: 'sess-1',
            title: 'Some Title',
            paused: false,
            rate: 1,
            positionSeconds: 60,
            durationMs: 600_000,
            observedAt: new Date().toISOString(),
            availableCommands,
            ...extra,
        },
    } as Partial<DeviceState>);
}

const applied = {
    data: { command: { id: 'c1', status: 'applied' } as DeviceCommand },
    error: null,
};

function renderRemote() {
    return render(DeviceRemote, {
        deviceSessionId: 'tv-1',
        deviceName: 'Living Room',
        onClose: vi.fn(),
    });
}

describe('DeviceRemote', () => {
    beforeEach(() => {
        getDeviceState.mockReset();
        sendDeviceCommand.mockReset().mockResolvedValue(applied);
        getDeviceCommand.mockReset();
        stateListener = null;
    });
    afterEach(cleanup);

    test('an idle device offers only the message box', async () => {
        getDeviceState.mockResolvedValue({ data: deviceState(), error: null });
        renderRemote();
        await screen.findByText('Nothing is playing.');
        expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
        expect(screen.getByPlaceholderText('A short message…')).toBeTruthy();
    });

    test('shows only the controls the device lists as available', async () => {
        getDeviceState.mockResolvedValue({
            data: playing('video', ['playback.togglePause', 'playback.seekBy', 'playback.next']),
            error: null,
        });
        renderRemote();
        await screen.findByText('Some Title');
        expect(screen.getByRole('button', { name: 'Pause' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Back 10 seconds' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Next episode' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Previous episode' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    });

    test('sends togglePause pinned to the playing session', async () => {
        getDeviceState.mockResolvedValue({
            data: playing('video', ['playback.togglePause']),
            error: null,
        });
        renderRemote();
        await fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
        await waitFor(() => expect(sendDeviceCommand).toHaveBeenCalled());
        expect(sendDeviceCommand).toHaveBeenCalledWith('tv-1', {
            type: 'playback.togglePause',
            expect: { sessionId: 'sess-1' },
        });
    });

    test('audiobooks seek by 30 seconds, live TV has channel buttons and no seek', async () => {
        getDeviceState.mockResolvedValue({
            data: playing('audiobook', ['playback.seekBy']),
            error: null,
        });
        const first = renderRemote();
        await fireEvent.click(await screen.findByRole('button', { name: 'Forward 30 seconds' }));
        await waitFor(() => expect(sendDeviceCommand).toHaveBeenCalled());
        expect(sendDeviceCommand.mock.calls[0]?.[1]).toMatchObject({
            type: 'playback.seekBy',
            args: { seconds: 30 },
        });
        first.unmount();

        getDeviceState.mockResolvedValue({
            data: playing('livetv', ['playback.seekBy', 'livetv.channelUp', 'livetv.channelDown'], {
                livetv: { stationId: 'c', feedId: 'feed-c', number: 7, name: 'News' },
            }),
            error: null,
        });
        renderRemote();
        expect(await screen.findByText(/Channel 7/)).toBeTruthy();
        expect(screen.queryByRole('button', { name: /seconds/ })).toBeNull();
        await fireEvent.click(screen.getByRole('button', { name: /Next channel/ }));
        await waitFor(() => expect(sendDeviceCommand).toHaveBeenCalledTimes(2));
    });

    test('ignores a lower revision from the event stream', async () => {
        getDeviceState.mockResolvedValue({
            data: playing('video', ['playback.togglePause']),
            error: null,
        });
        renderRemote();
        await screen.findByText('Some Title');
        stateListener?.(deviceState({ revision: 4, nowPlaying: null }));
        await Promise.resolve();
        expect(screen.getByText('Some Title')).toBeTruthy();
        stateListener?.(deviceState({ revision: 6, nowPlaying: null }));
        await screen.findByText('Nothing is playing.');
    });

    test('shows a calm message when the device is unreachable', async () => {
        sendDeviceCommand.mockResolvedValue({
            data: null,
            error: 'conflict',
            details: 'device_unreachable',
        });
        getDeviceState.mockResolvedValue({
            data: playing('video', ['playback.togglePause']),
            error: null,
        });
        renderRemote();
        await fireEvent.click(await screen.findByRole('button', { name: 'Pause' }));
        expect(await screen.findByText('Living Room is not connected')).toBeTruthy();
    });

    test('sends a message and clears the box', async () => {
        getDeviceState.mockResolvedValue({ data: deviceState(), error: null });
        renderRemote();
        const box = (await screen.findByPlaceholderText('A short message…')) as HTMLInputElement;
        expect(box.maxLength).toBe(280);
        await fireEvent.input(box, { target: { value: 'Dinner is ready' } });
        await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await waitFor(() => expect(sendDeviceCommand).toHaveBeenCalled());
        expect(sendDeviceCommand).toHaveBeenCalledWith('tv-1', {
            type: 'ui.message',
            args: { text: 'Dinner is ready' },
        });
        await screen.findByText('Message sent');
        expect(box.value).toBe('');
    });
});
