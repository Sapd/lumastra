// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * device-presence.service.ts — is a device signed in and listening, and what
 * can it do.
 *
 * Two signals, both in Valkey and both keyed by the device session id:
 *
 *  - **Heartbeat** (`device:online:<id>`, 10 min TTL): the app is open on the
 *    device. Carries the device's name, type, announced UI features and its
 *    remote-control capabilities. Refreshed every ~2 minutes by the app.
 *  - **Event stream** (`devcmd:v1:stream:<id>`, 45 s TTL): the device holds
 *    `/api/v1/events` open right now, so a `live` command reaches it in well
 *    under a second. Refreshed by the stream's own keepalive.
 *
 * Valkey errors are not swallowed into "offline" on the write side: callers
 * check `isCoordinationValkeyReady()` and answer 503.
 */

import { Logger } from '$lib/server/utils/logger.js';
import { connectValkey, setEx, cacheGet, getCoordinationClient } from '$lib/server/cache/valkey.js';
import type { DeviceCapabilities } from '$lib/schemas/device-commands.js';

const logger = Logger.for('DevicePresence');

/** Online-presence heartbeat key for a device. */
export const DEVICE_ONLINE_KEY = (deviceSessionId: string): string =>
    `device:online:${deviceSessionId}`;

/** The device has its event stream open (live commands can reach it). */
export const DEVICE_STREAM_KEY = (deviceSessionId: string): string =>
    `devcmd:v1:stream:${deviceSessionId}`;

/** TTL in seconds for the device heartbeat (10 minutes). */
export const HEARTBEAT_TTL_SECONDS = 10 * 60;

/** TTL of the event-stream marker; the stream refreshes it every keepalive. */
export const STREAM_PRESENCE_TTL_SECONDS = 45;

export interface DeviceOnlineStatus {
    /** User ID of the device owner. */
    userId: string;
    /** Username of the device owner (display only). */
    username: string;
    deviceSessionId: string;
    deviceName: string | null;
    deviceType: 'tv' | 'mobile' | 'web' | 'unknown';
    supportsWatchTogether: boolean;
    /**
     * UI features the device announced it renders — see
     * `$lib/shared/client-features.ts`. Absent for builds that predate the
     * field, which reads as "announces nothing".
     */
    features?: string[];
    /** Remote-control capabilities (command types it carries out). */
    capabilities?: DeviceCapabilities;
    /** Unix timestamp (ms) of the last heartbeat. */
    lastSeen: number;
}

/** Store / refresh the device presence heartbeat. Throws on Valkey error. */
export async function recordHeartbeat(
    deviceSessionId: string,
    status: DeviceOnlineStatus,
): Promise<void> {
    await connectValkey();
    await setEx(DEVICE_ONLINE_KEY(deviceSessionId), HEARTBEAT_TTL_SECONDS, JSON.stringify(status));
    logger.debug('Device heartbeat recorded', {
        deviceSessionId: deviceSessionId.substring(0, 8) + '...',
        deviceType: status.deviceType,
    });
}

/** The device's last heartbeat, or null (offline, expired, Valkey down). */
export async function getHeartbeat(deviceSessionId: string): Promise<DeviceOnlineStatus | null> {
    const raw = await cacheGet(DEVICE_ONLINE_KEY(deviceSessionId));
    if (!raw) return null;
    try {
        return JSON.parse(raw) as DeviceOnlineStatus;
    } catch {
        logger.warn('Failed to parse device heartbeat', {
            deviceSessionId: deviceSessionId.substring(0, 8) + '...',
        });
        return null;
    }
}

/**
 * Heartbeats of many devices at once (the lookups run concurrently over the one
 * Valkey connection). Offline devices are absent from the map.
 */
export async function getHeartbeats(
    deviceSessionIds: readonly string[],
): Promise<Map<string, DeviceOnlineStatus>> {
    const unique = [...new Set(deviceSessionIds)];
    const found = await Promise.all(unique.map((id) => getHeartbeat(id).catch(() => null)));
    const out = new Map<string, DeviceOnlineStatus>();
    unique.forEach((id, i) => {
        const hb = found[i];
        if (hb) out.set(id, hb);
    });
    return out;
}

/**
 * The device opened (or still holds) its event stream. `streamToken` names this
 * one stream: a reconnecting device briefly has two, and the old one closing
 * must not remove the marker the new one just set. Best effort.
 */
export async function markDeviceStreamOpen(
    deviceSessionId: string,
    streamToken: string,
): Promise<void> {
    await setEx(DEVICE_STREAM_KEY(deviceSessionId), STREAM_PRESENCE_TTL_SECONDS, streamToken);
}

/** Deletes the marker only while it still belongs to `streamToken`. */
const DELETE_IF_OWNED = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

/** This stream closed. Best effort; the TTL covers a crash. */
export async function markDeviceStreamClosed(
    deviceSessionId: string,
    streamToken: string,
): Promise<void> {
    const client = getCoordinationClient();
    if (!client) return;
    await client.customCommand([
        'EVAL',
        DELETE_IF_OWNED,
        '1',
        DEVICE_STREAM_KEY(deviceSessionId),
        streamToken,
    ]);
}

/** Whether a live command can reach the device now. */
export async function isDeviceStreamOpen(deviceSessionId: string): Promise<boolean> {
    return (await cacheGet(DEVICE_STREAM_KEY(deviceSessionId))) !== null;
}
