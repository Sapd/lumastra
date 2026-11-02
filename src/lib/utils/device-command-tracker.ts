// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Follows one device command until the device has acted on it (or it died).
 *
 * Two sources race: the `device.command_status` event and, when a `poll`
 * function is given, a GET every `intervalMs`. An admin has no GET route for
 * the command (the device is not theirs), so the admin path passes no `poll`
 * and relies on the event alone.
 */

import { onDeviceCommandStatus } from '$lib/stores/device-events';
import { isSettled } from '$lib/utils/device-remote';
import type { DeviceCommand } from '$lib/schemas/device-commands';

export interface TrackOptions {
    /** Fetch the current command (returns null when unavailable). */
    poll?: (() => Promise<DeviceCommand | null>) | undefined;
    intervalMs?: number;
    timeoutMs?: number;
    /** Called for every status seen, including the settled one. */
    onUpdate?: ((command: DeviceCommand) => void) | undefined;
    signal?: AbortSignal | undefined;
}

/**
 * Resolves with the first settled command, or with the last one seen (null if
 * none) once `timeoutMs` passes or `signal` aborts.
 */
export function trackDeviceCommand(
    initial: DeviceCommand,
    options: TrackOptions = {},
): Promise<DeviceCommand | null> {
    const { poll, intervalMs = 700, timeoutMs = 10_000, onUpdate, signal } = options;

    return new Promise((resolve) => {
        let last: DeviceCommand | null = initial;
        let done = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let deadline: ReturnType<typeof setTimeout> | null = null;
        let unsubscribe: (() => void) | null = null;

        const finish = (value: DeviceCommand | null): void => {
            if (done) return;
            done = true;
            if (timer) clearTimeout(timer);
            if (deadline) clearTimeout(deadline);
            unsubscribe?.();
            signal?.removeEventListener('abort', onAbort);
            resolve(value);
        };
        const onAbort = (): void => finish(last);

        const see = (command: DeviceCommand): void => {
            if (done || command.id !== initial.id) return;
            last = command;
            onUpdate?.(command);
            if (isSettled(command)) finish(command);
        };

        if (signal?.aborted) {
            resolve(last);
            return;
        }
        signal?.addEventListener('abort', onAbort, { once: true });

        unsubscribe = onDeviceCommandStatus((command) => see(command));
        deadline = setTimeout(() => finish(last), timeoutMs);

        if (isSettled(initial)) {
            finish(initial);
            return;
        }

        if (poll) {
            const tick = async (): Promise<void> => {
                if (done) return;
                try {
                    const next = await poll();
                    if (next) see(next);
                } catch {
                    // A failed poll is not a failed command; the next tick or the event decides.
                }
                if (!done) timer = setTimeout(() => void tick(), intervalMs);
            };
            timer = setTimeout(() => void tick(), intervalMs);
        }
    });
}
