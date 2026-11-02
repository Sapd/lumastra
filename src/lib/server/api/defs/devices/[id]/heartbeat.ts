// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/devices/[id]/heartbeat.ts — POST /devices/{id}/heartbeat
 *
 * POST /devices/{id}/heartbeat
 *   Devices call this periodically (≤ every 10 min) to mark themselves as
 *   online and available for Watch Together.  The presence state lives in
 *   Valkey with a 10-minute TTL and auto-expires when the device stops reporting.
 *
 *   Self-device guard: `{id}` MUST equal `locals.deviceSessionId` (the session ID
 *   embedded in the caller's JWT).  A device cannot heartbeat on behalf of another.
 *   PAT / svc_ tokens lack `deviceSessionId` and therefore cannot call this endpoint.
 *
 * Auth: feature:DEVICE_AUTH → user  (+ self-device guard in handler)
 *
 * The name `devices/{id}/heartbeat` is unambiguous alongside:
 *   - `play-sessions/{id}/beacon`  (progress / position)
 *   - `music/sessions/{id}/beacon` (music position)
 *   - `livetv/channels/{id}/keepalive` (proxy lease)
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { connectValkey, isCoordinationValkeyReady } from '$lib/server/cache/valkey.js';
import { getDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getDeviceIdForSession } from '$lib/server/database/queries/user-devices.queries.js';
import { reportDeviceName } from '$lib/server/services/user-devices.service.js';
import {
    recordHeartbeat,
    HEARTBEAT_TTL_SECONDS,
    type DeviceOnlineStatus,
} from '$lib/server/services/device-presence.service.js';
import { DeviceCapabilitiesSchema, type DeviceCapabilities } from '$lib/schemas/device-commands.js';
import { rememberCapabilities } from '$lib/server/services/device-commands.service.js';
import { sanitizeDisplayName } from '$lib/server/utils/display-name.js';
import {
    announcesFeature,
    normalizeClientFeatures,
    CLIENT_FEATURE_WATCH_TOGETHER,
} from '$lib/shared/client-features.js';

const logger = Logger.for('DeviceHeartbeat');

const HeartbeatBodySchemaFromDocs = z.object({
    deviceName: z
        .string()
        .max(128)
        .transform((v) => sanitizeDisplayName(v))
        .optional(),
    deviceType: z.enum(['tv', 'mobile', 'web']).optional(),
    supportsWatchTogether: z.boolean().optional(),
    features: z
        .array(z.string())
        .optional()
        .meta({
            description:
                'UI features this device can render, e.g. ["admin_message","maintenance_notice",' +
                '"watch_together"]. The general form of `supportsWatchTogether`, which keeps working ' +
                'and keeps winning when both are sent. Unknown tokens are ignored, never rejected.',
        }),
    capabilities: DeviceCapabilitiesSchema.optional().meta({
        description:
            'Remote control: the command types this device carries out (`POST /devices/{id}/commands`), ' +
            'each with options, e.g. {"commands": {"playback.seekBy": {}, "ui.message": {"actions": 3}}}. ' +
            'A command type the device does not list is refused with 409 device_unsupported.',
    }),
});

const HeartbeatResponseSchema = z.object({
    expiresIn: z
        .number()
        .meta({ description: 'Seconds until heartbeat expires — must re-heartbeat before then' }),
});

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

/**
 * Heartbeat body schema for the request contract layer.
 *
 * All fields are fully optional — the handler treats any non-conforming body
 * as an empty heartbeat (defaults apply). The schema strips unknown fields but
 * does NOT reject unrecognised deviceType values; the handler's own safeParse
 * will fall back to defaults for invalid enum values, so we match that leniency
 * here by accepting any string for deviceType.
 */
const HeartbeatBodySchema = z.object({
    /** Capped here as well as normalised downstream — this inlet is unauthenticated-adjacent
     *  and wrote straight into Valkey without a length bound.
     *
     *  Sanitised on THIS schema, not just the `*FromDocs` one: this is the
     *  schema wired into `request.body`, so it is what actually runs. The
     *  value reaches /settings devices via user-devices.service's fallback to
     *  the raw Valkey heartbeat name whenever the session has no device row. */
    deviceName: z
        .string()
        .max(256)
        .transform((v) => sanitizeDisplayName(v, 128))
        .optional(),
    /** Must be 'tv' | 'mobile' | 'web' for the handler to use it; other values → 'unknown'. */
    deviceType: z.string().optional(),
    supportsWatchTogether: z.boolean().optional(),
    /**
     * UI features this device announces it renders — the general form of
     * `supportsWatchTogether`. Normalised here (unknown tokens kept, malformed
     * and over-long dropped) so a client newer than this server is never
     * refused a heartbeat for announcing something unrecognised; losing
     * presence over an unknown string would take the device offline for Watch
     * Together, which is a far worse failure than ignoring the token.
     */
    features: z
        .array(z.string())
        .optional()
        .transform((v) => normalizeClientFeatures(v)),
    /**
     * Remote-control capabilities. A malformed object is dropped rather than
     * refused (presence matters more); at most 64 command types are kept.
     */
    capabilities: DeviceCapabilitiesSchema.optional()
        .catch(undefined)
        .transform((v): DeviceCapabilities | undefined =>
            v ? { ...v, commands: Object.fromEntries(Object.entries(v.commands).slice(0, 64)) } : v,
        ),
});

type HeartbeatResponse = {
    /** Seconds until the heartbeat expires (must re-heartbeat before then). */
    expiresIn: number;
};

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        POST: {
            tags: ['Devices'],
            summary: 'Record device heartbeat (presence)',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Devices call this periodically (recommended: every 5 minutes, max 10 minutes) to ' +
                'mark themselves as online and available for Watch Together. Presence state lives in ' +
                'Valkey with a 10-minute TTL and expires automatically when the device stops reporting. ' +
                "**Self-device guard**: `{id}` MUST equal the `deviceSessionId` claim from the caller's " +
                'device JWT. PAT and service tokens lack this claim and cannot call this endpoint. ' +
                'Requires `FEATURE_DEVICE_AUTH`.',
            body: HeartbeatBodySchemaFromDocs,
            responses: {
                200: {
                    schema: HeartbeatResponseSchema,
                    description: 'Heartbeat recorded',
                },
                401: 'Authentication required',
                403: 'Device JWT required or id mismatch',
                404: 'Feature not enabled',
                503: 'Cache service unavailable',
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
        body: HeartbeatBodySchema,
    },
    handlers: {
        /**
         * POST /devices/{id}/heartbeat
         *
         * Records device presence in Valkey.  {id} must equal the caller's
         * `deviceSessionId` claim from their JWT — devices can only heartbeat
         * themselves, not other devices.
         */
        POST: async (event, ctx) => {
            const { locals, params } = event;

            // Self-device guard: the {id} path param must equal the JWT's
            // deviceSessionId.  PAT/svc_ tokens lack this claim and are rejected.
            const deviceSessionId = locals.deviceSessionId;
            if (!deviceSessionId) {
                return ApiProblem.forbidden(
                    'Heartbeat requires a device JWT with a deviceSessionId claim. ' +
                        'PAT and service tokens cannot heartbeat.',
                );
            }

            const targetId = params.id;
            if (!targetId || targetId !== deviceSessionId) {
                return ApiProblem.forbidden(
                    'Device can only heartbeat its own session (id must equal the JWT deviceSessionId)',
                );
            }

            // Body was validated by mount() before this handler runs.
            // ctx.input?.body carries the stripped, typed heartbeat fields (all optional).
            // Falls back to {} when the body was empty or schema produced no output.
            type HeartbeatBody = {
                deviceName?: string;
                deviceType?: string;
                supportsWatchTogether?: boolean;
                features?: string[];
                capabilities?: DeviceCapabilities;
            };
            const body: HeartbeatBody = ctx.input?.body ?? {};

            type DeviceType = 'tv' | 'mobile' | 'web' | 'unknown';
            const rawDeviceType = body.deviceType;
            const deviceType: DeviceType =
                rawDeviceType === 'tv' || rawDeviceType === 'mobile' || rawDeviceType === 'web'
                    ? rawDeviceType
                    : 'unknown';
            // Resolution order, and the reason for it:
            //   1. The explicit boolean, when sent. The shipped tvOS build
            //      sends only this, and it must keep deciding.
            //   2. `watch_together` in the announced feature list. A client
            //      that sends `features` and omits the token is saying it does
            //      NOT do Watch Together — that is the point of an explicit
            //      list, and treating the omission as unknown would make the
            //      list unable to say "no".
            //   3. Otherwise the old heuristic: a TV is assumed capable.
            const features = body.features;
            const supportsWatchTogether =
                body.supportsWatchTogether !== undefined
                    ? body.supportsWatchTogether
                    : features !== undefined
                      ? announcesFeature(features, CLIENT_FEATURE_WATCH_TOGETHER)
                      : deviceType === 'tv';

            // Dependency check
            await connectValkey();
            if (!isCoordinationValkeyReady()) {
                return ApiProblem.dependencyUnavailable('Cache service unavailable');
            }

            const status: DeviceOnlineStatus = {
                userId: String(locals.user!.userId),
                username: locals.user!.username,
                deviceSessionId,
                deviceName: body.deviceName ?? null,
                deviceType,
                supportsWatchTogether,
                ...(features !== undefined ? { features } : {}),
                ...(body.capabilities ? { capabilities: body.capabilities } : {}),
                lastSeen: Date.now(),
            };

            try {
                await recordHeartbeat(deviceSessionId, status);
                // Kept 30 days, so commands to this device are still checked
                // against what it can do after its heartbeat lapses.
                if (body.capabilities) {
                    await rememberCapabilities(deviceSessionId, body.capabilities);
                }
            } catch {
                return ApiProblem.dependencyUnavailable('Failed to store heartbeat in cache');
            }

            // Persist the reported name so a device rename survives the 10-minute
            // presence TTL. Previously the name lived only in Valkey, so renaming a
            // TV showed up in the API while it was online and reverted to the
            // login-time name the moment it went quiet — and never reached the
            // settings page at all. Best-effort: presence is already recorded.
            const sql = getDb();
            if (sql && body.deviceName) {
                const deviceId = await getDeviceIdForSession(
                    sql,
                    locals.user!.userId,
                    deviceSessionId,
                );
                if (deviceId) {
                    // Best-effort: this handler holds no transaction, so a failure
                    // here cannot poison anything. Presence is already recorded;
                    // losing the name is not worth failing the heartbeat over.
                    try {
                        await reportDeviceName(sql, {
                            userId: locals.user!.userId,
                            deviceId,
                            name: body.deviceName,
                            deviceType,
                            source: 'heartbeat',
                        });
                    } catch (error) {
                        logger.warn('Failed to persist reported device name', {
                            deviceSessionId: deviceSessionId.substring(0, 8) + '...',
                            error: String(error),
                        });
                    }
                } else {
                    // The session carries no device_id, so a reported name has nowhere
                    // durable to go and the rename will never stick. Happens for
                    // sessions issued without a device_id. Log it rather than failing
                    // silently — from the user's side, a rename that quietly does
                    // nothing is indistinguishable from a bug.
                    logger.warn(
                        'Heartbeat reported a device name but the session has no device_id',
                        { deviceSessionId: deviceSessionId.substring(0, 8) + '...' },
                    );
                }
            }

            return json({ expiresIn: HEARTBEAT_TTL_SECONDS } satisfies HeartbeatResponse);
        },
    },
});
