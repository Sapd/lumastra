// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/devices/[id]/state.ts
 *   GET /devices/{id}/state — a device and what it plays now (owner or granted helper)
 *   PUT /devices/{id}/state — the device reports its own state (device itself)
 *
 * The device PUTs on every change and every ~10 s while playing; the report
 * lives 90 s and every one goes to the owner's account as a `device.state`
 * event. A device that does not report gets a server projection (`reported:
 * false`): the Live TV channel or the play session it runs, without titles.
 */

import { userAllowsLiveTv } from '$lib/server/auth/livetv-user-policy.js';
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { connectValkey, isCoordinationValkeyReady } from '$lib/server/cache/valkey.js';
import { DeviceStateReportSchema, DeviceStateSchema } from '$lib/schemas/device-commands.js';
import {
    buildDeviceState,
    reportDeviceState,
} from '$lib/server/services/device-commands.service.js';
import { toUserId } from '$lib/shared/user-id.js';
import { externalProviderFor } from '$lib/server/services/external-remote-targets.js';
import { projectNowPlaying } from '$lib/server/services/device-state-projection.js';
import {
    deviceCommandProblem,
    isCallingDevice,
    unknownDevice,
    verifyDeviceControlAccess,
} from '../device-access.js';

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Devices'],
            summary: 'What a device plays now',
            stability: 'beta',
            auth: 'bearer',
            description:
                'The device, whether it is online and `reachable` (live commands work), its ' +
                '`capabilities` and `nowPlaying`: one shared part for every kind (title, position, ' +
                'paused, rate) and one block per `kind` (video tracks and segments, Live TV channel, ' +
                'music queue, audiobook chapters). `positionSeconds` is a sample taken at ' +
                '`observedAt`; extrapolate while playing. `availableCommands` lists what works ' +
                'right now. Subscribe to `device.state` events for changes; ignore any with a ' +
                'lower `revision` than the last one you saw.',
            responses: {
                200: { schema: DeviceStateSchema, description: 'Device state' },
                401: 'Authentication required',
                404: 'Device not found',
                503: 'Cache service unavailable',
            },
        },
        PUT: {
            tags: ['Devices'],
            summary: 'Report the device state',
            stability: 'beta',
            auth: 'bearer',
            description:
                'For the device itself: the full state (not a patch) on every change and every ' +
                '~10 s while playing. `nowPlaying: null` = idle. Unknown keys inside the per-kind ' +
                'blocks are kept for newer remotes.',
            body: DeviceStateReportSchema,
            responses: {
                204: 'Recorded',
                401: 'Authentication required',
                403: 'Not the calling device',
                413: 'Report larger than 64 KB',
                422: 'Validation failed',
                429: 'More than 30 reports in 10 s',
                503: 'Cache service unavailable',
            },
        },
    },
    auth: { kind: 'feature', flag: 'DEVICE_AUTH', then: { kind: 'user' } },
    request: {
        params: z.object({ id: z.string().min(1).max(128) }),
        body: DeviceStateReportSchema,
        maxBodyBytes: 64 * 1024,
    },
    handlers: {
        GET: async (event, ctx) => {
            const { id } = ctx.input!.params;
            const user = event.locals.user!;
            const external = externalProviderFor(id);
            if (external) {
                const externalState = await external.state(id, {
                    userId: String(user.userId),
                    username: user.username,
                });
                if (!externalState) return unknownDevice();
                return json(externalState, { headers: { 'Cache-Control': 'no-store' } });
            }
            const self = isCallingDevice(event, id);
            const owned = self
                ? {
                      deviceName: null,
                      ownerUserId: String(user.userId),
                      ownerUsername: user.username,
                  }
                : await verifyDeviceControlAccess(id, String(user.userId));
            if (owned instanceof Response) return owned;
            if (!owned) return unknownDevice();
            await connectValkey();
            if (!isCoordinationValkeyReady())
                return ApiProblem.dependencyUnavailable('Cache service unavailable');
            const sql = getDb();
            const state = await buildDeviceState(id, {
                deviceName: owned.deviceName,
                ...(sql
                    ? {
                          fallback: {
                              project: () =>
                                  projectNowPlaying(
                                      sql,
                                      {
                                          userId: toUserId(owned.ownerUserId),
                                          username: owned.ownerUsername,
                                      },
                                      id,
                                  ),
                          },
                      }
                    : {}),
            });
            if (
                state.nowPlaying?.kind === 'livetv' &&
                !(await userAllowsLiveTv(owned.ownerUsername))
            )
                state.nowPlaying = null;
            return json(state, { headers: { 'Cache-Control': 'no-store' } });
        },
        PUT: async (event, ctx) => {
            const { id } = ctx.input!.params;
            if (!isCallingDevice(event, id)) {
                return ApiProblem.forbidden('Only the device itself reports its state');
            }
            await connectValkey();
            if (!isCoordinationValkeyReady())
                return ApiProblem.dependencyUnavailable('Cache service unavailable');
            const result = await reportDeviceState(
                String(event.locals.user!.userId),
                id,
                ctx.input!.body,
            );
            if (!result.ok) return deviceCommandProblem(result.error);
            return new Response(null, { status: 204 });
        },
    },
});
