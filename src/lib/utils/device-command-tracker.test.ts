// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceCommand } from '$lib/schemas/device-commands';

let statusListener: ((command: DeviceCommand) => void) | null = null;
const unsubscribe = vi.fn();
vi.mock('$lib/stores/device-events', () => ({
    onDeviceCommandStatus: (cb: (command: DeviceCommand) => void) => {
        statusListener = cb;
        return unsubscribe;
    },
}));

import { trackDeviceCommand } from './device-command-tracker';

function command(status: DeviceCommand['status'], id = 'cmd_1'): DeviceCommand {
    return { id, status } as DeviceCommand;
}

describe('trackDeviceCommand', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        statusListener = null;
        unsubscribe.mockClear();
    });
    afterEach(() => vi.useRealTimers());

    it('settles on the status event and ignores other commands', async () => {
        const updates: string[] = [];
        const done = trackDeviceCommand(command('pending'), {
            onUpdate: (c) => updates.push(c.status),
        });
        statusListener?.(command('applied', 'other'));
        statusListener?.(command('delivered'));
        statusListener?.(command('applied'));
        expect((await done)?.status).toBe('applied');
        expect(updates).toEqual(['delivered', 'applied']);
        expect(unsubscribe).toHaveBeenCalled();
    });

    it('polls until the command settles', async () => {
        const poll = vi
            .fn<() => Promise<DeviceCommand | null>>()
            .mockResolvedValueOnce(command('delivered'))
            .mockResolvedValueOnce(command('rejected'));
        const done = trackDeviceCommand(command('pending'), { poll, intervalMs: 700 });
        await vi.advanceTimersByTimeAsync(2000);
        expect((await done)?.status).toBe('rejected');
        expect(poll).toHaveBeenCalledTimes(2);
    });

    it('gives up at the timeout with the last status seen', async () => {
        const done = trackDeviceCommand(command('pending'), {
            poll: async () => command('delivered'),
            timeoutMs: 3000,
        });
        await vi.advanceTimersByTimeAsync(3500);
        expect((await done)?.status).toBe('delivered');
    });

    it('stops when aborted', async () => {
        const controller = new AbortController();
        const done = trackDeviceCommand(command('pending'), { signal: controller.signal });
        controller.abort();
        expect((await done)?.status).toBe('pending');
        expect(unsubscribe).toHaveBeenCalled();
    });

    it('resolves at once for an already settled command', async () => {
        expect((await trackDeviceCommand(command('applied')))?.status).toBe('applied');
    });
});
