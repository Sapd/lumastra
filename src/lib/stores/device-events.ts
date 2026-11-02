// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * device-events.ts — typed subscriptions to the two remote-control kinds on
 * the per-user event stream (`user-events.ts` owns the one EventSource):
 *
 *   - `device.command_status`: a `DeviceCommand` whenever one of the account's
 *     commands changes status.
 *   - `device.state`: a `DeviceState` whenever a device reports.
 *
 * Both are signals: a missed frame is recovered by `GET .../commands/{id}` or
 * `GET .../state`, so callers keep a poll or an initial fetch alongside.
 */

import { userEvents, type UserEventFrame } from '$lib/stores/user-events';
import { framePayload } from '$lib/utils/device-remote';
import type { DeviceCommand, DeviceState } from '$lib/schemas/device-commands';

export const DEVICE_COMMAND_STATUS_KIND = 'device.command_status';
export const DEVICE_STATE_KIND = 'device.state';

function subscribeTyped<T>(
    kind: string,
    isValid: (payload: Record<string, unknown>) => boolean,
    callback: (value: T, frame: UserEventFrame) => void,
): () => void {
    return userEvents.subscribe(kind, (frame) => {
        const payload = framePayload(frame.data);
        if (payload && isValid(payload)) callback(payload as unknown as T, frame);
    });
}

/** Called for every command status change of the account. Returns an unsubscribe. */
export function onDeviceCommandStatus(
    callback: (command: DeviceCommand, frame: UserEventFrame) => void,
): () => void {
    return subscribeTyped<DeviceCommand>(
        DEVICE_COMMAND_STATUS_KIND,
        (p) => typeof p.id === 'string' && typeof p.status === 'string',
        callback,
    );
}

/** Called for every device state report of the account. Returns an unsubscribe. */
export function onDeviceState(
    callback: (state: DeviceState, frame: UserEventFrame) => void,
): () => void {
    return subscribeTyped<DeviceState>(
        DEVICE_STATE_KIND,
        (p) => typeof p.deviceSessionId === 'string' && typeof p.revision === 'number',
        callback,
    );
}
