// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/devices/controllable.ts — GET /devices/controllable
 *
 * The devices of other users who granted me remote control (household
 * grant): the rows of `GET /devices`, plus `ownerUsername`.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { DeviceCapabilitiesSchema } from '$lib/schemas/device-commands.js';
import { getDb } from '$lib/server/database/connection.js';
import { listControllableDevices } from '$lib/server/database/queries/device-control-grants.queries.js';
import { getHeartbeats } from '$lib/server/services/device-presence.service.js';
import { sanitizeDisplayName } from '$lib/server/utils/display-name.js';

/** Only what a helper needs to pick a device and open its remote. */
const ControllableDeviceSchema = z.object({
    deviceSessionId: z.string(),
    deviceName: z.string().nullable(),
    deviceType: z.enum(['tv', 'mobile', 'web', 'unknown']).optional(),
    isOnline: z.boolean(),
    lastHeartbeat: z.string().optional().meta({ description: 'ISO-8601 last heartbeat timestamp' }),
    capabilities: DeviceCapabilitiesSchema.optional(),
    ownerUsername: z.string().meta({ description: 'The user who granted you control' }),
});

const ControllableResponseSchema = z.object({ items: z.array(ControllableDeviceSchema) });

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Devices'],
            summary: 'Devices I may control for others',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Devices of users who granted you remote control: name, type, whether it is ' +
                'online, its `capabilities` and `ownerUsername` (online first, then by name). ' +
                'Send commands with `POST /devices/{id}/commands`.',
            responses: {
                200: { schema: ControllableResponseSchema, description: 'Controllable devices' },
                401: 'Authentication required',
                503: 'Database unavailable',
            },
        },
    },
    auth: { kind: 'feature', flag: 'DEVICE_AUTH', then: { kind: 'user' } },
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not initialised');
            const rows = await listControllableDevices.all(sql, {
                granteeUserId: String(event.locals.user!.userId),
            });
            const heartbeats = await getHeartbeats(rows.map((r) => r.device_session_id));
            const items = rows
                .map((r) => {
                    const hb = heartbeats.get(r.device_session_id);
                    const name = r.device_name
                        ? sanitizeDisplayName(r.device_name, 64) || null
                        : null;
                    return {
                        deviceSessionId: r.device_session_id,
                        deviceName: name,
                        ...(hb?.deviceType && hb.deviceType !== 'unknown'
                            ? { deviceType: hb.deviceType }
                            : {}),
                        isOnline: Boolean(hb),
                        ...(hb ? { lastHeartbeat: new Date(hb.lastSeen).toISOString() } : {}),
                        ...(hb?.capabilities ? { capabilities: hb.capabilities } : {}),
                        ownerUsername: r.owner_username,
                    };
                })
                .sort(
                    (a, b) =>
                        Number(b.isOnline) - Number(a.isOnline) ||
                        (a.deviceName ?? '').localeCompare(b.deviceName ?? ''),
                );
            return json({ items }, { headers: { 'Cache-Control': 'no-store' } });
        },
    },
});
