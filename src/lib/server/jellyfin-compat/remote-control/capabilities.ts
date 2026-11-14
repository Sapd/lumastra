// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** `POST /Sessions/Capabilities[/Full]`: store what the app reported. */

import { localsIsAdmin } from '$lib/server/auth/locals-admin';
import type { RequestEvent } from '@sveltejs/kit';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getParam } from '../utils';
import { resolveControllableTarget } from './commands';
import { upsertDevice, type RemoteDeviceIdentity } from './device-registry';
import type { ReportedCapabilities } from './protocol';
import { noContent } from './route-helpers';

const logger = Logger.for('JellyfinCompat:Capabilities');

/**
 * Store `capabilities` for the caller's own device, or — with `?id=` — for a
 * session the caller may control (Jellyfin's ReportCapabilities(current, id)).
 * A PAT-authenticated call carries no device and is accepted as a no-op.
 */
export async function reportCapabilities(
    event: Pick<RequestEvent, 'locals' | 'url'>,
    capabilities: ReportedCapabilities,
): Promise<Response> {
    const { locals, url } = event;
    const caller = locals.user;
    if (!caller) return ApiResponses.unauthorized();
    const device = locals.jfDevice;

    try {
        const requested = getParam(url, 'id');
        if (requested) {
            const sql = getDb();
            if (!sql) return ApiResponses.error('Database unavailable');
            const target = await resolveControllableTarget(sql, requested, {
                userId: caller.userId,
                ownerIsAdmin: localsIsAdmin(locals),
            });
            if (!target) return ApiResponses.notFound('Session not found');
            const identity: RemoteDeviceIdentity = {
                userId: target.userId,
                username: target.username,
                displayName: target.displayName,
                deviceId: target.deviceId,
                deviceName: target.deviceName,
                client: target.client,
                clientVersion: target.clientVersion,
            };
            await upsertDevice(identity, capabilities);
            return noContent();
        }

        if (!device?.deviceId) return noContent();
        await upsertDevice(
            {
                userId: String(caller.userId),
                username: caller.username,
                displayName: null,
                deviceId: device.deviceId,
                deviceName: device.deviceName || 'Unknown',
                client: device.clientName || 'Unknown',
                clientVersion: device.clientVersion || '1.0.0',
            },
            capabilities,
        );
        return noContent();
    } catch (err) {
        // Capabilities are advisory: an outage must not fail the app's startup.
        logger.warn('Failed to store reported capabilities', { error: String(err) });
        return noContent();
    }
}
