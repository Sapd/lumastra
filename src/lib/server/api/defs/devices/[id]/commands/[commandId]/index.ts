// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/devices/[id]/commands/[commandId]/index.ts
 *   GET    /devices/{id}/commands/{commandId} — the command and its status
 *   DELETE /devices/{id}/commands/{commandId} — cancel it (not yet carried out)
 *
 * Owner of the device or a helper the owner granted control (household grant);
 * any session of the same user may ask (one trust principal). The device itself may read its own commands too.
 * A helper reads and cancels only the commands they sent themselves.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { DeviceCommandSchema } from '$lib/schemas/device-commands.js';
import {
    cancelDeviceCommand,
    getDeviceCommand,
    type CommandViewer,
} from '$lib/server/services/device-commands.service.js';
import {
    deviceCommandProblem,
    isCallingDevice,
    unknownDevice,
    verifyDeviceControlAccess,
} from '../../../device-access.js';
import type { RequestEvent } from '@sveltejs/kit';

const ParamsSchema = z.object({
    id: z.string().min(1).max(128),
    commandId: z.string().regex(/^cmd_[0-9a-f-]{36}$/),
});

/**
 * Who may ask: the device itself and its owner see every command; a granted
 * helper only the ones they sent (a foreign command answers like an unknown one).
 */
async function gate(event: RequestEvent): Promise<Response | CommandViewer> {
    const id = event.params.id!;
    if (isCallingDevice(event, id)) return {};
    const userId = String(event.locals.user!.userId);
    const owned = await verifyDeviceControlAccess(id, userId);
    if (owned instanceof Response) return owned;
    if (!owned) return unknownDevice();
    return owned.viaGrant ? { onlySenderUserId: userId } : {};
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Devices'],
            summary: 'A command sent to a device',
            stability: 'beta',
            auth: 'bearer',
            description:
                'The command with its status: `pending`, `delivered` (the device has it), ' +
                '`applied`, `rejected` (with `reason`), `expired`, `superseded`, `cancelled`, ' +
                '`acknowledged` (a message button was pressed: `actionId`). Kept 5 minutes after ' +
                'it ends.',
            responses: {
                200: { schema: DeviceCommandSchema, description: 'The command' },
                401: 'Authentication required',
                404: 'Unknown device or command (a helper: also one sent by someone else)',
                503: 'Cache service unavailable',
            },
        },
        DELETE: {
            tags: ['Devices'],
            summary: 'Cancel a command',
            stability: 'beta',
            auth: 'bearer',
            description:
                'Cancels a command the device has not carried out yet, e.g. a scheduled ' +
                '`playback.stop` (sleep timer). The device gets `device.command_cancelled`.',
            responses: {
                200: { schema: DeviceCommandSchema, description: 'Cancelled' },
                401: 'Authentication required',
                404: 'Unknown device or command',
                409: 'Already carried out or finished',
                503: 'Cache service unavailable',
            },
        },
    },
    auth: { kind: 'feature', flag: 'DEVICE_AUTH', then: { kind: 'user' } },
    request: { params: ParamsSchema },
    handlers: {
        GET: async (event, ctx) => {
            const viewer = await gate(event);
            if (viewer instanceof Response) return viewer;
            const { id, commandId } = ctx.input!.params;
            const result = await getDeviceCommand(id, commandId, viewer);
            if (!result.ok) return deviceCommandProblem(result.error);
            return json(result.value, { headers: { 'Cache-Control': 'no-store' } });
        },
        DELETE: async (event, ctx) => {
            const viewer = await gate(event);
            if (viewer instanceof Response) return viewer;
            const { id, commandId } = ctx.input!.params;
            const result = await cancelDeviceCommand(id, commandId, viewer);
            if (!result.ok) return deviceCommandProblem(result.error);
            return json(result.value);
        },
    },
});
