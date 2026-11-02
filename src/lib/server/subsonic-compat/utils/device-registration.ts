// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Device registration for the Subsonic compat surface.
 *
 * The Subsonic handlers create play sessions by calling `upsertExternalSession`
 * (a query module) directly rather than going through `startPlaySession`, so they
 * do not inherit the device registration that lives in the service tier. Without
 * this, no Subsonic client ever gets a `user_devices` row and every one of them
 * renders as "Unknown" in the admin playback-health view.
 *
 * The device id is also constructed here rather than at each call site — the
 * `${source}-${userId}` shape was previously repeated in four places, where a
 * single divergence would silently split one device into two.
 *
 * @module subsonic-compat/utils/device-registration
 */

import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id';
import { reportDeviceName } from '$lib/server/services/user-devices.service.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('SubsonicDeviceRegistration');

/**
 * The synthetic device id a Subsonic session is attributed to.
 *
 * Per-user, not per-device: the Subsonic protocol carries no stable device
 * identifier — only a client name (`c=`) — so all of a user's Subsonic clients
 * necessarily collapse into one device row. Keep this in sync with the
 * `device_id` written by `upsertExternalSession` at the call sites.
 *
 * This limitation is Subsonic's alone; do not generalise it to the other compat
 * surface. `/j` carries a real `DeviceId` in X-Emby-Authorization and does
 * resolve per-device — see `jellyfinCompatDeviceId()`.
 */
export function subsonicDeviceId(userId: string, source = 'subsonic'): string {
    return `${source}-${userId}`;
}

/**
 * Register (or refresh) the device behind a Subsonic session.
 *
 * Best-effort: caught here, because these handlers hold no transaction. The
 * playback paths deliberately let it propagate — see reportDeviceName().
 *
 * No name is reported: Subsonic sends a client name (`c=` parameter), not a
 * device name, and putting "DSub" in the device-name column would be the exact
 * category error this refactor removed. The client name goes to `client_id`.
 */
export async function registerSubsonicDevice(
    sql: postgres.Sql,
    userId: string,
    clientName: string | null | undefined,
    source = 'subsonic',
): Promise<void> {
    try {
        await reportDeviceName(sql, {
            userId: toUserId(userId),
            deviceId: subsonicDeviceId(userId, source),
            name: null,
            clientId: clientName || 'Subsonic',
            source: 'play-session',
        });
    } catch (error) {
        // These handlers hold no transaction, so swallowing is safe here — unlike
        // the playback paths, where it would hide an aborted transaction.
        logger.warn('Subsonic device registration failed', { error: String(error) });
    }
}
