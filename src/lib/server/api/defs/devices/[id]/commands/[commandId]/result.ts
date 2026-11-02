// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/devices/[id]/commands/[commandId]/result.ts
 *   POST /devices/{id}/commands/{commandId}/result — the device reports what it
 *   did: `delivered` (received), `applied`, `rejected` (+ `reason`) or, for a
 *   message with buttons, `acknowledged` (+ `actionId`).
 *
 * Only the target device itself (`{id}` = its JWT device session).
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { DeviceCommandResultSchema, DeviceCommandSchema } from '$lib/schemas/device-commands.js';
import { reportDeviceCommandResult } from '$lib/server/services/device-commands.service.js';
import { deviceCommandProblem, isCallingDevice } from '../../../device-access.js';

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Devices'],
            summary: 'Report what the device did with a command',
            stability: 'beta',
            auth: 'bearer',
            description:
                'For the target device only. Order: `delivered` → `applied` | `rejected`; ' +
                '`applied` → `acknowledged` for `ui.message` with buttons. Repeating the current ' +
                'status is a no-op. An `applied` after the command expired is recorded as ' +
                '`expired`. The sender gets every change as a `device.command_status` event.',
            body: DeviceCommandResultSchema,
            responses: {
                200: { schema: DeviceCommandSchema, description: 'The updated command' },
                401: 'Authentication required',
                403: 'Not the target device',
                404: 'Unknown command',
                409: 'Not allowed from the current status',
                422: 'Validation failed',
                503: 'Cache service unavailable',
            },
        },
    },
    auth: { kind: 'feature', flag: 'DEVICE_AUTH', then: { kind: 'user' } },
    request: {
        params: z.object({
            id: z.string().min(1).max(128),
            commandId: z.string().regex(/^cmd_[0-9a-f-]{36}$/),
        }),
        body: DeviceCommandResultSchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const { id, commandId } = ctx.input!.params;
            if (!isCallingDevice(event, id)) {
                return ApiProblem.forbidden('Only the target device reports results');
            }
            const result = await reportDeviceCommandResult(id, commandId, ctx.input!.body);
            if (!result.ok) return deviceCommandProblem(result.error);
            return json(result.value);
        },
    },
});
