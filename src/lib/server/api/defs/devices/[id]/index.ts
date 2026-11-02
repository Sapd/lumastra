// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/devices/[id]/index.ts — PATCH /devices/{id}
 *
 * Sets the user's own name for a device, overriding whatever the client reports.
 *
 * This is the writer for `user_devices.custom_name`. Display name resolves as
 * COALESCE(custom_name, reported_name), so an override survives every subsequent
 * client report — the heartbeat fires every few minutes and must never win over a
 * name the user chose. Sending `null` clears the override and falls back to the
 * reported name, which is the undo.
 *
 * `{id}` is the deviceSessionId, matching how every other device route addresses a
 * device. The underlying registry is keyed on the client-generated device_id, so
 * the session is resolved to its device first; sessions with no device_id (issued
 * without one) cannot be renamed and return 409 rather than silently doing nothing.
 *
 * Auth: feature:DEVICE_AUTH → user. Scoped to the caller's own devices.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { def as revoke } from '../revoke.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getDeviceIdForSession,
    sessionBelongsToUser,
    setUserDeviceCustomName,
} from '$lib/server/database/queries/user-devices.queries.js';
import { normalizeDeviceName } from '$lib/server/services/user-devices.service.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('DeviceRenameDef');

const RenameBodySchema = z.object({
    /** New display name; `null` clears the override and falls back to the client's. */
    deviceName: z.string().max(256).nullable(),
});

const RenameResponseSchema = z.object({
    deviceSessionId: z.string(),
    deviceId: z.string(),
    /** Resolved display name after the write. */
    deviceName: z.string().nullable(),
    isCustomName: z.boolean(),
});

export const def = defineEndpoint({
    docs: {
        DELETE: revoke.docs!.DELETE,
        PATCH: {
            tags: ['Devices'],
            summary: 'Rename a device',
            stability: 'stable',
            auth: 'bearer',
            description:
                "Sets the caller's own name for one of their devices, overriding the name the " +
                'client reports. The override wins over every subsequent client report. Send ' +
                '`deviceName: null` to clear it and fall back to the reported name. ' +
                'Requires `FEATURE_DEVICE_AUTH`.',
            body: RenameBodySchema,
            responses: {
                200: { schema: RenameResponseSchema, description: 'Device renamed' },
                400: 'Invalid body',
                401: 'Authentication required',
                404: 'Feature not enabled, or device not found for this user',
                409: 'Session has no device to rename',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        kind: 'feature',
        flag: 'DEVICE_AUTH',
        then: { kind: 'user' },
    },
    request: {
        params: z.object({ id: z.string().min(1) }),
        body: RenameBodySchema.partial(),
        bodyMethods: ['PATCH'],
    },
    handlers: {
        DELETE: (event, ctx) => revoke.handlers.DELETE!(event, ctx as never),
        PATCH: async (event, ctx) => {
            const { locals, params } = event;
            const deviceSessionId = params.id;
            if (!deviceSessionId) {
                return ApiProblem.validationFailed([
                    { field: 'id', message: 'Device session id is required' },
                ]);
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not initialised');

            const userId = locals.user!.userId;

            // Both lookups are user-scoped, so neither can be pointed at another
            // user's session, and this behaves the same with or without Jellyfin.
            const deviceId = await getDeviceIdForSession(sql, userId, deviceSessionId);
            if (!deviceId) {
                // Distinguish "not yours / revoked" from "yours but unlinked" — the
                // second re-checks rather than assuming, because a sign-out from
                // another tab between the two reads would otherwise be reported as
                // "this device is not linked", which is misleading.
                const owned = await sessionBelongsToUser(sql, userId, deviceSessionId);
                // 404 rather than 403 — do not confirm that someone else's session exists.
                if (!owned) return ApiProblem.notFound('Device session not found');
                return ApiProblem.conflict(
                    'This session is not linked to a device and cannot be renamed. ' +
                        'Sign in again from the device to link it.',
                );
            }

            const parsed = RenameBodySchema.safeParse(ctx.input?.body);
            if (!parsed.success) return ApiProblem.validationFailed('deviceName is required');
            const body = parsed.data;
            // null clears the override; a name that normalises away is treated as a
            // clear too, so a user cannot pin an invisible name onto a device.
            const customName =
                body.deviceName === null ? null : normalizeDeviceName(body.deviceName);

            const row = await setUserDeviceCustomName(sql, userId, deviceId, customName);
            if (!row) {
                return ApiProblem.notFound('Device not found');
            }

            logger.info('Device renamed', {
                username: locals.user!.username,
                deviceSessionId: deviceSessionId.substring(0, 8) + '...',
                cleared: customName === null,
            });

            return json(
                RenameResponseSchema.parse({
                    deviceSessionId,
                    deviceId,
                    deviceName: row.custom_name ?? row.reported_name,
                    isCustomName: row.custom_name !== null,
                }),
            );
        },
    },
});
